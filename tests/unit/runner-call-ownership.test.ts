import Database from 'better-sqlite3'
import { afterEach, expect, it, vi } from 'vitest'
import coreSchema from '../../src/shared/contracts/001-core.sql?raw'
import type { ExecutionScope, ModelRequest } from '../../src/shared/contracts.generated'
import { ContractError } from '../../src/shared/validation'
import { PluginCalls, type CallSource } from '../../src/runtime/plugins/calls'
import { PluginActions, type PluginActionContext } from '../../src/runtime/plugins/actions'
import type { PluginControl } from '../../src/runtime/plugins/control'
import type { PluginDirectory } from '../../src/runtime/plugins/directory'
import type { PluginExecution, PluginProcesses } from '../../src/runtime/plugins/process'
import { MontyCalls, type MontyCallSource } from '../../src/runtime/monty/calls'
import type { MontyOutput, MontyRunner } from '../../src/runtime/monty/runner'
import type { StorageLifecycle } from '../../src/runtime/storage-lifecycle'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const owner = (attempt = 'attempt'): ExecutionScope => ({ task_id: 'task', run_id: 'run', work_id: 'work-' + attempt, attempt_id: attempt, role: 'producer', purpose: 'production', request_id: 'goal-request', intent_revision: 1 })
const source = (scope = owner()): CallSource => ({ run_id: scope.run_id, owner: scope, chain: [], signal: new AbortController().signal, valid() {}, authorize() {}, async approve() {}, checkApproval() {} })
const denied = () => { throw new ContractError('WORKER_TOOL_DENIED', 'Role cannot use this operation') }

function database() {
  const db = new Database(':memory:')
  db.exec(coreSchema)
  db.prepare("INSERT INTO tasks(id,title,state,revision) VALUES ('task','Work','active',1)").run()
  db.prepare("INSERT INTO runs(id,task_id,state,runtime_epoch,limits_json,budget_json,created_at) VALUES ('run','task','running','epoch','{}','{}','now')").run()
  cleanups.push(() => { db.close() })
  return db
}

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function plugins(db = database()) {
  const capability = { id: 'echo', effect: 'read', errors: [] }
  const directory = { capability: vi.fn(async (_task: string, id: string) => ({ digest: id + '-digest', capability })), validateArguments: vi.fn(async () => {}) }
  const control = { get: vi.fn(() => ({ manifest: { access_level: 'task', version: '1.0.0' } })), available: vi.fn(() => true) }
  const execute = vi.fn(async (_copy: unknown, _task: string, call: PluginExecution) => { call.started?.('instance'); call.valid(); call.dispatch('sent'); return call.settle?.({ value: 'done' }) })
  const records = vi.fn(), references = vi.fn(), commitUploads = vi.fn(() => [])
  const calls = new PluginCalls(db, 'epoch', control as unknown as PluginControl, directory as unknown as PluginDirectory, { execute } as unknown as PluginProcesses, references, records, commitUploads)
  cleanups.push(async () => { calls.close(); await calls.drain() })
  return { db, directory, control, execute, records, references, calls, commitUploads }
}

it('returns durable plugin resource scope without arguments or results and reads older instance chains', async () => {
  const s = plugins()
  let id = ''
  await s.calls.call('task', 'plugin:echo', { private: 'input' }, [], source(), call => { id = call })
  const scope = { call_id: id, task_id: 'task', run_id: 'run', parent_call_id: null, instance_key: 'plugin:echo-digest:task', instance_id: 'instance', owner: owner() }
  expect(s.calls.resourceScope(id)).toEqual(scope)
  const changed = s.calls.resourceScope(id)
  changed.owner!.attempt_id = 'changed'
  expect(s.calls.resourceScope(id)).toEqual(scope)
  const row = s.db.prepare('SELECT limits_json FROM calls WHERE id=?').get(id) as { limits_json: string }
  const limits = JSON.parse(row.limits_json)
  delete limits.instance_key
  s.db.prepare('UPDATE calls SET limits_json=? WHERE id=?').run(JSON.stringify(limits), id)
  expect(s.calls.resourceScope(id)).toEqual(scope)
  expect(s.calls.activeScopes()).toEqual([])
})

