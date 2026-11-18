import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { afterEach, expect, it } from 'vitest'
import type { ArtifactCandidate, ExecutionAttempt, GoalRevision, LogicalWork, Outline, WorkDependency } from '../../src/shared/contracts.generated'
import { RunnerArtifactState, type ArtifactAssignment } from '../../src/runtime/runner/artifact-state'
import { RunnerBudgetLedger } from '../../src/runtime/runner/budget'
import { RunnerWorkState } from '../../src/runtime/runner/work-state'
import { bundleMediaType } from '../../src/shared/branding'

const coreSql = readFileSync(new URL('../../src/shared/contracts/001-core.sql', import.meta.url), 'utf8')
const runnerSql = readFileSync(new URL('../../src/shared/contracts/002-runner.sql', import.meta.url), 'utf8')
const databases: Database.Database[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })

const goal: GoalRevision = { task_id: 'task', request_id: 'goal', intent_revision: 1, input_event_id: 'input', state: 'active', requirements: [{ requirement_id: 'answer', kind: 'answer', required: true, provenance_required: false }] }
const outline: Outline = { task_id: 'task', outline_revision: 1, base_outline_revision: 0, sections: [{ section_id: 'section', request_id: 'goal', intent_revision: 1, order_key: 'a', position_revision: 1, title: 'Original' }] }
const assignment: ArtifactAssignment = { task_id: 'task', artifact_id: 'artifact', work_id: 'work', plan_revision: 1, section_id: 'section', base_artifact_revision: 0 }

