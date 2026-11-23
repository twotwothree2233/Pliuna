import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { afterEach, expect, it } from 'vitest'
import type { ArtifactCandidate, ArtifactIndex, CompositionBatch, ExecutionScope, ContentPlan, LogicalWork, PublicationEntry, WorkOutputDeclaration } from '../../src/shared/contracts.generated'
import { installChapterSchema } from '../../src/runtime/runner/chapter-state'
import { RunnerArtifactState } from '../../src/runtime/runner/artifact-state'
import { RunnerBudgetLedger } from '../../src/runtime/runner/budget'
import { RunnerCompositionState } from '../../src/runtime/runner/composition-state'
import { RunnerHostRecovery } from '../../src/runtime/runner/host-recovery'
import { RunnerHostStatus } from '../../src/runtime/runner/host-status'
import { RUNNER_LIMITS } from '../../src/runtime/runner/limits'
import { RunnerWorkState } from '../../src/runtime/runner/work-state'
import { liveRunnerFlow } from '../../src/runtime/runner/live-flow'

const coreSql = readFileSync(new URL('../../src/shared/contracts/001-core.sql', import.meta.url), 'utf8')
const runnerSql = readFileSync(new URL('../../src/shared/contracts/002-runner.sql', import.meta.url), 'utf8')
const databases: Database.Database[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
function fixture() {
  const db = new Database(':memory:'); databases.push(db); db.exec(coreSql); db.exec(runnerSql); installChapterSchema(db)
  db.prepare('UPDATE schema_version SET version=2').run()
  db.prepare("INSERT INTO tasks(id,title,state,revision) VALUES ('task','Task','active',1),('other','Other','active',1)").run()
  db.prepare("INSERT INTO surfaces VALUES ('surface','task',1,?)").run(JSON.stringify({ slots: [{ id: 'main', groups: [] }] }))
  const work = new RunnerWorkState(db, 'epoch'), artifacts = new RunnerArtifactState(db, work), composition = new RunnerCompositionState(db, work, artifacts), status = new RunnerHostStatus(db, 'epoch')
  const record = (id: string, kind: string, payload: unknown) => {
    const sequence = (db.prepare("SELECT COALESCE(MAX(sequence),0)+1 n FROM records WHERE task_id='task'").get() as { n: number }).n
    db.prepare("INSERT INTO records VALUES (?,'task',?,?,?,'time')").run(id, sequence, kind, JSON.stringify(payload))
    db.prepare("UPDATE tasks SET next_sequence=? WHERE id='task'").run(sequence + 1)
  }
  const goal = (id: string, text = id, kind: 'answer' | 'artifact' = 'answer'): ContentPlan => {
    db.prepare("INSERT INTO requests VALUES (?,'task','started','{}','{}','time')").run(id)
    record(`request-${id}`, 'message.user', { text })
    work.receive({ input_event_id: `input-${id}`, task_id: 'task', kind: 'request', record_id: `request-${id}`, request_id: id, stage: 'received' })
    return work.installGoal({ task_id: 'task', request_id: id, intent_revision: 1, input_event_id: `input-${id}`, state: 'active', requirements: [{ requirement_id: 'result', kind, required: true, provenance_required: false }] })
  }
  const revise = (original: ContentPlan): ContentPlan => {
    record(`correction-${original.request_id}`, 'message.user', { text: 'Corrected request text' })
    work.receive({ input_event_id: `correction-${original.request_id}`, task_id: 'task', kind: 'correction', record_id: `correction-${original.request_id}`, request_id: original.request_id, stage: 'received' })
    return work.installGoal({ ...original, intent_revision: original.intent_revision + 1, previous_revision: original.intent_revision, input_event_id: `correction-${original.request_id}` })
  }
  const start = (value: ContentPlan) => {
    const run = `run-${value.request_id}-${value.intent_revision}`, workId = `work-${value.request_id}-${value.intent_revision}`, attemptId = `attempt-${value.request_id}-${value.intent_revision}`
    new RunnerBudgetLedger(db).create({ budget_id: `budget-${value.request_id}`, task_id: 'task', purpose: 'production', request_id: value.request_id, limits: { model_requests: 10, tool_requests: 10, tokens: 1000, wall_ms: 60000 } })
    db.prepare("INSERT INTO runs(id,task_id,request_id,state,runtime_epoch,limits_json,budget_json,created_at) VALUES (?,'task',?,'running','epoch','{}','{}','time')").run(run, value.request_id)
    work.registerRun({ run_id: run, task_id: 'task', runtime_epoch: 'epoch', state: 'running', commit_valid: true, budget_id: `budget-${value.request_id}`, purpose: 'production', request_id: value.request_id, intent_revision: value.intent_revision })
    const logical: LogicalWork = { work_id: workId, task_id: 'task', run_id: run, plan_revision: 1, role: 'producer', required: true, requirement_ids: ['result'], dependencies: [{ kind: 'goal', task_id: 'task', request_id: value.request_id, intent_revision: value.intent_revision }], state: 'planned', max_attempts: 2, purpose: 'production', request_id: value.request_id, intent_revision: value.intent_revision }
    work.installPlan([logical])
    work.createAttempt({ attempt_id: attemptId, task_id: 'task', run_id: run, work_id: workId, runtime_epoch: 'epoch', attempt_number: 1, profile_id: 'producer-output-v1', model_config_id: 'model', model_config_revision: 1, input_versions: logical.dependencies, state: 'registered', dispatch_state: 'not_dispatched', usage_refs: [], purpose: 'production', request_id: value.request_id, intent_revision: value.intent_revision })
    work.updateAttempt({ ...work.attempt(attemptId), state: 'dispatched', dispatch_state: 'dispatched', operation_id: `operation-${attemptId}` })
    work.updateAttempt({ ...work.attempt(attemptId), state: 'running' })
    const owner: ExecutionScope = { task_id: 'task', run_id: run, work_id: workId, attempt_id: attemptId, role: 'producer', purpose: 'production', request_id: value.request_id, intent_revision: value.intent_revision }
    composition.designateSource({ task_id: 'task', request_id: value.request_id, intent_revision: value.intent_revision, work_id: workId, plan_revision: 1 })
    return owner
  }
  const finish = (value: ContentPlan, owner: ExecutionScope, fragments: ArtifactIndex[] = [], answerText = 'PRIVATE FINAL ANSWER') => {
    const result_ref = { task_id: 'task', kind: 'record' as const, id: `result-${owner.work_id}` }
    record(result_ref.id, 'worker.reply', { owner, text: 'PRIVATE WORKER BODY' })
    work.updateAttempt({ ...work.attempt(owner.attempt_id), state: 'succeeded', result_ref })
    const output: WorkOutputDeclaration = composition.declareOutputs({ task_id: 'task', request_id: value.request_id, intent_revision: value.intent_revision, run_id: owner.run_id, work_id: owner.work_id, attempt_id: owner.attempt_id, plan_revision: 1, result_revision: 1, result_ref, complete: true, artifacts: fragments.map(fragment => ({ task_id: 'task', artifact_id: fragment.artifact_id, artifact_revision: fragment.artifact_revision })), requirement_ids: ['result'], unresolved: [] })
    const inventory = composition.sealInventory({ task_id: 'task', request_id: value.request_id, intent_revision: value.intent_revision, inventory_revision: 1, required_works: [output], requirement_ids: ['result'], unresolved: [], sealed_by: { work_id: owner.work_id, plan_revision: 1, run_id: owner.run_id, attempt_id: owner.attempt_id, role: 'producer' } })
    const answer = { owner, purpose: 'final_answer', text: answerText, request_id: value.request_id, input_event_id: value.input_event_id, run_id: owner.run_id, intent_revision: value.intent_revision, result_ref }
    if (!fragments.length) record(`answer-${value.request_id}`, 'runner.answer', answer)
    db.prepare("UPDATE runs SET state='completed',commit_valid=0 WHERE id=?").run(owner.run_id)
    return { output, inventory, answer }
  }
  const resource = (id: string): void => {
    db.prepare("INSERT INTO resources VALUES (?,?,?,2,'application/json','Body','time')").run(id, id, 'a'.repeat(64))
    db.prepare("INSERT INTO task_resources VALUES ('task',?)").run(id)
  }
  const fragment = (value: ContentPlan, owner: ExecutionScope): ArtifactIndex => {
    resource('source'); resource('published')
    artifacts.installOutline({ task_id: 'task', outline_revision: 1, base_outline_revision: 0, sections: [{ section_id: 'section', request_id: value.request_id, intent_revision: value.intent_revision, order_key: 'a', position_revision: 1, title: 'Section' }] })
    artifacts.assign([{ task_id: 'task', artifact_id: 'artifact', section_id: 'section', work_id: owner.work_id, plan_revision: 1, base_artifact_revision: 0 }])
    const candidate: ArtifactCandidate = { candidate_id: 'candidate', task_id: 'task', request_id: value.request_id, intent_revision: value.intent_revision, run_id: owner.run_id, work_id: owner.work_id, attempt_id: owner.attempt_id, artifact_id: 'artifact', base_artifact_revision: 0, plan_revision: 1, bundle_resource_id: 'source', section_id: 'section', section_position_revision: 1, order_key: 'a', presentation_kind: 'managed-v1', width_constraint: 'full', interaction_kind: 'none', provenance_ref: { task_id: 'task', kind: 'record', id: `request-${value.request_id}` }, requirement_ids: ['result'], unresolved: [], dependencies: work.work(owner.work_id).dependencies }
    const decision = artifacts.decide(candidate, { state: 'accepted' })
    if (decision.state !== 'accepted') throw Error(decision.code)
    return decision.index
  }
  const scope = (value: ContentPlan, inventory = composition.inventory('task', value.request_id, value.intent_revision)): void => {
    const previous = composition.scope('task')
    composition.installScope({ task_id: 'task', composition_version: (previous?.composition_version ?? 0) + 1, ...(previous ? { previous_version: previous.composition_version } : {}), state: 'working', targets: [{ request_id: value.request_id, intent_revision: value.intent_revision, required: true, requirement_ids: ['result'], ...(inventory ? { contribution_inventory: { task_id: 'task', request_id: value.request_id, intent_revision: value.intent_revision, inventory_revision: inventory.inventory_revision } } : {}) }], unresolved: [] })
  }
  const publish = (value: ContentPlan): void => {
    const entry: PublicationEntry = { task_id: 'task', batch_id: 'batch', request_id: value.request_id, intent_revision: value.intent_revision, artifact_id: 'artifact', artifact_revision: 1, section_id: 'section', source_bundle_resource_id: 'source', published_bundle_resource_id: 'published', view_id: 'view', view_revision: 1, state_revision: 1, surface_history_id: 'surface-history' }
    db.prepare("INSERT INTO runner_batches VALUES ('batch','task',1,'{}')").run()
    db.prepare("INSERT INTO views VALUES ('view','surface',1,'published',1,'{}','v1',NULL,0)").run()
    db.prepare("INSERT INTO view_history VALUES ('view-history','task','view',1,'published','{}')").run()
    db.prepare("UPDATE surfaces SET layout_json=? WHERE id='surface'").run(JSON.stringify({ slots: [{ id: 'main', groups: [{ id: 'group', type: 'stack', views: ['view'] }] }] }))
    db.prepare("INSERT INTO actions(id,task_id,kind,state,result,source_json,request_json,commit_valid,created_at) VALUES ('publish','task','mutation','ended','success','{}','{}',0,'time')").run()
    db.prepare("INSERT INTO runner_surface_history VALUES ('surface-history','task','surface',1,'publish',?)").run(JSON.stringify({ task_id: 'task', surface_id: 'surface', surface_revision: 1, action_id: 'publish', layout: { slots: [] }, views: [{ view_id: 'view', view_revision: 1, state_revision: 1, view_history_id: 'view-history' }] }))
    db.prepare("INSERT INTO runner_view_mappings VALUES ('task','artifact',1,'batch','view',1,'source','published',?)").run(JSON.stringify(entry))
  }
  const batch = (value: ContentPlan, fragment: ArtifactIndex, id: string, state: CompositionBatch['state'], reason?: string, extraTargets: ContentPlan[] = []) => {
    const result: CompositionBatch = { task_id: 'task', batch_id: id, run_id: `run-${id}`, composition_version: composition.scope('task')!.composition_version, trigger_request_id: value.request_id, model_config_id: 'model', model_config_revision: 1, state, targets: [value, ...extraTargets].map(target => ({ task_id: 'task', request_id: target.request_id, intent_revision: target.intent_revision })), indexes: [{ task_id: 'task', artifact_id: fragment.artifact_id, artifact_revision: fragment.artifact_revision }], sections: [{ section_id: fragment.section_id, position_revision: 1, order_key: fragment.order_key }], operation_id: `operation-${id}`, action_id: `action-${id}` }
    db.prepare('INSERT INTO runner_batches VALUES (?,?,?,?)').run(id, 'task', result.composition_version, JSON.stringify(result))
    db.prepare("INSERT INTO runs(id,task_id,state,runtime_epoch,limits_json,budget_json,created_at,wait_reason) VALUES (?,'task',?,'epoch','{}','{}','time',?)").run(result.run_id, state === 'failed' ? 'failed' : 'waiting', state === 'failed' ? null : reason ?? 'model_queue')
    if (state === 'failed') record(`blocked-${id}`, 'runner.composition.blocked', { run_id: result.run_id, batch_id: id, operation_id: result.operation_id, code: reason })
    return result
  }
  return { db, work, composition, status, record, goal, revise, start, finish, fragment, scope, publish, batch }
}

it('projects queued requests, routing and independent live work without borrowing expired approvals', () => {
  const s = fixture(), a = s.start(s.goal('alpha')), b = s.start(s.goal('beta'))
  s.db.prepare("INSERT INTO requests VALUES ('queued','task','queued','{}',?,'time'),('routing','task','queued','{}',?,'time')")
    .run(JSON.stringify({ epoch: 'epoch', text: 'Queued input' }), JSON.stringify({ epoch: 'epoch', text: 'Routing input' }))
  s.db.prepare("INSERT INTO runs(id,task_id,request_id,state,runtime_epoch,limits_json,budget_json,created_at) VALUES ('router','task','routing','running','epoch','{}','{}','time'),('foreign','other',NULL,'running','epoch','{}','{}','time')").run()
  const another = { ...s.work.work(a.work_id), work_id: 'second-work', state: 'queued' }
  s.db.prepare("INSERT INTO runner_work VALUES ('second-work','task',?,1,'queued',?)").run(a.run_id, JSON.stringify(another))
  s.work.updateAttempt({ ...s.work.attempt(b.attempt_id), state: 'waiting' })
  s.record('waiting', 'worker.state', { owner: b, reason: 'approval' })
  s.db.prepare("INSERT INTO actions(id,task_id,run_id,kind,state,source_json,request_json,commit_valid,created_at) VALUES ('action','task',?,'mutation','waiting',?,'{}',1,'time')").run(b.run_id, JSON.stringify({ owner: b }))
  s.db.prepare("INSERT INTO approvals VALUES ('approval','action','pending','valid','manual','awaiting_human','2000-01-01',NULL,?)").run(JSON.stringify({ runtime_epoch: 'epoch' }))
  const read = (task_id = 'task') => liveRunnerFlow(s.db, { task_id }, 'epoch')
  expect(read().lanes.Router.items).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'request:queued', state: 'queued' }),
    expect.objectContaining({ id: 'request:routing', state: 'running', sources: [{ request_id: 'routing', run_id: 'router' }] })
  ]))
  expect(read().lanes.Worker.items).toMatchObject([
    { id: `work:${a.work_id}`, state: 'running' }, { id: 'work:second-work', state: 'queued' }, { id: `work:${b.work_id}`, state: 'waiting' }
  ])
  s.db.prepare("UPDATE approvals SET expires_at='2999-01-01'").run()
  expect(read().lanes.Worker.items.at(-1)).toMatchObject({ state: 'approval', approval_id: 'approval' })
  expect(read('other').lanes.Worker.items).toMatchObject([{ id: 'run:foreign' }])
  expect(() => read('missing')).toThrow('Task unavailable')
  expect(() => liveRunnerFlow(s.db, { task_id: 'task', scope: { run_id: a.run_id } }, 'epoch')).toThrow('Invalid live flow lookup')
})

