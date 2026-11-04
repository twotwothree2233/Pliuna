import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginControl } from '../../src/runtime/plugins/control'
import { pluginCapabilities, PluginProcesses, type PluginExecution } from '../../src/runtime/plugins/process'
import type { PluginCopy } from '../../src/runtime/plugins/package'
let root: string, control: PluginControl, processes: PluginProcesses | undefined, copy: PluginCopy
const task = '00000000-0000-4000-8000-000000000001'
const backend = `
const readline = require('node:readline');
require('node:fs').writeFileSync(MARKER_PATH, 'yes');
const callbacks = new Map(); let active = false;
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line);
 if(!m.method){const cb=callbacks.get(m.id);callbacks.delete(m.id);if(cb)cb(m.result);return}
 if(m.method==='initialize'){send({jsonrpc:'2.0',id:m.id,result:{protocol_version:'0.1',plugin_id:m.params.plugin_id,capabilities:m.params.capabilities}});return}
 if(m.method==='tools.cancel'){return}
 if(m.method==='shutdown'){require('node:fs').writeFileSync(MARKER_PATH+'.shutdown','yes');send({jsonrpc:'2.0',id:m.id,result:{accepted:true}});return}
 if(m.method==='tools.execute'){
  const a=m.params.arguments;
  if(active){send({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:'overlap'}});return}
  active=true;
  if(a.error){active=false;send({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:'expected fixture failure'}});return}
  const finish=value=>{active=false;send({jsonrpc:'2.0',id:m.id,result:value})};
  if(a.reverse){const id='plugin:'+m.id;callbacks.set(id,r=>finish({value:r.value}));send({jsonrpc:'2.0',id,method:'objects.read',params:{task_id:m.params.task_id}});return}
  setTimeout(()=>finish(a.bad?'invalid':{value:a.value}),a.delay||0);
 }
});
`
async function setup(options: { timeout?: number; badHandshake?: boolean; global?: boolean; pdf?: boolean; appRuntime?: boolean } = {}): Promise<void> {
  const source = join(root, 'source'); await mkdir(source)
  const script = backend.replaceAll('MARKER_PATH', JSON.stringify(join(root, 'started')))
  await writeFile(join(source, 'backend.cjs'), options.badHandshake ? script.replace("protocol_version:'0.1'", "protocol_version:'future'") : script)
  await writeFile(join(source, 'echo.json'), JSON.stringify({ id: 'echo', description: 'fixture', when_to_use: 'testing', input_schema: { type: 'object' }, output_schema: { type: 'object', properties: { value: {} }, required: ['value'], additionalProperties: false }, effect: 'read', timeout_ms: options.timeout ?? 2000, errors: [], examples: [] }))
  await writeFile(join(source, 'manifest.json'), JSON.stringify({ manifest_version: '0.1', protocol_version: '0.1', id: options.pdf ? 'trellis.pdf-text' : 'fixture.process', version: '1.0.0', access_level: options.global ? 'global' : 'task', contributes: [{ id: 'echo', kind: 'tool', entry: 'echo.json', description: 'fixture' }], backend: options.appRuntime ? { runtime: 'app-node', entry: 'backend.cjs' } : { command: process.execPath, args: ['backend.cjs'], entry: 'backend.cjs' } }))
  copy = await control.install(source); await control.grant(copy.digest, { local_code: true, cross_task: options.global ?? false })
  processes = new PluginProcesses(root, async item => { await control.executable(item.digest) }, async (_identity, method) => { expect(method).toBe('objects.read'); return { value: 'reverse result' } })
}
function request(args: Record<string, unknown> = {}, options: Partial<PluginExecution> = {}): PluginExecution {
  return { call_id: crypto.randomUUID(), capability: 'echo', arguments: args, references: [], signal: new AbortController().signal, dispatch() {}, valid() {}, ...options }
}
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'trellis-plugin-process-')); control = new PluginControl(root) })
afterEach(async () => { vi.restoreAllMocks(); await processes?.shutdown('test_cleanup', 20); processes = undefined; control.close(); await rm(root, { recursive: true, force: true }) })
it('discovers static descriptions without executing a backend, then calls lazily', async () => {
  await setup(); expect((await pluginCapabilities(root, copy))[0]!.capability.id).toBe('echo')
  await expect(readFile(join(root, 'started'))).rejects.toBeDefined()
  expect(await processes!.execute(copy, task, request({ value: 42 }))).toEqual({ value: 42 })
  expect((await readFile(join(root, 'started'))).toString()).toBe('yes')
})
it('rejects app-runtime packages without a trusted host executable and never falls back to PATH', async () => {
  await setup({ appRuntime: true })
  await expect(processes!.execute(copy, task, request({ value: 1 }))).rejects.toMatchObject({ code: 'PLUGIN_APP_RUNTIME_UNAVAILABLE' })
  await expect(readFile(join(root, 'started'))).rejects.toBeDefined()
})
it('admits at most two PDF executions app-wide and one per task, releasing only after cancellation exit', async () => {
  await setup({ pdf: true })
  const controller = new AbortController()
  let sent!: () => void; const dispatched = new Promise<void>(done => { sent = done })
  const first = processes!.execute(copy, task, request({ value: 1, delay: 500 }, { signal: controller.signal, dispatch: sent }))
  const cancelled = expect(first).rejects.toBeDefined(); await dispatched
  const second = processes!.execute(copy, 'other-task', request({ value: 2, delay: 150 }))
  await expect(processes!.execute(copy, task, request({ value: 3 }))).rejects.toMatchObject({ code: 'PDF_CONCURRENCY_LIMIT' })
  await expect(processes!.execute(copy, 'third-task', request({ value: 3 }))).rejects.toMatchObject({ code: 'PDF_CONCURRENCY_LIMIT' })
  controller.abort(); await cancelled
  expect(await second).toEqual({ value: 2 })
  expect(await processes!.execute(copy, task, request({ value: 4 }))).toEqual({ value: 4 })
})
it('allows a backend reverse read while awaiting its tool result', async () => {
  await setup(); expect(await processes!.execute(copy, task, request({ reverse: true }))).toEqual({ value: 'reverse result' })
})
it('serializes simultaneous top-level calls to one instance', async () => {
  await setup(); const values = await Promise.all([processes!.execute(copy, task, request({ value: 1, delay: 30 })), processes!.execute(copy, task, request({ value: 2 }))])
  expect(values).toEqual([{ value: 1 }, { value: 2 }])
})
it('refuses nested busy call immediately instead of queuing behind its parent', async () => {
  await setup(); let sent!: () => void; const dispatched = new Promise<void>(resolve => { sent = resolve })
  const first = processes!.execute(copy, task, request({ value: 1, delay: 100 }, { dispatch: sent })); await dispatched
  await expect(processes!.execute(copy, task, request({ value: 2 }, { nested: true }))).rejects.toMatchObject({ code: 'PLUGIN_INSTANCE_BUSY' }); await first
})
it('rejects an expanded or incompatible handshake', async () => {
  await setup({ badHandshake: true }); await expect(processes!.execute(copy, task, request())).rejects.toMatchObject({ code: 'PLUGIN_HANDSHAKE_INVALID' })
})
it('rejects result schema mismatch without replay', async () => {
  await setup(); await expect(processes!.execute(copy, task, request({ bad: true }))).rejects.toMatchObject({ code: 'PLUGIN_OUTPUT_INVALID' })
})
it('revokes qualification before accepting late process output', async () => {
  await setup(); let sent!: () => void; const dispatched = new Promise<void>(resolve => { sent = resolve })
  const pending = processes!.execute(copy, task, request({ value: 'late', delay: 100 }, { dispatch: sent })); const assertion = expect(pending).rejects.toBeDefined()
  await dispatched; control.revoke(copy.digest); processes!.revoke(copy.digest); await assertion
})
it('timeout terminates the direct child and does not retry the original request', async () => {
  await setup({ timeout: 20 }); const states: string[] = []
  await expect(processes!.execute(copy, task, request({ value: 'late', delay: 200 }, { dispatch: state => states.push(state) }))).rejects.toMatchObject({ code: 'PLUGIN_REQUEST_TIMEOUT' })
  expect(states).toEqual(['sent'])
})
it('cancels a waiting call promptly without letting later calls overlap the first', async () => {
  await setup(); let sent!: () => void; const dispatched = new Promise<void>(resolve => { sent = resolve })
  const first = processes!.execute(copy, task, request({ value: 1, delay: 100 }, { dispatch: sent })); await dispatched
  const controller = new AbortController()
  const second = processes!.execute(copy, task, request({ value: 2 }, { signal: controller.signal }))
  const assertion = expect(second).rejects.toMatchObject({ code: 'PLUGIN_CALL_CANCELLED' })
  controller.abort(); await assertion
  const third = processes!.execute(copy, task, request({ value: 3 }))
  expect(await first).toEqual({ value: 1 }); expect(await third).toEqual({ value: 3 })
})
it('requests bounded graceful shutdown and rejects subsequent executions', async () => {
  await setup(); await processes!.execute(copy,task,request({value:1}))
  await processes!.shutdown('fixture_shutdown',100)
  expect((await readFile(join(root,'started.shutdown'))).toString()).toBe('yes')
  await expect(processes!.execute(copy,task,request({value:2}))).rejects.toMatchObject({code:'PLUGIN_PROCESS_CLOSED'})
})
it('holds the instance slot through asynchronous result saving', async () => {
  await setup();let entered!:()=>void,release!:()=>void
  const saving=new Promise<void>(done=>{entered=done}),held=new Promise<void>(done=>{release=done})
  const first=processes!.execute(copy,task,request({value:1},{settle:async output=>{entered();await held;return output}}));await saving
  let sent=false;const second=processes!.execute(copy,task,request({value:2},{dispatch:()=>{sent=true}}))
  await new Promise(resolve=>setTimeout(resolve,30));expect(sent).toBe(false)
  release();expect(await first).toEqual({value:1});expect(await second).toEqual({value:2})
})
it('retains a healthy connection after a declared tool execution error', async () => {
  await setup(); await expect(processes!.execute(copy,task,request({error:true}))).rejects.toMatchObject({code:-32000})
  const before = processes!.status(task,copy.digest)
  expect(await processes!.execute(copy,task,request({value:'next independent call'}))).toEqual({value:'next independent call'})
  expect(processes!.status(task,copy.digest)).toEqual(before)
})
it('reconciles global instances whose required enablement is unavailable', async () => {
  await setup({global:true})
  await processes!.execute(copy,task,request({value:1}));expect(processes!.status(task,copy.digest)).toHaveLength(1)
  processes!.reconcile(()=>false);expect(processes!.status(task,copy.digest)).toMatchObject([{state:'stopping'}])
  await expect.poll(()=>processes!.status(task,copy.digest)).toHaveLength(0)
})
function childInstance(): { process: ChildProcess; exited: Promise<void> } {
  return [...(processes as any).children][0]
}
it('holds ordinary cancelled work and its instance slot until confirmed exit', async () => {
  await setup()
  const controller = new AbortController()
  let sent!: () => void
  const dispatched = new Promise<void>(resolve => { sent = resolve })
  let settled = false
  const work = processes!.execute(copy, task, request({value: 'late', delay: 500}, {signal:controller.signal, dispatch:sent})).finally(()=>{settled=true})
  const rejected = expect(work).rejects.toMatchObject({code:'PLUGIN_REQUEST_CANCELLED'})
  await dispatched
  const instance = childInstance()
  controller.abort()
  await Promise.resolve(); await Promise.resolve()
  expect(processes!.cleaning(task)).toBe(true)
  expect(settled).toBe(false)
  await expect(processes!.execute(copy,task,request({value:'replacement'}))).rejects.toMatchObject({code:'PLUGIN_CLEANUP_PENDING'})
  processes!.stopTask(task)
  await rejected
  await instance.exited
  expect(processes!.status(task,copy.digest)).toEqual([])
  expect(await processes!.execute(copy,task,request({value:'new explicit work'}))).toEqual({value:'new explicit work'})
})
it.each(['false', 'throw', 'error'])('retains unresolved shutdown when termination reports %s', async mode => {
  await setup()
  await processes!.execute(copy,task,request({value:1}))
  const instance=childInstance(), child=instance.process
  const kill=vi.spyOn(child,'kill').mockImplementation(()=>{if(mode==='throw')throw Error('synthetic');return false})
  if(mode==='error') child.emit('error',new Error('synthetic runtime error'))
  let settled=false
  const shutting=processes!.shutdown('fixture',10).then(()=>{settled=true})
  await expect.poll(()=>processes!.status(task,copy.digest)).toMatchObject([{state:'cleanup_failed',cleanup_error:mode==='throw'?'PLUGIN_TERMINATION_FAILED':'PLUGIN_TERMINATION_UNCONFIRMED'}])
  expect(processes!.cleaning(task)).toBe(true)
  expect(settled).toBe(false)
  kill.mockRestore()
  processes!.retryCleanup()
  await shutting
  expect(processes!.status(task,copy.digest)).toEqual([])
})
it('keeps a global instance bound to active task cleanup until its exit', async()=>{
  await setup({global:true})
  let sent!:()=>void;const dispatched=new Promise<void>(resolve=>{sent=resolve})
  const work=processes!.execute(copy,task,request({value:1,delay:500},{dispatch:sent}))
  const rejected=expect(work).rejects.toBeDefined();await dispatched
  processes!.stopTask(task)
  expect(processes!.cleaning(task)).toBe(true)
  await rejected
  expect(processes!.cleaning(task)).toBe(false)
})
it('waits for idle child exit before database rebind and admits only later explicit work', async()=>{
  await setup();await processes!.execute(copy,task,request({value:1}))
  const instance=childInstance(),kill=vi.spyOn(instance.process,'kill').mockReturnValue(false)
  let settled=false;const stopping=processes!.stopForRebind().then(()=>{settled=true})
  await Promise.resolve();expect(settled).toBe(false)
  await expect(processes!.execute(copy,task,request({value:2}))).rejects.toMatchObject({code:'PLUGIN_CLEANUP_PENDING'})
  kill.mockRestore();processes!.retryCleanup();await stopping
  expect(await processes!.execute(copy,task,request({value:3}))).toEqual({value:3})
})