function addGoal(db: Database.Database, work: RunnerWorkState, requestId: string): GoalRevision {
  db.prepare("INSERT INTO requests(id,task_id,state,config_selection_json,input_json,created_at) VALUES (?,'task','started','{}','{}','time')").run(requestId)
  const sequence = (db.prepare('SELECT COALESCE(MAX(sequence),0)+1 value FROM records WHERE task_id=?').get('task') as { value: number }).value
  db.prepare("INSERT INTO records(id,task_id,sequence,kind,payload_json,created_at) VALUES (?,'task',?,'message.user','{}','time')").run(`record-${requestId}`, sequence)
  work.receive({ input_event_id: `input-${requestId}`, task_id: 'task', kind: 'request', record_id: `record-${requestId}`, request_id: requestId, stage: 'received' })
  return work.installGoal({ ...goal, request_id: requestId, input_event_id: `input-${requestId}` })
}
function reviseGoal(db: Database.Database, work: RunnerWorkState, requestId = 'goal'): void {
  const sequence = (db.prepare('SELECT MAX(sequence)+1 value FROM records WHERE task_id=?').get('task') as { value: number }).value
  db.prepare("INSERT INTO records(id,task_id,sequence,kind,payload_json,created_at) VALUES (?,'task',?,'message.user','{}','time')").run(`correction-${requestId}`, sequence)
  work.receive({ input_event_id: `correction-${requestId}`, task_id: 'task', kind: 'correction', record_id: `correction-${requestId}`, request_id: requestId, stage: 'received' })
  work.installGoal({ ...work.goal(requestId), intent_revision: 2, previous_revision: 1, input_event_id: `correction-${requestId}` })
}
function logicalWork(workId = 'work', dependencies: WorkDependency[] = [{ kind: 'goal', task_id: 'task', request_id: 'goal', intent_revision: 1 }]): LogicalWork {
  return { work_id: workId, task_id: 'task', run_id: 'run', plan_revision: 1, role: 'producer', required: true, requirement_ids: ['answer'], dependencies, state: 'planned', max_attempts: 2, purpose: 'production', request_id: 'goal', intent_revision: 1 }
}
function startAttempt(work: RunnerWorkState, workId = 'work', attemptId = 'attempt', changes: Partial<ExecutionAttempt> = {}, dispatch = true): void {
  const value: ExecutionAttempt = { attempt_id: attemptId, task_id: 'task', run_id: 'run', work_id: workId, runtime_epoch: 'epoch', attempt_number: 1, profile_id: 'producer', model_config_id: 'model', model_config_revision: 1, input_versions: work.work(workId).dependencies, state: 'registered', dispatch_state: 'not_dispatched', usage_refs: [], purpose: 'production', request_id: 'goal', intent_revision: 1, ...changes } as ExecutionAttempt
  work.createAttempt(value)
  if (!dispatch) return
  work.updateAttempt({ ...work.attempt(attemptId), state: 'dispatched', dispatch_state: 'dispatched', operation_id: `operation-${attemptId}` })
  work.updateAttempt({ ...work.attempt(attemptId), state: 'running' })
}
function resource(db: Database.Database, resourceId: string, taskId = 'task'): void {
  db.prepare("INSERT INTO resources(id,storage_key,sha256,byte_length,media_type,display_name,created_at) VALUES (?,?,'fixture',2,'application/json','Body','time')").run(resourceId, `${resourceId}.json`)
  db.prepare('INSERT INTO task_resources(task_id,resource_id) VALUES (?,?)').run(taskId, resourceId)
}
function setup(install = true, withDependency = false) {
  const db = new Database(':memory:'); databases.push(db)
  db.pragma('foreign_keys=ON'); db.exec(coreSql); db.exec(runnerSql)
  db.prepare("INSERT INTO tasks(id,title,state,revision) VALUES ('task','Task','active',1),('other','Other','active',1)").run()
  db.prepare("INSERT INTO requests(id,task_id,state,config_selection_json,input_json,created_at) VALUES ('goal','task','started','{}','{}','time')").run()
  db.prepare("INSERT INTO records(id,task_id,sequence,kind,payload_json,created_at) VALUES ('record','task',1,'message.user','{}','time')").run()
  const work = new RunnerWorkState(db, 'epoch')
  work.receive({ input_event_id: 'input', task_id: 'task', kind: 'request', record_id: 'record', request_id: 'goal', stage: 'received' })
  work.installGoal(goal)
  const ledger = new RunnerBudgetLedger(db)
  ledger.create({ budget_id: 'budget', task_id: 'task', purpose: 'production', request_id: 'goal', limits: { model_requests: 10, tool_requests: 10, tokens: 1000, wall_ms: 60000 } })
  db.prepare("INSERT INTO runs(id,task_id,request_id,state,runtime_epoch,limits_json,budget_json,created_at) VALUES ('run','task','goal','running','epoch','{}','{}','time')").run()
  work.registerRun({ run_id: 'run', task_id: 'task', runtime_epoch: 'epoch', state: 'running', commit_valid: true, budget_id: 'budget', purpose: 'production', request_id: 'goal', intent_revision: 1 })
  const dependencies = logicalWork().dependencies
  if (withDependency) { addGoal(db, work, 'reference'); dependencies.push({ kind: 'goal', task_id: 'task', request_id: 'reference', intent_revision: 1 }) }
  work.installPlan([logicalWork('work', dependencies)])
  const state = new RunnerArtifactState(db, work)
  if (install) { state.installOutline(outline); state.assign([assignment]) }
  startAttempt(work)
  resource(db, 'body')
  const candidate: ArtifactCandidate = { candidate_id: 'candidate', task_id: 'task', request_id: 'goal', intent_revision: 1, run_id: 'run', work_id: 'work', attempt_id: 'attempt', artifact_id: 'artifact', base_artifact_revision: 0, plan_revision: 1, bundle_resource_id: 'body', section_id: 'section', section_position_revision: 1, order_key: 'a', presentation_kind: 'managed-v1', width_constraint: 'full', interaction_kind: 'none', provenance_ref: { task_id: 'task', kind: 'record', id: 'record' }, requirement_ids: ['answer'], unresolved: [], dependencies }
  return { db, work, state, candidate }
}

it('installs exact outline predecessors, preserves history and repeats an installed revision', () => {
  const { db, state } = setup(false)
  expect(state.outline('task')).toBeNull()
  expect(() => state.installOutline({ ...outline, outline_revision: 2 })).toThrow(/predecessor/)
  expect(state.installOutline(outline)).toEqual(outline)
  const renamed: Outline = { ...outline, outline_revision: 2, base_outline_revision: 1, sections: [{ ...outline.sections[0]!, title: 'Renamed' }] }
  expect(state.installOutline(renamed)).toEqual(renamed)
  expect(state.outline('task', 1)).toEqual(outline)
  expect(state.outline('task')).toEqual(renamed)
  expect(() => state.installOutline({ ...renamed, sections: [] })).toThrow(/overwritten/)
  db.prepare("UPDATE tasks SET state='stopped' WHERE id='task'").run()
  expect(state.installOutline(outline)).toEqual(outline)
  expect(state.outline('other')).toBeNull()
})

