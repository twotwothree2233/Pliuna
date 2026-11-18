import { afterEach, expect, test, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { runInNewContext } from 'node:vm'
import { startLocalWebServer, type LocalWebServer } from '../../src/main/web-server'
import defaults from '../../src/shared/contracts/development-defaults.json'

const roots: string[] = [], servers: LocalWebServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function launch() {
  const root = await mkdtemp(join(tmpdir(), 'pliuna-web-')); roots.push(root)
  await mkdir(join(root, 'assets'))
  await writeFile(join(root, 'index.html'), '<!doctype html><html><head><title>Pliuna</title></head><body><script type="module" src="/assets/main.js"></script></body></html>')
  await writeFile(join(root, 'assets', 'main.js'), 'document.title = "Pliuna"')
  const handle = vi.fn(async (input: unknown) => ({ ok: true as const, data: input }))
  const server = await startLocalWebServer({ root, port: 0, platform: 'darwin', request: handle }); servers.push(server)
  const send = (input: unknown, headers: Record<string, string> = {}) => fetch(server.url + '/_pliuna/request', { method: 'POST', headers: { Origin: server.url, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(input) })
  return { ...server, root, handle, send }
}

test('serves the real renderer with an external bridge before its module', async () => {
  const app = await launch(), response = await fetch(app.url), html = await response.text()
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
  expect(html.indexOf('/_pliuna/bridge.js')).toBeLessThan(html.indexOf('type="module"'))
  const asset = await fetch(app.url + '/assets/main.js?version=1')
  expect(asset.headers.get('content-type')).toContain('javascript')
  expect(await asset.text()).toBe(await readFile(join(app.root, 'assets/main.js'), 'utf8'))
  const bridgeResponse = await fetch(app.url + '/_pliuna/bridge.js'), source = await bridgeResponse.text()
  const transport = vi.fn(async () => ({ json: async () => ({ ok: true, data: 'actual host result' }) }))
  const window: any = {}
  runInNewContext(source, { window, fetch: transport })
  expect(window.pliuna.platform).toBe('darwin')
  expect(window.pliuna.transport).toBe('web')
  expect(Object.isFrozen(window.pliuna)).toBe(true)
  expect(await window.pliuna.request({ type: 'host.tasks' })).toEqual({ ok: true, data: 'actual host result' })
  expect(transport).toHaveBeenCalledWith('/_pliuna/request', expect.objectContaining({ method: 'POST', body: '{"type":"host.tasks"}', credentials: 'same-origin' }))
})

test('dispatches same-origin JSON without changing requests or host responses', async () => {
  const app = await launch(), input = { type: 'request.submit', text: '下一轮追问' }
  const response = await app.send(input)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true, data: input })
  expect(app.handle).toHaveBeenCalledExactlyOnceWith(input)
  expect(response.headers.get('access-control-allow-origin')).toBeNull()
})

test('denies foreign origins, absent origins and foreign Host values before dispatch', async () => {
  const app = await launch()
  expect((await app.send({}, { Origin: 'https://example.com' })).status).toBe(403)
  expect((await app.send({}, { Origin: '' })).status).toBe(403)
  const foreignHostStatus = await new Promise<number>(resolveStatus => {
    const request = httpRequest(app.url + '/_pliuna/request', { method: 'POST', headers: { Host: 'attacker.example', Origin: app.url, 'Content-Type': 'application/json' } }, response => { response.resume(); resolveStatus(response.statusCode!) })
    request.end('{}')
  })
  expect(foreignHostStatus).toBe(403)
  expect(app.handle).not.toHaveBeenCalled()
})

test('rejects invalid content types, malformed JSON and overlarge bodies without dispatch', async () => {
  const app = await launch()
  expect((await app.send({}, { 'Content-Type': 'text/plain' })).status).toBe(415)
  expect((await fetch(app.url + '/_pliuna/request', { method: 'POST', headers: { Origin: app.url, 'Content-Type': 'application/json' }, body: '{' })).status).toBe(400)
  expect((await app.send({ text: 'x'.repeat(defaults.transport.rpc_message_bytes) })).status).toBe(413)
  const chunkedStatus = await new Promise<number>(resolveStatus => {
    const request = httpRequest(app.url + '/_pliuna/request', { method: 'POST', headers: { Origin: app.url, 'Content-Type': 'application/json' } }, response => { response.resume(); resolveStatus(response.statusCode!) })
    request.write('"' + 'x'.repeat(defaults.transport.rpc_message_bytes)); request.end('"')
  })
  expect(chunkedStatus).toBe(413)
  expect(app.handle).not.toHaveBeenCalled()
})

test('rejects traversal and symlinks escaping the renderer root', async () => {
  const app = await launch(), outside = await mkdtemp(join(tmpdir(), 'pliuna-web-outside-')); roots.push(outside)
  await writeFile(join(outside, 'secret.json'), '{"private":true}')
  await symlink(join(outside, 'secret.json'), join(app.root, 'assets', 'escape.json'))
  for (const path of ['/assets/escape.json', '/assets/%2e%2e%2f%2e%2e%2fsecret.json', '/assets/%5c..%5csecret.json', '/.git/config']) {
    expect((await fetch(app.url + path)).status).toBe(404)
  }
  expect(app.handle).not.toHaveBeenCalled()
})

test('reports host failures without echoing internal errors or retrying', async () => {
  const app = await launch()
  app.handle.mockRejectedValueOnce(Error('private internal detail'))
  const response = await app.send({ type: 'host.tasks' })
  expect(response.status).toBe(500)
  expect(await response.json()).toEqual({ ok: false, error: { code: 'WEB_REQUEST_FAILED', message: 'Local web operation failed; query the original result before retrying' } })
  expect(app.handle).toHaveBeenCalledTimes(1)
})
