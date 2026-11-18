import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, expect, it, vi } from 'vitest'
import type { ExecutionScope, InputEvent, LogicalWork } from '../../src/shared/contracts.generated'
import { RuntimeStore } from '../../src/runtime/store'
import { RunnerWorkState } from '../../src/runtime/runner/work-state'
import { RunnerBudgetLedger } from '../../src/runtime/runner/budget'
import { RunnerCompositionState } from '../../src/runtime/runner/composition-state'
import { RunnerArtifactState } from '../../src/runtime/runner/artifact-state'
import type { PluginInstanceEvent } from '../../src/runtime/plugins/process'

const stores: RuntimeStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close(); vi.restoreAllMocks() })

function setup() {
  const store = new RuntimeStore(mkdtempSync(join(tmpdir(), 'pliuna-runner-input-')))
  stores.push(store)
  const internal = store as unknown as {
    db: Database.Database; epoch: string
    record(task: string, kind: string, value: unknown): string
    operationEvent(task: string, kind: string, value: unknown): string
    pluginInstanceEvent(value: PluginInstanceEvent): void
    runnerCleanupPending(run: string): boolean
    aggregateWorkerRun(task: string, run: string): void
  }
  const { db, epoch } = internal, task = store.create('Deterministic inputs').task.id
  const work = new RunnerWorkState(db, epoch)
  const composition = new RunnerCompositionState(db, work, new RunnerArtifactState(db, work))
  const records = (kind: string) => (db.prepare('SELECT id,payload_json FROM records WHERE task_id=? AND kind=? ORDER BY sequence').all(task, kind) as { id: string; payload_json: string }[]).map(row => ({ id: row.id, payload: JSON.parse(row.payload_json) }))
  let sequence = 0
  function input(kind: InputEvent['kind'], target: Partial<InputEvent> = {}) {
    const event: InputEvent = { input_event_id: `input-${++sequence}`, task_id: task, kind, record_id: internal.record(task, 'message.user', { text: `PRIVATE ORIGINAL ${kind}` }), stage: 'received', ...target }
    store.receiveRunnerInput(event)
    return { event, receipt: store.advanceRunnerInput(event.input_event_id) }
  }
  function goal(request: string) {
    db.prepare("INSERT INTO requests(id,task_id,state,config_selection_json,input_json,created_at) VALUES (?,?,'started','{}','{}','time')").run(request, task)
    return input('request', { request_id: request })
  }
  function run(request: string): ExecutionScope {
    const runId = `run-${request}`, workId = `work-${request}`, attemptId = `attempt-${request}`
    new RunnerBudgetLedger(db).create({ budget_id: `budget-${request}`, task_id: task, purpose: 'production', request_id: request, limits: { model_requests: 30, tool_requests: 30, tokens: 100000, wall_ms: 60000 } })
    db.prepare("INSERT INTO runs(id,task_id,request_id,state,runtime_epoch,limits_json,budget_json,created_at) VALUES (?,?,?,'running',?,'{}','{}','time')").run(runId, task, request, epoch)
    work.registerRun({ run_id: runId, task_id: task, runtime_epoch: epoch, state: 'running', commit_valid: true, budget_id: `budget-${request}`, purpose: 'production', request_id: request, intent_revision: 1 })
    const value: LogicalWork = { work_id: workId, task_id: task, run_id: runId, plan_revision: 1, role: 'producer', required: true, requirement_ids: ['answer'], dependencies: [{ kind: 'goal', task_id: task, request_id: request, intent_revision: 1 }], state: 'planned', max_attempts: 1, purpose: 'production', request_id: request, intent_revision: 1 }
    work.installPlan([value])
    work.createAttempt({ attempt_id: attemptId, work_id: workId, task_id: task, run_id: runId, runtime_epoch: epoch, attempt_number: 1, profile_id: 'producer', model_config_id: 'fixture', model_config_revision: 1, input_versions: value.dependencies, state: 'registered', dispatch_state: 'not_dispatched', usage_refs: [], purpose: 'production', request_id: request, intent_revision: 1 })
    return { task_id: task, run_id: runId, work_id: workId, attempt_id: attemptId, role: 'producer', purpose: 'production', request_id: request, intent_revision: 1 }
  }
  function call(owner: ExecutionScope, callId: string) {
    db.prepare("INSERT INTO calls(id,task_id,run_id,capability_id,state,dispatch,execution,delivery,input_json,limits_json,commit_valid,created_at) VALUES (?,?,?,'plugin:work','ended','sent','success','delivered','{}',?,0,'time')").run(callId, task, owner.run_id, JSON.stringify({ owner }))
  }
  return { store, internal, db, task, work, composition, records, input, goal, run, call }
}