it('accepts outline proposals only from the current dispatched Router of the same Task', () => {
  const { db, work, state } = setup(false)
  expect(() => state.acceptOutline(outline, 'attempt')).toThrow('current dispatched Router')
  work.installPlan([{ ...logicalWork('router'), role: 'router', required: false }])
  startAttempt(work, 'router', 'router-attempt', { profile_id: 'router' }, false)
  expect(() => state.acceptOutline(outline, 'router-attempt')).toThrow()
  expect(state.outline('task')).toBeNull()
  work.updateAttempt({ ...work.attempt('router-attempt'), state: 'dispatched', dispatch_state: 'dispatched', operation_id: 'router-operation' })
  work.updateAttempt({ ...work.attempt('router-attempt'), state: 'running' })
  expect(() => state.acceptOutline({ ...outline, task_id: 'other', sections: [] }, 'router-attempt')).toThrow('current dispatched Router')
  expect(state.acceptOutline(outline, 'router-attempt')).toEqual(outline)
  const renamed: Outline = { ...outline, outline_revision: 2, base_outline_revision: 1, sections: [{ ...outline.sections[0]!, title: 'Renamed' }] }
  work.updateAttempt({ ...work.attempt('router-attempt'), state: 'succeeded', result_ref: { task_id: 'task', kind: 'record', id: 'record' } })
  expect(state.acceptOutline(renamed, 'router-attempt')).toEqual(renamed)
  expect(() => new RunnerArtifactState(db, new RunnerWorkState(db, 'new-epoch')).acceptOutline(renamed, 'router-attempt')).toThrow()
})

it('denies old and revoked Router sources while retaining their accepted outline history', () => {
  const { work, state } = setup(false)
  work.installPlan([{ ...logicalWork('router'), role: 'router', required: false }])
  startAttempt(work, 'router', 'old-router', { profile_id: 'router' })
  expect(state.acceptOutline(outline, 'old-router')).toEqual(outline)
  work.updateAttempt({ ...work.attempt('old-router'), state: 'failed' }, { ...logicalWork('router'), role: 'router', required: false, plan_revision: 2, state: 'queued' })
  startAttempt(work, 'router', 'new-router', { profile_id: 'router', attempt_number: 2, previous_attempt_id: 'old-router' })
  const next: Outline = { ...outline, outline_revision: 2, base_outline_revision: 1 }
  expect(() => state.acceptOutline(next, 'old-router')).toThrow()
  work.revokeWork('router')
  expect(() => state.acceptOutline(next, 'new-router')).toThrow()
  expect(state.outline('task')).toEqual(outline)
})

it('renames and moves stable sections without changing accepted content or owners', () => {
  const { state, candidate } = setup()
  const accepted = state.decide(candidate, { state: 'accepted' })
  const owner = state.owner('task', 'artifact')
  state.installOutline({ ...outline, outline_revision: 2, base_outline_revision: 1, sections: [{ ...outline.sections[0]!, title: 'Renamed' }] })
  state.installOutline({ ...outline, outline_revision: 3, base_outline_revision: 2, sections: [{ ...outline.sections[0]!, title: 'Renamed', order_key: 'b', position_revision: 2 }] })
  expect(state.owner('task', 'artifact')).toEqual(owner)
  expect(state.artifact('task', 'artifact')).toEqual(accepted.state === 'accepted' ? accepted.index : null)
  expect(state.artifact('task', 'artifact')?.artifact_revision).toBe(1)
  expect(state.outline('task')?.sections[0]).toMatchObject({ section_id: 'section', position_revision: 2, order_key: 'b' })
})

it('rejects rewritten section identities, obsolete goals and incorrect position predecessors', () => {
  const { db, work, state } = setup()
  addGoal(db, work, 'another')
  const next = { ...outline, outline_revision: 2, base_outline_revision: 1 }
  expect(() => state.installOutline({ ...next, sections: [{ ...outline.sections[0]!, request_id: 'another' }] })).toThrow(/identity/)
  expect(() => state.installOutline({ ...next, sections: [{ ...outline.sections[0]!, order_key: 'b' }] })).toThrow(/position/)
  expect(() => state.installOutline({ ...next, sections: [{ ...outline.sections[0]!, position_revision: 2 }] })).toThrow(/position/)
  expect(() => state.installOutline({ ...next, sections: [{ ...outline.sections[0]!, section_id: 'new', position_revision: 2 }] })).toThrow(/position/)
  reviseGoal(db, work)
  expect(() => state.installOutline(next)).toThrow(/current goal/)
  expect(state.outline('task')).toEqual(outline)
})

