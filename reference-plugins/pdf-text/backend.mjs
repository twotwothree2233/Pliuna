import { createInterface } from 'node:readline'
import { Worker } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import { denyNetwork } from './network-guard.mjs'
denyNetwork()
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
let sequence = 0, active = null, initialized = false
const pending = new Map()
function request(method, params) {
  return new Promise((resolve, reject) => { const id = 'pdf:' + sequence++; const timer = setTimeout(() => { pending.delete(id); reject(Error('PDF_HOST_TIMEOUT')) }, 10000); pending.set(id, { resolve, reject, timer }); send({ jsonrpc: '2.0', id, method, params }) })
}
function check(call) { if (active !== call || call.cancelled) throw Error('PDF_CANCELLED') }
async function execute(params, call) {
  const { task_id, call_id, arguments: args } = params
  const parts = []; let offset = 0, sha256 = null, length = null
  do {
    check(call)
    const part = await request('resources.read_bytes', { task_id, resource_id: args.resource_id, offset, length: 262144 }); check(call)
    if (part.byte_length > 16777216 || part.byte_length < 1) throw Error('PDF_INPUT_LIMIT')
    if (length !== null && (length !== part.byte_length || sha256 !== part.sha256)) throw Error('PDF_SOURCE_CHANGED')
    length = part.byte_length; sha256 = part.sha256
    const bytes = Buffer.from(part.base64, 'base64'); if (part.offset !== offset || bytes.length > 262144 || (part.next_offset !== null && part.next_offset !== offset + bytes.length)) throw Error('PDF_SOURCE_CHANGED')
    parts.push(bytes); offset += bytes.length
    if (part.next_offset === null) break
  } while (offset < length)
  const input = Buffer.concat(parts)
  if (input.length !== length || createHash('sha256').update(input).digest('hex') !== sha256) throw Error('PDF_SOURCE_CHANGED')
  const bytes = Uint8Array.from(input)
  const worker = new Worker(new URL('./parser-worker.mjs', import.meta.url), { workerData: { bytes: bytes.buffer }, transferList: [bytes.buffer], resourceLimits: { maxOldGenerationSizeMb: 256 } }); call.worker = worker
  const result = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', () => reject(Error('PDF_WORKER_FAILED'))); worker.once('exit', code => { if (code !== 0 || call.cancelled) reject(Error(call.cancelled ? 'PDF_CANCELLED' : 'PDF_WORKER_FAILED')) }) })
  await worker.terminate(); call.worker = null; check(call)
  if (!result.ok) throw Error(result.code)
  const text = Buffer.from(result.text), digest = createHash('sha256').update(text).digest('hex')
  const upload = await request('upload.begin', { task_id, owner_id: call_id, byte_length: text.length, sha256: digest, media_type: 'text/plain; charset=utf-8', display_name: 'PDF extracted text.txt' })
  for (let start = 0; start < text.length; start += 262144) { check(call); await request('upload.chunk', { upload_id: upload.upload_id, offset: start, base64: text.subarray(start, start + 262144).toString('base64') }) }
  check(call); await request('upload.finish', { upload_id: upload.upload_id }); check(call)
  await request('materials.derive', { task_id, input_resource_id: args.resource_id, output_resource_id: upload.resource_id, pages: result.pages, partial: result.partial, notice: result.notice }); check(call)
  return { resource_id: upload.resource_id, page_count: result.page_count, extracted_pages: result.pages.length, partial: result.partial, notice: result.notice, location_verification: 'tool_reported' }
}
createInterface({ input: process.stdin }).on('line', line => {
  let message; try { message = JSON.parse(line) } catch { return }
  if (!message.method) { const p = pending.get(message.id); if (p) { clearTimeout(p.timer); pending.delete(message.id); message.error ? p.reject(Error('PDF_HOST_REJECTED')) : p.resolve(message.result) } return }
  const reply = result => send({ jsonrpc: '2.0', id: message.id, result })
  if (message.method === 'initialize') { initialized = true; reply({ protocol_version: '0.1', plugin_id: message.params.plugin_id, capabilities: message.params.capabilities }); return }
  if (message.method === 'shutdown' || message.method === 'tools.cancel') { if (active) { active.cancelled = true; void active.worker?.terminate() } if (message.id) reply({ accepted: true }); return }
  if (message.method !== 'tools.execute' || !message.id) return
  if (!initialized || active) { send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'PDF_BUSY' } }); return }
  const call = { cancelled: false, worker: null }; active = call
  const timer = setTimeout(() => { call.cancelled = true; void call.worker?.terminate() }, 60000)
  void execute(message.params, call).then(reply, error => send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: /^PDF_[A-Z_]+$/.test(error?.message) ? error.message : 'PDF_FAILED' } })).finally(() => { clearTimeout(timer); void call.worker?.terminate(); if (active === call) active = null })
})
