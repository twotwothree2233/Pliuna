import Database from 'better-sqlite3'
import { afterEach, expect, it, vi } from 'vitest'
import coreSchema from '../../src/shared/contracts/001-core.sql?raw'
import runnerSchema from '../../src/shared/contracts/002-runner.sql?raw'
import type { ExecutionScope } from '../../src/shared/contracts.generated'
import { ContractError } from '../../src/shared/validation'
import { PluginCalls } from '../../src/runtime/plugins/calls'
import type { PluginExecution, PluginIdentity } from '../../src/runtime/plugins/process'
import { RunnerBudgetLedger } from '../../src/runtime/runner/budget'
import { createWorkerProfile } from '../../src/runtime/runner/worker-profile'
import { RuntimeStore } from '../../src/runtime/store'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
type HostBoundary = {
  workerTool(attempt: string, request: unknown, signal: AbortSignal): Promise<unknown>
  pluginToolCallback(identity: PluginIdentity, method: string, params: Record<string, unknown>): unknown
}

function setup(limit: number, options: { children?: number; denied?: boolean; unknown?: boolean } = {}) {
  const db = new Database(':memory:')
  db.exec(coreSchema); db.exec(runnerSchema)
  db.prepare("INSERT INTO tasks(id,title,state,revision) VALUES ('task','Work','active',1)").run()
  db.prepare("INSERT INTO requests VALUES ('request','task','started','{}','{}','now')").run()
  db.prepare("INSERT INTO runs(id,task_id,request_id,state,runtime_epoch,limits_json,budget_json,created_at) VALUES ('run','task','request','running','epoch','{}','{}','now')").run()
  const ledger = new RunnerBudgetLedger(db)
  ledger.create({ budget_id: 'budget', task_id: 'task', purpose: 'production', request_id: 'request' })
  db.prepare("UPDATE runner_budgets SET limits_json=? WHERE budget_id='budget'").run(JSON.stringify({ model_requests: 5, tool_requests: limit, tokens: 10000, wall_ms: 60000 }))
  const run = { run_id: 'run', task_id: 'task', runtime_epoch: 'epoch', state: 'running', commit_valid: true, budget_id: 'budget', purpose: 'production', request_id: 'request', intent_revision: 1 }
  const work = { work_id: 'work', task_id: 'task', run_id: 'run', plan_revision: 1, role: 'producer', required: true, requirement_ids: [], dependencies: [], state: 'running', max_attempts: 1, current_attempt_id: 'attempt', purpose: 'production', request_id: 'request', intent_revision: 1 }
  db.prepare("INSERT INTO runner_runs VALUES ('run','task','production','request',1,NULL,NULL,'budget',?)").run(JSON.stringify(run))
  db.prepare("INSERT INTO runner_work VALUES ('work','task','run',1,'running',?)").run(JSON.stringify(work))
  db.prepare("INSERT INTO runner_attempts VALUES ('attempt','task','work','run',1,'running','{}')").run()
  const owner: ExecutionScope = { task_id: 'task', run_id: 'run', work_id: 'work', attempt_id: 'attempt', role: 'producer', purpose: 'production', request_id: 'request', intent_revision: 1 }
  const profile = createWorkerProfile({ id: 'producer', role: 'producer', system: 'Work', grants: [{ type: 'call', capability: 'plugin:parent' }, { type: 'call', capability: 'plugin:child' }], parseResult: value => value })
  const host: HostBoundary = Object.assign(Object.create(RuntimeStore.prototype), {
    db, epoch: 'epoch', closed: false,
    workers: new Map([['attempt', { owner, profile, state: 'running', controller: new AbortController() }]]),
    qualifyWorker: () => ({ task_id: 'task', run }), qualify: () => {}, qualifyPlugin: () => {},
    record: () => 'record', pluginChildOwners: new Map(), pluginInvocationSources: new Map(),
    pluginProcesses: { changed() {}, live: () => true },
    awaitApproval: async () => { throw new ContractError('ACTION_REJECTED', 'Declined') },
    checkApproval: () => {}
  })
  const directory = {
    capability: async (_task: string, capability: string) => ({ digest: capability, capability: { id: capability, effect: options.denied && capability === 'plugin:child' ? 'write' : 'read', errors: [] } }),
    validateArguments: async () => {}
  }
  const control = { get: () => ({ manifest: { access_level: 'task', version: '1.0.0' } }), available: () => true }
  const children: string[] = [], rejected: unknown[] = []
  let calls: PluginCalls
  const execute = vi.fn(async (_copy: unknown, _task: string, call: PluginExecution) => {
    call.started?.(call.capability + '-instance'); call.valid()
    call.dispatch(options.unknown && call.capability === 'plugin:child' ? 'unknown' : 'sent')
    if (call.capability === 'plugin:child' && options.unknown) throw new Error('Connection lost')
    if (call.capability === 'plugin:parent') {
      const results = await Promise.allSettled(Array.from({ length: options.children ?? 1 }, () => host.pluginToolCallback(
        { instance_id: 'plugin:parent-instance', digest: 'plugin:parent', task_id: 'task', call_id: call.call_id },
        'tools.call', { task_id: 'task', capability: 'plugin:child', arguments: {}, references: [] }
      )))
      for (const result of results) {
        if (result.status === 'rejected') rejected.push(result.reason)
        else children.push((result.value as { call_id: string }).call_id)
      }
      await vi.waitFor(() => {
        for (const child of children) expect(ledger.query(child).state).not.toBe('reserved')
      })
    }
    return call.settle?.({ value: 'done' })
  })
  calls = new PluginCalls(db, 'epoch', control as any, directory as any, { execute } as any, () => {}, () => {})
  Object.assign(host, { pluginCalls: calls })
  cleanups.push(async () => { calls.close(); await calls.drain(); db.close() })
  const invoke = () => host.workerTool('attempt', { type: 'call', input: { capability: 'plugin:parent', arguments: {}, references: [] } }, new AbortController().signal)
  return { db, ledger, invoke, calls, execute, children, rejected }
}

