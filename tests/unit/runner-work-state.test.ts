import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { afterEach, expect, it } from 'vitest'
import type { ExecutionAttempt, ContentPlan, InputEvent, LogicalWork, RunnerRun } from '../../src/shared/contracts.generated'
import { RunnerBudgetLedger } from '../../src/runtime/runner/budget'
import { RunnerArtifactState } from '../../src/runtime/runner/artifact-state'
import { RunnerWorkState } from '../../src/runtime/runner/work-state'
import { assignmentRevisions } from '../../src/runtime/runner/orchestration-plan'

const coreSql = readFileSync(new URL('../../src/shared/contracts/001-core.sql', import.meta.url), 'utf8')
const runnerSql = readFileSync(new URL('../../src/shared/contracts/002-runner.sql', import.meta.url), 'utf8')
const databases: Database.Database[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
const goal: ContentPlan = { task_id: 'task', request_id: 'goal', intent_revision: 1, input_event_id: 'input', state: 'active', requirements: [{ requirement_id: 'answer', kind: 'answer', required: true, provenance_required: false }] }
const input: InputEvent = { input_event_id: 'input', task_id: 'task', kind: 'request', record_id: 'record', request_id: 'goal', stage: 'received' }
function setup(install = true) {
  const db = new Database(':memory:'); databases.push(db)
  db.exec(coreSql); db.exec(runnerSql)
  db.prepare("INSERT INTO tasks(id,title,state,revision) VALUES ('task','Task','active',1)").run()
  db.prepare("INSERT INTO requests(id,task_id,state,config_selection_json,input_json,created_at) VALUES ('goal','task','started','{}','{}','time')").run()
  db.prepare("INSERT INTO records(id,task_id,sequence,kind,payload_json,created_at) VALUES ('record','task',1,'message.user','{}','time')").run()
  const state = new RunnerWorkState(db, 'epoch', () => 1000)
  state.receive(input)
  if (install) state.installGoal(goal)
  const ledger = new RunnerBudgetLedger(db, () => 1000)
  ledger.create({ budget_id: 'budget', task_id: 'task', purpose: 'production', request_id: 'goal', limits: { model_requests: 10, tool_requests: 10, tokens: 1000, wall_ms: 60000 } })
  return { db, state, ledger }
}
function register(db: Database.Database, state: RunnerWorkState, id = 'run', epoch = 'epoch', previous?: string): RunnerRun {
  db.prepare("INSERT INTO runs(id,task_id,request_id,state,runtime_epoch,limits_json,budget_json,created_at) VALUES (?,'task','goal','running',?,'{}','{}','time')").run(id, epoch)
  return state.registerRun({ run_id: id, task_id: 'task', runtime_epoch: epoch, state: 'running', commit_valid: true, budget_id: 'budget', purpose: 'production', request_id: 'goal', intent_revision: 1, ...(previous ? { previous_run_id: previous } : {}) })
}
function work(id = 'work', changes: Partial<LogicalWork> = {}): LogicalWork {
  return { work_id: id, task_id: 'task', run_id: 'run', plan_revision: 1, role: 'producer', required: true, requirement_ids: ['answer'], dependencies: [{ kind: 'goal', task_id: 'task', request_id: 'goal', intent_revision: 1 }], state: 'planned', max_attempts: 2, purpose: 'production', request_id: 'goal', intent_revision: 1, ...changes } as LogicalWork
}
function attempt(id = 'attempt', changes: Partial<ExecutionAttempt> = {}): ExecutionAttempt {
  return { attempt_id: id, task_id: 'task', run_id: 'run', work_id: 'work', runtime_epoch: 'epoch', attempt_number: 1, profile_id: 'producer', model_config_id: 'model', model_config_revision: 1, input_versions: work().dependencies, state: 'registered', dispatch_state: 'not_dispatched', usage_refs: [], purpose: 'production', request_id: 'goal', intent_revision: 1, ...changes } as ExecutionAttempt
}
function dispatch(state: RunnerWorkState, id = 'attempt'): ExecutionAttempt {
  return state.updateAttempt({ ...state.attempt(id), state: 'dispatched', dispatch_state: 'dispatched', operation_id: `operation-${id}` })
}
function nextInput(db: Database.Database, state: RunnerWorkState, kind: InputEvent['kind'] = 'correction', id = 'correction'): InputEvent {
  db.prepare("INSERT INTO records(id,task_id,sequence,kind,payload_json,created_at) VALUES (?,'task',?,'message.user','{}','time')").run(`record-${id}`, Number((db.prepare('SELECT MAX(sequence) n FROM records').get() as { n: number }).n) + 1)
  return state.receive({ ...input, input_event_id: id, record_id: `record-${id}`, kind })
}
function independentGoal(db: Database.Database, state: RunnerWorkState, id = 'other'): void {
  db.prepare("INSERT INTO requests(id,task_id,state,config_selection_json,input_json,created_at) VALUES (?,'task','started','{}','{}','time')").run(id)
  db.prepare("INSERT INTO records(id,task_id,sequence,kind,payload_json,created_at) VALUES (?,'task',?,'message.user','{}','time')").run(`record-${id}`, Number((db.prepare('SELECT MAX(sequence) n FROM records').get() as { n: number }).n) + 1)
  state.receive({ ...input, input_event_id: `input-${id}`, request_id: id, record_id: `record-${id}` })
  state.installGoal({ ...goal, request_id: id, input_event_id: `input-${id}` })
  new RunnerBudgetLedger(db).create({ budget_id: `budget-${id}`, task_id: 'task', purpose: 'production', request_id: id, limits: { model_requests: 10, tool_requests: 10, tokens: 1000, wall_ms: 60000 } })
  db.prepare("INSERT INTO runs(id,task_id,request_id,state,runtime_epoch,limits_json,budget_json,created_at) VALUES (?,'task',?,'running','epoch','{}','{}','time')").run(`run-${id}`, id)
  state.registerRun({ run_id: `run-${id}`, task_id: 'task', runtime_epoch: 'epoch', state: 'running', commit_valid: true, budget_id: `budget-${id}`, purpose: 'production', request_id: id, intent_revision: 1 })
}
function acceptArtifact(db: Database.Database, state: RunnerWorkState): RunnerArtifactState {
  state.updateAttempt({ ...state.attempt('attempt'), state: 'running' })
  const artifacts = new RunnerArtifactState(db, state)
  artifacts.installOutline({ task_id: 'task', outline_revision: 1, base_outline_revision: 0, sections: [{ section_id: 'section', request_id: 'goal', intent_revision: 1, position_revision: 1, order_key: 'a' }] })
  artifacts.assign([{ task_id: 'task', artifact_id: 'artifact', work_id: 'work', plan_revision: 1, section_id: 'section', base_artifact_revision: 0 }])
  db.prepare("INSERT INTO resources(id,storage_key,sha256,byte_length,media_type,display_name,created_at) VALUES ('body','body.json','fixture',2,'application/json','Body','time')").run()
  db.prepare("INSERT INTO task_resources(task_id,resource_id) VALUES ('task','body')").run()
  expect(artifacts.decide({ candidate_id: 'candidate', task_id: 'task', request_id: 'goal', intent_revision: 1, run_id: 'run', work_id: 'work', attempt_id: 'attempt', artifact_id: 'artifact', plan_revision: 1, base_artifact_revision: 0, bundle_resource_id: 'body', section_id: 'section', section_position_revision: 1, order_key: 'a', presentation_kind: 'managed-v1', width_constraint: 'full', interaction_kind: 'none', provenance_ref: { task_id: 'task', kind: 'record', id: 'record' }, dependencies: work().dependencies, requirement_ids: ['answer'], unresolved: [] }, { state: 'accepted' }).state).toBe('accepted')
  return artifacts
}

it('installs each input stage and business mutation atomically and repeats the original result after restart', () => {
  const { db, state } = setup(false)
  let routes = 0, installs = 0
  expect(() => state.consume('input', 'installed', () => null)).toThrow(/stages/)
  const routed = state.consume('input', 'routed', () => { routes++; return { route: 'direct', request_id: 'goal' } })
  expect(routed).toEqual({ route: 'direct', request_id: 'goal' })
  expect(() => state.consume('input', 'installed', () => { state.installGoal(goal); throw Error('interrupted') })).toThrow('interrupted')
  expect(state.consumption('input', 'installed')).toBeNull()
  expect(db.prepare('SELECT * FROM runner_content_plans').all()).toHaveLength(0)
  const restarted = new RunnerWorkState(db, 'new-epoch', () => 2000)
  expect(restarted.input('input').stage).toBe('routed')
  const result = restarted.consume('input', 'installed', () => { installs++; restarted.installGoal(goal); return { request_id: 'goal', intent_revision: 1 } })
  expect(restarted.consume('input', 'installed', () => { installs++; throw Error('must not repeat') })).toEqual(result)
  expect(restarted.consume('input', 'routed', () => { routes++; return null })).toEqual(routed)
  expect([routes, installs]).toEqual([1, 1])
  expect(restarted.receive(input).stage).toBe('installed')
  expect(db.prepare('SELECT * FROM runner_content_plans').all()).toHaveLength(1)
  expect(db.prepare('SELECT * FROM runner_consumptions').all()).toHaveLength(3)
})

it('rolls back an installation whose acknowledgement is not synchronous finite JSON', () => {
  const { db, state } = setup(false)
  state.consume('input', 'routed', () => null)
  const invalidResults: unknown[] = [undefined, { bad: NaN }, Promise.resolve('later')]
  for (const result of invalidResults) {
    expect(() => state.consume('input', 'installed', () => { state.installGoal(goal); return result })).toThrow(/JSON/)
    expect(db.prepare('SELECT * FROM runner_content_plans').all()).toHaveLength(0)
    expect(state.consumption('input', 'installed')).toBeNull()
  }
})

it('rejects async installers before they start and excludes Promise and PromiseLike return types', async () => {
  const { db, state } = setup(false)
  state.consume('input', 'routed', () => null)
  let started = false
  expect(() => {
    // @ts-expect-error Asynchronous installation cannot participate in the synchronous transaction.
    state.consume('input', 'installed', async () => {
      started = true
      await Promise.resolve()
      state.installGoal(goal)
      return { request_id: 'goal' }
    })
  }).toThrow(/synchronous/)
  await Promise.resolve()
  expect(started).toBe(false)
  expect(state.consumption('input', 'installed')).toBeNull()
  expect(db.prepare('SELECT * FROM runner_content_plans').all()).toHaveLength(0)
  expect(() => {
    // @ts-expect-error A normal function returning a Promise is also an invalid installer.
    state.consume('input', 'installed', () => Promise.resolve(null))
  }).toThrow(/JSON/)
  const fulfilled = Promise.resolve(null)
  const thenable: PromiseLike<null> = { then: fulfilled.then.bind(fulfilled) }
  expect(() => {
    // @ts-expect-error PromiseLike results cannot be persisted as synchronous installation results.
    state.consume('input', 'installed', () => thenable)
  }).toThrow(/JSON/)
  expect(state.consumption('input', 'installed')).toBeNull()
  expect(db.prepare('SELECT * FROM runner_content_plans').all()).toHaveLength(0)
})

it('preserves original input ownership and immutable identities', () => {
  const { db, state } = setup()
  db.prepare("INSERT INTO tasks(id,title,state,revision) VALUES ('other','Other','active',1)").run()
  db.prepare("INSERT INTO records(id,task_id,sequence,kind,payload_json,created_at) VALUES ('foreign','other',1,'message.user','{}','time')").run()
  expect(() => state.receive({ ...input, input_event_id: 'foreign-input', record_id: 'foreign' })).toThrow(/Original input/)
  expect(() => state.receive({ ...input, kind: 'query' })).toThrow(/bindings/)
  expect(() => state.receive({ ...input, input_event_id: 'late', stage: 'installed' })).toThrow(/received/)
  expect(db.prepare('SELECT * FROM runner_inputs').all()).toHaveLength(1)
})

it('uses exact goal CAS while retaining history and rejecting query-driven revisions', () => {
  const { db, state } = setup()
  nextInput(db, state)
  const second: ContentPlan = { ...goal, intent_revision: 2, previous_revision: 1, input_event_id: 'correction' }
  expect(() => state.installGoal(second, 0)).toThrow(/predecessor/)
  expect(state.installGoal(second, 1)).toEqual(second)
  expect(state.installGoal(goal)).toEqual(goal)
  expect(state.goal('goal').intent_revision).toBe(2)
  expect(state.goal('goal', 1)).toEqual(goal)
  expect(() => state.installGoal({ ...second, requirements: [] })).toThrow(/overwritten/)
  nextInput(db, state, 'query', 'query')
  expect(() => state.installGoal({ ...second, intent_revision: 3, previous_revision: 2, input_event_id: 'query' })).toThrow(/targeted goal/)
  expect(state.goal('goal').intent_revision).toBe(2)
})

it('allows several historical Runs while the database permits one active production Run per request', () => {
  const { db, state, ledger } = setup()
  const original = register(db, state)
  expect(state.registerRun(original)).toEqual(original)
  expect(() => register(db, state, 'duplicate')).toThrow(/UNIQUE/)
  ledger.reserve('reservation', 'budget', 'operation', { tokens: 100 })
  db.prepare("UPDATE runs SET state='interrupted',commit_valid=0 WHERE id='run'").run()
  const resumed = register(db, state, 'resumed', 'epoch', 'run')
  expect(resumed.previous_run_id).toBe('run')
  expect(state.run('run')).toMatchObject({ state: 'interrupted', commit_valid: false })
  expect(db.prepare('SELECT * FROM runner_runs WHERE request_id=?').all('goal')).toHaveLength(2)
  expect(ledger.snapshot('budget').total.tokens).toBe(100)
  expect(() => state.registerRun({ ...resumed, budget_id: 'different' })).toThrow(/bindings/)
})

it('rejects invalid plans atomically and preserves an attempt on duplicate plan installation', () => {
  const { db, state } = setup(); register(db, state)
  const a = work('a', { dependencies: [{ kind: 'work', task_id: 'task', work_id: 'b', result_revision: 1 }] })
  const b = work('b', { dependencies: [{ kind: 'work', task_id: 'task', work_id: 'a', result_revision: 1 }] })
  expect(() => state.installPlan([a, b])).toThrow(/DAG/)
  expect(() => state.installPlan([a])).toThrow(/does not exist/)
  expect(state.taskWorks('task')).toEqual([])
  state.installPlan([work()]); state.createAttempt(attempt())
  expect(state.installPlan([work()])[0]).toMatchObject({ current_attempt_id: 'attempt', state: 'queued' })
  expect(state.attempts('work')).toHaveLength(1)
  expect(() => state.installPlan([work('foreign', { requirement_ids: ['unowned'] })])).toThrow(/requirements/)
})

it('revises a branch without changing its user authority, priority or independent work', () => {
  const { db, state } = setup(); register(db, state)
  const assigned = (key: string, inputs: Array<{ work_id: string; plan_revision: number; output_key: string }> = []) => ({
    ...work(key), purpose: 'production' as const, request_id: 'goal', intent_revision: 1,
    assignment: { instructions: key, inputs, outputs: [{ kind: 'answer' as const, output_key: 'answer' }] },
    dependencies: [...work().dependencies, ...inputs.map(input => ({ kind: 'work' as const, task_id: 'task', work_id: input.work_id, result_revision: 1 }))]
  })
  const upstream = { work_id: 'source', plan_revision: 1, output_key: 'answer' }
  const initial = [assigned('source'), assigned('consumer', [upstream]), assigned('independent')]
  state.installPlan(initial)
  const propose = (workId: string, input: typeof upstream) => assignmentRevisions({ action: 'bind', base_revision: 1, work_id: workId, input }, initial, binding => initial.find(work => work.work_id === binding.work_id)!)
  expect(() => state.installAssignmentRevisions(propose('source', { ...upstream, work_id: 'consumer' }))).toThrow(/DAG/)
  expect(state.taskWorks('task')).toEqual(initial)
  const revised = propose('consumer', { ...upstream, work_id: 'independent' })[0]!
  expect(() => state.installAssignmentRevisions([{ ...revised, required: false }])).toThrow(/priority/)
  expect(() => state.installAssignmentRevisions([{ ...revised, dependencies: revised.dependencies.filter(input => input.kind !== 'goal') }])).toThrow(/authority/)
  expect(state.taskWorks('task')).toEqual(initial)
  state.installAssignmentRevisions([revised])
  expect(state.taskWorks('task')).toEqual([initial[0], revised, initial[2]])
  expect(() => state.installAssignmentRevisions([revised])).toThrow(/authority/)
})

it('holds downstream work until its exact successful input exists and rechecks revisions before commit', () => {
  const { db, state } = setup(); register(db, state)
  const downstream = work('downstream', { dependencies: [{ kind: 'work', task_id: 'task', work_id: 'work', result_revision: 1 }] })
  state.installPlan([work(), downstream])
  const child = attempt('child', { work_id: 'downstream', input_versions: downstream.dependencies })
  expect(() => state.createAttempt(child)).toThrow(/exact result/)
  state.createAttempt(attempt()); dispatch(state)
  state.updateAttempt({ ...state.attempt('attempt'), state: 'succeeded' })
  state.createAttempt(child)
  expect(state.qualify('child', 'dispatch').work.work_id).toBe('downstream')
  nextInput(db, state)
  state.installGoal({ ...goal, intent_revision: 2, previous_revision: 1, input_event_id: 'correction' })
  expect(() => state.qualify('child')).toThrow(/revision/)
  expect(state.attempt('attempt').state).toBe('succeeded')
})

it('revokes only consumers holding a superseded exact output', () => {
  const { db, state } = setup(); register(db, state)
  const source = { ...work(), purpose: 'production' as const, request_id: 'goal', intent_revision: 1,
    assignment: { instructions: 'Source', inputs: [], outputs: [{ kind: 'answer' as const, output_key: 'value' }] } }
  const consumer = { ...source, work_id: 'consumer', assignment: { ...source.assignment, inputs: [{ work_id: 'work', plan_revision: 1, output_key: 'value' }] },
    dependencies: [...source.dependencies, { kind: 'work' as const, task_id: 'task', work_id: 'work', result_revision: 1 }] }
  state.installPlan([source, consumer, work('independent')])
  state.createAttempt(attempt()); dispatch(state)
  state.updateAttempt({ ...state.attempt('attempt'), state: 'succeeded' })
  state.createAttempt(attempt('consumer-attempt', { work_id: consumer.work_id, input_versions: consumer.dependencies }))
  state.createAttempt(attempt('independent-attempt', { work_id: 'independent' }))
  db.prepare("INSERT INTO records(id,task_id,sequence,kind,payload_json,created_at) VALUES ('handoff','task',2,'runner.output.handoff',?,'time')").run(JSON.stringify({ work_id: 'work', plan_revision: 1, result_revision: 1, output_key: 'value', consumer_work_id: 'consumer', consumer_attempt_id: 'consumer-attempt' }))
  expect(state.qualify('consumer-attempt', 'dispatch').work.work_id).toBe('consumer')
  state.installPlan([{ ...source, plan_revision: 2 }])
  expect(state.reconcileDependencies('task').map(work => work.work_id)).toEqual(['consumer'])
  expect(state.attempt('consumer-attempt').state).toBe('revoked')
  expect(state.qualify('independent-attempt', 'dispatch').work.plan_revision).toBe(1)
  expect(state.attempt('attempt').state).toBe('succeeded')
})

it('retains bounded attempts and unknown operation evidence without permitting a replay', () => {
  const { db, state } = setup(); register(db, state); state.installPlan([work()]); state.createAttempt(attempt()); dispatch(state)
  state.updateAttempt({ ...state.attempt('attempt'), state: 'failed' }, work('work', { plan_revision: 2, state: 'queued' }))
  expect(state.work('work').state).toBe('queued')
  const second = attempt('second', { attempt_number: 2, previous_attempt_id: 'attempt' })
  state.createAttempt(second); dispatch(state, 'second')
  state.updateAttempt({ ...state.attempt('second'), state: 'unknown', dispatch_state: 'unknown' })
  expect(() => state.createAttempt(attempt('third', { attempt_number: 3, previous_attempt_id: 'second' }))).toThrow(/bound/)
  expect(() => state.qualify('second')).toThrow(/authority/)
  expect(() => state.updateAttempt({ ...state.attempt('second'), state: 'running', dispatch_state: 'dispatched' })).toThrow(/chapter/)
  expect(() => state.updateAttempt({ ...state.attempt('second'), state: 'queued', dispatch_state: 'not_dispatched' })).toThrow(/overwritten/)
  expect(() => state.createAttempt({ ...second, model_config_id: 'different' })).toThrow(/inputs/)
  expect(state.attempt('attempt')).toMatchObject({ state: 'failed', operation_id: 'operation-attempt' })
  expect(state.createAttempt(attempt())).toMatchObject({ state: 'failed', operation_id: 'operation-attempt' })
  expect(state.attempts('work')).toHaveLength(2)
})

it('finalizes a known failure without an installed successor even when attempts remain', () => {
  const { db, state } = setup(); register(db, state); state.installPlan([work()]); state.createAttempt(attempt()); dispatch(state)
  state.updateAttempt({ ...state.attempt('attempt'), state: 'failed' })
  expect(state.work('work')).toMatchObject({ state: 'failed', max_attempts: 2, root_cause: { kind: 'failure', work_id: 'work', attempt_id: 'attempt', operation_id: 'operation-attempt' } })
  expect(() => state.createAttempt(attempt('second', { attempt_number: 2, previous_attempt_id: 'attempt' }))).toThrow(/eligible/)
  expect(() => state.installPlan([work('work', { plan_revision: 2 })])).toThrow(/revive/)
})

it.each([
  { name: 'unchanged revision', plan: work('work', { plan_revision: 1 }) },
  { name: 'skipped revision', plan: work('work', { plan_revision: 3 }) },
  { name: 'different work', plan: work('other', { plan_revision: 2 }) },
  { name: 'expanded bound', plan: work('work', { plan_revision: 2, max_attempts: 3 }) },
  { name: 'exhausted bound', plan: work('work', { plan_revision: 2, max_attempts: 1 }) },
  { name: 'stale dependency', plan: work('work', { plan_revision: 2, dependencies: [{ kind: 'goal', task_id: 'task', request_id: 'goal', intent_revision: 2 }] }) }
])('rolls back failure and invalid retry plan together: $name', ({ plan }) => {
  const { db, state } = setup(); register(db, state); state.installPlan([work()]); state.createAttempt(attempt()); dispatch(state)
  expect(() => state.updateAttempt({ ...state.attempt('attempt'), state: 'failed' }, plan)).toThrow()
  expect(state.attempt('attempt').state).toBe('dispatched')
  expect(state.work('work')).toMatchObject({ state: 'running', plan_revision: 1, current_attempt_id: 'attempt' })
})

it('resumes a logical work under new Run and epoch identities without resetting attempt or budget history', () => {
  const { db, state, ledger } = setup(); register(db, state); state.installPlan([work()]); state.createAttempt(attempt()); dispatch(state)
  ledger.reserve('reservation', 'budget', 'operation-attempt', { tokens: 100 }, 'attempt')
  ledger.markDispatched('reservation'); ledger.settle('reservation', { tokens: 80 })
  state.updateAttempt({ ...state.attempt('attempt'), state: 'failed' }, work('work', { plan_revision: 2, state: 'queued' }))
  db.prepare("UPDATE runs SET state='interrupted',commit_valid=0 WHERE id='run'").run()
  const restarted = new RunnerWorkState(db, 'new-epoch', () => 2000)
  register(db, restarted, 'resumed', 'new-epoch', 'run')
  restarted.installPlan([work('work', { run_id: 'resumed', plan_revision: 3 })])
  const next = attempt('resumed-attempt', { run_id: 'resumed', runtime_epoch: 'new-epoch', attempt_number: 2, previous_attempt_id: 'attempt' })
  restarted.createAttempt(next)
  expect(restarted.qualify('resumed-attempt', 'dispatch')).toMatchObject({ runtime_epoch: 'new-epoch', run: { previous_run_id: 'run', budget_id: 'budget' } })
  expect(restarted.attempt('attempt')).toMatchObject({ runtime_epoch: 'epoch', run_id: 'run', state: 'failed' })
  expect(ledger.snapshot('budget').total.tokens).toBe(80)
  expect(() => restarted.qualify('attempt')).toThrow(/permits/)
})

it('does not revive cancelled work or allow stopped Tasks and late epochs to commit', () => {
  const { db, state } = setup(); register(db, state); state.installPlan([work()]); state.createAttempt(attempt())
  state.updateAttempt({ ...state.attempt('attempt'), state: 'cancelled' })
  expect(state.work('work').state).toBe('cancelled')
  expect(() => state.createAttempt(attempt('replacement', { attempt_number: 2, previous_attempt_id: 'attempt' }))).toThrow(/eligible/)
  expect(() => state.installPlan([work('work', { plan_revision: 2 })])).toThrow(/revive/)
  state.installPlan([work('other')]); state.createAttempt(attempt('other-attempt', { work_id: 'other' }))
  expect(() => new RunnerWorkState(db, 'later-epoch').qualify('other-attempt')).toThrow(/permits/)
  db.prepare("UPDATE tasks SET state='stopped' WHERE id='task'").run()
  expect(() => state.qualify('other-attempt')).toThrow(/active/)
})

it('closes dispatch and commit authority without installing a core terminal state', () => {
  const { db, state } = setup(); const original = register(db, state)
  state.installPlan([work()]); state.createAttempt(attempt())
  db.prepare("UPDATE runs SET state='waiting' WHERE id='run'").run()
  expect(state.closeRun('run')).toMatchObject({ state: 'closing', commit_valid: false })
  expect(db.prepare("SELECT state,commit_valid FROM runs WHERE id='run'").get()).toEqual({ state: 'waiting', commit_valid: 0 })
  expect(() => state.qualify('attempt', 'dispatch')).toThrow(/permits/)
  expect(() => state.qualify('attempt')).toThrow(/permits/)
  expect(() => state.createAttempt(attempt('new', { work_id: 'work' }))).toThrow(/permits/)
  expect(() => state.installPlan([work('new-work')])).toThrow(/permits/)
  expect(state.attempt('attempt')).toMatchObject({ state: 'registered', dispatch_state: 'not_dispatched' })
  expect(state.closeRun('run')).toEqual(state.registerRun(original))
  expect(() => state.registerRun({ ...original, budget_id: 'different' })).toThrow(/bindings/)
})

it('revokes only a work dependency closure and retains its cancellation root', () => {
  const { db, state } = setup(); register(db, state)
  const child = work('child', { dependencies: [{ kind: 'work', task_id: 'task', work_id: 'work', result_revision: 1 }] })
  const leaf = work('leaf', { dependencies: [{ kind: 'work', task_id: 'task', work_id: 'child', result_revision: 1 }] })
  state.installPlan([work(), child, leaf, work('independent')]); state.createAttempt(attempt())
  const first = state.revokeWork('work')
  expect(first.map(item => item.work_id)).toEqual(['work', 'child', 'leaf'])
  expect(state.work('work')).toMatchObject({ state: 'cancelled', root_cause: { kind: 'cancellation', work_id: 'work', attempt_id: 'attempt' } })
  for (const id of ['child', 'leaf']) expect(state.work(id)).toMatchObject({ state: 'dependency_cancelled', root_cause: state.work('work').root_cause })
  expect(state.attempt('attempt')).toMatchObject({ state: 'revoked', dispatch_state: 'not_dispatched' })
  expect(state.attempts('child')).toEqual([])
  expect(state.attempts('leaf')).toEqual([])
  expect(state.work('independent').state).toBe('planned')
  expect(state.run('run')).toMatchObject({ state: 'running', commit_valid: true })
  expect(state.revokeWork('work')).toEqual(first)
  expect(() => state.createAttempt(attempt('replacement', { attempt_number: 2, previous_attempt_id: 'attempt' }))).toThrow(/eligible/)
})

it.each(['running', 'unknown'] as const)('preserves dispatched %s execution evidence after logical revocation', execution => {
  const { db, state } = setup(); register(db, state); state.installPlan([work()]); state.createAttempt(attempt()); dispatch(state)
  state.updateAttempt({ ...state.attempt('attempt'), state: execution, dispatch_state: execution === 'unknown' ? 'unknown' : 'dispatched', usage_refs: ['usage'] })
  const before = state.attempt('attempt')
  state.revokeWork('work')
  expect(state.attempt('attempt')).toEqual(before)
  expect(() => state.qualify('attempt')).toThrow(/authority/)
  state.updateAttempt({ ...state.attempt('attempt'), state: 'succeeded', dispatch_state: 'dispatched', result_ref: { task_id: 'task', kind: 'record', id: 'record' } })
  expect(state.work('work')).toMatchObject({ state: 'cancelled', root_cause: { kind: 'cancellation', work_id: 'work', operation_id: 'operation-attempt' } })
  expect(state.work('work').result_revision).toBeUndefined()
  expect(state.attempt('attempt')).toMatchObject({ state: 'succeeded', usage_refs: ['usage'] })
})

it('propagates final failure through actual downstream work without inventing calls', () => {
  const { db, state } = setup(); register(db, state)
  const child = work('child', { dependencies: [{ kind: 'work', task_id: 'task', work_id: 'work', result_revision: 1 }] })
  const leaf = work('leaf', { dependencies: [{ kind: 'work', task_id: 'task', work_id: 'child', result_revision: 1 }] })
  state.installPlan([work('work', { max_attempts: 1 }), child, leaf, work('independent')]); state.createAttempt(attempt()); dispatch(state)
  state.updateAttempt({ ...state.attempt('attempt'), state: 'failed' })
  expect(state.reconcileDependencies('task').map(item => item.work_id)).toEqual(['child', 'leaf'])
  for (const id of ['child', 'leaf']) expect(state.work(id)).toMatchObject({ state: 'dependency_failed', root_cause: { kind: 'failure', work_id: 'work', attempt_id: 'attempt', operation_id: 'operation-attempt' } })
  expect(state.attempts('child')).toEqual([])
  expect(state.work('independent').state).toBe('planned')
  expect(state.reconcileDependencies('task')).toEqual([])
  state.revokeWork('work')
  expect(state.work('work').state).toBe('failed')
  expect(state.work('child').state).toBe('dependency_failed')
})

it('does not propagate an attempt failure while its installed retry remains', () => {
  const { db, state } = setup(); register(db, state)
  const child = work('child', { dependencies: [{ kind: 'work', task_id: 'task', work_id: 'work', result_revision: 1 }] })
  state.installPlan([work(), child]); state.createAttempt(attempt()); dispatch(state)
  state.updateAttempt({ ...state.attempt('attempt'), state: 'failed' }, work('work', { plan_revision: 2, state: 'queued' }))
  expect(state.reconcileDependencies('task')).toEqual([])
  expect(state.work('child').state).toBe('planned')
  state.createAttempt(attempt('second', { attempt_number: 2, previous_attempt_id: 'attempt' })); dispatch(state, 'second')
  state.updateAttempt({ ...state.attempt('second'), state: 'succeeded' })
  state.createAttempt(attempt('child-attempt', { work_id: 'child', input_versions: child.dependencies }))
  expect(state.qualify('child-attempt', 'dispatch').work.work_id).toBe('child')
})

it('chooses failure over cancellation when both dependencies are already final', () => {
  const { db, state } = setup(); register(db, state)
  const cancelled = work('cancelled'), failed = work('failed', { max_attempts: 1 })
  const child = work('child', { dependencies: [{ kind: 'work', task_id: 'task', work_id: 'cancelled', result_revision: 1 }, { kind: 'work', task_id: 'task', work_id: 'failed', result_revision: 1 }] })
  state.installPlan([cancelled, failed, child])
  state.createAttempt(attempt('cancel-attempt', { work_id: 'cancelled' }))
  state.updateAttempt({ ...state.attempt('cancel-attempt'), state: 'cancelled' })
  state.createAttempt(attempt('fail-attempt', { work_id: 'failed' })); dispatch(state, 'fail-attempt')
  state.updateAttempt({ ...state.attempt('fail-attempt'), state: 'failed' })
  state.reconcileDependencies('task')
  expect(state.work('child')).toMatchObject({ state: 'dependency_failed', root_cause: { kind: 'failure', work_id: 'failed' } })
  expect(state.work('cancelled').state).toBe('cancelled')
})

it('preserves successful work history when cancellation arrives later', () => {
  const { db, state } = setup(); register(db, state)
  const child = work('child', { dependencies: [{ kind: 'work', task_id: 'task', work_id: 'work', result_revision: 1 }] })
  state.installPlan([work(), child]); state.createAttempt(attempt()); dispatch(state)
  state.updateAttempt({ ...state.attempt('attempt'), state: 'succeeded' })
  const completed = state.work('work'), completedAttempt = state.attempt('attempt')
  expect(state.revokeWork('work')).toEqual([completed])
  expect(state.work('work')).toEqual(completed)
  expect(state.attempt('attempt')).toEqual(completedAttempt)
  expect(state.work('child').state).toBe('planned')
})

it('revokes a whole Run and its actual downstream while another goal keeps authority', () => {
  const { db, state } = setup(); register(db, state); independentGoal(db, state)
  state.installPlan([work(), work('optional', { required: false })]); state.createAttempt(attempt()); dispatch(state)
  state.updateAttempt({ ...state.attempt('attempt'), state: 'succeeded' })
  const child = work('child', { run_id: 'run-other', request_id: 'other', dependencies: [{ kind: 'work', task_id: 'task', work_id: 'work', result_revision: 1 }] })
  const independent = work('independent', { run_id: 'run-other', request_id: 'other', dependencies: [{ kind: 'goal', task_id: 'task', request_id: 'other', intent_revision: 1 }] })
  state.installPlan([child, independent])
  state.createAttempt(attempt('optional-attempt', { work_id: 'optional' }))
  state.revokeRun('run')
  expect(state.run('run')).toMatchObject({ state: 'closing', commit_valid: false })
  expect(state.work('work').state).toBe('succeeded')
  expect(state.work('optional').state).toBe('cancelled')
  expect(state.attempt('optional-attempt')).toMatchObject({ state: 'revoked', dispatch_state: 'not_dispatched' })
  expect(state.work('child')).toMatchObject({ state: 'dependency_cancelled', root_cause: { work_id: 'work', kind: 'cancellation' } })
  expect(state.work('independent').state).toBe('planned')
  expect(state.run('run-other')).toMatchObject({ state: 'running', commit_valid: true })
  state.createAttempt(attempt('independent-attempt', { work_id: 'independent', run_id: 'run-other', request_id: 'other', input_versions: independent.dependencies }))
  expect(state.qualify('independent-attempt', 'dispatch').work.work_id).toBe('independent')
})

it('does not rewrite an ended Run or extend a late cancellation to another Run', () => {
  const { db, state } = setup(); register(db, state); independentGoal(db, state)
  state.installPlan([work()]); state.createAttempt(attempt()); dispatch(state)
  state.updateAttempt({ ...state.attempt('attempt'), state: 'succeeded' })
  const child = work('child', { run_id: 'run-other', request_id: 'other', dependencies: [{ kind: 'work', task_id: 'task', work_id: 'work', result_revision: 1 }] })
  state.installPlan([child])
  db.prepare("UPDATE runs SET state='completed',commit_valid=0 WHERE id='run'").run()
  const before = state.run('run')
  expect(state.closeRun('run')).toEqual(before)
  state.revokeRun('run')
  expect(state.run('run')).toEqual(before)
  expect(state.work('child').state).toBe('planned')
})

it('invalidates only corrected goal inputs and their actual downstream', () => {
  const { db, state } = setup(); register(db, state); independentGoal(db, state)
  state.installPlan([work()]); state.createAttempt(attempt())
  const child = work('child', { run_id: 'run-other', request_id: 'other', dependencies: [{ kind: 'work', task_id: 'task', work_id: 'work', result_revision: 1 }] })
  const independent = work('independent', { run_id: 'run-other', request_id: 'other', dependencies: [{ kind: 'goal', task_id: 'task', request_id: 'other', intent_revision: 1 }] })
  state.installPlan([child, independent])
  nextInput(db, state); state.installGoal({ ...goal, intent_revision: 2, previous_revision: 1, input_event_id: 'correction' })
  expect(state.reconcileDependencies('task').map(item => item.work_id)).toEqual(['work', 'child'])
  expect(state.work('work')).toMatchObject({ state: 'invalidated', root_cause: { kind: 'invalidation', work_id: 'work' } })
  expect(state.work('child')).toMatchObject({ state: 'invalidated', root_cause: state.work('work').root_cause })
  expect(state.attempt('attempt').state).toBe('revoked')
  expect(state.work('independent').state).toBe('planned')
})

it('rechecks transitive input revisions through successful historical work', () => {
  const { db, state } = setup(); register(db, state); independentGoal(db, state)
  state.installPlan([work()]); state.createAttempt(attempt()); dispatch(state)
  state.updateAttempt({ ...state.attempt('attempt'), state: 'succeeded' })
  const bridge = work('bridge', { run_id: 'run-other', request_id: 'other', dependencies: [{ kind: 'work', task_id: 'task', work_id: 'work', result_revision: 1 }] })
  const child = work('child', { run_id: 'run-other', request_id: 'other', dependencies: [{ kind: 'work', task_id: 'task', work_id: 'bridge', result_revision: 1 }] })
  state.installPlan([bridge, child])
  state.createAttempt(attempt('bridge-attempt', { work_id: 'bridge', run_id: 'run-other', request_id: 'other', input_versions: bridge.dependencies })); dispatch(state, 'bridge-attempt')
  state.updateAttempt({ ...state.attempt('bridge-attempt'), state: 'succeeded' })
  state.createAttempt(attempt('child-attempt', { work_id: 'child', run_id: 'run-other', request_id: 'other', input_versions: child.dependencies }))
  nextInput(db, state); state.installGoal({ ...goal, intent_revision: 2, previous_revision: 1, input_event_id: 'correction' })
  expect(() => state.qualify('child-attempt')).toThrow(/obsolete|current/)
  state.reconcileDependencies('task')
  expect(state.work('work').state).toBe('succeeded')
  expect(state.work('bridge').state).toBe('succeeded')
  expect(state.work('child')).toMatchObject({ state: 'invalidated', root_cause: { kind: 'invalidation', work_id: 'work' } })
})

it('invalidates exact artifact dependencies after ownership changes without a new body', () => {
  const { db, state } = setup(); register(db, state); independentGoal(db, state)
  state.installPlan([work(), work('replacement')]); state.createAttempt(attempt()); dispatch(state)
  const artifacts = acceptArtifact(db, state)
  state.updateAttempt({ ...state.attempt('attempt'), state: 'succeeded' })
  const child = work('child', { run_id: 'run-other', request_id: 'other', dependencies: [{ kind: 'artifact', task_id: 'task', artifact_id: 'artifact', artifact_revision: 1 }] })
  state.installPlan([child]); state.createAttempt(attempt('child-attempt', { work_id: 'child', run_id: 'run-other', request_id: 'other', input_versions: child.dependencies }))
  expect(state.reconcileDependencies('task')).toEqual([])
  artifacts.assign([{ task_id: 'task', artifact_id: 'artifact', work_id: 'replacement', plan_revision: 1, section_id: 'section', base_artifact_revision: 1, previous_owner: { work_id: 'work', plan_revision: 1 } }])
  expect(() => state.qualify('child-attempt')).toThrow(/current accepted/)
  state.reconcileDependencies('task')
  expect(state.work('child').state).toBe('invalidated')
  expect(state.attempt('child-attempt').state).toBe('revoked')
  expect(state.work('work').state).toBe('succeeded')
})

it.each([
  { kind: 'failure' as const, root: 'failed', child: 'dependency_failed' },
  { kind: 'cancellation' as const, root: 'cancelled', child: 'dependency_cancelled' },
  { kind: 'invalidation' as const, root: 'invalidated', child: 'invalidated' }
])('propagates $kind through exact artifact and work dependencies before reconciliation', ({ kind, root, child }) => {
  const { db, state } = setup(); register(db, state); independentGoal(db, state)
  state.installPlan([work()]); state.createAttempt(attempt()); dispatch(state); acceptArtifact(db, state)
  const consumer = work('consumer', { run_id: 'run-other', request_id: 'other', dependencies: [{ kind: 'artifact', task_id: 'task', artifact_id: 'artifact', artifact_revision: 1 }] })
  const downstream = work('downstream', { run_id: 'run-other', request_id: 'other', dependencies: [{ kind: 'work', task_id: 'task', work_id: 'consumer', result_revision: 1 }] })
  state.installPlan([consumer, downstream, work('independent', { run_id: 'run-other', request_id: 'other', dependencies: [] })])
  state.createAttempt(attempt('consumer-attempt', { work_id: 'consumer', run_id: 'run-other', request_id: 'other', input_versions: consumer.dependencies }))
  const cause = { kind, work_id: 'work', attempt_id: 'attempt' }
  expect(state.revokeWork('work', cause).map(item => item.work_id)).toEqual(['work', 'consumer', 'downstream'])
  expect(state.work('work')).toMatchObject({ state: root, root_cause: cause })
  expect(state.work('consumer')).toMatchObject({ state: child, root_cause: cause })
  expect(state.work('downstream')).toMatchObject({ state: child, root_cause: cause })
  expect(state.attempt('consumer-attempt').state).toBe('revoked')
  expect(state.attempt('attempt').state).toBe('running')
  expect(state.work('independent').state).toBe('planned')
})

it('retains accepted artifact history while Run revocation reaches its active consumer', () => {
  const { db, state } = setup(); register(db, state); independentGoal(db, state)
  state.installPlan([work()]); state.createAttempt(attempt()); dispatch(state)
  const artifacts = acceptArtifact(db, state), before = artifacts.artifact('task', 'artifact')
  state.updateAttempt({ ...state.attempt('attempt'), state: 'succeeded' })
  state.installPlan([work('consumer', { run_id: 'run-other', request_id: 'other', dependencies: [{ kind: 'artifact', task_id: 'task', artifact_id: 'artifact', artifact_revision: 1 }] })])
  state.revokeRun('run')
  expect(state.work('work').state).toBe('succeeded')
  expect(state.work('consumer')).toMatchObject({ state: 'dependency_cancelled', root_cause: { kind: 'cancellation', work_id: 'work' } })
  expect(artifacts.artifact('task', 'artifact')).toEqual(before)
  expect(state.run('run-other').commit_valid).toBe(true)
})

it('checks the accepted artifact source goal before dispatch and retains its invalidation cause', () => {
  const { db, state } = setup(); register(db, state); independentGoal(db, state)
  state.installPlan([work()]); state.createAttempt(attempt()); dispatch(state); acceptArtifact(db, state)
  state.updateAttempt({ ...state.attempt('attempt'), state: 'succeeded' })
  const consumer = work('consumer', { run_id: 'run-other', request_id: 'other', dependencies: [{ kind: 'artifact', task_id: 'task', artifact_id: 'artifact', artifact_revision: 1 }] })
  state.installPlan([consumer]); state.createAttempt(attempt('consumer-attempt', { work_id: 'consumer', run_id: 'run-other', request_id: 'other', input_versions: consumer.dependencies }))
  nextInput(db, state); state.installGoal({ ...goal, intent_revision: 2, previous_revision: 1, input_event_id: 'correction' })
  expect(() => state.qualify('consumer-attempt', 'dispatch')).toThrow(/obsolete/)
  state.reconcileDependencies('task')
  expect(state.work('consumer')).toMatchObject({ state: 'invalidated', root_cause: { kind: 'invalidation', work_id: 'work' } })
  expect(state.work('work').state).toBe('succeeded')
})

it('repeats a full plan without hiding the original accepted artifact source execution', () => {
  const { db, state } = setup(); register(db, state)
  state.installPlan([work()]); state.createAttempt(attempt()); dispatch(state); acceptArtifact(db, state)
  state.updateAttempt({ ...state.attempt('attempt'), state: 'succeeded' })
  const consumer = work('consumer', { dependencies: [{ kind: 'artifact', task_id: 'task', artifact_id: 'artifact', artifact_revision: 1 }] })
  state.installPlan([consumer]); state.createAttempt(attempt('consumer-attempt', { work_id: 'consumer', input_versions: consumer.dependencies }))
  expect(state.installPlan([work(), consumer])).toEqual([state.work('work'), state.work('consumer')])
  expect(state.qualify('consumer-attempt', 'dispatch').work.current_attempt_id).toBe('consumer-attempt')
})

it('invalidates a failed attempt artifact without treating its bounded work retry as final failure', () => {
  const { db, state } = setup(); register(db, state); independentGoal(db, state)
  state.installPlan([work()]); state.createAttempt(attempt()); dispatch(state); acceptArtifact(db, state)
  const consumer = work('consumer', { run_id: 'run-other', request_id: 'other', dependencies: [{ kind: 'artifact', task_id: 'task', artifact_id: 'artifact', artifact_revision: 1 }] })
  const resultConsumer = work('result-consumer', { run_id: 'run-other', request_id: 'other', dependencies: [{ kind: 'work', task_id: 'task', work_id: 'work', result_revision: 1 }] })
  state.installPlan([consumer, resultConsumer]); state.createAttempt(attempt('consumer-attempt', { work_id: 'consumer', run_id: 'run-other', request_id: 'other', input_versions: consumer.dependencies }))
  state.updateAttempt({ ...state.attempt('attempt'), state: 'failed' }, work('work', { plan_revision: 2, state: 'queued' }))
  expect(() => state.qualify('consumer-attempt', 'dispatch')).toThrow(/current accepted/)
  state.reconcileDependencies('task')
  expect(state.work('consumer').state).toBe('invalidated')
  expect(state.work('work').state).toBe('queued')
  expect(state.work('result-consumer').state).toBe('planned')
})

it.each([
  { outcome: 'failed' as const, expected: 'dependency_failed', kind: 'failure' },
  { outcome: 'cancelled' as const, expected: 'dependency_cancelled', kind: 'cancellation' }
])('retains the real $outcome cause behind an accepted artifact dependency', ({ outcome, expected, kind }) => {
  const { db, state } = setup(); register(db, state); independentGoal(db, state)
  state.installPlan([work('work', { max_attempts: 1 })]); state.createAttempt(attempt()); dispatch(state); acceptArtifact(db, state)
  state.installPlan([work('consumer', { run_id: 'run-other', request_id: 'other', dependencies: [{ kind: 'artifact', task_id: 'task', artifact_id: 'artifact', artifact_revision: 1 }] })])
  state.updateAttempt({ ...state.attempt('attempt'), state: outcome })
  state.reconcileDependencies('task')
  expect(state.work('consumer')).toMatchObject({ state: expected, root_cause: { kind, work_id: 'work', attempt_id: 'attempt' } })
})

it('does not replace an already cancelled dependency root when its artifact input fails later', () => {
  const { db, state } = setup(); register(db, state); independentGoal(db, state)
  state.installPlan([work('work', { max_attempts: 1 })]); state.createAttempt(attempt()); dispatch(state); acceptArtifact(db, state)
  const consumer = work('consumer', { run_id: 'run-other', request_id: 'other', dependencies: [{ kind: 'artifact', task_id: 'task', artifact_id: 'artifact', artifact_revision: 1 }] })
  const downstream = work('downstream', { run_id: 'run-other', request_id: 'other', dependencies: [{ kind: 'work', task_id: 'task', work_id: 'consumer', result_revision: 1 }] })
  state.installPlan([consumer, downstream]); state.createAttempt(attempt('consumer-attempt', { work_id: 'consumer', run_id: 'run-other', request_id: 'other', input_versions: consumer.dependencies }))
  state.updateAttempt({ ...state.attempt('consumer-attempt'), state: 'cancelled' })
  const cause = state.work('consumer').root_cause
  state.updateAttempt({ ...state.attempt('attempt'), state: 'failed' })
  state.reconcileDependencies('task')
  expect(state.work('consumer')).toMatchObject({ state: 'cancelled', root_cause: cause })
  expect(state.work('downstream')).toMatchObject({ state: 'dependency_cancelled', root_cause: cause })
})

it('records a late physical result without rewriting logical work after a Run is interrupted', () => {
  const { db, state } = setup(); register(db, state)
  state.installPlan([work()]); state.createAttempt(attempt()); dispatch(state)
  db.prepare("UPDATE runs SET state='interrupted',commit_valid=0 WHERE id='run'").run()
  const before = state.work('work')
  state.updateAttempt({ ...state.attempt('attempt'), state: 'succeeded' })
  expect(state.attempt('attempt').state).toBe('succeeded')
  expect(state.work('work')).toEqual(before)
  expect(state.run('run').state).toBe('interrupted')
})

it('does not invalidate unrelated work when one resource membership disappears', () => {
  const { db, state } = setup(); register(db, state)
  db.prepare("INSERT INTO resources(id,storage_key,sha256,byte_length,media_type,display_name,created_at) VALUES ('body','body.json','fixture',2,'application/json','Body','time')").run()
  db.prepare("INSERT INTO task_resources(task_id,resource_id) VALUES ('task','body')").run()
  state.installPlan([work('resource-work', { dependencies: [{ kind: 'resource', task_id: 'task', resource_id: 'body' }] }), work('independent')])
  db.prepare("DELETE FROM task_resources WHERE task_id='task' AND resource_id='body'").run()
  expect(state.reconcileDependencies('task').map(item => item.work_id)).toEqual(['resource-work'])
  expect(state.work('independent').state).toBe('planned')
})

it('rolls back closing, revocation and dependency installation with the owning transaction', () => {
  const { db, state } = setup(); register(db, state)
  const child = work('child', { dependencies: [{ kind: 'work', task_id: 'task', work_id: 'work', result_revision: 1 }] })
  state.installPlan([work(), child]); state.createAttempt(attempt())
  expect(() => db.transaction(() => { state.closeRun('run'); state.revokeWork('work'); throw Error('interrupted') })()).toThrow('interrupted')
  expect(state.run('run')).toMatchObject({ state: 'running', commit_valid: true })
  expect(state.work('work').state).toBe('queued')
  expect(state.work('child').state).toBe('planned')
  expect(state.attempt('attempt')).toMatchObject({ state: 'registered', dispatch_state: 'not_dispatched' })
  nextInput(db, state); state.installGoal({ ...goal, intent_revision: 2, previous_revision: 1, input_event_id: 'correction' })
  expect(() => db.transaction(() => { state.reconcileDependencies('task'); throw Error('interrupted') })()).toThrow('interrupted')
  expect(state.work('work').state).toBe('queued')
  expect(state.work('child').state).toBe('planned')
})
