import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { HostResponse } from '../shared/types'
import defaults from '../shared/contracts/development-defaults.json'

interface LocalWebOptions {
  root: string
  port: number
  platform: string
  request(input: unknown): HostResponse | Promise<HostResponse>
}
export interface LocalWebServer { url: string; close(): Promise<void> }

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm'
}
const failure = (code: string, message: string): HostResponse => ({ ok: false, error: { code, message } })
function json(response: ServerResponse, status: number, value: HostResponse): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}
function body(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0, failed = false
    request.on('data', (chunk: Buffer) => {
      if (failed) return
      bytes += chunk.length
      if (bytes > defaults.transport.rpc_message_bytes) {
        failed = true; chunks.length = 0; reject(Error('WEB_REQUEST_TOO_LARGE'))
      } else chunks.push(chunk)
    })
    request.on('end', () => { if (!failed) resolveBody(Buffer.concat(chunks)) })
    request.on('aborted', () => reject(Error('WEB_REQUEST_ABORTED')))
    request.on('error', reject)
  })
}
function bridge(platform: string): string {
  return `Object.defineProperty(window, 'pliuna', { value: Object.freeze({
    platform: ${JSON.stringify(platform)}, transport: 'web',
    async request(input) {
      try {
        const response = await fetch('/_pliuna/request', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin', cache: 'no-store', body: JSON.stringify(input)
        });
        return await response.json();
      } catch {
        return { ok: false, error: { code: 'CONNECTION_LOST', message: 'Local runtime disconnected; result may be unknown. Do not automatically resend.' } };
      }
    }
  }), configurable: false, writable: false });`
}

export async function startLocalWebServer(options: LocalWebOptions): Promise<LocalWebServer> {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw Error('WEB_PORT_INVALID')
  const root = await realpath(options.root)
  if (!(await stat(root)).isDirectory()) throw Error('WEB_BUILD_UNAVAILABLE')
  const html = await readFile(resolve(root, 'index.html'), 'utf8')
  if (!/<head(?:\s[^>]*)?>/i.test(html)) throw Error('WEB_BUILD_INVALID')
  const index = html.replace(/<head(?:\s[^>]*)?>/i, '$&<script src="/_pliuna/bridge.js"></script>')
  const script = bridge(options.platform)
  let url = '', host = '', closing = false
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'no-referrer')
    void (async () => {
      if (closing) { json(response, 503, failure('SHUTTING_DOWN', 'Host is shutting down')); return }
      if (request.headers.host !== host) { json(response, 403, failure('WEB_ORIGIN_DENIED', 'Local web origin required')); return }
      let path: string
      try { path = decodeURIComponent(new URL(request.url ?? '/', url).pathname) }
      catch { json(response, 400, failure('WEB_PATH_INVALID', 'Invalid local web path')); return }
      if (path === '/_pliuna/request') {
        if (request.method !== 'POST') { json(response, 405, failure('WEB_METHOD_INVALID', 'POST required')); return }
        if (request.headers.origin !== url) { request.resume(); json(response, 403, failure('WEB_ORIGIN_DENIED', 'Local web origin required')); return }
        if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) { request.resume(); json(response, 415, failure('WEB_CONTENT_TYPE_INVALID', 'JSON request required')); return }
        const length = Number(request.headers['content-length'])
        if (Number.isFinite(length) && length > defaults.transport.rpc_message_bytes) { request.resume(); json(response, 413, failure('WEB_REQUEST_TOO_LARGE', 'Request exceeds the local transport limit')); return }
        let input: unknown
        try { input = JSON.parse((await body(request)).toString('utf8')) }
        catch (error) {
          const large = error instanceof Error && error.message === 'WEB_REQUEST_TOO_LARGE'
          json(response, large ? 413 : 400, failure(large ? 'WEB_REQUEST_TOO_LARGE' : 'WEB_REQUEST_INVALID', 'Invalid local web request')); return
        }
        json(response, 200, await options.request(input))
        return
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') { json(response, 405, failure('WEB_METHOD_INVALID', 'GET required')); return }
      if (path === '/_pliuna/bridge.js') {
        response.writeHead(200, { 'Content-Type': types['.js']! })
        response.end(request.method === 'HEAD' ? undefined : script); return
      }
      if (path === '/' || path === '/index.html') {
        response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
        response.writeHead(200, { 'Content-Type': types['.html']! })
        response.end(request.method === 'HEAD' ? undefined : index); return
      }
      if (path.includes('\\') || path.includes('\0') || path.split('/').some(segment => segment.startsWith('.'))) { json(response, 404, failure('WEB_NOT_FOUND', 'Local web asset not found')); return }
      let file: string
      try {
        file = await realpath(resolve(root, '.' + path))
        const within = relative(root, file)
        if (within === '..' || within.startsWith('..' + sep) || isAbsolute(within) || !(await stat(file)).isFile() || !types[extname(file)]) throw Error()
      } catch { json(response, 404, failure('WEB_NOT_FOUND', 'Local web asset not found')); return }
      const content = request.method === 'HEAD' ? undefined : await readFile(file)
      response.writeHead(200, { 'Content-Type': types[extname(file)]! })
      response.end(content)
    })().catch(() => {
      if (!response.headersSent) json(response, 500, failure('WEB_REQUEST_FAILED', 'Local web operation failed; query the original result before retrying'))
      else response.end()
    })
  })
  await new Promise<void>((resolveStart, reject) => {
    server.once('error', reject)
    server.listen(options.port, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') { reject(Error('WEB_START_FAILED')); return }
      host = `127.0.0.1:${address.port}`; url = `http://${host}`
      server.removeListener('error', reject); resolveStart()
    })
  })
  return { url, close: () => new Promise<void>((resolveClose, reject) => {
    closing = true
    server.close(error => { if (error) reject(error); else resolveClose() })
  }) }
}