it('does not reuse a removed section identity for another goal', () => {
  const { db, work, state } = setup()
  addGoal(db, work, 'another')
  state.installOutline({ ...outline, outline_revision: 2, base_outline_revision: 1, sections: [] })
  expect(() => state.installOutline({ ...outline, outline_revision: 3, base_outline_revision: 2, sections: [{ ...outline.sections[0]!, request_id: 'another' }] })).toThrow(/identity/)
  expect(state.outline('task')?.outline_revision).toBe(2)
})

it('installs owner assignments atomically and requires registered work and sections', () => {
  const { state } = setup(false)
  expect(() => state.assign([assignment])).toThrow(/section/)
  state.installOutline(outline)
  expect(() => state.assign([assignment, { ...assignment, artifact_id: 'second', work_id: 'missing' }])).toThrow(/does not exist/)
  expect(state.owner('task', 'artifact')).toBeNull()
  expect(() => state.assign([{ ...assignment, base_artifact_revision: 1 }])).toThrow(/baseline/)
  expect(() => state.assign([{ ...assignment, previous_owner: { work_id: 'work', plan_revision: 1 } }])).toThrow(/owner/)
  expect(state.assign([assignment])[0]).toMatchObject({ work_id: 'work', current_revision: 0 })
})

it('retains the current pointer on duplicate assignment and explicit reassignment', () => {
  const { state, work, candidate } = setup()
  state.decide(candidate, { state: 'accepted' })
  expect(state.assign([assignment])[0]?.current_revision).toBe(1)
  work.installPlan([logicalWork('replacement')])
  const next: ArtifactAssignment = { ...assignment, work_id: 'replacement', base_artifact_revision: 1, previous_owner: { work_id: 'work', plan_revision: 1 } }
  expect(() => state.assign([{ ...next, base_artifact_revision: 0 }])).toThrow(/baseline/)
  expect(() => state.assign([{ ...next, previous_owner: { work_id: 'other-work', plan_revision: 1 } }])).toThrow(/owner/)
  expect(state.assign([next])[0]).toMatchObject({ work_id: 'replacement', current_revision: 1 })
  expect(() => state.assign([assignment])).toThrow(/owner/)
  expect(state.artifact('task', 'artifact')?.work_id).toBe('work')
  expect(state.assign([next])[0]?.current_revision).toBe(1)
})

it('rejects foreign owners and assignments outside the current plan, epoch or goal', () => {
  const { db, work, state } = setup()
  expect(() => state.assign([{ ...assignment, task_id: 'other' }])).toThrow(/another Task/)
  expect(state.owner('other', 'artifact')).toBeNull()
  expect(() => state.assign([{ ...assignment, artifact_id: 'new', plan_revision: 2 }])).toThrow(/production plan/)
  expect(() => new RunnerArtifactState(db, new RunnerWorkState(db, 'later')).assign([{ ...assignment, artifact_id: 'new' }])).toThrow(/production plan/)
  reviseGoal(db, work)
  expect(() => state.assign([{ ...assignment, artifact_id: 'new' }])).toThrow(/obsolete goal/)
})

it('accepts one immutable content revision with its candidate and advances the exact current pointer', () => {
  const { db, state, candidate } = setup()
  expect(state.artifact('task', 'artifact')).toBeNull()
  const result = state.decide(candidate, { state: 'accepted' })
  expect(result).toMatchObject({ state: 'accepted', index: { artifact_id: 'artifact', artifact_revision: 1, bundle_resource_id: 'body', acceptance_state: 'accepted' } })
  expect(state.owner('task', 'artifact')?.current_revision).toBe(1)
  expect(state.candidate('task', 'candidate')).toEqual({ candidate, result })
  expect(state.artifact('other', 'artifact')).toBeNull()
  expect(state.candidate('other', 'candidate')).toBeNull()
  expect(db.prepare('SELECT * FROM runner_candidates').all()).toHaveLength(1)
  expect(db.prepare('SELECT * FROM runner_artifacts').all()).toHaveLength(1)
})

