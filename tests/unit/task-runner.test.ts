import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import type { ExecutionScope, ContentPlan, InputEvent, LogicalWork } from '../../src/shared/contracts.generated'
import { RunnerBudgetLedger } from '../../src/runtime/runner/budget'
import { RUNNER_LIMITS } from '../../src/runtime/runner/limits'
import { TaskRunner, type TaskRunnerEffect, type TaskRunnerHost, type TaskRunnerReference, type TaskRunnerRoute, type TaskRunnerStatusPage } from '../../src/runtime/runner/task-runner'
import { RunnerWorkState } from '../../src/runtime/runner/work-state'

const coreSql = readFileSync(new URL('../../src/shared/contracts/001-core.sql', import.meta.url), 'utf8')
const runnerSql = readFileSync(new URL('../../src/shared/contracts/002-runner.sql', import.meta.url), 'utf8')
const databases: Database.Database[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })

function setup() {
  const db = new Database(':memory:'); databases.push(db)
  db.exec(coreSql); db.exec(runnerSql)
  db.prepare("INSERT INTO tasks(id,title,state,revision) VALUES ('task','Task','active',1),('other-task','Other','active',1)").run()
  let sequence = 0
  const record = (kind: string, text: string) => {
    const id = `record-${++sequence}`
    db.prepare("INSERT INTO records(id,task_id,sequence,kind,payload_json,created_at) VALUES (?,'task',?,?,?,'time')").run(id, sequence, kind, JSON.stringify({ text }))
    db.prepare("UPDATE tasks SET next_sequence=? WHERE id='task'").run(sequence + 1)
    return id
  }
  const original = (id: string) => JSON.parse((db.prepare('SELECT payload_json FROM records WHERE id=?').get(id) as { payload_json: string }).payload_json)
  const state = new RunnerWorkState(db, 'epoch', () => 1000)
  const goal = vi.fn((input: InputEvent, current: ContentPlan | null): ContentPlan => ({ task_id: input.task_id, request_id: input.request_id!, intent_revision: (current?.intent_revision ?? 0) + 1, input_event_id: input.input_event_id, state: input.kind === 'withdraw_goal' ? 'withdrawn' : 'active', requirements: current?.requirements ?? [{ requirement_id: 'answer', kind: 'answer', required: true, provenance_required: false }], ...(current ? { previous_revision: current.intent_revision } : {}) }))
  const install = vi.fn((input: InputEvent, _route: TaskRunnerRoute, _goal?: ContentPlan): TaskRunnerEffect => {
    expect(db.inTransaction).toBe(true)
    record('runner.test.installed', input.input_event_id)
    return { refs: [{ task_id: input.task_id, kind: 'record', id: input.record_id }], waits: [] }
  })
  const operationOwner = vi.fn((_input: InputEvent): { operation_id: string; owner: ExecutionScope } | null => null)
  const status = vi.fn((query: { task_id: string }): TaskRunnerStatusPage => ({ task_id: query.task_id, items: [], next_cursor: null }))
  const host: TaskRunnerHost = { goal, install, operationOwner, status }, runner = new TaskRunner(state, host)
  const request = (id: string) => db.prepare("INSERT INTO requests(id,task_id,state,config_selection_json,input_json,created_at) VALUES (?,'task','started',?,?,'time')").run(id, JSON.stringify({ model_id: `model-${id}` }), JSON.stringify({ text: `ORIGINAL REQUEST ${id}`, attachments: ['material'] }))
  const input = (kind: InputEvent['kind'], changes: Partial<InputEvent> = {}): InputEvent => {
    const record_id = record(kind === 'operation_completed' ? 'operation.completed' : 'message.user', `ORIGINAL INPUT ${kind} ${sequence}`)
    return { input_event_id: `input-${sequence}`, task_id: 'task', kind, record_id, stage: 'received', ...changes }
  }
  const addGoal = (id: string) => { request(id); const value = input('request', { request_id: id }); runner.receive(value); runner.advance(value.input_event_id); return state.goal(id) }
  const operation = () => {
    addGoal('goal')
    new RunnerBudgetLedger(db, () => 1000).create({ budget_id: 'budget', task_id: 'task', purpose: 'production', request_id: 'goal', limits: { model_requests: 10, tool_requests: 10, tokens: 10000, wall_ms: 60000 } })
    db.prepare("INSERT INTO runs(id,task_id,request_id,state,runtime_epoch,limits_json,budget_json,created_at) VALUES ('run','task','goal','running','epoch','{}','{}','time')").run()
    state.registerRun({ run_id: 'run', task_id: 'task', purpose: 'production', request_id: 'goal', intent_revision: 1, runtime_epoch: 'epoch', state: 'running', commit_valid: true, budget_id: 'budget' })
    const work: LogicalWork = { work_id: 'work', task_id: 'task', run_id: 'run', purpose: 'production', request_id: 'goal', intent_revision: 1, plan_revision: 1, role: 'producer', required: true, requirement_ids: ['answer'], dependencies: [{ kind: 'goal', task_id: 'task', request_id: 'goal', intent_revision: 1 }], state: 'planned', max_attempts: 1 }
    state.installPlan([work])
    state.createAttempt({ attempt_id: 'attempt', task_id: 'task', run_id: 'run', work_id: 'work', purpose: 'production', request_id: 'goal', intent_revision: 1, runtime_epoch: 'epoch', attempt_number: 1, profile_id: 'producer', model_config_id: 'model', model_config_revision: 1, input_versions: work.dependencies, state: 'registered', dispatch_state: 'not_dispatched', usage_refs: [] })
    state.updateAttempt({ ...state.attempt('attempt'), state: 'dispatched', dispatch_state: 'dispatched', operation_id: 'worker-operation' })
    const owner: ExecutionScope = { task_id: 'task', run_id: 'run', work_id: 'work', attempt_id: 'attempt', purpose: 'production', request_id: 'goal', intent_revision: 1, role: 'producer' }
    operationOwner.mockReturnValue({ operation_id: 'external-operation', owner })
    goal.mockClear(); install.mockClear()
    return owner
  }
  return { db, state, host, runner, goal, install, operationOwner, status, record, original, request, input, addGoal, operation }
}

