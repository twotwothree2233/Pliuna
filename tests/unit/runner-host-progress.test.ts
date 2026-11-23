import Database from 'better-sqlite3'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { ExecutionScope, LogicalWork } from '../../src/shared/contracts.generated'
import { RunnerArtifactState } from '../../src/runtime/runner/artifact-state'
import { RunnerBudgetLedger } from '../../src/runtime/runner/budget'
import { RunnerCompositionState } from '../../src/runtime/runner/composition-state'
import { RunnerHostProgress } from '../../src/runtime/runner/host-progress'
import { RunnerWorkState } from '../../src/runtime/runner/work-state'

const coreSql = readFileSync(new URL('../../src/shared/contracts/001-core.sql', import.meta.url), 'utf8')
const runnerSql = readFileSync(new URL('../../src/shared/contracts/002-runner.sql', import.meta.url), 'utf8')
const databases: Database.Database[] = []
afterEach(() => { for (const db of databases.splice(0)) if (db.open) db.close() })
const secret = 'PRIVATE BODY AND ERROR DETAILS'

function setup(path = ':memory:') {
  const db = new Database(path); databases.push(db); db.exec(coreSql); db.exec(runnerSql)
  let time = 100000, serial = 0
  const epoch = 'epoch', clock = () => time
  db.prepare("INSERT INTO tasks(id,title,state,revision) VALUES ('task','Progress','active',1)").run()
  const state = new RunnerWorkState(db, epoch, clock), ledger = new RunnerBudgetLedger(db, clock), host = new RunnerHostProgress(db, epoch, clock)
  function record(kind: string, value: unknown, at = time) {
    const sequence = (db.prepare("SELECT next_sequence FROM tasks WHERE id='task'").get() as { next_sequence: number }).next_sequence
    const id = `record-${++serial}`, created_at = new Date(at).toISOString()
    db.prepare("INSERT INTO records(id,task_id,sequence,kind,payload_json,created_at) VALUES (?,'task',?,?,?,?)").run(id, sequence, kind, JSON.stringify(value), created_at)
    db.prepare("UPDATE tasks SET next_sequence=next_sequence+1,revision=revision+1 WHERE id='task'").run()
    return { id, sequence, created_at }
  }
  function addGoal(request = 'goal'): ExecutionScope {
    const run = `run-${request}`, work = `work-${request}`, attempt = `attempt-${request}`, budget = `budget-${request}`
    db.prepare("INSERT INTO requests(id,task_id,state,config_selection_json,input_json,created_at) VALUES (?,'task','started','{}',?,?)").run(request, JSON.stringify({ text: secret }), new Date(time).toISOString())
    const input = record('message.user', { text: secret }, time - 1000)
    state.receive({ input_event_id: `input-${request}`, task_id: 'task', kind: 'request', record_id: input.id, request_id: request, stage: 'received' })
    state.installGoal({ task_id: 'task', request_id: request, intent_revision: 1, input_event_id: `input-${request}`, state: 'active', requirements: [{ requirement_id: 'answer', kind: 'answer', required: true, provenance_required: false }] })
    ledger.create({ budget_id: budget, task_id: 'task', purpose: 'production', request_id: request, limits: { model_requests: 20, tool_requests: 50, tokens: 100000, wall_ms: 3600000 } })
    db.prepare("INSERT INTO runs(id,task_id,request_id,state,runtime_epoch,limits_json,budget_json,created_at) VALUES (?,'task',?,'running',?,'{}','{}',?)").run(run, request, epoch, new Date(time).toISOString())
    state.registerRun({ run_id: run, task_id: 'task', runtime_epoch: epoch, state: 'running', commit_valid: true, budget_id: budget, purpose: 'production', request_id: request, intent_revision: 1 })
    const logical: LogicalWork = { work_id: work, task_id: 'task', run_id: run, plan_revision: 1, role: 'producer', required: true, requirement_ids: ['answer'], dependencies: [{ kind: 'goal', task_id: 'task', request_id: request, intent_revision: 1 }], state: 'planned', max_attempts: 3, purpose: 'production', request_id: request, intent_revision: 1 }
    state.installPlan([logical])
    state.createAttempt({ attempt_id: attempt, work_id: work, task_id: 'task', run_id: run, runtime_epoch: epoch, attempt_number: 1, profile_id: 'producer', model_config_id: 'fixture', model_config_revision: 1, input_versions: logical.dependencies, state: 'registered', dispatch_state: 'not_dispatched', usage_refs: [], purpose: 'production', request_id: request, intent_revision: 1 })
    state.updateAttempt({ ...state.attempt(attempt), state: 'dispatched', dispatch_state: 'dispatched', operation_id: `operation-${request}` })
    state.updateAttempt({ ...state.attempt(attempt), state: 'running' })
    const owner: ExecutionScope = { task_id: 'task', run_id: run, work_id: work, attempt_id: attempt, role: 'producer', purpose: 'production', request_id: request, intent_revision: 1 }
    record('worker.input', { text: secret, owner, plan_revision: 1 }, time - 500)
    return owner
  }
  const owner = addGoal()
  function call(source = owner, execution = 'success', delivery = 'delivered', errorCode = 'PLUGIN_RETRY') {
    const id = `call-${++serial}`, at = time - 100 + serial
    db.prepare("INSERT INTO calls(id,task_id,run_id,capability_id,state,dispatch,execution,delivery,input_json,result_json,limits_json,commit_valid,created_at,ended_at) VALUES (?,'task',?,'plugin:worker','ended','sent',?,?,?, ?,?,0,?,?)").run(id, source.run_id, execution, delivery, JSON.stringify({ arguments: secret }), JSON.stringify({ error: { code: errorCode, message: secret }, data: secret }), JSON.stringify({ owner: source }), new Date(at - 1).toISOString(), new Date(at).toISOString())
    const event = record('plugin.call.ended', { call_id: id, execution, owner: source }, at)
    return { ...event, call_id: id }
  }
  function successes(source = owner, count = 4) { return Array.from({ length: count }, () => model(source, 'success', undefined, 1)) }
  function model(source = owner, execution = 'success', operation?: string, query_result_id?: number) {
    return record('model.tool_result', { owner: source, query_result_id, message: { role: 'tool', tool_call_id: 'reused-model-call-id', content: JSON.stringify({ request_type: 'read', execution, delivery: 'delivered', ...(operation ? { operation_id: operation } : {}), data: secret }) } }, time - 10)
  }
  function waiting(reason: string) {
    state.updateAttempt({ ...state.attempt(owner.attempt_id), state: 'waiting' })
    return record('worker.state', { owner, state: 'waiting', reason })
  }
  function observe(allowed = true, request = 'goal') { return host.observe('task', request, { capability_allowed: allowed }, { stalled_repeat_threshold: 3 }) }
  function records(kind: string) { return (db.prepare("SELECT id,sequence,payload_json FROM records WHERE task_id='task' AND kind=? ORDER BY sequence").all(kind) as { id: string; sequence: number; payload_json: string }[]).map(row => ({ ...row, payload: JSON.parse(row.payload_json) })) }
  function artifact() {
    const artifacts = new RunnerArtifactState(db, state), provenance = record('worker.content.produced', { owner, value: secret })
    artifacts.installOutline({ task_id: 'task', outline_revision: 1, base_outline_revision: 0, sections: [{ section_id: 'section', request_id: 'goal', intent_revision: 1, position_revision: 1, order_key: 'a' }] })
    artifacts.assign([{ task_id: 'task', artifact_id: 'artifact', work_id: owner.work_id, plan_revision: 1, section_id: 'section', base_artifact_revision: 0 }])
    db.prepare("INSERT INTO resources(id,storage_key,sha256,byte_length,media_type,display_name,created_at) VALUES ('body','body.json','fixture',2,'application/json','Content',?)").run(new Date(time).toISOString())
    db.prepare("INSERT INTO task_resources VALUES ('task','body')").run()
    const result = artifacts.decide({ candidate_id: 'candidate', task_id: 'task', request_id: 'goal', intent_revision: 1, run_id: owner.run_id, work_id: owner.work_id, attempt_id: owner.attempt_id, artifact_id: 'artifact', plan_revision: 1, base_artifact_revision: 0, bundle_resource_id: 'body', section_id: 'section', section_position_revision: 1, order_key: 'a', presentation_kind: 'managed-v1', width_constraint: 'full', interaction_kind: 'none', provenance_ref: { task_id: 'task', kind: 'record', id: provenance.id }, dependencies: state.work(owner.work_id).dependencies, requirement_ids: ['answer'], unresolved: [] }, { state: 'accepted' })
    expect(result.state).toBe('accepted')
  }
  function activeCall(requestType = 'call') {
    const operation = `background-${++serial}`
    const started = record('worker.tool.started', { owner, plan_revision: 1, request_type: requestType, capability: 'plugin:worker', operation_id: operation }, time - 100)
    const callId = `active-call-${++serial}`
    db.prepare("INSERT INTO calls(id,task_id,run_id,capability_id,state,dispatch,delivery,input_json,limits_json,commit_valid,created_at) VALUES (?,'task',?,'plugin:worker','executing','sent','pending',?,?,1,?)").run(callId, owner.run_id, JSON.stringify({ arguments: secret }), JSON.stringify({ owner }), new Date(time - 99).toISOString())
    return { ...started, call_id: callId, operation_id: operation }
  }
  function completeOutput(patch: Record<string, unknown> = {}) {
    const result = record('worker.result', { owner, text: secret }), result_ref = { task_id: 'task', kind: 'record' as const, id: result.id }
    state.updateAttempt({ ...state.attempt(owner.attempt_id), state: 'succeeded', result_ref })
    const work = state.work(owner.work_id), artifacts = new RunnerArtifactState(db, state), composition = new RunnerCompositionState(db, state, artifacts)
    const refs = (db.prepare("SELECT artifact_id,current_revision artifact_revision FROM runner_artifact_owners WHERE task_id='task' AND work_id=? AND plan_revision=?").all(work.work_id, work.plan_revision) as { artifact_id: string; artifact_revision: number }[]).map(item => ({ task_id: 'task', ...item }))
    const output = composition.declareOutputs({ task_id: 'task', request_id: 'goal', intent_revision: 1, run_id: owner.run_id, work_id: work.work_id, attempt_id: owner.attempt_id, plan_revision: work.plan_revision, result_revision: work.result_revision!, result_ref, complete: true, artifacts: refs, requirement_ids: ['answer'], unresolved: [] })
    const value = { owner, run_id: owner.run_id, plan_revision: work.plan_revision, result_revision: output.result_revision, requirement_ids: output.requirement_ids, artifacts: output.artifacts, inventory_revision: null, ...patch }
    return { ...record('runner.output.accepted', value), value, output }
  }
  return { db, epoch, clock, state, ledger, host, owner, addGoal, record, call, successes, model, waiting, observe, records, artifact, activeCall, completeOutput, advance: (amount: number) => { time += amount } }
}