it('returns the original acceptance after restart, cancellation and later accepted revisions', () => {
  const { db, state, work, candidate } = setup()
  const first = state.decide(candidate, { state: 'accepted' })
  resource(db, 'body-2')
  const next = { ...candidate, candidate_id: 'new', base_artifact_revision: 1, bundle_resource_id: 'body-2' }
  expect(state.decide(next, { state: 'accepted' })).toMatchObject({ state: 'accepted', index: { artifact_revision: 2 } })
  db.prepare("UPDATE runs SET state='cancelled',commit_valid=0 WHERE id='run'").run()
  const restarted = new RunnerArtifactState(db, new RunnerWorkState(db, 'new-epoch'))
  expect(restarted.decide({ ...candidate, provenance_ref: { id: 'record', kind: 'record', task_id: 'task' } }, { state: 'rejected', code: 'LATER_REVIEW' })).toEqual(first)
  expect(restarted.artifact('task', 'artifact')?.artifact_revision).toBe(2)
  expect(restarted.artifact('task', 'artifact', 1)).toEqual(first.state === 'accepted' ? first.index : null)
  expect(work.attempt('attempt').state).toBe('running')
})

it('keeps accepted history detached from mutable return values and rejects conflicting candidate payloads', () => {
  const { state, candidate } = setup()
  const accepted = state.decide(candidate, { state: 'accepted' })
  if (accepted.state === 'accepted') accepted.index.title = 'Changed by caller'
  expect(state.artifact('task', 'artifact')?.title).toBeUndefined()
  expect(() => state.decide({ ...candidate, title: 'Conflicting payload' }, { state: 'accepted' })).toThrow(/original payload/)
  expect(state.candidate('task', candidate.candidate_id)?.candidate).toEqual(candidate)
  expect(state.owner('task', 'artifact')?.current_revision).toBe(1)
})

it('records a stable rejection for a late baseline and never regresses the current pointer', () => {
  const { db, state, candidate } = setup()
  state.decide(candidate, { state: 'accepted' })
  const late = { ...candidate, candidate_id: 'late' }
  const rejected = state.decide(late, { state: 'accepted' })
  expect(rejected).toEqual({ state: 'rejected', code: 'RUNNER_ARTIFACT_CONFLICT' })
  expect(state.candidate('task', 'late')).toEqual({ candidate: late, result: rejected })
  expect(state.decide(late, { state: 'accepted' })).toEqual(rejected)
  expect(state.owner('task', 'artifact')?.current_revision).toBe(1)
  expect(db.prepare('SELECT * FROM runner_artifacts').all()).toHaveLength(1)
})

it('rejects the former owner after reassignment and accepts only the new registered source', () => {
  const { state, work, candidate } = setup()
  state.decide(candidate, { state: 'accepted' })
  work.installPlan([logicalWork('replacement')])
  startAttempt(work, 'replacement', 'replacement-attempt')
  state.assign([{ ...assignment, work_id: 'replacement', base_artifact_revision: 1, previous_owner: { work_id: 'work', plan_revision: 1 } }])
  expect(state.decide({ ...candidate, candidate_id: 'old-owner', base_artifact_revision: 1 }, { state: 'accepted' })).toEqual({ state: 'rejected', code: 'RUNNER_OWNERSHIP_INVALID' })
  const fresh = { ...candidate, candidate_id: 'new-owner', work_id: 'replacement', attempt_id: 'replacement-attempt', base_artifact_revision: 1 }
  expect(state.decide(fresh, { state: 'accepted' })).toMatchObject({ state: 'accepted', index: { artifact_revision: 2, work_id: 'replacement' } })
  expect(state.owner('task', 'artifact')).toMatchObject({ work_id: 'replacement', current_revision: 2 })
})

it('preserves the first content review outcome even if later qualification and review change', () => {
  const { db, state, candidate } = setup()
  const rejected = state.decide(candidate, { state: 'rejected', code: 'CONTENT_REVIEW_FAILED' })
  expect(rejected).toEqual({ state: 'rejected', code: 'CONTENT_REVIEW_FAILED' })
  db.prepare("UPDATE runs SET state='completed',commit_valid=0 WHERE id='run'").run()
  expect(state.decide(candidate, { state: 'accepted' })).toEqual(rejected)
  expect(state.artifact('task', 'artifact')).toBeNull()
  expect(state.owner('task', 'artifact')?.current_revision).toBe(0)
})