it('receives original references and atomically installs a goal and its host effect once, including after reconstruction', () => {
  const s = setup(); s.request('goal')
  const input = s.input('request', { request_id: 'goal', route: 'semantic' }), original = s.original(input.record_id)
  expect(s.runner.receive(input)).toEqual(input)
  expect(s.state.input(input.input_event_id).stage).toBe('received')
  const result = s.runner.advance(input.input_event_id)
  expect(result).toMatchObject({ version: 1, state: 'installed', route: { route: 'direct', kind: 'request', request_id: 'goal' }, goal: { request_id: 'goal', intent_revision: 1, state: 'active' } })
  expect(s.state.input(input.input_event_id).stage).toBe('installed')
  expect(s.state.consumption(input.input_event_id, 'installed')!.result).toEqual(result)
  expect(new TaskRunner(new RunnerWorkState(s.db, 'epoch'), s.host).advance(input.input_event_id)).toEqual(result)
  expect(s.runner.receive(input)).toEqual({ ...input, stage: 'installed' })
  expect(s.goal).toHaveBeenCalledTimes(1)
  expect(s.install).toHaveBeenCalledTimes(1)
  expect(s.original(input.record_id)).toEqual(original)
  const request = s.db.prepare("SELECT input_json,config_selection_json FROM requests WHERE id='goal'").get() as { input_json: string; config_selection_json: string }
  expect(JSON.parse(request.input_json)).toEqual({ text: 'ORIGINAL REQUEST goal', attachments: ['material'] })
  expect(JSON.parse(request.config_selection_json)).toEqual({ model_id: 'model-goal' })
})

