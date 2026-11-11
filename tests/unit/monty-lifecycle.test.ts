import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fork } from 'node:child_process'
import { processEnvironment } from '../../src/platform/process-tree'
import { nativeMonty, type MontyExecution } from '../../src/runtime/monty/runner'
import { montyLimits } from '../../src/runtime/monty/contract'
import { hostMontyTarget } from '../../src/shared/native-targets.mjs'
import { processFixtures } from '../helpers/process-fixtures'

let directory: string, built: string
const childRuntime = process.env.PLIUNA_TEST_CHILD_RUNTIME ?? process.execPath
const active: MontyExecution[] = []
beforeAll(async () => { directory = mkdtempSync(join(tmpdir(), 'pliuna-monty-lifecycle-')); built = await processFixtures() })
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); for (const execution of active.splice(0)) await execution.stop() })
afterAll(() => { rmSync(directory, { recursive: true, force: true }); rmSync(built, { recursive: true, force: true }) })
function launch(runner: string, code: string, signal = new AbortController().signal, start: (pid: number) => void = () => {}) {
  const execution = nativeMonty({ runner, binary: 'fixture', native: 'fixture', binary_sha256: '0'.repeat(64) }, { code, inputs: {} }, signal, childRuntime, start)
  active.push(execution); return execution
}
function fixture(name: string, body: string): string { const file = join(directory, name + '.cjs'); writeFileSync(file, body); return file }
function deadlineControl(): () => void {
  const schedule = globalThis.setTimeout
  let fire!: () => void
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: any[]) => void, ms?: number, ...args: any[]) => {
    if (ms === montyLimits.wall_ms) fire = () => callback(...args)
    return schedule(callback, ms, ...args)
  }) as typeof setTimeout)
  return () => fire()
}
it('cancels before dispatch without accepting a late successful result', async () => {
  const runner = fixture('late', `process.on('message',()=>setTimeout(()=>process.stdout.write(JSON.stringify({ok:true,value:{type:'json',value:1},stdout:'',stderr:''}),()=>process.exit(0)),100));`)
  const controller = new AbortController()
  const execution = launch(runner, 'result=1', controller.signal)
  controller.abort()
  await expect(execution.result).rejects.toMatchObject({ code: 'MONTY_CANCELLED' })
})
it('enforces the outer deadline even without a worker PID', async () => {
  const runner = fixture('hung', `process.on('message',()=>{});setInterval(()=>{},1000)`)
  let started!: () => void
  const ready = new Promise<void>(done => { started = done })
  const fireDeadline = deadlineControl()
  const execution = launch(runner, 'result=1', undefined, () => started())
  const checked = expect(execution.result).rejects.toMatchObject({ code: 'MONTY_TIMEOUT' })
  await ready; fireDeadline(); await checked
})
it('retains cancellation as the primary reason when its deadline also fires', async () => {
  const runner = fixture('primary', `process.on('message',()=>{});setInterval(()=>{},1000)`)
  const controller = new AbortController()
  let started!: () => void; const ready = new Promise<void>(done => { started = done })
  const fireDeadline = deadlineControl()
  const execution = launch(runner, 'result=1', controller.signal, () => started())
  const checked = expect(execution.result).rejects.toMatchObject({ code: 'MONTY_CANCELLED' })
  await ready; controller.abort(); fireDeadline(); await checked
})
it('never trusts a reported foreign worker PID as a termination target', async () => {
  const runner = fixture('foreign', `process.on('message',()=>{process.send({worker_pid:${process.pid}});process.stdout.write(JSON.stringify({ok:true,value:{type:'json',value:2},stdout:'',stderr:''}),()=>process.exit(0))})`)
  expect(await launch(runner, 'result=2').result).toMatchObject({ ok: true })
})
it('terminates a still-running backend after its own IPC channel disconnects', async () => {
  const runner = fixture('ipc-lost', `process.on('message',()=>{process.disconnect();setInterval(()=>{},1000)})`)
  await expect(launch(runner, 'result=1').result).rejects.toMatchObject({ code: 'MONTY_PROCESS_FAILED' })
})
it.runIf(hostMontyTarget()?.runtimeVerified === true)('executes native values and enforces print, memory and host-access restrictions', async () => {
  const runner = join(built, 'monty.mjs')
  expect(await launch(runner, 'result = 17 * 14.5 + 0.3').result).toMatchObject({ ok: true, value: { type: 'json', value: 246.8 } })
  for (const code of ['print("x" * 1048577)\nresult=1', 'result="x" * (256 * 1024 * 1024)', 'result=open("/synthetic-not-mounted").read()', 'import socket\nresult=1', 'import time\ntime.sleep(1)\nresult=1']) {
    expect(await launch(runner, code).result).toMatchObject({ ok: false, execution: 'failure' })
  }
}, 30000)
it.runIf(hostMontyTarget()?.runtimeVerified === true)('cancels an actual native calculation and confirms its entire tree', async () => {
  const controller = new AbortController()
  let pid = 0
  const execution = launch(join(built, 'monty.mjs'), 'while True:\n    pass', controller.signal, value => { pid = value })
  const checked = expect(execution.result).rejects.toMatchObject({ code: 'MONTY_CANCELLED' })
  await new Promise(done => setTimeout(done, 300)); controller.abort(); await checked
  expect(pid).toBeGreaterThan(0)
  expect(() => process.kill(pid, 0)).toThrow()
})
it.runIf(hostMontyTarget()?.runtimeVerified === true)('destroys an actual native worker after its runtime owner crashes', async () => {
  const owner = fork(join(built, 'owner.mjs'), [], { execPath: childRuntime, execArgv: [], env: processEnvironment(), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  owner.stderr!.resume()
  try {
    const received = new Promise<{ root: number; value: { worker_pid: number } }>((resolve, reject) => { owner.once('message', value => resolve(value as any)); owner.once('error', reject) })
    owner.send({ mode: 'fork', command: join(built, 'monty.mjs'), args: [], env: processEnvironment(), initial: { input: { code: 'while True:\n    pass', inputs: {} } } })
    const report = await received
    expect(report.value.worker_pid).toBeGreaterThan(0)
    owner.kill('SIGKILL'); await new Promise(done => owner.once('exit', done))
    const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
    await expect.poll(() => [report.root, report.value.worker_pid].some(alive), { timeout: 5000 }).toBe(false)
  } finally { owner.kill('SIGKILL') }
})