it('installs independent goals once and pages bounded metadata without original input', () => {
  const s = setup(), first = s.goal('alpha')
  s.goal('beta')
  expect(s.store.advanceRunnerInput(first.event.input_event_id)).toEqual(first.receipt)
  expect(s.records('runner.input.installed')).toHaveLength(2)
  const page = s.store.runnerStatus({ task_id: s.task, limit: 1 })
  expect(page.items[0]!.ref.id).toBe('alpha')
  expect(page.next_cursor).toBeTypeOf('string')
  expect(JSON.stringify(page)).not.toContain('PRIVATE ORIGINAL')
  expect(s.store.runnerStatus({ task_id: s.task, limit: 1, cursor: page.next_cursor! }).items[0]!.ref.id).toBe('beta')
  expect(s.composition.scope(s.task)?.targets.map(target => target.request_id)).toEqual(['alpha', 'beta'])
})

it('keeps queries and explanations on their input and persists ambiguous correction', () => {
  const s = setup()
  s.goal('alpha'); s.goal('beta')
  const query = s.input('query', { request_id: 'beta' })
  s.input('explanation', { request_id: 'alpha' })
  const ambiguous = s.input('correction')
  expect(ambiguous.receipt).toMatchObject({ state: 'clarification', waits: [{ reason: 'goal_target_required' }] })
  expect(s.work.consumption(ambiguous.event.input_event_id, 'installed')?.result).toEqual(ambiguous.receipt)
  expect(s.records('runner.status.reply')[0]!.payload).toMatchObject({ input_event_id: query.event.input_event_id, purpose: 'query_reply', items: [{ ref: { id: 'beta' } }] })
  expect(s.work.goal('alpha').intent_revision).toBe(1)
  expect(s.work.goal('beta').intent_revision).toBe(1)
})

it('interrupts only the superseded producer and retains its original goal revision', () => {
  const s = setup()
  const original = s.goal('alpha'); s.goal('beta')
  const alpha = s.run('alpha'), beta = s.run('beta')
  s.input('correction', { request_id: 'alpha' })
  expect(s.work.goal('alpha')).toMatchObject({ intent_revision: 2, previous_revision: 1 })
  expect(s.work.goal('alpha', 1).input_event_id).toBe(original.event.input_event_id)
  expect(s.work.run(alpha.run_id)).toMatchObject({ state: 'interrupted', commit_valid: false })
  expect(s.work.work(alpha.work_id).state).toBe('invalidated')
  expect(s.work.run(beta.run_id)).toMatchObject({ state: 'running', commit_valid: true })
  expect(s.work.qualify(beta.attempt_id, 'dispatch').attempt.state).toBe('registered')
  expect(s.composition.scope(s.task)?.targets.map(target => [target.request_id, target.intent_revision])).toEqual([['alpha', 2], ['beta', 1]])
})

it('withdraws a completed goal through a new scope without changing its terminal history', () => {
  const s = setup()
  s.goal('alpha'); s.goal('beta')
  const alpha = s.run('alpha'), previous = s.composition.scope(s.task)!
  s.db.prepare("UPDATE runs SET state='completed',commit_valid=0,ended_at='finished' WHERE id=?").run(alpha.run_id)
  s.input('withdraw_goal', { request_id: 'alpha' })
  expect(s.work.run(alpha.run_id).state).toBe('completed')
  expect(s.work.goal('alpha')).toMatchObject({ state: 'withdrawn', intent_revision: 2 })
  expect(s.composition.scope(s.task)?.targets.map(target => target.request_id)).toEqual(['beta'])
  expect(s.composition.scope(s.task, previous.composition_version)).toEqual(previous)
})