it('rolls goal, host mutation and installed acknowledgement back together, then retries the durable route', () => {
  const s = setup(); s.request('goal')
  const input = s.input('request', { request_id: 'goal' }); s.runner.receive(input)
  s.install.mockImplementationOnce(value => { s.db.prepare("UPDATE requests SET state='cancelled' WHERE id='goal'").run(); throw new Error(`installation fault ${value.input_event_id}`) })
  expect(() => s.runner.advance(input.input_event_id)).toThrow('installation fault')
  expect(s.state.input(input.input_event_id).stage).toBe('routed')
  expect(s.state.consumption(input.input_event_id, 'installed')).toBeNull()
  expect(() => s.state.goal('goal')).toThrow(expect.objectContaining({ code: 'RUNNER_NOT_FOUND' }))
  expect(s.db.prepare("SELECT state FROM requests WHERE id='goal'").get()).toEqual({ state: 'started' })
  expect(s.runner.advance(input.input_event_id).goal?.intent_revision).toBe(1)
  expect(s.state.input(input.input_event_id).stage).toBe('installed')
})

it('rolls successful business installation back when persistence of its acknowledgement fails', () => {
  const s = setup(); s.request('goal')
  const input = s.input('request', { request_id: 'goal' }); s.runner.receive(input)
  s.install.mockImplementation(value => {
    s.db.prepare("UPDATE requests SET state='cancelled' WHERE id='goal'").run()
    return { refs: [{ task_id: 'task', kind: 'record', id: value.record_id }], waits: [] }
  })
  s.db.exec("CREATE TRIGGER fail_ack BEFORE INSERT ON runner_consumptions WHEN NEW.stage='installed' BEGIN SELECT RAISE(ABORT,'acknowledgement fault'); END")
  expect(() => s.runner.advance(input.input_event_id)).toThrow('acknowledgement fault')
  expect(s.state.consumption(input.input_event_id, 'routed')).not.toBeNull()
  expect(s.state.consumption(input.input_event_id, 'installed')).toBeNull()
  expect(() => s.state.goal('goal')).toThrow(expect.objectContaining({ code: 'RUNNER_NOT_FOUND' }))
  expect(s.db.prepare("SELECT state FROM requests WHERE id='goal'").get()).toEqual({ state: 'started' })
  s.db.exec('DROP TRIGGER fail_ack')
  const installed = s.runner.advance(input.input_event_id)
  expect(s.state.goal('goal').intent_revision).toBe(1)
  expect(s.db.prepare("SELECT state FROM requests WHERE id='goal'").get()).toEqual({ state: 'cancelled' })
  expect(s.runner.advance(input.input_event_id)).toEqual(installed)
  expect(s.install).toHaveBeenCalledTimes(2)
})

it('corrects only the named goal and withdraws it through its exact predecessor', () => {
  const s = setup(), first = s.addGoal('alpha'), sibling = s.addGoal('beta')
  const correction = s.input('correction', { request_id: 'alpha' }); s.runner.receive(correction)
  const corrected = s.runner.advance(correction.input_event_id)
  expect(corrected.goal).toEqual({ request_id: 'alpha', intent_revision: 2, state: 'active' })
  expect(s.state.goal('alpha')).toMatchObject({ previous_revision: 1, input_event_id: correction.input_event_id })
  expect(s.state.goal('alpha', 1)).toEqual(first)
  expect(s.state.goal('beta')).toEqual(sibling)
  const withdrawal = s.input('withdraw_goal', { request_id: 'alpha' }); s.runner.receive(withdrawal)
  expect(s.runner.advance(withdrawal.input_event_id).goal).toEqual({ request_id: 'alpha', intent_revision: 3, state: 'withdrawn' })
  expect(s.state.goal('alpha').requirements).toEqual(first.requirements)
  expect(s.state.goal('beta')).toEqual(sibling)
})