it('records unchanged query results as a bounded metadata diagnosis', () => {
  const s = setup(), events = s.successes(), result = s.observe()
  expect(result.works[0]?.disposition).toBe('suspected_stall')
  expect(result.diagnoses[0]).toMatchObject({ task_id: 'task', request_id: 'goal', intent_revision: 1, work_id: s.owner.work_id, plan_revision: 1, reason: 'suspected_stall', model_diagnosis: 'eligible', required_role: 'diagnostic', automatic_replay: false, execution_permission: false, recovery_permission: false })
  expect(result.diagnoses[0]?.calls.map(call => call.record_id)).toEqual(events.map(event => event.id))
  expect(s.records('runner.progress.diagnosis')).toHaveLength(1)
  expect(s.records('runner.progress.checkpoint')[0]?.payload.reservations).toHaveLength(1)
  expect(JSON.stringify(result) + JSON.stringify(s.records('runner.progress.diagnosis'))).not.toContain(secret)
  expect((s.db.prepare('SELECT COUNT(*) n FROM runner_attempts').get() as { n: number }).n).toBe(1)
})

it('does not attribute another chapter update to matching run and attempt fields', () => {
  const s = setup()
  if (s.owner.purpose !== 'production') throw Error('Production fixture required')
  s.successes({ ...s.owner, update_id: 'another-update' })
  expect(s.observe().diagnoses).toEqual([])
})