it('rechecks a dependency revision even when the candidate goal and baseline are unchanged', () => {
  const { db, state, work, candidate } = setup(true, true)
  reviseGoal(db, work, 'reference')
  expect(work.goal('goal').intent_revision).toBe(1)
  expect(state.decide(candidate, { state: 'accepted' })).toEqual({ state: 'rejected', code: 'RUNNER_DEPENDENCY_INVALID' })
  expect(state.owner('task', 'artifact')?.current_revision).toBe(0)
})

it.each([
  ['current goal', (db: Database.Database, work: RunnerWorkState) => reviseGoal(db, work)],
  ['Task state', (db: Database.Database) => db.prepare("UPDATE tasks SET state='stopped' WHERE id='task'").run()],
  ['Run commit authority', (db: Database.Database) => db.prepare("UPDATE runs SET commit_valid=0 WHERE id='run'").run()],
  ['Run completion', (db: Database.Database) => db.prepare("UPDATE runs SET state='completed',commit_valid=0 WHERE id='run'").run()]
] as const)('records rejection when %s changes before acceptance', (_name, change) => {
  const { db, state, work, candidate } = setup()
  change(db, work)
  expect(state.decide(candidate, { state: 'accepted' })).toEqual({ state: 'rejected', code: 'RUNNER_OWNERSHIP_INVALID' })
  expect(state.artifact('task', 'artifact')).toBeNull()
})

it('rejects obsolete attempts and runtime epochs without changing the artifact pointer', () => {
  const { db, state, work, candidate } = setup()
  work.updateAttempt({ ...work.attempt('attempt'), state: 'failed' }, { ...logicalWork(), plan_revision: 2, state: 'queued' })
  startAttempt(work, 'work', 'new-attempt', { attempt_number: 2, previous_attempt_id: 'attempt' })
  state.assign([{ ...assignment, plan_revision: 2, previous_owner: { work_id: 'work', plan_revision: 1 } }])
  expect(state.decide(candidate, { state: 'accepted' })).toEqual({ state: 'rejected', code: 'RUNNER_OWNERSHIP_INVALID' })
  const restarted = new RunnerArtifactState(db, new RunnerWorkState(db, 'later'))
  expect(restarted.decide({ ...candidate, candidate_id: 'late-epoch', attempt_id: 'new-attempt', plan_revision: 2 }, { state: 'accepted' })).toEqual({ state: 'rejected', code: 'RUNNER_OWNERSHIP_INVALID' })
  expect(state.owner('task', 'artifact')?.current_revision).toBe(0)
})

const invalidBindings: Array<[string, Partial<ArtifactCandidate>]> = [
  ['work', { work_id: 'wrong' }],
  ['attempt', { attempt_id: 'missing' }],
  ['plan', { plan_revision: 2 }],
  ['intent', { intent_revision: 2 }],
  ['section', { section_id: 'missing' }],
  ['position', { section_position_revision: 2 }],
  ['order', { order_key: 'b' }],
  ['dependency set', { dependencies: [] }],
  ['requirement', { requirement_ids: ['unowned'] }]
]
it.each(invalidBindings)('retains a rejected candidate whose %s binding is invalid', (_name, changes) => {
  const { state, candidate } = setup()
  const invalid = { ...candidate, ...changes }
  const result = state.decide(invalid, { state: 'accepted' })
  expect(result.state).toBe('rejected')
  expect(state.candidate('task', 'candidate')).toEqual({ candidate: invalid, result })
  expect(state.owner('task', 'artifact')?.current_revision).toBe(0)
})

it('rejects absent or foreign resource associations and freezes that rejection after repair', () => {
  const { db, state, candidate } = setup()
  resource(db, 'foreign-body', 'other')
  const foreign = { ...candidate, bundle_resource_id: 'foreign-body' }
  const rejected = { state: 'rejected', code: 'RUNNER_RESOURCE_INVALID' }
  expect(state.decide(foreign, { state: 'accepted' })).toEqual(rejected)
  db.prepare("INSERT INTO task_resources(task_id,resource_id) VALUES ('task','foreign-body')").run()
  expect(state.decide(foreign, { state: 'accepted' })).toEqual(rejected)
  expect(state.decide({ ...candidate, candidate_id: 'absent', bundle_resource_id: 'absent' }, { state: 'accepted' })).toEqual(rejected)
  expect(state.artifact('task', 'artifact')).toBeNull()
})