it('lists executing and queued plugin calls by their actual resource key', async () => {
  const s = plugins(), release = new Map<string, () => void>(), ids: string[] = []
  let executing = 0
  s.execute.mockImplementation(async (_copy, _task, call) => {
    const queued = call.capability === 'echo' && ++executing === 2
    if (!queued) { call.started?.(call.call_id); call.dispatch('sent') }
    await new Promise<void>((resolve, reject) => {
      release.set(call.call_id, resolve)
      call.signal.addEventListener('abort', () => reject(new ContractError('PLUGIN_CALL_CANCELLED', 'Stopped')), { once: true })
    })
    return call.settle?.({ value: 'done' })
  })
  const pending = [
    s.calls.call('task', 'plugin:echo', {}, [], source(owner('first')), id => { ids[0] = id }),
    s.calls.call('task', 'plugin:echo', {}, [], { ...source(owner('second')), instance_id: 'caller-instance' }, id => { ids[1] = id }),
    s.calls.call('task', 'plugin:other', {}, [], source(owner('third')), id => { ids[2] = id })
  ]
  try {
    await vi.waitFor(() => { expect(release.size).toBe(3) })
    expect(s.calls.activeScopes()).toHaveLength(3)
    expect(s.calls.activeScopes('plugin:echo-digest:task').map(scope => scope.call_id)).toEqual(ids.slice(0, 2))
    expect(s.calls.activeScopes('plugin:other-digest:task').map(scope => scope.call_id)).toEqual([ids[2]])
    expect(s.calls.resourceScope(ids[1]!).instance_id).toBeNull()
    expect(s.calls.busyRun('run')).toBe(true)
    expect(s.calls.busyRun('other-run')).toBe(false)
  } finally {
    for (const finish of release.values()) finish()
    await Promise.all(pending)
  }
  expect(s.calls.activeScopes()).toEqual([])
  expect(s.calls.busyRun('run')).toBe(false)
})

it('denies a plugin capability before reference checks, directory lookup, registration or dispatch', async () => {
  const s = plugins(), origin = { ...source(), authorize: vi.fn(denied) }, registered = vi.fn()
  await expect(s.calls.call('task', 'plugin:echo', {}, [], origin, registered)).rejects.toMatchObject({ code: 'WORKER_TOOL_DENIED' })
  expect(origin.authorize).toHaveBeenCalledWith({ type: 'call', input: { capability: 'plugin:echo', arguments: {}, references: [] } })
  expect(s.references).not.toHaveBeenCalled()
  expect(s.directory.capability).not.toHaveBeenCalled()
  expect(registered).not.toHaveBeenCalled()
  expect(s.execute).not.toHaveBeenCalled()
  expect(s.db.prepare('SELECT count(*) n FROM calls').get()).toEqual({ n: 0 })
})

it('rechecks attempt validity after capability lookup before parsing arguments', async () => {
  const s = plugins()
  let live = true
  const origin = { ...source(), valid() { if (!live) throw new ContractError('ATTEMPT_ENDED', 'Attempt ended') } }
  s.directory.capability.mockImplementationOnce(async () => { live = false; return { digest: 'digest', capability: { id: 'echo', effect: 'read', errors: [] } } })
  await expect(s.calls.call('task', 'plugin:echo', {}, [], origin)).rejects.toMatchObject({ code: 'ATTEMPT_ENDED' })
  expect(s.control.get).not.toHaveBeenCalled()
  expect(s.directory.validateArguments).not.toHaveBeenCalled()
  expect(s.execute).not.toHaveBeenCalled()
})

