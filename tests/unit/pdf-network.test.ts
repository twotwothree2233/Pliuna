import { expect, it } from 'vitest'
import { Worker } from 'node:worker_threads'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
it('rejects fetch, HTTP, TLS, raw sockets, DNS and child-process bypasses inside the parser guard', async () => {
  let requests = 0
  const server = createServer((_req, res) => { requests++; res.end('unexpected') })
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) }); const port = (server.address() as any).port
  const worker = new Worker(`const {parentPort}=require('node:worker_threads');(async()=>{const {denyNetwork}=await import(${JSON.stringify(pathToFileURL(resolve('reference-plugins/pdf-text/network-guard.mjs')).href)});denyNetwork();const probes=[()=>fetch('http://127.0.0.1:${port}'),()=>require('node:http').get('http://127.0.0.1:${port}'),()=>require('node:https').get('https://127.0.0.1:${port}'),()=>require('node:net').connect(${port},'127.0.0.1'),()=>new (require('node:net').Socket)().connect(${port},'127.0.0.1'),()=>require('node:tls').connect(${port}),()=>require('node:dns').lookup('localhost',()=>{}),()=>require('node:dns').promises.lookup('localhost'),()=>require('node:child_process').spawn(process.execPath,['-v'])];const codes=[];for(const probe of probes){try{await probe();codes.push('UNBLOCKED')}catch(e){codes.push(e.message)}}parentPort.postMessage(codes)})().catch(e=>parentPort.postMessage({error:e.message}));`, { eval: true })
  try {
    const result = await new Promise((done, reject) => { worker.once('message', done); worker.once('error', reject) })
    expect(result).toEqual(Array(9).fill('PDF_NETWORK_DENIED')); expect(requests).toBe(0)
  } finally { await worker.terminate(); await new Promise<void>(done => server.close(() => done())) }
})
it('matches vendor checksums without importing or executing the upstream package', async () => {
  const source = JSON.parse(await readFile('reference-plugins/pdf-text/vendor-source.json', 'utf8'))
  expect(source.version).toBe('6.4.299'); expect(source.source).toBe('https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.4.299.tgz')
  for (const file of source.files) expect(createHash('sha256').update(await readFile(resolve('reference-plugins/pdf-text', file.path))).digest('hex')).toBe(file.sha256)
})
