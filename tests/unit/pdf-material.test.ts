import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Worker } from 'node:worker_threads'
import { RuntimeStore } from '../../src/runtime/store'
import { ModelService } from '../../src/runtime/model/service'
import { pluginCapabilityId } from '../../src/runtime/plugins/directory'
import { digest } from '../../src/runtime/resources'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { pdfFixture } from '../helpers/pdf-fixture'
let root: string, store: RuntimeStore, db: Database.Database, task: string, capability: string
const host = (type: string, extra: Record<string, unknown> = {}): any => store.handle({ type, ...extra })
async function input(body = pdfFixture(), id = randomUUID()) {
  await writeFile(join(root, 'resources', id), body)
  db.prepare('INSERT INTO resources VALUES (?,?,?,?,?,?,?)').run(id, id, digest(body), body.length, 'application/pdf', 'synthetic.pdf', 'now')
  db.prepare('INSERT INTO task_resources VALUES (?,?)').run(task, id)
  return id
}
async function execute(resource: string, signal = new AbortController().signal) {
  const run = store.start(task, 'synthetic PDF extraction', 'fixture', [])
  clearTimeout((store as any).timers.get(run)); (store as any).timers.delete(run)
  const result = await store.agentTool(task, run, { type: 'call', input: { capability, arguments: { resource_id: resource }, references: [] } }, signal) as any
  host('run.cancel', { task_id: task, run_id: run })
  return result
}
async function parser(body: Buffer): Promise<any> {
  const bytes = Uint8Array.from(body), worker = new Worker(new URL('../../reference-plugins/pdf-text/parser-worker.mjs', import.meta.url), { workerData: { bytes: bytes.buffer }, transferList: [bytes.buffer], resourceLimits: { maxOldGenerationSizeMb: 256 } })
  try { return await new Promise((res, rej) => { worker.once('message', res); worker.once('error', rej); worker.once('exit', code => { if (code) rej(Error('worker exit ' + code)) }) }) } finally { await worker.terminate() }
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pliuna-pdf-material-')); store = new RuntimeStore(root, new ModelService(), { viewReplacement: true }, undefined, process.execPath); db = new Database(join(root, 'pliuna.sqlite')); task = store.create('synthetic PDF task').task.id
  const installed = await host('plugin.internal.install', { source: resolve('reference-plugins/pdf-text') }); capability = pluginCapabilityId(installed.digest, 'extract')
  await host('plugin.trust', { digest: installed.digest, confirm_local_code: true, confirm_cross_task: false })
  const plan = await host('plugin.plan', { task_id: task, digest: installed.digest }); await host('plugin.enable', { task_id: task, digest: installed.digest, fingerprint: plan.fingerprint, confirm_cross_task: false })
})
afterEach(async () => { await store.shutdown(); db.close() })
it('extracts real text through binary RPC, commits source and result atomically, and restores without replay', async () => {
  const id = await input(), result = await execute(id)
  expect(result).toMatchObject({ execution: 'success', delivery: 'delivered', data: { page_count: 2, extracted_pages: 2, partial: false } })
  const output = result.data.resource_id, text = await readFile(join(root, 'resources', output), 'utf8')
  expect(text).toContain('Pliuna PDF text one'); expect(text).toContain('Pliuna PDF text two')
  const events = db.prepare("SELECT payload_json FROM records WHERE kind='material.derived'").all() as any[]; expect(events).toHaveLength(1)
  const provenance = JSON.parse(events[0].payload_json); expect(provenance).toMatchObject({ version: 1, input: { id, sha256: digest(pdfFixture()) }, output: { id: output, sha256: digest(Buffer.from(text)) }, location_verification: 'tool_reported' }); expect(provenance.pages).toHaveLength(2)
  expect(Buffer.from(text).subarray(provenance.pages[1].start, provenance.pages[1].end).toString()).toContain('Page 2')
  expect(db.prepare('SELECT count(*) n FROM task_resources').get()).toEqual({ n: 2 }); expect(db.prepare('SELECT * FROM object_references').all()).toEqual([])
  await store.shutdown(); store = new RuntimeStore(root, new ModelService(), { viewReplacement: true }, undefined, process.execPath)
  const read = host('task.query', { task_id: task, query: { type: 'read', input: { target: { kind: 'resource', id: output } } } }); const { parameters: _, ...navigation } = provenance; expect(read.data.provenance).toEqual(navigation)
  expect(host('task.query', { task_id: task, query: { type: 'read', input: { target: { kind: 'resource', id } } } }).data.derived_results.items).toMatchObject([{ resource_id: output }])
  const original = host('task.query', { task_id: task, query: { type: 'read', input: { target: { kind: 'call', id: result.operation_id } } } }).data
  expect(original).toMatchObject({ capability_id: capability, execution: 'success', delivery: 'delivered' })
  for (const field of ['parameters', 'input', 'input_json', 'package_digest', 'plugin_version', 'pages']) expect(original).not.toHaveProperty(field)
  expect(original.result_data.resources).toContainEqual(expect.objectContaining(provenance.output))
  expect(read.data.provenance).not.toHaveProperty('parameters')
  expect(provenance.parameters).toEqual({ resource_id: id })
  const pageTwo = await host('task.query', { task_id: task, query: { type: 'read', input: { target: { kind: 'resource', id: output }, content: { pages: { start: 2, end: 2 }, max_chars: 5 } } } })
  expect(pageTwo).toMatchObject({ content_selection: true, actual_range: { chars: 5 }, location_verification: 'tool_reported', partial: false, truncated: true })
  let selected = pageTwo.data.text, cursor = pageTwo.next_cursor
  while (cursor) { const next = await host('task.query', { task_id: task, query: { type: 'read', input: { target: { kind: 'resource', id: output }, cursor } } }); selected += next.data.text; cursor = next.next_cursor }
  expect(selected).toContain('Pliuna PDF text two'); expect(selected).not.toContain('Pliuna PDF text one')
  await expect(host('task.query', { task_id: task, query: { type: 'read', input: { target: { kind: 'resource', id: output }, content: { pages: { start: 2, end: 3 } } } } })).rejects.toThrow('not present')
  expect(db.prepare('SELECT count(*) n FROM calls').get()).toEqual({ n: 1 }); expect(await readFile(join(root, 'resources', id))).toEqual(pdfFixture())
}, 20000)
it.each(['invalid', 'scanned', 'too-large', 'cross-task', 'tampered'])('rejects %s without publishing derived output', async mode => {
  const body = mode === 'invalid' ? Buffer.from('not a PDF') : mode === 'scanned' ? pdfFixture(['']) : mode === 'too-large' ? Buffer.alloc(16777217) : pdfFixture()
  const id = await input(body)
  if (mode === 'cross-task') db.prepare('DELETE FROM task_resources WHERE resource_id=?').run(id)
  if (mode === 'tampered') await writeFile(join(root, 'resources', id), Buffer.alloc(body.length, 65))
  const result = await execute(id); expect(result.execution).not.toBe('success'); expect(db.prepare("SELECT * FROM records WHERE kind='material.derived'").all()).toEqual([]); expect(db.prepare('SELECT count(*) n FROM resources').get()).toEqual({ n: 1 })
}, 20000)
it('reports page limit as partial with real page numbers rather than empty success', async () => {
  const result = await parser(pdfFixture(Array.from({ length: 201 }, (_, i) => 'Page text ' + (i + 1))))
  expect(result).toMatchObject({ ok: true, partial: true, page_count: 201 }); expect(result.pages).toHaveLength(200); expect(result.pages.at(-1).page).toBe(200); expect(result.notice).toContain('PDF_PAGE_LIMIT')
}, 20000)
it.each([2,50,200])('reads first, middle and last saved page selections from a %i-page actual extraction', async count => {
 const source=await input(pdfFixture(Array.from({length:count},(_,i)=>'Independent page marker '+(i+1)))), result=await execute(source)
 expect(result.execution).toBe('success')
 for(const page of new Set([1,Math.ceil(count/2),count])) {
  const part=await host('task.query',{task_id:task,query:{type:'read',input:{target:{kind:'resource',id:result.data.resource_id},content:{pages:{start:page,end:page},max_chars:32000}}}})
  expect(part.data.text).toContain('Independent page marker '+page);expect(part.next_cursor).toBeNull();expect(part.location_verification).toBe('tool_reported');expect(part.partial).toBe(false)
 }
 expect(db.prepare('SELECT count(*) n FROM calls').get()).toEqual({n:1})
},30000)
it('keeps the exact official vendor files and all fixed package limits', async () => {
  const source = JSON.parse(await readFile('reference-plugins/pdf-text/vendor-source.json', 'utf8'))
  for (const file of source.files) { const body = await readFile(join('reference-plugins/pdf-text', file.path)); expect(body.length).toBe(file.bytes); expect(digest(body)).toBe(file.sha256) }
  const dirs = await readdir(join(root, 'plugins')); const pkg = dirs.find(name => /^[a-f0-9]{64}$/.test(name)); expect(pkg).toBeTruthy()
})
it('rolls back upload publication and provenance together if the event transaction fails', async () => {
  const id = await input()
  db.exec("CREATE TRIGGER fail_derivation BEFORE INSERT ON records WHEN NEW.kind='material.derived' BEGIN SELECT RAISE(ABORT,'synthetic fault'); END")
  const result = await execute(id)
  expect(result).toMatchObject({ execution: 'success', delivery: 'failed' })
  expect(db.prepare('SELECT count(*) n FROM resources').get()).toEqual({ n: 1 }); expect(db.prepare("SELECT * FROM records WHERE kind='material.derived'").all()).toEqual([])
  expect(db.prepare("SELECT * FROM staging WHERE state='committed'").all()).toEqual([])
  const files = await readdir(join(root, 'resources')); expect(files.length).toBeGreaterThan(1)
  db.exec('DROP TRIGGER fail_derivation'); await store.shutdown(); store = new RuntimeStore(root)
  expect(await readdir(join(root, 'resources'))).toEqual(files); expect(db.prepare('SELECT count(*) n FROM calls').get()).toEqual({ n: 1 })
}, 20000)
it('revokes source before a late parser result can publish resources', async () => {
  const id = await input(), controller = new AbortController(), derivations = (store as any).derivations
  const original = derivations.prepare.bind(derivations)
  vi.spyOn(derivations, 'prepare').mockImplementation(async (call, valid) => { (store as any).pluginCalls.cancel(call); await original(call, valid) })
  const result = await execute(id, controller.signal)
  expect(result.delivery).toBe('failed'); expect(db.prepare('SELECT count(*) n FROM resources').get()).toEqual({ n: 1 }); expect(db.prepare("SELECT * FROM records WHERE kind='material.derived'").all()).toEqual([])
}, 20000)
it('returns a declared no-text error rather than a completed empty document', async () => {
  expect(await execute(await input(pdfFixture([''])))).toMatchObject({ execution: 'failure', error: { code: 'PDF_NO_TEXT' } })
}, 20000)
it('rejects encrypted input without asking the model for a password', async () => {
  expect(await parser(pdfFixture(['secret'], { encrypted: true }))).toMatchObject({ ok: false, code: 'PDF_PASSWORD_REQUIRED' })
}, 20000)
it('does not execute document JavaScript or follow external actions while extracting text', async () => {
  let hits = 0; const server = createServer((_req, res) => { hits++; res.end('unexpected') })
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  try {
    const result = await parser(pdfFixture(['Active content stays data'], { activityUrl: `http://127.0.0.1:${(server.address() as any).port}/forbidden` }))
    expect(result).toMatchObject({ ok: true, partial: false }); expect(result.text).toContain('Active content stays data'); expect(hits).toBe(0)
  } finally { await new Promise<void>(done => server.close(() => done())) }
}, 20000)
it('bounds each page including headings and stops total text with an explicit partial result', async () => {
  const result = await parser(pdfFixture(Array.from({ length: 34 }, () => 'x'.repeat(270000)), { overlapLines: true }))
  expect(result, JSON.stringify({ code: result.code, bytes: result.text && Buffer.byteLength(result.text), notice: result.notice })).toMatchObject({ ok: true, partial: true }); expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(8388608)
  expect(result.notice).toContain('PDF_TEXT_LIMIT'); for (const page of result.pages) expect(page.end - page.start).toBeLessThanOrEqual(262144)
}, 30000)
it('retains source, output and provenance through a verified recovery point and restore', async () => {
  const id = await input(), result = await execute(id); expect(result.execution).toBe('success')
  const begin = () => host('maintenance.begin').reservation.token
  const point = (await host('maintenance.create', { token: begin(), inputs_saved: true, replace_id: null })).active
  expect(point.resource_count).toBe(2)
  const restored = await host('maintenance.restore', { token: begin(), point_id: point.id, database_sha256: point.database_sha256, inputs_saved: true, confirm_replace_newer_data: true })
  expect(restored.last.outcome).toBe('restored')
  const read = await host('task.query', { task_id: task, query: { type: 'read', input: { target: { kind: 'resource', id: result.data.resource_id } } } }); expect(read.data.provenance.input.id).toBe(id)
}, 20000)
