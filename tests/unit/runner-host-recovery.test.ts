import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { afterEach, expect, it, vi } from 'vitest'
import type { ExecutionAttempt, ExecutionScope, ContentPlan, InputEvent, LogicalWork, PublicationEntry, RunnerRun } from '../../src/shared/contracts.generated'
import { RunnerBudgetLedger } from '../../src/runtime/runner/budget'
import { RunnerHostRecovery, type RunnerResumeHost, type RunnerResumeInput } from '../../src/runtime/runner/host-recovery'
import { RunnerWorkState } from '../../src/runtime/runner/work-state'

const coreSql = readFileSync(new URL('../../src/shared/contracts/001-core.sql', import.meta.url), 'utf8')
const runnerSql = readFileSync(new URL('../../src/shared/contracts/002-runner.sql', import.meta.url), 'utf8')
const databases: Database.Database[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
const input: InputEvent = { input_event_id: 'input', task_id: 'task', kind: 'request', record_id: 'input-record', request_id: 'goal', stage: 'received' }
const goal: ContentPlan = { task_id: 'task', request_id: 'goal', intent_revision: 1, input_event_id: 'input', state: 'active', requirements: [{ requirement_id: 'answer', kind: 'answer', required: true, provenance_required: false }] }
const work = (id = 'work'): LogicalWork => ({ work_id: id, task_id: 'task', run_id: 'old-run', plan_revision: 1, role: 'producer', required: true, requirement_ids: ['answer'], dependencies: [{ kind: 'goal', task_id: 'task', request_id: 'goal', intent_revision: 1 }], state: 'queued', max_attempts: 3, purpose: 'production', request_id: 'goal', intent_revision: 1 })
const attempt = (id = 'old-attempt', workId = 'work'): ExecutionAttempt => ({ attempt_id: id, task_id: 'task', run_id: 'old-run', work_id: workId, runtime_epoch: 'old-epoch', attempt_number: 1, profile_id: 'producer-output-v1', model_config_id: 'model', model_config_revision: 1, input_versions: work().dependencies, state: 'queued', dispatch_state: 'not_dispatched', usage_refs: [], purpose: 'production', request_id: 'goal', intent_revision: 1 })
function executionOwner(value = attempt()): ExecutionScope {
  return { task_id: 'task', run_id: value.run_id, work_id: value.work_id, attempt_id: value.attempt_id, role: 'producer', purpose: 'production', request_id: 'goal', intent_revision: 1 }
}
function fixture(registerAttempt = true) {
  const db = new Database(':memory:'); databases.push(db)
  db.exec(coreSql); db.exec(runnerSql)
  db.prepare("INSERT INTO tasks(id,title,state,revision) VALUES ('task','Task','active',1),('other-task','Other','active',1)").run()
  db.prepare("INSERT INTO requests VALUES ('goal','task','started','{}','{}','time')").run()
  db.prepare("INSERT INTO records VALUES ('input-record','task',1,'message.user','{}','time')").run()
  const state = new RunnerWorkState(db, 'old-epoch', () => 1000), ledger = new RunnerBudgetLedger(db, () => 1000)
  state.receive(input); state.installGoal(goal)
  ledger.create({ budget_id: 'budget', task_id: 'task', purpose: 'production', request_id: 'goal', limits: { model_requests: 10, tool_requests: 10, tokens: 1000, wall_ms: 60000 } })
  db.prepare("INSERT INTO runs(id,task_id,request_id,state,runtime_epoch,limits_json,budget_json,created_at) VALUES ('old-run','task','goal','running','old-epoch','{}','{}','time')").run()
  const run: RunnerRun = { run_id: 'old-run', task_id: 'task', runtime_epoch: 'old-epoch', state: 'running', commit_valid: true, budget_id: 'budget', purpose: 'production', request_id: 'goal', intent_revision: 1 }
  state.registerRun(run); state.installPlan([work()]); if (registerAttempt) state.createAttempt(attempt())
  return { db, state, ledger, recovery: new RunnerHostRecovery(db, 'new-epoch', () => 2000), run }
}
function dispatch(state: RunnerWorkState, id = 'old-attempt'): void {
  state.updateAttempt({ ...state.attempt(id), operation_id: `execution-${id}`, state: 'dispatched', dispatch_state: 'dispatched' })
}
function call(db: Database.Database, id = 'call', dispatchState = 'sent', execution: string | null = null): void {
  db.prepare("INSERT INTO calls(id,task_id,run_id,capability_id,state,dispatch,execution,delivery,input_json,limits_json,commit_valid,created_at) VALUES (?,'task','old-run','plugin:test','executing',?,?,'pending',?, ?,1,'time')").run(id, dispatchState, execution, JSON.stringify({ private: 'PRIVATE BODY' }), JSON.stringify({ owner: executionOwner() }))
}
function action(db: Database.Database, id = 'action', state = 'executing', result: string | null = null): void {
  db.prepare("INSERT INTO actions(id,task_id,run_id,kind,state,result,source_json,request_json,commit_valid,created_at) VALUES (?,'task','old-run','mutation',?,?,?, ?,1,'time')").run(id, state, result, JSON.stringify({ owner: executionOwner() }), JSON.stringify({ private: 'PRIVATE BODY' }))
}
function resumeInput(): RunnerResumeInput {
  return {
    run: { run_id: 'new-run', previous_run_id: 'old-run', task_id: 'task', runtime_epoch: 'new-epoch', state: 'running', commit_valid: true, budget_id: 'budget', purpose: 'production', request_id: 'goal', intent_revision: 1 },
    attempts: [{ ...attempt('new-attempt'), run_id: 'new-run', runtime_epoch: 'new-epoch', attempt_number: 2, previous_attempt_id: 'old-attempt', model_config_revision: 2 }]
  }
}
function resumeHost(db: Database.Database): RunnerResumeHost {
  return { recheck: vi.fn(), installRun: vi.fn((run: RunnerRun) => { db.prepare("INSERT INTO runs(id,task_id,request_id,state,runtime_epoch,limits_json,budget_json,created_at) VALUES (?,? ,?,'running',?,'{}','{}','time')").run(run.run_id, run.task_id, run.purpose === 'production' ? run.request_id : null, run.runtime_epoch) }) }
}

it('revokes old queued attempts and preserves original identities without dispatching anything', () => {
  const { db, state, recovery } = fixture()
  const result = recovery.recover()
  expect(result).toMatchObject({ run_ids: ['old-run'], revoked_attempt_ids: ['old-attempt'], unknown_attempt_ids: [] })
  expect(state.run('old-run')).toMatchObject({ state: 'interrupted', commit_valid: false, runtime_epoch: 'old-epoch' })
  expect(state.attempt('old-attempt')).toMatchObject({ state: 'revoked', dispatch_state: 'not_dispatched', runtime_epoch: 'old-epoch' })
  expect(() => new RunnerWorkState(db, 'new-epoch').qualify('old-attempt')).toThrow()
  expect(recovery.recover()).toMatchObject({ run_ids: [], revoked_attempt_ids: [] })
  expect(db.prepare('SELECT id FROM runs').all()).toEqual([{ id: 'old-run' }])
})

it('classifies reservations by the persisted dispatch barrier and preserves actual usage', () => {
  const { db, state, ledger, recovery } = fixture()
  ledger.reserve('unsent', 'budget', 'unsent-operation', { tokens: 100 }, 'old-attempt')
  ledger.reserve('uncertain', 'budget', 'unknown-operation', { model_requests: 1, tokens: 100 }, 'old-attempt'); ledger.markDispatched('uncertain')
  ledger.reserve('actual', 'budget', 'actual-operation', { model_requests: 1, tokens: 100 }, 'old-attempt'); ledger.markDispatched('actual'); ledger.settle('actual', { tokens: 50 })
  expect(recovery.recover()).toMatchObject({ released_reservation_ids: ['unsent'], unknown_reservation_ids: ['uncertain'], unknown_attempt_ids: ['old-attempt'] })
  expect(ledger.snapshot('budget')).toMatchObject({ settled: { tokens: 50 }, reserved: { tokens: 0 }, unknown: { tokens: 100 }, total: { tokens: 150 } })
  expect(state.attempt('old-attempt')).toMatchObject({ state: 'unknown', dispatch_state: 'unknown' })
  expect(() => recovery.resume(resumeInput(), resumeHost(db))).toThrow()
})

it.each(['dispatched', 'running', 'waiting'] as const)('keeps an old %s attempt unknown after restart', stateName => {
  const { state, recovery } = fixture(); dispatch(state)
  if (stateName !== 'dispatched') state.updateAttempt({ ...state.attempt('old-attempt'), state: stateName })
  recovery.recover()
  expect(state.attempt('old-attempt')).toMatchObject({ state: 'unknown', dispatch_state: 'unknown', operation_id: 'execution-old-attempt' })
  expect(recovery.queryOperation('task', 'execution-old-attempt')).toMatchObject({ kind: 'attempt', state: 'unknown', owner: executionOwner() })
})

it('does not rewrite completed work, accepted outputs or known terminal attempt evidence', () => {
  const { db, state, recovery } = fixture(); dispatch(state)
  state.updateAttempt({ ...state.attempt('old-attempt'), state: 'succeeded', result_ref: { task_id: 'task', kind: 'record', id: 'input-record' } })
  db.prepare("UPDATE runs SET state='completed',commit_valid=0 WHERE id='old-run'").run()
  const original = state.attempt('old-attempt')
  expect(recovery.recover().unknown_attempt_ids).toEqual([])
  expect(state.attempt('old-attempt')).toEqual(original)
  expect(state.work('work')).toMatchObject({ state: 'succeeded', result_revision: 1 })
  expect(() => recovery.resume(resumeInput(), resumeHost(db))).toThrow(expect.objectContaining({ code: 'RUNNER_RESUME_NOT_ELIGIBLE' }))
})

it('revokes only old epoch authority and leaves current execution and reservations alone', () => {
  const { db, state, ledger, run } = fixture()
  const currentRun: RunnerRun = { ...run, runtime_epoch: 'new-epoch' }
  db.prepare("UPDATE runs SET runtime_epoch='new-epoch' WHERE id='old-run'").run()
  db.prepare('UPDATE runner_runs SET payload_json=? WHERE run_id=?').run(JSON.stringify(currentRun), run.run_id)
  const currentAttempt = { ...state.attempt('old-attempt'), runtime_epoch: 'new-epoch' }
  db.prepare('UPDATE runner_attempts SET payload_json=? WHERE attempt_id=?').run(JSON.stringify(currentAttempt), currentAttempt.attempt_id)
  ledger.reserve('current-reservation', 'budget', 'current-operation', { tokens: 20 }, 'old-attempt')
  expect(new RunnerHostRecovery(db, 'new-epoch', () => 2000).recover()).toEqual({ run_ids: [], revoked_attempt_ids: [], unknown_attempt_ids: [], released_reservation_ids: [], unknown_reservation_ids: [] })
  expect(ledger.query('current-reservation').state).toBe('reserved')
  expect(state.run('old-run').commit_valid).toBe(true)
})

it('keeps dispatched calls and executing actions unknown while revoking old approvals', () => {
  const { db, state, recovery } = fixture(); call(db); action(db); action(db, 'unsent-action', 'waiting')
  db.prepare("INSERT INTO approvals VALUES ('approval','action','approve','valid','manual','resolved','future',NULL,'{}')").run()
  recovery.recover()
  expect(recovery.queryOperation('task', 'call')).toMatchObject({ kind: 'call', state: 'unknown', execution: 'unknown', owner: executionOwner() })
  expect(recovery.queryOperation('task', 'action')).toMatchObject({ kind: 'action', state: 'unknown', execution: 'unknown' })
  expect(recovery.queryOperation('task', 'unsent-action')).toMatchObject({ state: 'not_dispatched', execution: 'not_executed' })
  expect(state.attempt('old-attempt').state).toBe('unknown')
  expect(db.prepare('SELECT validity FROM approvals').get()).toEqual({ validity: 'revoked' })
  expect(JSON.stringify(recovery.queryOperation('task', 'call'))).not.toContain('PRIVATE BODY')
  expect(recovery.queryOperation('other-task', 'call')).toBeNull()
})

it('queries an original capability before accepting new facts and never invents a replay identity', async () => {
  const { db, recovery } = fixture(); call(db); recovery.recover()
  expect(await recovery.queryUnknown('task', 'call')).toMatchObject({ state: 'unknown' })
  const lookup = vi.fn(async value => {
    expect(value).toMatchObject({ operation_id: 'call', state: 'unknown' })
    db.prepare("UPDATE calls SET execution='success' WHERE id='call'").run()
  })
  expect(await recovery.queryUnknown('task', 'call', lookup)).toMatchObject({ operation_id: 'call', state: 'known', execution: 'success' })
  await recovery.queryUnknown('task', 'call', lookup)
  expect(lookup).toHaveBeenCalledOnce()
  expect(db.prepare('SELECT id FROM calls').all()).toEqual([{ id: 'call' }])
})

it('does not turn a wrapper acknowledgment or settled tool count into external success', () => {
  const { db, ledger, recovery } = fixture(); call(db)
  ledger.reserve('wrapper', 'budget', 'wrapper', { tool_requests: 1 }, 'old-attempt'); ledger.markDispatched('wrapper'); ledger.settle('wrapper', { tokens: 0 })
  db.prepare("INSERT INTO records VALUES ('tool-ended','task',2,'worker.tool.ended',?,'time')").run(JSON.stringify({ operation_id: 'wrapper', source_operation_id: 'call', state: 'completed' }))
  recovery.recover()
  expect(recovery.queryOperation('task', 'wrapper')).toMatchObject({ kind: 'tool', state: 'unknown', source_operation_id: 'call' })
})

it('does not report a cancelled attempt clean while its original tool effects remain unknown', () => {
  const { db, state, recovery } = fixture(); dispatch(state); call(db)
  state.updateAttempt({ ...state.attempt('old-attempt'), state: 'cancelled' })
  recovery.recover()
  expect(recovery.queryOperation('task', 'execution-old-attempt')).toMatchObject({ state: 'unknown', execution: 'cancelled' })
})

it('enumerates only incomplete input metadata with a bounded fixed read window', () => {
  const { db, state, recovery } = fixture()
  state.consume('input', 'routed', () => ({ route: 'known' }))
  for (let i = 1; i <= 3; i++) {
    db.prepare("INSERT INTO records VALUES (?,'task',?,'message.user',?,'time')").run(`input-record-${i}`, i + 1, JSON.stringify({ text: 'PRIVATE BODY' }))
    state.receive({ ...input, input_event_id: `input-${i}`, record_id: `input-record-${i}`, kind: 'query' })
  }
  state.consume('input-1', 'routed', () => ({})); state.consume('input-1', 'installed', () => ({}))
  const first = recovery.pendingInputs('task', undefined, 1)
  expect(first.items).toEqual([{ ...input, stage: 'routed' }])
  expect(first.next_cursor).toBeTypeOf('string')
  db.prepare("INSERT INTO records VALUES ('late-record','task',5,'message.user','{}','time')").run()
  state.receive({ ...input, input_event_id: 'late-input', record_id: 'late-record', kind: 'query' })
  const rest = recovery.pendingInputs('task', first.next_cursor!, 32)
  expect(rest.items.map(value => value.input_event_id)).toEqual(['input-2', 'input-3'])
  expect(rest.next_cursor).toBeNull()
  expect(JSON.stringify([first, rest])).not.toContain('PRIVATE BODY')
  expect(() => recovery.pendingInputs('other-task', first.next_cursor!)).toThrow()
  expect(() => new RunnerHostRecovery(db, 'third-epoch').pendingInputs('task', first.next_cursor!)).toThrow()
})

it('does not automatically resume input consumption or execution for a stopped Task', () => {
  const { db, recovery } = fixture(); db.prepare("UPDATE tasks SET state='stopped' WHERE id='task'").run()
  recovery.recover()
  expect(recovery.pendingInputs('task')).toEqual({ items: [], next_cursor: null })
  expect(() => recovery.resume(resumeInput(), resumeHost(db))).toThrow()
  expect(db.prepare("SELECT state FROM tasks WHERE id='task'").get()).toEqual({ state: 'stopped' })
})

it.each([true, false])('resumes a definitely undispatched work after startup=%s with cumulative identities', startup => {
  const { db, state, ledger, recovery } = fixture(), host = resumeHost(db)
  ledger.reserve('unused', 'budget', 'unused-operation', { tokens: 50 }, 'old-attempt')
  if (startup) recovery.recover()
  else db.prepare("UPDATE runs SET state='interrupted',commit_valid=0 WHERE id='old-run'").run()
  const result = recovery.resume(resumeInput(), host)
  expect(result.run).toMatchObject({ run_id: 'new-run', previous_run_id: 'old-run', budget_id: 'budget', runtime_epoch: 'new-epoch' })
  expect(result.works).toMatchObject([{ work_id: 'work', plan_revision: 2, max_attempts: 3, run_id: 'new-run' }])
  expect(result.attempts).toMatchObject([{ attempt_id: 'new-attempt', previous_attempt_id: 'old-attempt', attempt_number: 2, model_config_revision: 2 }])
  expect(state.attempt('old-attempt')).toMatchObject({ state: 'revoked', run_id: 'old-run', runtime_epoch: 'old-epoch' })
  expect(ledger.budget('budget').created_at).toBe(new Date(1000).toISOString())
  expect(host.recheck).toHaveBeenCalledOnce()
  expect(new RunnerWorkState(db, 'new-epoch', () => 2000).qualify('new-attempt', 'dispatch').run.budget_id).toBe('budget')
  expect(recovery.resume(resumeInput(), host).attempts[0]?.attempt_id).toBe('new-attempt')
  expect(host.installRun).toHaveBeenCalledOnce()
  expect(db.prepare('SELECT attempt_id FROM runner_attempts').all()).toHaveLength(2)
})

it('resumes never-attempted work with its first actual attempt while retaining the old Run', () => {
  const { db, recovery } = fixture(false); recovery.recover()
  const next = resumeInput(); next.attempts = [{ ...next.attempts[0]!, attempt_number: 1 }]; delete next.attempts[0]!.previous_attempt_id
  expect(recovery.resume(next, resumeHost(db)).attempts[0]?.attempt_number).toBe(1)
  expect(db.prepare('SELECT run_id FROM runner_runs').all()).toHaveLength(2)
})

it.each(['task', 'goal', 'budget', 'attempt-bound', 'model', 'materials', 'cancelled-request'] as const)('rejects resumption when the %s facts changed', reason => {
  const { db, state, recovery } = fixture(); recovery.recover()
  const next = resumeInput(), host = resumeHost(db)
  if (reason === 'task') db.prepare("UPDATE tasks SET state='stopped' WHERE id='task'").run()
  if (reason === 'goal') {
    db.prepare("INSERT INTO records VALUES ('correction-record','task',2,'message.user','{}','time')").run()
    const current = new RunnerWorkState(db, 'new-epoch'); current.receive({ ...input, input_event_id: 'correction', record_id: 'correction-record', kind: 'correction' }); current.installGoal({ ...goal, input_event_id: 'correction', intent_revision: 2, previous_revision: 1 })
  }
  if (reason === 'budget') next.run.budget_id = 'new-budget'
  if (reason === 'attempt-bound') {
    const value = { ...state.work('work'), max_attempts: 1 }; db.prepare('UPDATE runner_work SET payload_json=? WHERE work_id=?').run(JSON.stringify(value), value.work_id)
  }
  if (reason === 'cancelled-request') db.prepare("UPDATE requests SET state='cancelled' WHERE id='goal'").run()
  if (reason === 'model' || reason === 'materials') host.recheck = () => { throw Error(`${reason} changed`) }
  expect(() => recovery.resume(next, host)).toThrow()
  expect(db.prepare("SELECT id FROM runs WHERE id='new-run'").get()).toBeUndefined()
  expect(state.work('work').plan_revision).toBe(1)
})

it('resumes after legacy elapsed limits while retaining the original accounting identity', () => {
  const { db, ledger, recovery } = fixture(); recovery.recover()
  const original = ledger.budget('budget'), legacy = JSON.stringify({ model_requests: 0, tool_requests: 0, tokens: 0, wall_ms: 60000 })
  db.prepare("UPDATE runner_budgets SET limits_json=? WHERE budget_id='budget'").run(legacy)
  new RunnerHostRecovery(db, 'new-epoch', () => 61000).resume(resumeInput(), resumeHost(db))
  expect(new RunnerWorkState(db, 'new-epoch').run('new-run').budget_id).toBe('budget')
  expect(ledger.budget('budget')).toEqual(original)
  expect(db.prepare("SELECT limits_json FROM runner_budgets WHERE budget_id='budget'").get()).toEqual({ limits_json: legacy })
})

it('rolls back revocation and every new execution record when installation fails midway', () => {
  const { db, state, recovery } = fixture(); db.prepare("UPDATE runs SET state='interrupted',commit_valid=0 WHERE id='old-run'").run()
  const host = resumeHost(db), install = host.installRun
  host.installRun = (run, source) => { install(run, source); throw Error('crash after core Run') }
  expect(() => recovery.resume(resumeInput(), host)).toThrow('crash after core Run')
  expect(state.attempt('old-attempt').state).toBe('queued')
  expect(db.prepare("SELECT id FROM runs WHERE id='new-run'").get()).toBeUndefined()
  expect(db.prepare("SELECT attempt_id FROM runner_attempts WHERE attempt_id='new-attempt'").get()).toBeUndefined()
})

it('rejects asynchronous installation callbacks before committing new authority', () => {
  const { db, recovery } = fixture(); recovery.recover()
  const host = resumeHost(db); host.recheck = async () => {}
  expect(() => recovery.resume(resumeInput(), host)).toThrow(expect.objectContaining({ code: 'RUNNER_TRANSACTION_ASYNC' }))
  expect(db.prepare("SELECT id FROM runs WHERE id='new-run'").get()).toBeUndefined()
})

it('queries frozen publication mappings after acknowledgement loss without recreating a View', () => {
  const { db, recovery } = fixture()
  const resourceId = 'published-resource'
  db.prepare("INSERT INTO resources VALUES (?,?,'fixture',2,'application/json','Published','time')").run(resourceId, resourceId)
  db.prepare("INSERT INTO task_resources VALUES ('task',?)").run(resourceId)
  db.prepare("INSERT INTO surfaces VALUES ('surface','task',2,'{}')").run()
  db.prepare("INSERT INTO views VALUES ('view','surface',1,?,1,'{}','v1',NULL,0)").run(resourceId)
  db.prepare("INSERT INTO view_history VALUES ('view-history','task','view',1,?,'{}')").run(resourceId)
  db.prepare("INSERT INTO runner_artifact_owners VALUES ('artifact','task','work',1,'section',1)").run()
  db.prepare("INSERT INTO runner_candidates VALUES ('candidate','task','artifact','{}','{}')").run()
  db.prepare("INSERT INTO runner_artifacts VALUES ('task','artifact',1,'candidate',?,'{}')").run(resourceId)
  db.prepare("INSERT INTO runner_scopes VALUES ('task',1,'{}')").run()
  db.prepare("INSERT INTO runner_batches VALUES ('batch','task',1,'{}')").run()
  action(db, 'publication-action', 'ended', 'success')
  const plan = { intents: [{ artifact: { artifact_id: 'artifact', artifact_revision: 1 } }] }
  const result = { operation_id: 'publication', state: 'published', batch_id: 'batch', action_id: 'publication-action', surface_id: 'surface', surface_revision: 2, surface_history_id: 'surface-history', delivery_id: 'delivery' }
  db.prepare("INSERT INTO runner_publications VALUES ('publication','task','batch','publication-action','published',?,?)").run(JSON.stringify({ registration: { operation_id: 'publication', task_id: 'task', batch_id: 'batch', action_id: 'publication-action', plan } }), JSON.stringify(result))
  db.prepare("INSERT INTO runner_surface_history VALUES ('surface-history','task','surface',2,'publication-action',?)").run(JSON.stringify({ surface_history_id: 'surface-history', task_id: 'task', surface_id: 'surface', surface_revision: 2, action_id: 'publication-action', layout: {}, views: [{ view_id: 'view', view_revision: 1, view_history_id: 'view-history', state_revision: 1 }] }))
  const entry: PublicationEntry = { task_id: 'task', request_id: 'goal', intent_revision: 1, batch_id: 'batch', artifact_id: 'artifact', artifact_revision: 1, section_id: 'section', source_bundle_resource_id: resourceId, published_bundle_resource_id: resourceId, view_id: 'view', view_revision: 1, state_revision: 1, surface_history_id: 'surface-history' }
  db.prepare("INSERT INTO runner_view_mappings VALUES ('task','artifact',1,'batch','view',1,?,?,?)").run(resourceId, resourceId, JSON.stringify(entry))
  const original = recovery.queryOperation('task', 'publication')
  expect(original).toMatchObject({ state: 'known', execution: 'success', publication: result, publication_entries: [entry] })
  expect(recovery.queryOperation('task', 'publication')).toEqual(original)
  expect(db.prepare('SELECT id FROM views').all()).toEqual([{ id: 'view' }])
  db.prepare("DELETE FROM view_history WHERE id='view-history'").run()
  expect(() => recovery.queryOperation('task', 'publication')).toThrow(expect.objectContaining({ code: 'RUNNER_RECOVERY_FACTS_INVALID' }))
})