it.each(['query', 'explanation'] as const)('%s reads and replies without increasing any goal revision', kind => {
  const s = setup(), alpha = s.addGoal('alpha'), beta = s.addGoal('beta'); s.goal.mockClear(); s.install.mockClear()
  for (const changes of [{ request_id: 'alpha' }, {}]) {
    const input = s.input(kind, changes); s.runner.receive(input)
    expect(s.runner.advance(input.input_event_id)).toMatchObject({ state: 'installed', route: { route: 'direct', kind, ...changes } })
  }
  expect(s.goal).not.toHaveBeenCalled()
  expect(s.install).toHaveBeenCalledTimes(2)
  expect(s.state.goal('alpha')).toEqual(alpha)
  expect(s.state.goal('beta')).toEqual(beta)
})

it.each(['request', 'correction', 'withdraw_goal'] as const)('persists an unassigned %s as clarification and never broadcasts it', kind => {
  const s = setup(), alpha = s.addGoal('alpha'), beta = s.addGoal('beta'); s.goal.mockClear(); s.install.mockClear()
  const input = s.input(kind); s.runner.receive(input)
  const result = s.runner.advance(input.input_event_id)
  expect(result).toMatchObject({ state: 'clarification', route: { route: 'clarification', kind: 'clarification', input_kind: kind, reason: 'goal_target_required' }, refs: [{ task_id: 'task', kind: 'record', id: input.record_id }], waits: [{ reason: 'goal_target_required' }] })
  expect(s.state.consumption(input.input_event_id, 'routed')!.result).toEqual(result.route)
  expect(s.state.consumption(input.input_event_id, 'installed')!.result).toEqual(result)
  expect(s.runner.advance(input.input_event_id)).toEqual(result)
  expect(s.goal).not.toHaveBeenCalled(); expect(s.install).not.toHaveBeenCalled()
  expect(s.state.goal('alpha')).toEqual(alpha); expect(s.state.goal('beta')).toEqual(beta)
})

it('accepts clarified targeting as a new causal input while retaining the ambiguous original', () => {
  const s = setup(); s.addGoal('alpha'); const beta = s.addGoal('beta')
  const ambiguous = s.input('correction'); s.runner.receive(ambiguous)
  const original = s.original(ambiguous.record_id), clarification = s.runner.advance(ambiguous.input_event_id)
  const targeted = s.input('correction', { request_id: 'alpha', caused_by_event_id: ambiguous.input_event_id }); s.runner.receive(targeted)
  expect(s.runner.advance(targeted.input_event_id).goal).toMatchObject({ request_id: 'alpha', intent_revision: 2 })
  expect(s.runner.advance(ambiguous.input_event_id)).toEqual(clarification)
  expect(s.original(ambiguous.record_id)).toEqual(original)
  expect(s.state.goal('beta')).toEqual(beta)
})

it('rejects a stale goal proposal using CAS and does not consume or install its business result', () => {
  const s = setup(), first = s.addGoal('goal'), input = s.input('correction', { request_id: 'goal' }); s.runner.receive(input)
  s.goal.mockReturnValueOnce({ ...first, intent_revision: 3, previous_revision: 2, input_event_id: input.input_event_id })
  s.install.mockClear()
  expect(() => s.runner.advance(input.input_event_id)).toThrow(expect.objectContaining({ code: 'RUNNER_GOAL_CONFLICT' }))
  expect(s.state.goal('goal')).toEqual(first)
  expect(s.install).not.toHaveBeenCalled()
  expect(s.state.consumption(input.input_event_id, 'installed')).toBeNull()
})

it('rejects a goal adapter that targets a sibling request before business installation', () => {
  const s = setup(), alpha = s.addGoal('alpha'), beta = s.addGoal('beta'), input = s.input('correction', { request_id: 'alpha' }); s.runner.receive(input)
  s.goal.mockReturnValueOnce({ ...beta, intent_revision: 2, previous_revision: 1, input_event_id: input.input_event_id }); s.install.mockClear()
  expect(() => s.runner.advance(input.input_event_id)).toThrow(expect.objectContaining({ code: 'RUNNER_OWNERSHIP_INVALID' }))
  expect(s.state.goal('alpha')).toEqual(alpha); expect(s.state.goal('beta')).toEqual(beta)
  expect(s.install).not.toHaveBeenCalled()
})