it('pages only active work and exposes verified handoff references without bodies', () => {
  const s = fixture(), live = s.start(s.goal('live', 'PRIVATE REQUEST')), old = s.start(s.goal('old'))
  s.db.prepare("UPDATE runs SET state='completed',commit_valid=0 WHERE id=?").run(old.run_id)
  s.record('handoff', 'worker.input', { owner: live, text: 'PRIVATE WORKER BODY' })
  s.record('wrong-owner', 'worker.input', { owner: { ...live, work_id: 'different' }, text: 'PRIVATE WORKER BODY' })
  const insert = s.db.prepare("INSERT INTO runner_work VALUES (?,'task',?,1,'queued','{}')")
  for (let i = 0; i < 20; i++) insert.run(`live-${i}`, live.run_id)
  insert.run('dead-work', old.run_id)
  const read = (page = 0, focus_run_id?: string) => liveRunnerFlow(s.db, { task_id: 'task', pages: { Worker: page }, ...(focus_run_id ? { focus_run_id } : {}) }, 'epoch')
  const first = read()
  expect(first.lanes.Worker).toMatchObject({ total: 21, page: 0 })
  expect(first.lanes.Worker.items).toHaveLength(8)
  expect(first.lanes.Worker.items[0]).toMatchObject({ handoff: { from: 'Router', kind: 'work', sequence: 3 } })
  expect(JSON.stringify(first)).not.toContain('PRIVATE')
  expect(read(2).lanes.Worker.items.map(item => item.id)).toEqual(['work:live-15', 'work:live-16', 'work:live-17', 'work:live-18', 'work:live-19'])
  expect(read(2, live.run_id)).toMatchObject({ focus: { role: 'Worker', id: `work:${live.work_id}` }, lanes: { Worker: { page: 0 } } })
  expect(read(2, old.run_id).focus).toBeUndefined()
})