it('counts separate query records with the same result identity even when model call IDs repeat', () => {
  const s = setup(), events = s.successes()
  const result = s.observe()
  expect(result.diagnoses[0]?.model_diagnosis).toBe('eligible')
  expect(result.diagnoses[0]?.calls.map(call => call.call_id)).toEqual(events.map(event => event.id))
  expect(JSON.stringify(result)).not.toContain(secret)
})

it('does not infer repeated results from legacy reads or successful plugin calls', () => {
  const s = setup()
  for (let i = 0; i < 4; i++) { s.model(); s.call() }
  const result = s.observe()
  expect(result.works[0]?.evidence.calls).toHaveLength(8)
  expect(result.diagnoses).toEqual([])
})

it('does not count a plugin completion again through its model tool result', () => {
  const s = setup(), event = s.call()
  s.record('plugin.call.ended', { call_id: event.call_id, execution: 'success', owner: s.owner })
  s.model(s.owner, 'success', event.call_id)
  expect(s.observe().diagnoses).toEqual([])
})

it('excludes actual calls whose complete persisted owner differs from the event', () => {
  const s = setup(); s.call()
  s.db.prepare("UPDATE calls SET limits_json=json_set(limits_json,'$.owner.role','router')").run()
  const result = s.observe()
  expect(result.works[0]?.evidence.calls).toEqual([])
  expect(result.diagnoses).toEqual([])
})