it.each(['operation_completed', 'approval_decided'] as const)('routes known %s to the original attempt without requesting a goal proposal', kind => {
  const s = setup(), owner = s.operation()
  const input = s.input(kind, { operation_id: 'external-operation', work_id: 'work', run_id: 'run', request_id: 'goal' }); s.runner.receive(input)
  const result = s.runner.advance(input.input_event_id)
  expect(result.route).toEqual({ route: 'direct', kind, operation_id: 'external-operation', owner })
  expect(s.install.mock.calls[0]![1]).toEqual(result.route)
  expect(s.goal).not.toHaveBeenCalled()
  expect(s.operationOwner).toHaveBeenCalledTimes(1)
  expect(new TaskRunner(s.state, s.host).advance(input.input_event_id)).toEqual(result)
  expect(s.operationOwner).toHaveBeenCalledTimes(1)
  expect(s.install).toHaveBeenCalledTimes(1)
})

it('keeps late operation facts on the original cancelled attempt without recovering commit authority', () => {
  const s = setup(), owner = s.operation()
  s.state.updateAttempt({ ...s.state.attempt('attempt'), state: 'cancelled' })
  s.state.closeRun('run')
  const input = s.input('operation_completed', { operation_id: 'external-operation' }); s.runner.receive(input)
  expect(s.runner.advance(input.input_event_id).route).toEqual({ route: 'direct', kind: 'operation_completed', operation_id: 'external-operation', owner })
  expect(s.state.attempt('attempt').state).toBe('cancelled')
  expect(s.state.run('run').commit_valid).toBe(false)
  expect(s.goal).not.toHaveBeenCalled()
})

it.each(['missing-operation', 'unknown-owner'] as const)('saves %s events for clarification without guessing an owner', scenario => {
  const s = setup(), input = s.input('operation_completed', scenario === 'missing-operation' ? {} : { operation_id: 'unknown-operation' }); s.runner.receive(input)
  expect(s.runner.advance(input.input_event_id)).toMatchObject({ state: 'clarification', route: { reason: 'operation_owner_required' } })
  expect(s.goal).not.toHaveBeenCalled(); expect(s.install).not.toHaveBeenCalled()
  expect(s.operationOwner).toHaveBeenCalledTimes(scenario === 'missing-operation' ? 0 : 1)
})

it.each([
  ['operation', { operation_id: 'another-operation' }],
  ['Task', { owner: { task_id: 'other-task' } }],
  ['goal revision', { owner: { intent_revision: 2 } }],
  ['work', { owner: { work_id: 'another-work' } }]
] as const)('rejects a known-event %s mismatch without routing or consuming the installation', (_name, changes) => {
  const s = setup(), owner = s.operation()
  s.operationOwner.mockReturnValue({ operation_id: 'external-operation', ...changes, owner: { ...owner, ...('owner' in changes ? changes.owner : {}) } })
  const input = s.input('operation_completed', { operation_id: 'external-operation' }); s.runner.receive(input)
  expect(() => s.runner.advance(input.input_event_id)).toThrow(expect.objectContaining({ code: 'RUNNER_OWNERSHIP_INVALID' }))
  expect(s.state.input(input.input_event_id).stage).toBe('received')
  expect(s.goal).not.toHaveBeenCalled(); expect(s.install).not.toHaveBeenCalled()
})