it('retains unknown outcomes and cleanup until the original operations settle', () => {
  const s = fixture(), cleanup = s.start(s.goal('cleanup')), pending = s.start(s.goal('pending'))
  s.db.prepare("UPDATE runs SET state='waiting',runtime_epoch='previous',commit_valid=0,intended_terminal='cancelled',wait_reason='ending_cleanup' WHERE id=?").run(cleanup.run_id)
  s.db.prepare("UPDATE runs SET state='interrupted',runtime_epoch='previous',commit_valid=0 WHERE id=?").run(pending.run_id)
  s.db.prepare("INSERT INTO calls(id,task_id,run_id,capability_id,state,dispatch,execution,delivery,input_json,limits_json,commit_valid,created_at) VALUES ('call','task',?,'test','ended','unknown','unknown','not_applicable','{}','{}',0,'time')").run(pending.run_id)
  const read = () => liveRunnerFlow(s.db, { task_id: 'task' }, 'epoch').lanes.Host.items
  expect(read()).toMatchObject([{ id: `run:${cleanup.run_id}`, state: 'closing' }, { id: `run:${pending.run_id}`, state: 'unknown' }])
  s.db.prepare("UPDATE runs SET state='cancelled' WHERE id=?").run(cleanup.run_id)
  s.db.prepare("UPDATE calls SET execution='failure' WHERE id='call'").run()
  expect(read()).toEqual([])
})