it('preserves the registered call ID and captured owner through a delayed result', async () => {
  const s = plugins(), scope = owner(), expected = { ...scope }, gate = deferred<unknown>(), ready = deferred<string>(), authorize = vi.fn()
  s.execute.mockImplementationOnce(async (_copy, _task, call) => {
    call.valid(); call.dispatch('sent')
    const output = await gate.promise
    return call.settle?.(output)
  })
  const pending = s.calls.call('task', 'plugin:echo', { value: 1 }, [], { ...source(scope), authorize }, id => ready.resolve(id))
  const id = await ready.promise
  expect(s.records).not.toHaveBeenCalled()
  expect(s.calls.status(id)).toMatchObject({ call_id: id, execution: null, owner: expected })
  scope.attempt_id = 'changed-caller'
  gate.resolve({ value: 'late result' })
  expect(await pending).toMatchObject({ operation_id: id, execution: 'success' })
  const row = s.db.prepare('SELECT limits_json FROM calls WHERE id=?').get(id) as { limits_json: string }
  expect(JSON.parse(row.limits_json).owner).toEqual(expected)
  expect(s.records).toHaveBeenCalledOnce()
  expect(s.records.mock.calls[0]).toEqual(['task', 'plugin.call.ended', expect.objectContaining({ call_id: id, owner: expected, execution: 'success' })])
  expect(authorize.mock.calls.length).toBeGreaterThan(2)
})

it('coalesces duplicate plugin completion callbacks into one durable result', async () => {
  const s = plugins()
  s.execute.mockImplementationOnce(async (_copy, _task, call) => {
    call.dispatch('sent')
    const [first, duplicate] = await Promise.all([call.settle?.({ value: 'original' }), call.settle?.({ value: 'duplicate' })])
    expect(duplicate).toEqual(first)
    return first
  })
  const result = await s.calls.call('task', 'plugin:echo', {}, [], source())
  expect(result).toMatchObject({ execution: 'success', data: { value: 'original' } })
  expect(s.commitUploads).toHaveBeenCalledOnce()
  expect(s.records).toHaveBeenCalledOnce()
})

it('ends a failed registration callback without executing or retaining an active call', async () => {
  const s = plugins()
  const result = await s.calls.call('task', 'plugin:echo', {}, [], source(), () => { throw Error('registration persistence failed') })
  expect(result).toMatchObject({ execution: 'not_executed' })
  expect(s.execute).not.toHaveBeenCalled()
  expect(s.calls.busy('task')).toBe(false)
  expect(s.records).toHaveBeenCalledOnce()
})

it('retains a committed original result when the plugin reports another failure afterward', async () => {
  const s = plugins()
  s.execute.mockImplementationOnce(async (_copy, _task, call) => { call.dispatch('sent'); await call.settle?.({ value: 'original' }); throw Error('late duplicate failure') })
  const result = await s.calls.call('task', 'plugin:echo', {}, [], source())
  expect(result).toMatchObject({ execution: 'success', data: { value: 'original' } })
  expect(s.records).toHaveBeenCalledOnce()
})

it('cancels one attempt without revoking its sibling call in the same Run', async () => {
  const s = plugins(), firstReady = deferred<string>(), secondReady = deferred<string>(), gate = deferred<unknown>(), signals: AbortSignal[] = []
  s.execute.mockImplementation(async (_copy, _task, call) => { signals.push(call.signal); call.dispatch('sent'); await gate.promise; return call.settle?.({ value: 'done' }) })
  const first = s.calls.call('task', 'plugin:first', {}, [], source(owner('first')), id => firstReady.resolve(id))
  const second = s.calls.call('task', 'plugin:second', {}, [], source(owner('second')), id => secondReady.resolve(id))
  const [firstId, secondId] = await Promise.all([firstReady.promise, secondReady.promise])
  s.calls.cancelAttempt('first')
  expect(signals.map(signal => signal.aborted)).toEqual([true, false])
  expect(s.db.prepare('SELECT commit_valid FROM calls WHERE id=?').get(firstId)).toEqual({ commit_valid: 0 })
  expect(s.db.prepare('SELECT commit_valid FROM calls WHERE id=?').get(secondId)).toEqual({ commit_valid: 1 })
  gate.resolve({})
  expect(await first).toMatchObject({ operation_id: firstId, execution: 'cancelled' })
  expect(await second).toMatchObject({ operation_id: secondId, execution: 'success' })
})