it.each([
  ['cancel_work', { work_id: 'work' }, { scope: 'work', work_id: 'work', run_id: 'run' }],
  ['cancel_run', { run_id: 'run' }, { scope: 'run', run_id: 'run' }],
  ['stop_task', {}, { scope: 'task' }]
] as const)('installs %s synchronously and leaves external cancellation to the caller after return', (kind, target, route) => {
  const s = setup(); s.operation()
  let revoked = false, aborted = false
  s.install.mockImplementation(input => {
    expect(s.db.inTransaction).toBe(true)
    expect(aborted).toBe(false)
    s.state.revokeRun('run'); revoked = true
    return { refs: [{ task_id: 'task', kind: 'run', id: 'run' }], waits: [{ reason: 'ending_cleanup' }] }
  })
  const input = s.input(kind, target)
  const receipt = s.runner.cancel({ ...input, kind })
  expect(receipt.route).toEqual({ route: 'direct', kind, ...route })
  expect(revoked).toBe(true)
  expect(s.state.run('run').commit_valid).toBe(false)
  expect(s.state.input(input.input_event_id).stage).toBe('installed')
  expect(s.db.inTransaction).toBe(false)
  aborted = true
  expect(s.runner.cancel({ ...input, kind })).toEqual(receipt)
  expect(s.install).toHaveBeenCalledTimes(1)
  expect(s.goal).not.toHaveBeenCalled()
})

it.each(['cancel_work', 'cancel_run'] as const)('does not broaden an unassigned %s into a Task stop', kind => {
  const s = setup(), input = s.input(kind)
  expect(s.runner.cancel({ ...input, kind })).toMatchObject({ state: 'clarification', route: { route: 'clarification' } })
  expect(s.install).not.toHaveBeenCalled()
})

it('rejects ordinary input sent to the cancellation Interface before receiving it', () => {
  const s = setup(), input = s.input('query')
  expect(() => s.runner.cancel(input as Parameters<TaskRunner['cancel']>[0])).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
  expect(() => s.state.input(input.input_event_id)).toThrow(expect.objectContaining({ code: 'RUNNER_NOT_FOUND' }))
})

it.each(['goal', 'install'] as const)('rejects an async %s adapter before its body can run', method => {
  const s = setup(); s.request('goal')
  const input = s.input('request', { request_id: 'goal' }); s.runner.receive(input)
  let ran = false
  s.host[method] = (async () => { ran = true; throw Error('async body must not execute') }) as never
  expect(() => s.runner.advance(input.input_event_id)).toThrow(expect.objectContaining({ code: 'RUNNER_RESULT_INVALID' }))
  expect(ran).toBe(false)
  expect(s.state.consumption(input.input_event_id, 'installed')).toBeNull()
  expect(() => s.state.goal('goal')).toThrow(expect.objectContaining({ code: 'RUNNER_NOT_FOUND' }))
})

it('rejects a Promise returned by a synchronous installer and rolls back the already installed goal', async () => {
  const s = setup(); s.request('goal')
  const input = s.input('request', { request_id: 'goal' }); s.runner.receive(input)
  s.host.install = (() => {
    s.db.prepare("UPDATE requests SET state='cancelled' WHERE id='goal'").run()
    return Promise.reject(Error('rejected installation'))
  }) as unknown as TaskRunnerHost['install']
  expect(() => s.runner.advance(input.input_event_id)).toThrow(expect.objectContaining({ code: 'RUNNER_RESULT_INVALID' }))
  expect(s.state.consumption(input.input_event_id, 'installed')).toBeNull()
  expect(() => s.state.goal('goal')).toThrow(expect.objectContaining({ code: 'RUNNER_NOT_FOUND' }))
  expect(s.db.prepare("SELECT state FROM requests WHERE id='goal'").get()).toEqual({ state: 'started' })
  await Promise.resolve()
})

it('rejects cross-Task effect references and rolls back business changes with their acknowledgement', () => {
  const s = setup(), input = s.input('query'); s.runner.receive(input)
  s.install.mockImplementation(() => {
    s.db.prepare("UPDATE tasks SET title='must roll back' WHERE id='task'").run()
    return { refs: [{ task_id: 'other-task', kind: 'resource', id: 'secret' }], waits: [] }
  })
  expect(() => s.runner.advance(input.input_event_id)).toThrow(expect.objectContaining({ code: 'RUNNER_OWNERSHIP_INVALID' }))
  expect(s.db.prepare("SELECT title FROM tasks WHERE id='task'").get()).toEqual({ title: 'Task' })
  expect(s.state.consumption(input.input_event_id, 'installed')).toBeNull()
})