it('groups recognizable persistent failures without treating cancellation as failure', () => {
  const s = setup()
  for (let i = 0; i < 3; i++) s.call(s.owner, 'failure')
  s.call(s.owner, 'cancelled'); s.call(s.owner, 'not_executed')
  const result = s.observe()
  expect(result.diagnoses).toHaveLength(1)
  expect(result.diagnoses[0]).toMatchObject({ reason: 'repeated_failure', error_source: 'PLUGIN_RETRY', model_diagnosis: 'eligible' })
  expect(result.diagnoses[0]?.calls).toHaveLength(3)
})

it('uses fixed source codes when recorded errors contain arbitrary text', () => {
  const s = setup()
  for (let i = 0; i < 3; i++) s.call(s.owner, 'failure', 'delivered', secret)
  expect(s.observe().diagnoses[0]?.error_source).toBe('CALL_FAILED')
  expect(JSON.stringify(s.records('runner.progress.diagnosis'))).not.toContain(secret)
})

it('ignores legacy cumulative limits while respecting capability restrictions', () => {
  const s = setup(); s.successes()
  expect(s.observe(false).diagnoses[0]?.model_diagnosis).toBe('capability_blocked')
  s.ledger.reserve('other-operation-reservation', 'budget-goal', 'other-operation', { model_requests: 20 })
  s.db.prepare("UPDATE runner_budgets SET limits_json=? WHERE budget_id='budget-goal'").run(JSON.stringify({ model_requests: 0, tool_requests: 0, tokens: 0, wall_ms: 1 }))
  const result = s.observe()
  expect(result.diagnoses[0]?.model_diagnosis).toBe('eligible')
  expect(result.checkpoint.reservations).toHaveLength(1)
  expect((s.db.prepare('SELECT COUNT(*) n FROM runner_budget_reservations').get() as { n: number }).n).toBe(1)
})