it.each([
  '已生成讲义。\n```json\n{"version":1,"complete":true,"answer":"讲义说明","artifacts":[],"requirement_ids":["result"],"unresolved":[]}\n```',
  '已生成讲义。\n```json\n{version:1,complete:true,answer:"讲义说明",artifacts:[],requirement_ids:["result"],unresolved:[]}\n```'
])('excludes a historical producer envelope from replies and full-scope completeness: %s', text => {
  const s = fixture(), visible = s.goal('visible'), visibleOwner = s.start(visible), visibleResult = s.finish(visible, visibleOwner)
  const polluted = s.goal('polluted'), pollutedOwner = s.start(polluted), pollutedResult = s.finish(polluted, pollutedOwner, [], text)
  s.composition.installScope({
    task_id: 'task', composition_version: 1, state: 'working', unresolved: [],
    targets: [{ goal: visible, inventory: visibleResult.inventory }, { goal: polluted, inventory: pollutedResult.inventory }].map(({ goal, inventory }) => ({
      request_id: goal.request_id, intent_revision: 1, required: true, requirement_ids: ['result'],
      contribution_inventory: { task_id: 'task', request_id: goal.request_id, intent_revision: 1, inventory_revision: inventory.inventory_revision }
    }))
  })
  const page = s.status.page({ task_id: 'task', limit: 1 })
  expect(page.goals).toMatchObject([{ request_id: 'visible', delivery: 'published', reply: { id: 'answer-visible' } }])
  expect(page.next_cursor).not.toBeNull()
  expect(page.scope).toMatchObject({ state: 'partial', required_content_count: 2, unresolved_count: 1, published_count: 0 })
  const current = s.status.page({ task_id: 'task', request_id: 'polluted' })
  expect(current.goals).toMatchObject([{ request_id: 'polluted', delivery: 'incomplete', unresolved_count: 1, reply: null }])
  expect(current.scope).toEqual(page.scope)
  const original = s.db.prepare("SELECT payload_json FROM records WHERE id='answer-polluted'").get() as { payload_json: string }
  expect(JSON.parse(original.payload_json)).toEqual(pollutedResult.answer)
})