it('dispatches a nested call after its parent consumed the legacy tool allowance', async () => {
  const s = setup(1)
  expect(await s.invoke()).toMatchObject({ execution: 'success' })
  expect(s.rejected).toEqual([])
  expect(s.children).toHaveLength(1)
  expect(s.execute).toHaveBeenCalledTimes(2)
  expect(s.db.prepare('SELECT count(*) count FROM calls').get()).toEqual({ count: 2 })
  expect(s.ledger.snapshot('budget')).toMatchObject({ total: { tool_requests: 2 }, reserved: { tool_requests: 0 }, unknown: { tool_requests: 0 } })
})

it('charges an allowed child once under its original call and attempt identities', async () => {
  const s = setup(2)
  expect(await s.invoke()).toMatchObject({ execution: 'success' })
  expect(s.rejected).toEqual([])
  expect(s.execute).toHaveBeenCalledTimes(2)
  expect(s.children).toHaveLength(1)
  expect(s.ledger.query(s.children[0]!)).toMatchObject({ operation_id: s.children[0], attempt_id: 'attempt', budget_id: 'budget', state: 'settled', usage: { tool_requests: 1 } })
  expect(s.ledger.snapshot('budget').total.tool_requests).toBe(2)
})

it('accounts for concurrent child requests beyond the legacy shared tool cap', async () => {
  const s = setup(2, { children: 2 })
  expect(await s.invoke()).toMatchObject({ execution: 'success' })
  expect(s.children).toHaveLength(2)
  expect(new Set(s.children).size).toBe(2)
  expect(s.rejected).toEqual([])
  expect(s.execute).toHaveBeenCalledTimes(3)
  expect(s.ledger.snapshot('budget').total.tool_requests).toBe(3)
})

it('releases a child reservation when approval rejects it before execution', async () => {
  const s = setup(2, { denied: true })
  expect(await s.invoke()).toMatchObject({ execution: 'success' })
  expect(s.children).toHaveLength(1)
  expect(s.calls.status(s.children[0]!)).toMatchObject({ execution: 'not_executed', dispatch: 'not_sent' })
  expect(s.ledger.query(s.children[0]!)).toMatchObject({ state: 'released', dispatched_at: null })
  expect(s.execute).toHaveBeenCalledTimes(1)
  expect(s.ledger.snapshot('budget').total.tool_requests).toBe(1)
})

it('retains unknown child usage under the same operation and attempt identities', async () => {
  const s = setup(2, { unknown: true })
  expect(await s.invoke()).toMatchObject({ execution: 'success' })
  expect(s.children).toHaveLength(1)
  expect(s.calls.status(s.children[0]!)).toMatchObject({ execution: 'unknown' })
  expect(s.ledger.query(s.children[0]!)).toMatchObject({ operation_id: s.children[0], state: 'unknown', attempt_id: 'attempt' })
  expect(s.ledger.snapshot('budget')).toMatchObject({ total: { tool_requests: 2 }, unknown: { tool_requests: 1 } })
})