it('reuses evidence reservations after closing and reopening real SQLite', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'pliuna-host-progress-')), 'business.sqlite'), s = setup(path)
  s.successes(); expect(s.observe().diagnoses[0]?.model_diagnosis).toBe('eligible')
  s.db.close()
  const db = new Database(path); databases.push(db)
  const result = new RunnerHostProgress(db, s.epoch, s.clock).observe('task', 'goal', { capability_allowed: true }, { stalled_repeat_threshold: 3 })
  expect(result.diagnoses[0]?.model_diagnosis).toBe('same_evidence')
  expect((db.prepare("SELECT COUNT(*) n FROM records WHERE kind='runner.progress.diagnosis'").get() as { n: number }).n).toBe(1)
})

it('shares the persisted diagnosis frequency across independent goals', () => {
  const s = setup(); s.successes(); expect(s.observe().diagnoses[0]?.model_diagnosis).toBe('eligible')
  const second = s.addGoal('second'); s.successes(second)
  expect(s.observe(true, 'second').diagnoses[0]?.model_diagnosis).toBe('rate_limited')
  expect(s.records('runner.progress.checkpoint').at(-1)?.payload.reservations).toHaveLength(1)
})

it('rolls diagnosis, checkpoint and task sequence back together on install failure', () => {
  const s = setup(); s.successes()
  const before = s.db.prepare("SELECT revision,next_sequence FROM tasks WHERE id='task'").get()
  s.db.exec("CREATE TRIGGER reject_checkpoint BEFORE INSERT ON records WHEN NEW.kind='runner.progress.checkpoint' BEGIN SELECT RAISE(ABORT,'checkpoint fault'); END")
  expect(() => s.observe()).toThrow('checkpoint fault')
  expect(s.records('runner.progress.diagnosis')).toEqual([])
  expect(s.records('runner.progress.checkpoint')).toEqual([])
  expect(s.db.prepare("SELECT revision,next_sequence FROM tasks WHERE id='task'").get()).toEqual(before)
  s.db.exec('DROP TRIGGER reject_checkpoint')
  expect(s.observe().diagnoses[0]?.model_diagnosis).toBe('eligible')
})

it('recognizes pending approval only while its exact owner and expiry remain valid', () => {
  const s = setup(); s.successes(); const waiting = s.waiting('approval')
  s.db.prepare("INSERT INTO actions(id,task_id,run_id,kind,state,source_json,request_json,commit_valid,created_at) VALUES ('approval-action','task',?,'mutation','waiting',?,?,1,?)").run(s.owner.run_id, JSON.stringify({ owner: s.owner }), JSON.stringify({ body: secret }), waiting.created_at)
  s.db.prepare("INSERT INTO approvals VALUES ('approval','approval-action','pending','valid','manual','awaiting_human',?,NULL,?)").run(new Date(s.clock() + 10000).toISOString(), JSON.stringify({ owner: s.owner, runtime_epoch: s.epoch, request: secret }))
  expect(s.observe().works[0]?.disposition).toBe('waiting_approval')
  expect(s.observe().diagnoses).toEqual([])
  s.advance(10001)
  expect(s.observe().diagnoses[0]?.reason).toBe('suspected_stall')
})

it('does not reuse an approval owned by a different attempt', () => {
  const s = setup(); s.successes(); const waiting = s.waiting('approval')
  s.db.prepare("INSERT INTO actions(id,task_id,run_id,kind,state,source_json,request_json,commit_valid,created_at) VALUES ('approval-action','task',?,'mutation','waiting',?,'{}',1,?)").run(s.owner.run_id, JSON.stringify({ owner: s.owner }), waiting.created_at)
  s.db.prepare("INSERT INTO approvals VALUES ('approval','approval-action','pending','valid','manual','awaiting_human',?,NULL,?)").run(new Date(s.clock() + 10000).toISOString(), JSON.stringify({ owner: { ...s.owner, attempt_id: 'different-attempt' }, runtime_epoch: s.epoch }))
  expect(s.observe().works[0]?.disposition).toBe('suspected_stall')
})

