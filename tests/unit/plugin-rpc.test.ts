import { PassThrough, Writable } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { PluginRpc, RpcError } from '../../src/runtime/plugins/rpc'
const connections: PluginRpc[] = []
afterEach(() => { connections.forEach(peer => peer.close()); connections.length = 0; vi.useRealTimers() })
function pair(left: (method: string, params: Record<string, unknown>) => unknown = () => null, right: (method: string, params: Record<string, unknown>) => unknown = () => null): [PluginRpc, PluginRpc] {
  const ab = new PassThrough(), ba = new PassThrough()
  const a = new PluginRpc(ba, ab, left), b = new PluginRpc(ab, ba, right)
  connections.push(a, b); return [a, b]
}
it('serves reverse queries while an outbound tool remains active', async () => {
  let finish!: (value: unknown) => void
  const [host, plugin] = pair(() => ({ scope: 'task' }), () => new Promise(resolve => { finish = resolve }))
  const call = host.request('tools.execute', { call_id: 'host-id' })
  await expect(plugin.request('host.describe', { protocol_version: '0.1' })).resolves.toEqual({ scope: 'task' })
  finish({ execution: 'success' }); await expect(call).resolves.toEqual({ execution: 'success' })
})
it('keeps cancellation responsive during slow inbound handlers', async () => {
  let finish!: (value: unknown) => void
  const [host] = pair(() => null, method => method === 'slow' ? new Promise(resolve => { finish = resolve }) : { cancelled: true })
  const slow = host.request('slow', {})
  await expect(host.request('tools.cancel', { call_id: 'id' })).resolves.toEqual({ cancelled: true })
  finish(null); await slow
})
it('preserves declared RPC errors and never exports internal exception text', async () => {
  const [host] = pair(() => null, method => { if (method === 'known') throw new RpcError(-32601, 'Unknown method'); throw Error('private sentinel') })
  await expect(host.request('known', {})).rejects.toMatchObject({ code: -32601, message: 'Unknown method' })
  await expect(host.request('other', {})).rejects.toMatchObject({ code: -32603, message: 'Plugin method failed' })
})
it.each(['json', 'utf8', 'oversize', 'envelope', 'duplicate'])('closes polluted protocol input: %s', async mode => {
  const input = new PassThrough(), output = new PassThrough(), closed = vi.fn()
  const rpc = new PluginRpc(input, output, () => new Promise(() => {}), closed); connections.push(rpc)
  if (mode === 'json') input.write('not JSON\n')
  if (mode === 'utf8') input.write(Buffer.from([0xff, 10]))
  if (mode === 'oversize') input.write(Buffer.alloc(1048577, 32))
  if (mode === 'envelope') input.write('{"jsonrpc":"2.0","id":null,"result":1}\n')
  if (mode === 'duplicate') input.write('{"jsonrpc":"2.0","id":1,"method":"slow","params":{}}\n'.repeat(2))
  expect(closed).toHaveBeenCalledOnce()
  await expect(rpc.request('later', {})).rejects.toMatchObject({ code: 'PLUGIN_CONNECTION_CLOSED' })
})
it('handles fragmented UTF-8 bytes only after a complete frame', async () => {
  const input = new PassThrough(), output = new PassThrough(), handled = vi.fn(() => 'ok')
  const rpc = new PluginRpc(input, output, handled); connections.push(rpc)
  const body = Buffer.from('{"jsonrpc":"2.0","id":1,"method":"query","params":{"text":"中文"}}\n')
  for (const byte of body) input.write(Buffer.from([byte]))
  await Promise.resolve(); expect(handled).toHaveBeenCalledWith('query', { text: '中文' })
})
it('reports reliably delimited JSON parse errors without blocking a subsequent valid request', async () => {
  const input = new PassThrough(), output = new PassThrough(), closed = vi.fn(), frames: any[] = []
  output.on('data', bytes => frames.push(JSON.parse(bytes.toString())))
  const rpc = new PluginRpc(input, output, () => ({ valid: true }), closed); connections.push(rpc)
  input.write('{broken}\n'); input.write('{"jsonrpc":"2.0","id":1,"method":"query","params":{}}\n')
  await new Promise(resolve => setImmediate(resolve))
  expect(frames).toEqual([{ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON frame' } }, { jsonrpc: '2.0', id: 1, result: { valid: true } }])
  expect(closed).not.toHaveBeenCalled()
  input.write('{broken}\n'.repeat(3)); expect(closed).toHaveBeenCalledOnce()
})
it('records complete channel writes as sent, without claiming execution', async () => {
  const dispatch = vi.fn(), [host] = pair(() => null, () => ({ done: false }))
  await host.request('tools.execute', {}, { dispatch }); await new Promise(resolve => setImmediate(resolve))
  expect(dispatch).toHaveBeenCalledExactlyOnceWith('sent')
})
it('records uncertain in-flight write as unknown on disconnect without replay', async () => {
  const input = new PassThrough(), write = vi.fn(), output = new Writable({ write(_chunk, _encoding, _callback) { write() } }), dispatch = vi.fn()
  const rpc = new PluginRpc(input, output, () => null); connections.push(rpc)
  const request = rpc.request('execute', {}, { dispatch }); rpc.close()
  await expect(request).rejects.toBeDefined(); expect(dispatch).toHaveBeenCalledExactlyOnceWith('unknown'); expect(write).toHaveBeenCalledOnce()
})
it('cancels one request and ignores its late response without killing control traffic', async () => {
  const controller = new AbortController(); let finish!: (value: unknown) => void
  const [host] = pair(() => null, method => method === 'slow' ? new Promise(resolve => { finish = resolve }) : 'live')
  const pending = host.request('slow', {}, { signal: controller.signal }); await Promise.resolve(); controller.abort()
  await expect(pending).rejects.toMatchObject({ code: 'PLUGIN_REQUEST_CANCELLED' }); finish('late')
  await expect(host.request('query', {})).resolves.toBe('live')
})
it('times out once without automatic retry', async () => {
  vi.useFakeTimers(); const called = vi.fn(() => new Promise(() => {})), [host] = pair(() => null, called)
  const pending = host.request('slow', {}, { timeout: 10 }); const assertion = expect(pending).rejects.toMatchObject({ code: 'PLUGIN_REQUEST_TIMEOUT' })
  await vi.advanceTimersByTimeAsync(11); await assertion; expect(called).toHaveBeenCalledOnce()
})
it('bounds active requests and rejects the next without dispatch', async () => {
  const [host] = pair(() => null, () => new Promise(() => {})), pending: Promise<unknown>[] = []
  for (let i = 0; i < 100; i++) pending.push(host.request('slow', {}).catch(() => null))
  await expect(host.request('overflow', {})).rejects.toMatchObject({ code: 'PLUGIN_REQUEST_LIMIT' })
  host.close(); await Promise.all(pending)
})