it.each(['正常回复。', 'JSON 示例：\n```json\n{"answer":"解释","artifacts":[]}\n```'])('keeps ordinary saved answers and JSON explanations complete: %s', text => {
  const s = fixture(), goal = s.goal('alpha'), owner = s.start(goal)
  s.finish(goal, owner, [], text); s.scope(goal)
  expect(s.status.page({ task_id: 'task' })).toMatchObject({
    goals: [{ request_id: 'alpha', delivery: 'published', artifact_count: 0, unresolved_count: 0, reply: { id: 'answer-alpha' } }],
    scope: { state: 'complete', unresolved_count: 0 }
  })
})

it('counts current accepted and published artifacts once without carrying old content into a correction', () => {
  const s = fixture(), goal = s.goal('alpha', 'Build content', 'artifact'), owner = s.start(goal), fragment = s.fragment(goal, owner)
  s.finish(goal, owner, [fragment]); s.scope(goal)
  expect(s.status.page({ task_id: 'task' }).goals[0]).toMatchObject({ delivery: 'accepted', artifact_count: 1 })
  s.publish(goal)
  expect(s.status.page({ task_id: 'task' }).goals[0]).toMatchObject({ delivery: 'published', artifact_count: 1 })
  s.revise(goal)
  expect(s.status.page({ task_id: 'task' }).goals[0]).toMatchObject({ intent_revision: 2, delivery: 'pending_update', artifact_count: 0, reply: null })
  const answerGoal = s.goal('beta'), answerOwner = s.start(answerGoal)
  s.finish(answerGoal, answerOwner)
  expect(s.status.page({ task_id: 'task', request_id: 'beta' }).goals[0]).toMatchObject({ delivery: 'published', artifact_count: 0, reply: { id: 'answer-beta' } })
})

it('selects the exact current final answer and returns no answer or worker body in status', () => {
  const s = fixture(), goal = s.goal('alpha', 'Initial goal'), owner = s.start(goal), result = s.finish(goal, owner)
  s.record('progress', 'runner.answer', { ...result.answer, purpose: 'progress' })
  s.record('query', 'runner.status.reply', { ...result.answer })
  s.record('wrong-input', 'runner.answer', { ...result.answer, input_event_id: 'unrelated-query' })
  s.record('foreign-owner', 'runner.answer', { ...result.answer, owner: { ...owner, task_id: 'other' } })
  s.record('unaccepted-result', 'runner.answer', { ...result.answer, result_ref: { task_id: 'task', kind: 'record', id: 'query' } })
  const page = s.status.page({ task_id: 'task' })
  expect(page.goals).toMatchObject([{ request_id: 'alpha', title: 'Initial goal', delivery: 'published', unresolved_count: 0, reply: { id: 'answer-alpha', request_id: 'alpha', run_id: owner.run_id } }])
  expect(JSON.stringify(page)).not.toMatch(/PRIVATE|result_ref|payload_json|"text"/)
})