it.each(['application/json', bundleMediaType])('accepts a bundle resource at the existing 256 KiB boundary with %s', mediaType => {
  const { db, state, candidate } = setup()
  db.prepare("UPDATE resources SET byte_length=?,media_type=? WHERE id='body'").run(262144, mediaType)
  expect(state.decide(candidate, { state: 'accepted' }).state).toBe('accepted')
})

it.each([
  [262145, 'application/json'],
  [2, 'text/plain'],
  [2, 'application/octet-stream']
])('rejects an invalid bundle resource of %i bytes with %s', (bytes, mediaType) => {
  const { db, state, candidate } = setup()
  db.prepare("UPDATE resources SET byte_length=?,media_type=? WHERE id='body'").run(bytes, mediaType)
  expect(state.decide(candidate, { state: 'accepted' })).toEqual({ state: 'rejected', code: 'INVALID_BUNDLE_SOURCE' })
  expect(state.artifact('task', 'artifact')).toBeNull()
  expect(state.owner('task', 'artifact')?.current_revision).toBe(0)
})

it.each(['record', 'action', 'resource'] as const)('requires existing same-Task %s provenance', kind => {
  const { db, state, candidate } = setup()
  db.prepare("INSERT INTO records(id,task_id,sequence,kind,payload_json,created_at) VALUES ('foreign-record','other',1,'message.user','{}','time')").run()
  db.prepare("INSERT INTO actions(id,task_id,kind,state,source_json,request_json,commit_valid,created_at) VALUES ('foreign-action','other','invocation','ended','{}','{}',0,'time'),('local-action','task','invocation','ended','{}','{}',0,'time')").run()
  resource(db, 'foreign-resource', 'other'); resource(db, 'local-resource')
  for (const id of ['missing', `foreign-${kind}`]) {
    expect(state.decide({ ...candidate, candidate_id: `candidate-${id}`, provenance_ref: { task_id: 'task', kind, id } }, { state: 'accepted' })).toEqual({ state: 'rejected', code: 'RUNNER_PROVENANCE_INVALID' })
  }
  const id = kind === 'record' ? 'record' : `local-${kind}`
  expect(state.decide({ ...candidate, candidate_id: 'valid-provenance', provenance_ref: { task_id: 'task', kind, id } }, { state: 'accepted' }).state).toBe('accepted')
})

it('rolls back candidate, artifact and pointer together when final installation fails', () => {
  const { db, state, candidate } = setup()
  db.exec("CREATE TRIGGER interrupt_pointer BEFORE UPDATE OF current_revision ON runner_artifact_owners BEGIN SELECT RAISE(ABORT,'interrupted'); END")
  expect(() => state.decide(candidate, { state: 'accepted' })).toThrow('interrupted')
  expect(state.candidate('task', 'candidate')).toBeNull()
  expect(state.artifact('task', 'artifact')).toBeNull()
  expect(state.owner('task', 'artifact')?.current_revision).toBe(0)
  db.exec('DROP TRIGGER interrupt_pointer')
  expect(state.decide(candidate, { state: 'accepted' })).toMatchObject({ state: 'accepted', index: { artifact_revision: 1 } })
})

it('participates in the parent installation transaction without partial outline or ownership writes', () => {
  const { db, state, candidate } = setup(false)
  expect(() => db.transaction(() => {
    state.installOutline(outline)
    state.assign([assignment])
    state.decide(candidate, { state: 'accepted' })
    throw Error('parent interrupted')
  }).immediate()).toThrow('parent interrupted')
  expect(state.outline('task')).toBeNull()
  expect(state.owner('task', 'artifact')).toBeNull()
  expect(state.candidate('task', 'candidate')).toBeNull()
})

it('rejects malformed metadata and reason text before creating a candidate outcome', () => {
  const { state, candidate } = setup()
  expect(() => state.decide({ ...candidate, title: 'x'.repeat(257) }, { state: 'accepted' })).toThrow(/structure/)
  expect(() => state.decide(candidate, { state: 'rejected', code: 'unbounded body text' })).toThrow(/reason code/)
  expect(state.candidate('task', 'candidate')).toBeNull()
  expect(state.owner('task', 'artifact')?.current_revision).toBe(0)
})