it('routes repeated and late operation completion to the original work without inference', () => {
  const s = setup()
  s.goal('alpha')
  const owner = s.run('alpha'), request = vi.spyOn(s.store.models, 'request')
  s.call(owner, 'original-call')
  s.input('cancel_work', { request_id: 'alpha', work_id: owner.work_id })
  const payload = { owner, call_id: 'original-call', execution: 'success' }
  s.internal.operationEvent(s.task, 'plugin.call.ended', payload)
  s.internal.operationEvent(s.task, 'plugin.call.ended', payload)
  expect(s.records('runner.operation.installed')).toHaveLength(1)
  expect(s.records('runner.operation.installed')[0]!.payload).toMatchObject({ operation_id: 'original-call', owner })
  expect(s.work.consumption('operation:original-call', 'installed')?.result).toMatchObject({ state: 'installed', route: { kind: 'operation_completed', owner } })
  expect(s.work.work(owner.work_id).state).toBe('cancelled')
  expect(request).not.toHaveBeenCalled()
})

it('installs an approval decision with its exact original action and work', () => {
  const s = setup()
  s.goal('alpha')
  const owner = s.run('alpha')
  s.db.prepare("INSERT INTO actions(id,task_id,run_id,kind,state,source_json,request_json,commit_valid,created_at) VALUES ('approved-action',?,?,'mutation','waiting',?,'{}',1,'time')").run(s.task, owner.run_id, JSON.stringify({ owner }))
  s.db.prepare("INSERT INTO approvals VALUES ('approval','approved-action','pending','valid','manual','awaiting_human','2999-01-01',NULL,'{}')").run()
  expect(s.store.handle({ type: 'approval.decide', task_id: s.task, approval_id: 'approval', decision: 'approve' })).toMatchObject({ decision: 'approve', action_id: 'approved-action' })
  expect(s.work.consumption('approval:approval', 'installed')?.result).toMatchObject({ state: 'installed', route: { kind: 'approval_decided', operation_id: 'approved-action', owner } })
  expect(s.records('approval.decided')).toHaveLength(1)
})

it('blocks cleanup only for the exact affected runs and waits for confirmed instance exit', () => {
  const s = setup()
  s.goal('alpha'); s.goal('beta')
  const alpha = s.run('alpha'), beta = s.run('beta')
  s.call(alpha, 'alpha-call'); s.call(beta, 'beta-call')
  const event = { instance_id: 'shared-instance', instance_key: 'package:global', call_ids: ['alpha-call'], reason: 'cancelled' }
  s.internal.pluginInstanceEvent({ ...event, kind: 'interrupted' })
  expect(s.internal.runnerCleanupPending(alpha.run_id)).toBe(true)
  expect(s.internal.runnerCleanupPending(beta.run_id)).toBe(false)
  s.internal.pluginInstanceEvent({ ...event, kind: 'cleanup_failed' })
  expect(s.internal.runnerCleanupPending(alpha.run_id)).toBe(true)
  s.internal.pluginInstanceEvent({ ...event, kind: 'cleanup_confirmed' })
  s.internal.pluginInstanceEvent({ ...event, kind: 'cleanup_failed' })
  expect(s.internal.runnerCleanupPending(alpha.run_id)).toBe(false)
  expect(s.db.prepare("SELECT state,detail_json FROM cleanup_jobs WHERE owner_kind='plugin_instance'").get()).toMatchObject({ state: 'done', detail_json: JSON.stringify({ ...event }) })
})

it('records all calls affected by a shared instance interruption across producers', () => {
  const s = setup()
  s.goal('alpha'); s.goal('beta')
  const alpha = s.run('alpha'), beta = s.run('beta')
  s.call(alpha, 'alpha-call'); s.call(beta, 'beta-call')
  const event = { instance_id: 'shared-instance', instance_key: 'package:global', call_ids: ['alpha-call', 'beta-call'], reason: 'disconnect' }
  s.internal.pluginInstanceEvent({ ...event, kind: 'interrupted' })
  expect(s.records('plugin.instance.interrupted')[0]!.payload.call_ids).toEqual(event.call_ids)
  expect(s.internal.runnerCleanupPending(alpha.run_id)).toBe(true)
  expect(s.internal.runnerCleanupPending(beta.run_id)).toBe(true)
  s.db.prepare("UPDATE calls SET execution='unknown' WHERE id='alpha-call'").run()
  s.internal.pluginInstanceEvent({ ...event, kind: 'cleanup_confirmed' })
  s.input('cancel_run', { run_id: alpha.run_id })
  expect(s.work.run(alpha.run_id)).toMatchObject({ state: 'closing', commit_valid: false })
  expect(s.db.prepare("SELECT execution FROM calls WHERE id='alpha-call'").get()).toEqual({ execution: 'unknown' })
})