it('keeps nested authorization and ownership when the host forwards the parent source', async () => {
  const s = plugins(), ready = deferred<string>(), gate = deferred<unknown>(), origin = source(), authorize = vi.fn((request: ModelRequest) => { if (request.type === 'call' && request.input.capability === 'plugin:denied') denied() })
  origin.authorize = authorize
  s.execute.mockImplementationOnce(async (_copy, _task, call) => { call.dispatch('sent'); await gate.promise; return call.settle?.({ value: 'parent' }) })
  const parent = s.calls.call('task', 'plugin:parent', {}, [], origin, id => ready.resolve(id))
  const parentId = await ready.promise, active = s.calls.source(parentId)!
  const childSource = { ...active.source, parent_call_id: parentId, signal: active.controller.signal }
  await expect(s.calls.call('task', 'plugin:denied', {}, [], childSource)).rejects.toMatchObject({ code: 'WORKER_TOOL_DENIED' })
  const child = await s.calls.call('task', 'plugin:child', {}, [], childSource) as { operation_id: string }
  expect(s.calls.status(child.operation_id)).toMatchObject({ parent_call_id: parentId, owner: owner() })
  expect(s.db.prepare('SELECT count(*) n FROM calls').get()).toEqual({ n: 2 })
  gate.resolve({})
  await parent
})

it('allows more than 200 sequential child calls under the same active parent', async () => {
  const s = plugins(), ready = deferred<string>(), gate = deferred<unknown>()
  s.execute.mockImplementationOnce(async (_copy, _task, call) => { call.dispatch('sent'); await gate.promise; return call.settle?.({ value: 'parent' }) })
  const parent = s.calls.call('task', 'plugin:parent', {}, [], source(), id => ready.resolve(id))
  const parentId = await ready.promise, active = s.calls.source(parentId)!
  const childSource = { ...active.source, parent_call_id: parentId, signal: active.controller.signal }
  try {
    for (let index = 0; index < 201; index++) {
      expect(await s.calls.call('task', 'plugin:child', {}, [], childSource)).toMatchObject({ execution: 'success' })
    }
  } finally { gate.resolve({}); await parent }
  expect(s.execute).toHaveBeenCalledTimes(202)
  expect(s.db.prepare("SELECT count(*) n FROM calls WHERE state='ended' AND execution='success'").get()).toEqual({ n: 202 })
})

const identity = { instance_id: 'instance', digest: 'digest', task_id: 'task', call_id: 'parent-call' }
const mutation = { type: 'resource.create', display_name: 'Result', content: { type: 'text', text: 'Body' } }
function actions(origin?: Pick<CallSource, 'owner' | 'valid' | 'authorize'>) {
  const db = database(), qualify = vi.fn(), changed = vi.fn()
  db.prepare("INSERT INTO calls(id,task_id,run_id,capability_id,state,dispatch,delivery,input_json,limits_json,commit_valid,created_at) VALUES ('parent-call','task','run','plugin:parent','executing','sent','pending','{}','{}',1,'now')").run()
  const execute = vi.fn(async (_task: string, _input: unknown, context: PluginActionContext) => {
    context.valid()
    db.prepare("UPDATE actions SET state='ended',result='success',commit_valid=0 WHERE id=?").run(context.id)
    return { saved: true }
  })
  const resolveSource = vi.fn(() => origin)
  const manager = new PluginActions(db, 'epoch', qualify, execute, changed, resolveSource)
  cleanups.push(() => manager.close())
  return { db, qualify, changed, execute, manager, resolveSource }
}

it('authorizes plugin writes before qualification or action registration', () => {
  const authorize = vi.fn(denied), s = actions({ ...source(), authorize })
  expect(() => s.manager.submit(identity, 'task', mutation)).toThrow(expect.objectContaining({ code: 'WORKER_TOOL_DENIED' }))
  expect(authorize).toHaveBeenCalledWith({ type: 'write', input: mutation })
  expect(s.qualify).not.toHaveBeenCalled()
  expect(s.execute).not.toHaveBeenCalled()
  expect(s.db.prepare('SELECT count(*) n FROM actions').get()).toEqual({ n: 0 })
})