it.each([null, 'required_work_settled', 'MODEL_TIMEOUT'])('projects a historical worker failure while preserving stored reason %s', primaryReason => {
  const s = fixture(), goal = s.goal('alpha'), owner = s.start(goal)
  s.work.updateAttempt({ ...s.work.attempt(owner.attempt_id), state: 'failed' })
  s.record('worker-ended', 'worker.ended', { state: 'failed', code: 'INVALID_WORKER_RESULT', run_id: owner.run_id, owner })
  s.db.prepare("UPDATE runs SET state='failed',primary_reason=?,commit_valid=0 WHERE id=?").run(primaryReason, owner.run_id)
  expect(s.status.page({ task_id: 'task' }).goals[0]).toMatchObject({ run: { state: 'failed', primary_reason: primaryReason === 'MODEL_TIMEOUT' ? primaryReason : 'INVALID_WORKER_RESULT' }, delivery: 'incomplete' })
  expect(s.db.prepare('SELECT primary_reason FROM runs WHERE id=?').get(owner.run_id)).toEqual({ primary_reason: primaryReason })
})

it('keeps the initial title while current request navigation and answer selection follow a correction', () => {
  const s = fixture(), original = s.goal('alpha', 'Alpha original'), owner = s.start(original)
  s.finish(original, owner); const current = s.revise(original)
  const page = s.status.page({ task_id: 'task', request_id: 'alpha' })
  expect(page.goals).toMatchObject([{ intent_revision: 2, input_event_id: current.input_event_id, title: 'Alpha original', run: null, request: { id: 'correction-alpha' }, reply: null, delivery: 'pending' }])
})

it('does not expose a forged answer without its original accepted output', () => {
  const s = fixture(), goal = s.goal('alpha'), owner = s.start(goal)
  s.record('forged', 'runner.answer', { owner, purpose: 'final_answer', request_id: goal.request_id, intent_revision: 1, input_event_id: goal.input_event_id, run_id: owner.run_id, text: 'PRIVATE FORGED', result_ref: { kind: 'record', task_id: 'task', id: 'forged' } })
  expect(s.status.page({ task_id: 'task' }).goals[0]!.reply).toBeNull()
})

it('truncates titles by UTF-8 bytes without cutting Unicode characters', () => {
  const s = fixture(); s.goal('unicode', '😀'.repeat(100))
  const value = s.status.page({ task_id: 'task' }).goals[0]!.title
  expect(value).toBe('😀'.repeat(64)); expect(Buffer.byteLength(value)).toBe(256)
})

it('pages a fixed goal set, keeps current revisions, and excludes later arrivals', () => {
  const s = fixture(), goals = Array.from({ length: 35 }, (_, index) => s.goal(`goal-${index}`))
  const first = s.status.page({ task_id: 'task' })
  expect(first.goals).toHaveLength(16)
  s.goal('later'); s.revise(goals[20]!)
  const second = new RunnerHostStatus(s.db, 'epoch').page({ task_id: 'task', cursor: first.next_cursor! })
  expect(second.goals).toHaveLength(16); expect(second.goals[4]!.intent_revision).toBe(2)
  const final = s.status.page({ task_id: 'task', cursor: second.next_cursor! })
  expect(final.goals.map(goal => goal.request_id)).toEqual(['goal-32', 'goal-33', 'goal-34']); expect(final.next_cursor).toBeNull()
  expect(s.status.page({ task_id: 'task', request_id: 'later' }).goals).toHaveLength(1)
})

it('binds opaque cursors to the Task, request and runtime epoch and rejects invented cursors', () => {
  const s = fixture(); s.goal('alpha'); s.goal('beta')
  const cursor = s.status.page({ task_id: 'task', limit: 1 }).next_cursor!
  for (const query of [{ task_id: 'other', cursor }, { task_id: 'task', request_id: 'alpha', cursor }, { task_id: 'task', cursor: 'invented' }]) expect(() => s.status.page(query)).toThrow(expect.objectContaining({ code: 'INVALID_CURSOR' }))
  expect(() => new RunnerHostStatus(s.db, 'new-epoch').page({ task_id: 'task', cursor })).toThrow(expect.objectContaining({ code: 'INVALID_CURSOR' }))
})

it.each([0, 33, 1.5, NaN])('rejects an invalid status page limit %s', limit => {
  const s = fixture(); expect(() => s.status.page({ task_id: 'task', limit })).toThrow(expect.objectContaining({ code: 'RUNNER_STATUS_INVALID' }))
})

it('keeps status within item and page byte limits without writing business records', () => {
  const s = fixture(); for (let index = 0; index < 40; index++) s.start(s.goal(`goal-${index}`, '😀'.repeat(100)))
  const before = s.db.prepare('SELECT total_changes() n').get(), page = s.status.page({ task_id: 'task', limit: 32 })
  expect(page.goals.length).toBeLessThanOrEqual(32); expect(page.next_cursor).toBeTruthy()
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(RUNNER_LIMITS.index.page_bytes)
  for (const goal of page.goals) expect(Buffer.byteLength(JSON.stringify(goal))).toBeLessThanOrEqual(RUNNER_LIMITS.index.item_bytes)
  expect(s.db.prepare('SELECT total_changes() n').get()).toEqual(before)
})

