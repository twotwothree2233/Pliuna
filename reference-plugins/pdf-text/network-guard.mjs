import { syncBuiltinESMExports } from 'node:module'
import net from 'node:net'
import tls from 'node:tls'
import http from 'node:http'
import https from 'node:https'
import http2 from 'node:http2'
import dgram from 'node:dgram'
import dns from 'node:dns'
import childProcess from 'node:child_process'
export function denyNetwork() {
  const denied = () => { throw new Error('PDF_NETWORK_DENIED') }
  globalThis.fetch = denied
  globalThis.WebSocket = class { constructor() { denied() } }
  for (const [module, names] of [[net, ['connect', 'createConnection', 'createServer']], [tls, ['connect', 'createServer']], [http, ['request', 'get', 'createServer']], [https, ['request', 'get', 'createServer']], [http2, ['connect', 'createServer', 'createSecureServer']], [dgram, ['createSocket']], [dns, ['lookup', 'resolve', 'resolve4', 'resolve6']], [childProcess, ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']]]) for (const name of names) module[name] = denied
  net.Socket.prototype.connect = denied
  for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6']) dns.promises[name] = denied
  syncBuiltinESMExports()
}