it('inherits a fixed owner and exact write authorization into deferred plugin actions', async () => {
  const scope = owner(), expected = { ...scope }, authorize = vi.fn(), s = actions({ ...source(scope), authorize })
  const registered = s.manager.submit(identity, 'task', mutation) as { action_id: string; status: string }
  expect(registered.status).toBe('registered')
  expect(s.execute).not.toHaveBeenCalled()
  scope.attempt_id = 'changed-caller'
  await vi.waitFor(() => expect(s.changed).toHaveBeenCalledOnce())
  expect(s.execute.mock.calls[0]?.[2].owner).toEqual(expected)
  expect(s.execute.mock.calls[0]?.[2].authorize).toBe(authorize)
  const row = s.db.prepare('SELECT source_json FROM actions WHERE id=?').get(registered.action_id) as { source_json: string }
  expect(JSON.parse(row.source_json).owner).toEqual(expected)
  expect(authorize.mock.calls.every(([request]) => JSON.stringify(request) === JSON.stringify({ type: 'write', input: mutation }))).toBe(true)
  expect(authorize.mock.calls.length).toBeGreaterThan(1)
})

it('revokes deferred actions for an ended attempt before execution', async () => {
  let live = true
  const s = actions({ ...source(), valid() { if (!live) throw new ContractError('ATTEMPT_ENDED', 'Attempt ended') } })
  const registered = s.manager.submit(identity, 'task', mutation) as { action_id: string }
  live = false
  await vi.waitFor(() => expect(s.changed).toHaveBeenCalledOnce())
  expect(s.execute).not.toHaveBeenCalled()
  expect(s.db.prepare('SELECT state,result FROM actions WHERE id=?').get(registered.action_id)).toEqual({ state: 'ended', result: 'not_executed' })
})

it('cancels only the matching action attempt and rejects a missing inherited source', async () => {
  const s = actions(source())
  const registered = s.manager.submit(identity, 'task', mutation) as { action_id: string }
  s.manager.cancelAttempt('other-attempt')
  expect(s.db.prepare('SELECT commit_valid FROM actions WHERE id=?').get(registered.action_id)).toEqual({ commit_valid: 1 })
  s.manager.cancelAttempt('attempt')
  await vi.waitFor(() => expect(s.changed).toHaveBeenCalledOnce())
  expect(s.execute).not.toHaveBeenCalled()
  const missing = actions()
  expect(() => missing.manager.submit(identity, 'task', mutation)).toThrow(expect.objectContaining({ code: 'PLUGIN_SOURCE_INVALID' }))
  expect(missing.qualify).not.toHaveBeenCalled()
})

it('checks the entire action owner before reading a result from a shared plugin instance', async () => {
  const s = actions(source()), registered = s.manager.submit(identity, 'task', mutation) as { action_id: string }
  await vi.waitFor(() => expect(s.changed).toHaveBeenCalledOnce())
  const prepare = vi.spyOn(s.db, 'prepare')
  s.resolveSource.mockReturnValue({ ...source(), owner: { ...owner(), role: 'lightweight' } })
  expect(() => s.manager.get(identity, registered.action_id)).toThrow(expect.objectContaining({ code: 'PLUGIN_ACTION_UNAVAILABLE' }))
  expect(prepare.mock.calls.every(([sql]) => !sql.includes('result_json'))).toBe(true)
  s.resolveSource.mockReturnValue(source({ ...owner(), task_id: 'other-task' }))
  expect(() => s.manager.get(identity, registered.action_id)).toThrow(expect.objectContaining({ code: 'PLUGIN_ACTION_UNAVAILABLE' }))
  const same: ExecutionScope = { role: 'producer', purpose: 'production', request_id: 'goal-request', intent_revision: 1, attempt_id: 'attempt', work_id: 'work-attempt', run_id: 'run', task_id: 'task' }
  s.resolveSource.mockReturnValue(source(same))
  expect(s.manager.get(identity, registered.action_id)).toMatchObject({ action_id: registered.action_id, state: 'ended', result: 'success' })
})

it('restricts owned actions to their original parent when the current source is absent', async () => {
  const s = actions(source()), registered = s.manager.submit(identity, 'task', mutation) as { action_id: string }
  await vi.waitFor(() => expect(s.changed).toHaveBeenCalledOnce())
  s.resolveSource.mockReturnValue(undefined)
  expect(s.manager.get(identity, registered.action_id)).toMatchObject({ action_id: registered.action_id })
  expect(() => s.manager.get({ ...identity, call_id: null }, registered.action_id)).toThrow(expect.objectContaining({ code: 'PLUGIN_ACTION_UNAVAILABLE' }))
  expect(() => s.manager.get({ ...identity, call_id: 'another-parent' }, registered.action_id)).toThrow(expect.objectContaining({ code: 'PLUGIN_ACTION_UNAVAILABLE' }))
})

