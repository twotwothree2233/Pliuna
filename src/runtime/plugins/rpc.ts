import { randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import { ContractError } from '../../shared/validation'
import defaults from '../../shared/contracts/development-defaults.json'

type RpcId = string | number
type Params = Record<string, unknown>
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; abort?: () => void; signal?: AbortSignal; attempted: boolean; dispatch?: (state: 'sent' | 'unknown') => void }
export class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) { super(message) }
}
const object = (value: unknown): value is Params => !!value && typeof value === 'object' && !Array.isArray(value)
const validId = (id: unknown): id is RpcId => (typeof id === 'string' && id.length > 0 && id.length <= 200) || (typeof id === 'number' && Number.isSafeInteger(id))
const key = (id: RpcId) => `${typeof id}:${id}`
const failure = (code: string) => new ContractError(code, 'Plugin connection ended; dispatched effects may be unknown and are not replayed')

export class PluginRpc {
  private buffer = Buffer.alloc(0)
  private pending = new Map<string, Pending>()
  private inbound = new Set<string>()
  private expired = new Set<string>()
  private ended = false
  private queuedBytes = 0
  private received = 0
  private period = Date.now()
  private readonly prefix = randomUUID()
  private sequence = 0
  private parseErrors = 0
  constructor(private input: Readable, private output: Writable, private handler: (method: string, params: Params) => unknown | Promise<unknown>, private closed: (code: string) => void = () => {}, private notification: (method: string, params: Params) => void = () => {}) {
    input.on('data', this.data)
    input.once('end', this.end); input.once('error', this.ioError); output.once('error', this.ioError)
  }
  private end = (): void => { this.close('PLUGIN_CONNECTION_CLOSED') }
  private ioError = (): void => { this.close('PLUGIN_TRANSPORT_FAILED') }
  private data = (chunk: Buffer | string): void => {
    if (this.ended) return
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    let start = 0
    for (let index = 0; index < bytes.length; index++) {
      if (bytes[index] !== 10) continue
      if (this.buffer.length + index - start > defaults.transport.rpc_message_bytes) { this.close('PLUGIN_FRAME_TOO_LARGE'); return }
      const frame = Buffer.concat([this.buffer, bytes.subarray(start, index)])
      this.buffer = Buffer.alloc(0); start = index + 1
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(frame)
        let message: unknown
        try { message = JSON.parse(text) }
        catch {
          if (!text.trimStart().startsWith('{') || ++this.parseErrors > 3) { this.close('PLUGIN_PROTOCOL_INVALID'); return }
          this.send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON frame' } })
          continue
        }
        this.receive(message)
      } catch { this.close('PLUGIN_PROTOCOL_INVALID') }
      if (this.ended) return
    }
    if (this.buffer.length + bytes.length - start > defaults.transport.rpc_message_bytes) { this.close('PLUGIN_FRAME_TOO_LARGE'); return }
    this.buffer = Buffer.concat([this.buffer, bytes.subarray(start)])
  }
  private receive(message: unknown): void {
    if (Date.now() - this.period >= 1000) { this.period = Date.now(); this.received = 0 }
    if (++this.received > 200) { this.close('PLUGIN_RATE_LIMIT'); return }
    if (!object(message) || message.jsonrpc !== '2.0') throw new Error()
    if ('method' in message) {
      if (typeof message.method !== 'string' || !message.method.length || message.method.length > 200 || !object(message.params) || Object.keys(message).some(k => !['jsonrpc', 'id', 'method', 'params'].includes(k))) throw new Error()
      if (!('id' in message)) { this.notification(message.method, message.params); return }
      if (!validId(message.id)) throw new Error()
      const id = message.id, requestKey = key(id)
      if (this.inbound.has(requestKey)) throw new Error()
      if (this.inbound.size >= 100) { this.send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'Request capacity exceeded' } }); return }
      this.inbound.add(requestKey)
      // Do not await a handler in the receive loop: callbacks and cancellation must keep flowing.
      void Promise.resolve().then(() => this.handler(message.method as string, message.params as Params)).then(result => {
        if (!this.ended) this.send({ jsonrpc: '2.0', id, result: result ?? null })
      }, error => {
        if (!this.ended) this.send({ jsonrpc: '2.0', id, error: error instanceof RpcError ? { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) } : error instanceof ContractError ? { code: -32000, message: 'Host operation rejected; inspect the original action or call if registered', data: { code: error.code } } : { code: -32603, message: 'Plugin method failed' } })
      }).catch(() => this.close('PLUGIN_TRANSPORT_FAILED')).finally(() => this.inbound.delete(requestKey))
      return
    }
    if (!validId(message.id) || Object.keys(message).some(k => !['jsonrpc', 'id', 'result', 'error'].includes(k)) || ('result' in message) === ('error' in message)) throw new Error()
    if ('error' in message && (!object(message.error) || !Number.isInteger(message.error.code) || typeof message.error.message !== 'string' || Object.keys(message.error).some(k => !['code', 'message', 'data'].includes(k)))) throw new Error()
    const id = key(message.id), pending = this.pending.get(id)
    if (!pending) { if (this.expired.has(id)) return; throw new Error() }
    this.remove(id, pending)
    if ('error' in message) { const error = message.error as Params; pending.reject(new RpcError(error.code as number, error.message as string, error.data)) }
    else pending.resolve(message.result)
  }
  private send(message: unknown, callback?: (error?: Error | null) => void): void {
    if (this.ended) throw failure('PLUGIN_CONNECTION_CLOSED')
    const encoded = Buffer.from(JSON.stringify(message) + '\n')
    if (encoded.length - 1 > defaults.transport.rpc_message_bytes) throw failure('PLUGIN_FRAME_TOO_LARGE')
    if (this.queuedBytes + encoded.length > 4 * defaults.transport.rpc_message_bytes) { this.close('PLUGIN_BACKPRESSURE'); throw failure('PLUGIN_BACKPRESSURE') }
    this.queuedBytes += encoded.length
    try {
      this.output.write(encoded, error => {
        this.queuedBytes -= encoded.length
        callback?.(error)
        if (error) this.close('PLUGIN_TRANSPORT_FAILED')
      })
    } catch { this.queuedBytes -= encoded.length; this.close('PLUGIN_TRANSPORT_FAILED'); throw failure('PLUGIN_TRANSPORT_FAILED') }
  }
  request(method: string, params: Params, options: { timeout?: number; signal?: AbortSignal; dispatch?: (state: 'sent' | 'unknown') => void } = {}): Promise<unknown> {
    if (this.ended || options.signal?.aborted) return Promise.reject(failure('PLUGIN_CONNECTION_CLOSED'))
    if (this.pending.size >= 100) return Promise.reject(failure('PLUGIN_REQUEST_LIMIT'))
    const id = `${this.prefix}:${++this.sequence}`, requestKey = key(id)
    return new Promise((resolve, reject) => {
      const expire = (code: string) => {
        const pending = this.pending.get(requestKey)
        if (!pending) return
        this.remove(requestKey, pending); this.expired.add(requestKey)
        if (this.expired.size > 200) this.expired.delete(this.expired.values().next().value!)
        reject(failure(code))
      }
      const timer = setTimeout(() => expire('PLUGIN_REQUEST_TIMEOUT'), options.timeout ?? defaults.tool.execution_ms)
      timer.unref?.()
      const pending: Pending = { resolve, reject, timer, attempted: false, dispatch: options.dispatch, signal: options.signal }
      if (options.signal) { pending.abort = () => expire('PLUGIN_REQUEST_CANCELLED'); options.signal.addEventListener('abort', pending.abort, { once: true }) }
      this.pending.set(requestKey, pending)
      try {
        pending.attempted = true
        this.send({ jsonrpc: '2.0', id, method, params }, error => { if (error) pending.dispatch?.('unknown'); else pending.dispatch?.('sent'); pending.dispatch = undefined })
      } catch (error) { if (this.pending.has(requestKey)) { this.remove(requestKey, pending); reject(error as Error) } }
    })
  }
  notify(method: string, params: Params): void { this.send({ jsonrpc: '2.0', method, params }) }
  private remove(id: string, pending: Pending): void {
    clearTimeout(pending.timer)
    if (pending.abort) pending.signal?.removeEventListener('abort', pending.abort)
    this.pending.delete(id)
  }
  close(code = 'PLUGIN_CONNECTION_CLOSED'): void {
    if (this.ended) return
    this.ended = true
    this.input.off('data', this.data); this.input.off('end', this.end)
    this.buffer = Buffer.alloc(0)
    for (const [id, pending] of this.pending) {
      this.remove(id, pending)
      if (pending.attempted) pending.dispatch?.('unknown')
      pending.dispatch = undefined; pending.reject(failure(code))
    }
    this.inbound.clear(); this.closed(code)
  }
}