it('bounds installation navigation before acknowledging the business mutation', () => {
  const s = setup(), input = s.input('query'); s.runner.receive(input)
  s.install.mockImplementation(() => {
    s.db.prepare("UPDATE tasks SET title='must roll back' WHERE id='task'").run()
    return { refs: Array.from({ length: RUNNER_LIMITS.index.page_items + 1 }, () => ({ task_id: 'task', kind: 'record', id: 'result' })), waits: [] }
  })
  expect(() => s.runner.advance(input.input_event_id)).toThrow(expect.objectContaining({ code: 'RUNNER_RESULT_INVALID' }))
  expect(s.db.prepare("SELECT title FROM tasks WHERE id='task'").get()).toEqual({ title: 'Task' })
  expect(s.state.consumption(input.input_event_id, 'installed')).toBeNull()
})

const ref = (id = 'work'): TaskRunnerReference => ({ task_id: 'task', kind: 'work', id })
it('rejects a persisted operation owner with a different work role', () => {
  const s = setup(), owner = s.operation()
  s.operationOwner.mockReturnValue({ operation_id: 'external-operation', owner: { ...owner, role: 'integrator' } })
  const input = s.input('operation_completed', { operation_id: 'external-operation' }); s.runner.receive(input)
  expect(() => s.runner.advance(input.input_event_id)).toThrow(expect.objectContaining({ code: 'RUNNER_OWNERSHIP_INVALID' }))
  expect(s.state.input(input.input_event_id).stage).toBe('received')
  expect(s.install).not.toHaveBeenCalled()
})

it('rejects an operation routed from an unrelated request in the same Task', () => {
  const s = setup(); s.operation(); s.request('other-goal')
  const input = s.input('operation_completed', { operation_id: 'external-operation', request_id: 'other-goal' }); s.runner.receive(input)
  expect(() => s.runner.advance(input.input_event_id)).toThrow(expect.objectContaining({ code: 'RUNNER_OWNERSHIP_INVALID' }))
  expect(s.state.input(input.input_event_id).stage).toBe('received')
  expect(s.install).not.toHaveBeenCalled()
})

it('rechecks the logical work source against its persisted operation owner', () => {
  const s = setup(); s.operation()
  const work = s.state.work('work')
  s.db.prepare('UPDATE runner_work SET payload_json=? WHERE work_id=?').run(JSON.stringify({ ...work, intent_revision: 2 }), 'work')
  const input = s.input('operation_completed', { operation_id: 'external-operation' }); s.runner.receive(input)
  expect(() => s.runner.advance(input.input_event_id)).toThrow(expect.objectContaining({ code: 'RUNNER_OWNERSHIP_INVALID' }))
  expect(s.state.input(input.input_event_id).stage).toBe('received')
  expect(s.install).not.toHaveBeenCalled()
})

it('returns bounded status references and separate wait reasons without expanding history', () => {
  const s = setup(), page: TaskRunnerStatusPage = { task_id: 'task', items: [{ ref: ref('alpha'), state: 'running', refs: [{ task_id: 'task', kind: 'record', id: 'result' }], waits: [{ reason: 'approval_wait', ref: { task_id: 'task', kind: 'action', id: 'approval' } }] }, { ref: ref('beta'), state: 'waiting', refs: [], waits: [{ reason: 'model_queue' }] }], next_cursor: 'host-bound-cursor' }
  s.status.mockReturnValue(page)
  const result = s.runner.status({ task_id: 'task', request_id: 'goal', limit: 2, cursor: 'previous' })
  expect(result).toEqual(page)
  expect(s.status).toHaveBeenCalledWith({ task_id: 'task', request_id: 'goal', limit: 2, cursor: 'previous' })
  result.items[0]!.waits[0]!.reason = 'caller_changed'
  expect(page.items[0]!.waits[0]!.reason).toBe('approval_wait')
  expect(s.install).not.toHaveBeenCalled(); expect(s.goal).not.toHaveBeenCalled(); expect(s.operationOwner).not.toHaveBeenCalled()
})