it('preserves independent plugin action lookup for legacy actions without an owner', async () => {
  const s = actions(), independent = { ...identity, call_id: null }
  const registered = s.manager.submit(independent, 'task', mutation) as { action_id: string }
  await vi.waitFor(() => expect(s.changed).toHaveBeenCalledOnce())
  expect(s.manager.get(independent, registered.action_id)).toMatchObject({ action_id: registered.action_id, state: 'ended', result: 'success' })
})

const montyOutput: MontyOutput = { ok: true, value: { type: 'json', value: 17 }, stdout: '', stderr: '' }
function monty(custom?: MontyRunner) {
  const db = database(), records = vi.fn(() => 'record'), references = vi.fn(), validRun = vi.fn()
  const storage = { publish: vi.fn(), commit: vi.fn(), failed: vi.fn() }
  const runner = vi.fn<MontyRunner>(custom ?? ((_assets, _input, _signal, _runtime, started) => { started(123); return { result: Promise.resolve(montyOutput), async stop() {} } }))
  const manager = new MontyCalls(db, '/unused', storage as unknown as StorageLifecycle, validRun, references, records, process.execPath, true, runner, () => ({ binary: 'binary', native: 'native', binary_sha256: 'synthetic', runner: 'runner' }))
  cleanups.push(() => manager.shutdown())
  const call = (origin?: MontyCallSource) => manager.call('task', 'run', { code: 'result = 17', inputs: {} }, [], new AbortController().signal, origin) as Promise<Record<string, any>>
  return { db, records, references, validRun, storage, runner, manager, call }
}

it('keeps only the calculation Run busy until uncertain process cleanup is confirmed', async () => {
  const result = deferred<MontyOutput>()
  const stop = vi.fn<() => Promise<void>>(async () => { throw new ContractError('MONTY_CLEANUP_UNCONFIRMED', 'Process still exists') })
  const s = monty((_assets, _input, _signal, _runtime, started) => { started(123); return { result: result.promise, stop } })
  const call = s.call({ owner: owner(), valid() {} })
  expect(s.manager.busyRun('run')).toBe(true)
  expect(s.manager.busyRun('other-run')).toBe(false)
  result.reject(new ContractError('MONTY_CLEANUP_UNCONFIRMED', 'Process still exists'))
  await expect(call).resolves.toMatchObject({ execution: 'unknown', error: { code: 'MONTY_CLEANUP_UNCONFIRMED' } })
  expect(s.manager.busyRun('run')).toBe(true)
  await expect(s.manager.shutdown()).rejects.toMatchObject({ code: 'MONTY_CLEANUP_UNCONFIRMED' })
  expect(s.manager.busyRun('run')).toBe(true)
  stop.mockImplementation(async () => {})
  await s.manager.shutdown()
  expect(s.manager.busyRun('run')).toBe(false)
})

it('authorizes native calculations before reference reads or registration', async () => {
  const s = monty()
  await expect(s.call({ ...source(), authorize: denied })).rejects.toMatchObject({ code: 'WORKER_TOOL_DENIED' })
  expect(s.references).not.toHaveBeenCalled()
  expect(s.runner).not.toHaveBeenCalled()
  expect(s.records).not.toHaveBeenCalled()
  expect(s.db.prepare('SELECT count(*) n FROM calls').get()).toEqual({ n: 0 })
})