it('shows exact pending approvals and unknown attempts while excluding expired approvals', () => {
  const s = fixture(), goal = s.goal('alpha'), owner = s.start(goal)
  s.work.updateAttempt({ ...s.work.attempt(owner.attempt_id), state: 'unknown', dispatch_state: 'unknown' })
  for (const [id, expiry] of [['pending', '2999-01-01T00:00:00.000Z'], ['expired', '2000-01-01T00:00:00.000Z']]) {
    s.db.prepare("INSERT INTO actions(id,task_id,run_id,kind,state,source_json,request_json,commit_valid,created_at) VALUES (?,'task',?,'mutation','waiting',?,'{}',1,'time')").run(id, owner.run_id, JSON.stringify({ owner }))
    s.db.prepare("INSERT INTO approvals VALUES (?,?,'pending','valid','manual','awaiting_human',?,NULL,'{}')").run(id, id, expiry)
  }
  const waits = s.status.page({ task_id: 'task' }).goals[0]!.waits
  expect(waits).toContainEqual({ reason: 'approval', run_id: owner.run_id, work_id: owner.work_id, approval_id: 'pending' })
  expect(waits.some(wait => wait.approval_id === 'expired')).toBe(false)
  expect(waits).toContainEqual({ reason: 'unknown', run_id: owner.run_id, work_id: owner.work_id })
})

function missingModelUsage(s: ReturnType<typeof fixture>, owner: ExecutionScope) {
  const ledger = new RunnerBudgetLedger(s.db)
  ledger.reserve('model-request', s.work.run(owner.run_id).budget_id, 'model-request', { model_requests: 1, tokens: 100 }, owner.attempt_id)
  ledger.markDispatched('model-request'); ledger.markUnknown('model-request')
  s.record('model-ended', 'model.request.accounting', { request_id: 'model-request', phase: 'failed', usage: null, code: 'MODEL_CANCELLED', run_id: owner.run_id, owner })
  s.work.closeRun(owner.run_id)
  s.db.prepare("UPDATE runs SET state='waiting',wait_reason='ending_cleanup',intended_terminal='failed' WHERE id=?").run(owner.run_id)
  return ledger
}

it('shows stopped model usage reconciliation with its original operation while retaining the reservation', () => {
  const s = fixture(), owner = s.start(s.goal('alpha'))
  s.work.updateAttempt({ ...s.work.attempt(owner.attempt_id), state: 'failed' })
  const ledger = missingModelUsage(s, owner), before = s.db.prepare('SELECT total_changes() n').get()
  const goal = s.status.page({ task_id: 'task' }).goals[0]!
  expect(goal.run).toMatchObject({ state: 'closing', wait_reason: 'ending_cleanup' })
  expect(goal.waits).toEqual([{ reason: 'usage_unknown', run_id: owner.run_id, work_id: owner.work_id, operation_id: 'model-request' }])
  expect(s.db.prepare('SELECT total_changes() n').get()).toEqual(before)
  expect(ledger.query('model-request')).toMatchObject({ state: 'unknown', usage: null })
  expect(ledger.snapshot(s.work.run(owner.run_id).budget_id).unknown).toEqual({ model_requests: 1, tool_requests: 0, tokens: 100 })
  expect(s.work.run(owner.run_id)).toMatchObject({ state: 'closing', commit_valid: false })
})

it('omits stale execution waits after recovering a failed Run while retaining its unknown usage', () => {
  const s = fixture(), owner = s.start(s.goal('alpha'))
  s.work.updateAttempt({ ...s.work.attempt(owner.attempt_id), state: 'failed' })
  const ledger = missingModelUsage(s, owner)
  new RunnerHostRecovery(s.db, 'restarted-epoch').recover()
  const goal = new RunnerHostStatus(s.db, 'restarted-epoch').page({ task_id: 'task' }).goals[0]!
  expect(goal.run).toMatchObject({ state: 'failed' })
  expect(goal.waits).toEqual([])
  expect(goal.delivery).toBe('incomplete')
  expect(s.db.prepare('SELECT state,wait_reason FROM runs WHERE id=?').get(owner.run_id)).toEqual({ state: 'failed', wait_reason: 'ending_cleanup' })
  expect(ledger.query('model-request')).toMatchObject({ state: 'unknown', usage: null })
})

