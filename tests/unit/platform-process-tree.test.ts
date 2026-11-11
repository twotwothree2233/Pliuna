import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { fork, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startProcessTree, processEnvironment, type ManagedProcessTree } from '../../src/platform/process-tree'
import { processFixtures } from '../helpers/process-fixtures'

let directory: string, built: string, entry: string
const trees: ManagedProcessTree[] = [], owners: ChildProcess[] = []
const backend = `
const {fork}=require('node:child_process');
if(process.argv[2]==='leaf')setInterval(()=>{},1000);
else if(process.argv[2]==='env'){process.stdout.write(JSON.stringify(process.env),()=>process.exit(0))}
else if(process.argv[2]==='success'){process.stdout.write('complete 中',()=>process.exit(0))}
else {
 const leaf=fork(__filename,['leaf'],{env:{},execArgv:[],stdio:'ignore'});
 leaf.once('spawn',()=>process.send({pids:[process.pid,leaf.pid]}));
 process.on('message',m=>{if(m==='exit')process.exit(0)});
 setInterval(()=>{},1000);
}
`
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'trellis-process-tree-')); built = await processFixtures()
  entry = join(directory, 'backend.cjs'); writeFileSync(entry, backend)
})
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  for (const owner of owners.splice(0)) owner.kill('SIGKILL')
  for (const tree of trees.splice(0)) { tree.terminate(); await tree.confirm() }
})
afterAll(() => { rmSync(directory, { recursive: true, force: true }); rmSync(built, { recursive: true, force: true }) })
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false; throw e } }
async function scene() {
  let report!: (value: any) => void
  const received = new Promise<{ pids: number[] }>(resolve => { report = resolve })
  const tree = startProcessTree({ mode: 'fork', command: entry, args: [], env: processEnvironment() }, { runtime: process.execPath, message: report })
  trees.push(tree); tree.process.stdout!.resume(); tree.process.stderr!.resume()
  await tree.ready
  return { tree, pids: (await received).pids }
}
it('confirms the supervisor and every contained descendant after termination', async () => {
  const { tree, pids } = await scene()
  expect(pids.every(alive)).toBe(true)
  tree.terminate(); await tree.confirm()
  expect([tree.process.pid!, ...pids].some(alive)).toBe(false)
})
it('contains descendants before dispatching backend messages', async () => {
  const { tree, pids } = await scene()
  tree.send('exit')
  await tree.confirm()
  expect(pids.some(alive)).toBe(false)
})
it('terminates the whole tree when its control IPC is lost', async () => {
  const { tree, pids } = await scene()
  tree.process.disconnect(); await tree.confirm()
  expect(pids.some(alive)).toBe(false)
})
it('does not treat a termination request as confirmed exit', async () => {
  const { tree } = await scene()
  await expect(tree.confirm(20)).rejects.toMatchObject({ code: 'PROCESS_TREE_CLEANUP_UNCONFIRMED' })
  tree.terminate(); await expect(tree.confirm()).resolves.toBeDefined()
})
it('refuses an invalidated source before executing backend code', async () => {
  const reports: unknown[] = []
  const tree = startProcessTree({ mode: 'fork', command: entry, args: [], env: {} }, { runtime: process.execPath,
    beforeStart: () => { throw Error('revoked') }, message: value => reports.push(value) })
  trees.push(tree); tree.process.stdout!.resume(); tree.process.stderr!.resume()
  await expect(tree.ready).rejects.toMatchObject({ code: 'PROCESS_TREE_SOURCE_INVALID' })
  await tree.confirm(); expect(reports).toEqual([])
})
it('confirms absence after a failed supervisor spawn', async () => {
  const tree = startProcessTree({ mode: 'spawn', command: entry, args: [], env: {} }, { runtime: join(directory, 'missing-runtime') })
  trees.push(tree)
  await expect(tree.ready).rejects.toMatchObject({ code: 'PROCESS_TREE_START_FAILED' })
  await expect(tree.confirm()).resolves.toBeDefined()
})
it('forwards necessary Windows startup variables without host secrets', async () => {
  vi.stubEnv('PRIVATE_MODEL_SECRET', 'never-forward')
  const env = processEnvironment()
  expect(env).not.toHaveProperty('PRIVATE_MODEL_SECRET')
  if (process.platform === 'win32') expect(env.SystemRoot).toBe(process.env.SystemRoot)
  const tree = startProcessTree({ mode: 'spawn', command: process.execPath, args: [entry, 'env'], env }, { runtime: process.execPath })
  trees.push(tree)
  let output = ''; tree.process.stdout!.on('data', chunk => { output += chunk }); tree.process.stderr!.resume()
  await new Promise(resolve => tree.process.once('close', resolve)); await tree.confirm()
  expect(JSON.parse(output)).not.toHaveProperty('PRIVATE_MODEL_SECRET')
})
it('preserves complete output on ordinary completion', async () => {
  const tree = startProcessTree({ mode: 'spawn', command: process.execPath, args: [entry, 'success'], env: processEnvironment() }, { runtime: process.execPath })
  trees.push(tree)
  let output = ''; tree.process.stdout!.on('data', chunk => { output += chunk }); tree.process.stderr!.resume()
  await new Promise(resolve => tree.process.once('close', resolve))
  expect((await tree.confirm()).code).toBe(0); expect(output).toBe('complete 中')
})
it.each(['owner.mjs', 'owner.cjs'])('cleans contained descendants after its %s owner is abruptly killed', async ownerEntry => {
  const owner = fork(join(built, ownerEntry), [], { execArgv: [], env: processEnvironment(), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  owners.push(owner); owner.stderr!.resume()
  const received = new Promise<{ root: number; value: { pids: number[] } }>((resolve, reject) => { owner.once('message', value => resolve(value as any)); owner.once('error', reject) })
  owner.send({ mode: 'fork', command: entry, args: [], env: processEnvironment() })
  const report = await received
  owner.kill('SIGKILL'); await new Promise(resolve => owner.once('exit', resolve))
  await expect.poll(() => [report.root, ...report.value.pids].some(alive), { timeout: 5000 }).toBe(false)
})