it('rejects conflicting task or Run ownership at each call and action boundary', async () => {
  const plugin = plugins()
  await expect(plugin.calls.call('task', 'plugin:echo', {}, [], { ...source(), owner: { ...owner(), run_id: 'other-run' } })).rejects.toMatchObject({ code: 'RUNNER_OWNERSHIP_INVALID' })
  expect(plugin.references).not.toHaveBeenCalled()
  const calculation = monty()
  await expect(calculation.call(source({ ...owner(), run_id: 'other-run' }))).rejects.toMatchObject({ code: 'RUNNER_OWNERSHIP_INVALID' })
  expect(calculation.runner).not.toHaveBeenCalled()
  const action = actions(source({ ...owner(), task_id: 'other-task' }))
  expect(() => action.manager.submit(identity, 'task', mutation)).toThrow(expect.objectContaining({ code: 'RUNNER_OWNERSHIP_INVALID' }))
  expect(action.qualify).not.toHaveBeenCalled()
})

it('preserves native call ownership and rechecks both attempt and Run around execution', async () => {
  const scope = owner(), expected = { ...scope }, gate = deferred<MontyOutput>(), authorize = vi.fn()
  const s = monty((_assets, _input, _signal, _runtime, started) => { started(123); return { result: gate.promise, async stop() {} } })
  const pending = s.call({ ...source(scope), authorize })
  const row = s.db.prepare('SELECT id,limits_json FROM calls').get() as { id: string; limits_json: string }
  scope.attempt_id = 'changed-caller'
  expect(s.records).toHaveBeenCalledOnce()
  expect(s.records.mock.calls[0]).toEqual(['task', 'monty.call.registered', expect.objectContaining({ call_id: row.id, owner: expected })])
  gate.resolve(montyOutput)
  expect(await pending).toMatchObject({ operation_id: row.id, execution: 'success' })
  expect(JSON.parse(row.limits_json).owner).toEqual(expected)
  expect(s.records.mock.calls[1]).toEqual(['task', 'monty.call.ended', expect.objectContaining({ call_id: row.id, owner: expected })])
  expect(authorize.mock.calls.length).toBeGreaterThan(2)
  expect(s.validRun.mock.calls.length).toBeGreaterThan(2)
})

it('revokes a native attempt before accepting late output and retains the original call', async () => {
  const scope = owner(), gate = deferred<MontyOutput>()
  let signal!: AbortSignal
  const s = monty((_assets, _input, cancellation, _runtime, started) => { signal = cancellation; started(123); return { result: gate.promise, async stop() {} } })
  const pending = s.call(source(scope))
  scope.attempt_id = 'changed-caller'
  s.manager.cancelAttempt('other-attempt')
  expect(signal.aborted).toBe(false)
  s.manager.cancelAttempt('attempt')
  expect(signal.aborted).toBe(true)
  expect(s.db.prepare('SELECT commit_valid FROM calls').get()).toEqual({ commit_valid: 0 })
  gate.resolve(montyOutput)
  expect(await pending).toMatchObject({ execution: 'cancelled' })
  expect(s.storage.publish).not.toHaveBeenCalled()
  expect(s.db.prepare('SELECT count(*) n FROM calls').get()).toEqual({ n: 1 })
  expect(s.records.mock.calls.at(-1)).toEqual(['task', 'monty.call.ended', expect.objectContaining({ owner: owner(), execution: 'cancelled' })])
})

it('rejects a stale attempt while the Run remains live and preserves an already terminal native result', async () => {
  let live = true
  const gate = deferred<MontyOutput>(), s = monty((_assets, _input, _signal, _runtime, started) => { started(123); return { result: gate.promise, async stop() {} } })
  const pending = s.call({ ...source(), valid() { if (!live) throw new ContractError('ATTEMPT_ENDED', 'Attempt ended') } })
  live = false
  gate.resolve(montyOutput)
  expect(await pending).toMatchObject({ error: { code: 'ATTEMPT_ENDED' } })
  expect(s.storage.publish).not.toHaveBeenCalled()

  const later = deferred<MontyOutput>(), original = { operation_id: 'original', execution: 'cancelled', delivery: 'delivered' }
  const other = monty((_assets, _input, _signal, _runtime, started) => { started(123); return { result: later.promise, async stop() {} } })
  const duplicate = other.call(source())
  other.db.prepare("UPDATE calls SET state='ended',commit_valid=0,result_json=?").run(JSON.stringify(original))
  later.resolve(montyOutput)
  expect(await duplicate).toEqual(original)
  expect(other.records).toHaveBeenCalledOnce()
})