it.each(['active-attempt', 'cleanup', 'unknown-call', 'unknown-tool', 'missing-end-event'] as const)('keeps ending execution when usage uncertainty also has %s', blocker => {
  const s = fixture(), owner = s.start(s.goal('alpha'))
  if (blocker !== 'active-attempt') s.work.updateAttempt({ ...s.work.attempt(owner.attempt_id), state: 'failed' })
  const ledger = missingModelUsage(s, owner)
  if (blocker === 'cleanup') s.db.prepare("INSERT INTO cleanup_jobs(id,task_id,owner_kind,owner_id,necessary,state,detail_json) VALUES ('cleanup','task','task','task',1,'pending','{}')").run()
  if (blocker === 'unknown-call') s.db.prepare("INSERT INTO calls(id,task_id,run_id,capability_id,state,dispatch,execution,delivery,input_json,limits_json,commit_valid,created_at) VALUES ('call','task',?,'read','ended','sent','unknown','failed','{}','{}',0,'time')").run(owner.run_id)
  if (blocker === 'unknown-tool') {
    ledger.reserve('tool-request', s.work.run(owner.run_id).budget_id, 'tool-request', { tool_requests: 1 }, owner.attempt_id)
    ledger.markDispatched('tool-request'); ledger.markUnknown('tool-request')
  }
  if (blocker === 'missing-end-event') s.db.prepare("DELETE FROM records WHERE id='model-ended'").run()
  const waits = s.status.page({ task_id: 'task' }).goals[0]!.waits
  expect(waits.some(wait => wait.reason === 'usage_unknown')).toBe(false)
  expect(waits).toContainEqual({ reason: 'ending_cleanup', run_id: owner.run_id })
  expect(ledger.query('model-request').state).toBe('unknown')
})

it('distinguishes accepted unpublished fragments from exact delivered contributions', () => {
  const s = fixture(), goal = s.goal('alpha', 'Alpha artifact', 'artifact'), owner = s.start(goal), fragment = s.fragment(goal, owner)
  s.finish(goal, owner, [fragment]); s.scope(goal)
  expect(s.status.page({ task_id: 'task' })).toMatchObject({ goals: [{ delivery: 'accepted', reply: null }], scope: { state: 'partial', published_count: 0 } })
  s.publish(goal)
  expect(s.status.page({ task_id: 'task' })).toMatchObject({ goals: [{ delivery: 'published' }], scope: { state: 'complete', required_content_count: 1, unresolved_count: 0, pending_update_count: 0, published_count: 1 } })
})

it('keeps old published Views visible and marks them pending update after a correction', () => {
  const s = fixture(), goal = s.goal('alpha', 'Alpha artifact', 'artifact'), owner = s.start(goal), fragment = s.fragment(goal, owner)
  s.finish(goal, owner, [fragment]); s.scope(goal); s.publish(goal)
  const current = s.revise(goal); s.scope(current, null)
  const page = s.status.page({ task_id: 'task' })
  expect(page).toMatchObject({ goals: [{ intent_revision: 2, delivery: 'pending_update', reply: null }], scope: { state: 'partial', pending_update_count: 1, published_count: 1 } })
  expect(s.db.prepare("SELECT id,bundle_resource_id FROM views WHERE id='view'").get()).toEqual({ id: 'view', bundle_resource_id: 'published' })
})

it('projects a composition obstruction only onto its current unpublished fragment owner', () => {
  const s = fixture(), goal = s.goal('alpha', 'Alpha artifact', 'artifact'), other = s.goal('beta'), owner = s.start(goal), fragment = s.fragment(goal, owner)
  s.finish(goal, owner, [fragment]); s.scope(goal)
  const batch = s.batch(goal, fragment, 'disabled', 'failed', 'CAPABILITY_DISABLED', [other])
  const page = s.status.page({ task_id: 'task' })
  expect(page.goals[0]).toMatchObject({ delivery: 'accepted', waits: [{ reason: 'CAPABILITY_DISABLED', run_id: batch.run_id, batch_id: batch.batch_id, operation_id: batch.operation_id }] })
  expect(page.goals[1]!.waits).toEqual([])
  expect(JSON.stringify(page)).not.toMatch(/PRIVATE|payload_json|request_json/)
  s.publish(goal)
  expect(s.status.page({ task_id: 'task' }).goals[0]).toMatchObject({ delivery: 'published', waits: [] })
})

it('replaces a previous composition error with the exact current batch approval', () => {
  const s = fixture(), goal = s.goal('alpha', 'Alpha artifact', 'artifact'), owner = s.start(goal), fragment = s.fragment(goal, owner)
  s.finish(goal, owner, [fragment]); s.scope(goal)
  s.batch(goal, fragment, 'old', 'failed', 'INVALID_LAYOUT')
  const batch = s.batch(goal, fragment, 'current', 'waiting', 'approval')
  s.db.prepare("INSERT INTO actions(id,task_id,run_id,kind,state,source_json,request_json,commit_valid,created_at) VALUES (?,'task',?,'mutation','waiting','{}','{}',1,'time')").run(batch.action_id, batch.run_id)
  s.db.prepare("INSERT INTO approvals VALUES ('composition-approval',?,'pending','valid','manual','awaiting_human','2999-01-01T00:00:00.000Z',NULL,'{}')").run(batch.action_id)
  expect(s.status.page({ task_id: 'task' }).goals[0]!.waits).toEqual([{ reason: 'approval', run_id: batch.run_id, batch_id: batch.batch_id, operation_id: batch.operation_id, approval_id: 'composition-approval' }])
  s.revise(goal)
  expect(s.status.page({ task_id: 'task' }).goals[0]!.waits).toEqual([])
})
