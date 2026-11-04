import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RuntimeStore } from '../../src/runtime/store'
import { pluginCapabilityId } from '../../src/runtime/plugins/directory'
const [root, task, boundary] = process.argv.slice(2)
const pause = () => { process.send?.({ boundary }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0) }
async function main() {
  const source = join(root!, 'source'); mkdirSync(source)
  writeFileSync(join(source, 'backend.cjs'), "const rl=require('node:readline').createInterface({input:process.stdin});rl.on('close',()=>process.exit());rl.on('line',line=>{const m=JSON.parse(line);if(!m.id)return;const result=m.method==='initialize'?{protocol_version:'0.1',plugin_id:m.params.plugin_id,capabilities:m.params.capabilities}:{value:'result '.repeat(3000)};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')})")
  writeFileSync(join(source, 'tool.json'), JSON.stringify({ id: 'echo', description: 'isolated crash fixture', when_to_use: 'test', input_schema: { type: 'object' }, output_schema: { type: 'object' }, effect: 'read', timeout_ms: 10000, errors: [], examples: [] }))
  writeFileSync(join(source, 'manifest.json'), JSON.stringify({ manifest_version: '0.1', protocol_version: '0.1', id: 'fixture.crash', version: '1.0.0', access_level: 'task', contributes: [{ id: 'echo', kind: 'tool', entry: 'tool.json', description: 'isolated' }], backend: { command: process.execPath, args: ['backend.cjs'], entry: 'backend.cjs' } }))
  const store = new RuntimeStore(root!), call = (type: string, extra = {}): any => store.handle({ type, ...(['plugin.plan','plugin.enable'].includes(type)?{task_id:task}:{}), ...extra })
  const installed = await call('plugin.internal.install', { source }); await call('plugin.trust', { digest: installed.digest, confirm_local_code: true, confirm_cross_task: false })
  const plan = await call('plugin.plan', { digest: installed.digest }); await call('plugin.enable', { digest: installed.digest, fingerprint: plan.fingerprint, confirm_cross_task: false })
  if (boundary === 'sent') {
    const processes = (store as any).pluginProcesses, execute = processes.execute.bind(processes)
    processes.execute = (copy: unknown, task: string, request: any) => execute(copy, task, { ...request, dispatch: (state: string) => { request.dispatch(state); if (state === 'sent') pause() } })
  }
  if (boundary === 'prepared') {
    const uploads = (store as any).pluginUploads, receive = uploads.receiveResult.bind(uploads)
    uploads.receiveResult = async (...args: any[]) => { await receive(...args); pause() }
  }
  const run = store.start(task!, 'isolated crash', 'fixture', [])
  clearTimeout((store as any).timers.get(run)); (store as any).timers.delete(run)
  await store.agentTool(task!, run, { type: 'call', input: { capability: pluginCapabilityId(installed.digest, 'echo'), arguments: {}, references: [] } }, new AbortController().signal)
  if (boundary === 'committed') pause()
  throw Error('Boundary not reached')
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'Fixture failure'); process.exit(2) })