it.each([
  ['extra history', { task_id: 'task', items: [], next_cursor: null, history: 'PRIVATE BODY' }],
  ['extra item body', { task_id: 'task', items: [{ ref: ref(), state: 'running', refs: [], waits: [], body: 'PRIVATE BODY' }], next_cursor: null }],
  ['cross Task', { task_id: 'other-task', items: [], next_cursor: null }],
  ['cross Task reference', { task_id: 'task', items: [{ ref: { ...ref(), task_id: 'other-task' }, state: 'running', refs: [], waits: [] }], next_cursor: null }],
  ['too many items', { task_id: 'task', items: Array.from({ length: RUNNER_LIMITS.index.page_items + 1 }, () => ({ ref: ref(), state: 'running', refs: [], waits: [] })), next_cursor: null }],
  ['unbounded reason', { task_id: 'task', items: [{ ref: ref(), state: 'waiting', refs: [], waits: [{ reason: 'x'.repeat(129) }] }], next_cursor: null }]
] as const)('rejects status %s with content-free errors', (_name, raw) => {
  const s = setup(); s.status.mockReturnValue(raw as unknown as TaskRunnerStatusPage)
  expect(() => s.runner.status({ task_id: 'task' })).toThrow()
  try { s.runner.status({ task_id: 'task' }) } catch (error) { expect((error as Error).message).not.toContain('PRIVATE BODY') }
})

it.each([0, 33, 1.5, Infinity])('rejects invalid status limit %s before invoking the host', limit => {
  const s = setup()
  expect(() => s.runner.status({ task_id: 'task', limit })).toThrow(expect.objectContaining({ code: 'RUNNER_RESULT_INVALID' }))
  expect(s.status).not.toHaveBeenCalled()
})

it('enforces status item and whole-page byte limits separately', () => {
  const s = setup(), reference = { ...ref(), id: 'r'.repeat(RUNNER_LIMITS.index.id_bytes) }
  const item = { ref: reference, state: 'waiting', refs: Array.from({ length: 12 }, () => reference), waits: [] }
  expect(Buffer.byteLength(JSON.stringify(item))).toBeLessThan(RUNNER_LIMITS.index.item_bytes)
  s.status.mockReturnValue({ task_id: 'task', items: Array.from({ length: RUNNER_LIMITS.index.page_items }, () => item), next_cursor: null })
  expect(() => s.runner.status({ task_id: 'task' })).toThrow(expect.objectContaining({ code: 'RUNNER_LIMIT_EXCEEDED' }))
  s.status.mockReturnValue({ task_id: 'task', items: [{ ...item, refs: Array.from({ length: 24 }, () => reference) }], next_cursor: null })
  expect(() => s.runner.status({ task_id: 'task' })).toThrow(expect.objectContaining({ code: 'RUNNER_LIMIT_EXCEEDED' }))
})

it.each(['status', 'operationOwner'] as const)('rejects an async %s adapter without running its body', method => {
  const s = setup(); let ran = false
  s.host[method] = (async () => { ran = true; throw Error('must not execute') }) as never
  if (method === 'status') expect(() => s.runner.status({ task_id: 'task' })).toThrow(expect.objectContaining({ code: 'RUNNER_RESULT_INVALID' }))
  else {
    const input = s.input('operation_completed', { operation_id: 'operation' }); s.runner.receive(input)
    expect(() => s.runner.advance(input.input_event_id)).toThrow(expect.objectContaining({ code: 'RUNNER_RESULT_INVALID' }))
    expect(s.state.input(input.input_event_id).stage).toBe('received')
  }
  expect(ran).toBe(false)
})