it('recognizes an explicit current input wait and stops suppressing after resumption', () => {
  const s = setup(); s.successes(); s.waiting('input_required')
  expect(s.observe().works[0]?.disposition).toBe('waiting_input')
  s.state.updateAttempt({ ...s.state.attempt(s.owner.attempt_id), state: 'running' })
  s.record('worker.state', { owner: s.owner, state: 'running' })
  expect(s.observe().works[0]?.disposition).toBe('suspected_stall')
})

it('recognizes actual dispatched background calls with a fixed validity interval', () => {
  const s = setup(); s.successes(); const active = s.activeCall()
  const result = s.observe()
  expect(result.works[0]?.disposition).toBe('background')
  expect(result.works[0]?.evidence.background[0]).toMatchObject({ record_id: active.id, operation_id: active.call_id })
  expect(result.diagnoses).toEqual([])
  s.db.prepare("UPDATE calls SET state='ended',execution='success',commit_valid=0 WHERE id=?").run(active.call_id)
  s.record('worker.tool.ended', { owner: s.owner, operation_id: active.operation_id, source_operation_id: active.call_id, state: 'completed' })
  expect(s.observe().works[0]?.disposition).toBe('suspected_stall')
})

it('does not turn short reads or a billing reservation into background execution', () => {
  const s = setup(); s.successes(); s.activeCall('read')
  s.ledger.reserve('tool-reservation', 'budget-goal', 'slow-read', { tool_requests: 1 }, s.owner.attempt_id)
  s.ledger.markDispatched('tool-reservation')
  expect(s.observe().works[0]?.disposition).toBe('suspected_stall')
})

it('keeps accepted unpublished content as progress without renewing old evidence', () => {
  const s = setup(); s.successes(); s.artifact()
  const producedAt = s.clock(); s.advance(1000)
  const result = s.observe()
  expect(result.works[0]?.disposition).toBe('progressing')
  expect(result.diagnoses).toEqual([])
  expect(s.records('runner.progress.artifact')).toHaveLength(1)
  expect(s.records('runner.progress.artifact')[0]?.payload).toMatchObject({ effective_at: producedAt, source_ref: { task_id: 'task', kind: 'resource', id: 'body' }, source_created_at: new Date(producedAt).toISOString() })
  expect(result.works[0]?.evidence.progress[0]?.at).toBe(producedAt)
  expect((s.db.prepare('SELECT COUNT(*) n FROM runner_view_mappings').get() as { n: number }).n).toBe(0)
  s.advance(60001); s.successes()
  expect(s.observe().works[0]?.disposition).toBe('suspected_stall')
  expect(s.records('runner.progress.artifact')).toHaveLength(1)
})

it('does not treat the first observation of an old accepted resource as new progress', () => {
  const s = setup(); s.artifact(); s.advance(60001); s.successes()
  const result = s.observe()
  expect(result.works[0]?.disposition).toBe('suspected_stall')
  expect(result.works[0]?.evidence.progress).toEqual([])
  expect(s.records('runner.progress.artifact')).toEqual([])
})

it('uses the persisted exact output acceptance record as progress for an unpublished final result', () => {
  const s = setup(); s.artifact(); const accepted = s.completeOutput(), acceptedAt = s.clock()
  s.advance(1000)
  const result = s.observe()
  expect(result.works[0]?.disposition).toBe('completed')
  expect(result.works[0]?.evidence.progress).toEqual([{ record_id: accepted.id, sequence: accepted.sequence, at: acceptedAt, owner: s.owner, plan_revision: 1 }])
  expect(s.records('runner.progress.artifact')).toEqual([])
  expect((s.db.prepare('SELECT COUNT(*) n FROM runner_view_mappings').get() as { n: number }).n).toBe(0)
  expect(JSON.stringify(result)).not.toContain(secret)
})

it.each([
  { plan_revision: 2 }, { result_revision: 2 }, { requirement_ids: [] },
  { artifacts: [{ task_id: 'task', artifact_id: 'missing', artifact_revision: 1 }] },
  { owner: { task_id: 'task', run_id: 'run-goal', work_id: 'work-goal', attempt_id: 'other-attempt', role: 'producer', purpose: 'production', request_id: 'goal', intent_revision: 1 } }
])('requires exact persisted output bindings for acceptance metadata %j', patch => {
  const s = setup(); s.completeOutput(patch)
  expect(s.observe().works[0]?.evidence.progress).toEqual([])
})

it('does not renew output progress when acceptance is recorded again later', () => {
  const s = setup(), accepted = s.completeOutput()
  s.advance(60001); s.record('runner.output.accepted', accepted.value)
  expect(s.observe().works[0]?.evidence.progress).toEqual([])
})

it('rolls newly observed artifact evidence back when checkpoint installation fails', () => {
  const s = setup(); s.successes(); s.artifact()
  s.db.exec("CREATE TRIGGER reject_checkpoint BEFORE INSERT ON records WHEN NEW.kind='runner.progress.checkpoint' BEGIN SELECT RAISE(ABORT,'checkpoint fault'); END")
  expect(() => s.observe()).toThrow('checkpoint fault')
  expect(s.records('runner.progress.artifact')).toEqual([])
  expect(s.records('runner.progress.checkpoint')).toEqual([])
})

it('excludes calls from a previous plan and retains their original attribution', () => {
  const s = setup(); const events = s.successes()
  const { current_attempt_id: _current, ...old } = s.state.work(s.owner.work_id)
  s.state.updateAttempt({ ...s.state.attempt(s.owner.attempt_id), state: 'failed' }, { ...old, plan_revision: 2, state: 'planned' })
  const next = { ...s.state.attempt(s.owner.attempt_id), attempt_id: 'next-attempt', attempt_number: 2, previous_attempt_id: s.owner.attempt_id, state: 'registered' as const, dispatch_state: 'not_dispatched' as const, usage_refs: [] }
  const { operation_id: _operation, ...registered } = next
  s.state.createAttempt(registered)
  s.state.updateAttempt({ ...registered, state: 'dispatched', dispatch_state: 'dispatched', operation_id: 'next-operation' })
  s.state.updateAttempt({ ...s.state.attempt('next-attempt'), state: 'running' })
  const owner = { ...s.owner, attempt_id: 'next-attempt' }
  s.record('worker.input', { owner, plan_revision: 2 })
  expect(s.observe().diagnoses).toEqual([])
  s.successes(owner)
  const result = s.observe()
  expect(result.diagnoses[0]?.calls.every(call => !events.some(event => event.id === call.record_id))).toBe(true)
  expect(result.diagnoses[0]?.plan_revision).toBe(2)
})

it('does not diagnose execution facts from a revoked runtime epoch', () => {
  const s = setup(); s.successes()
  const result = new RunnerHostProgress(s.db, 'new-epoch', s.clock).observe('task', 'goal', { capability_allowed: true }, { stalled_repeat_threshold: 3 })
  expect(result.works[0]?.disposition).toBe('inactive')
  expect(result.diagnoses).toEqual([])
})

it('preserves unresolved calls and never turns them into automatic replay permission', () => {
  const s = setup(); s.successes(); s.call(s.owner, 'unknown')
  const before = s.db.prepare('SELECT COUNT(*) n FROM calls').get()
  const result = s.observe()
  expect(result.works[0]?.disposition).toBe('unresolved_operation')
  expect(result.diagnoses).toEqual([])
  expect(s.db.prepare('SELECT COUNT(*) n FROM calls').get()).toEqual(before)
})
