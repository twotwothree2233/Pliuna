import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, expect, it } from 'vitest'
import type { ExecutionScope, GoalRevision, LogicalWork } from '../../src/shared/contracts.generated'
import type { Completion } from '../../src/runtime/model/adapter'
import { upgradeCandidate, purgeRunnerTask, hasV2Writes } from '../../src/runtime/schema-upgrade'
import { RunnerWorkState } from '../../src/runtime/runner/work-state'
import { RunnerArtifactState } from '../../src/runtime/runner/artifact-state'
import { RunnerHostProduction } from '../../src/runtime/runner/host-production'
import { RunnerBudgetLedger } from '../../src/runtime/runner/budget'
import { installProductionIdentitySchema } from '../../src/runtime/runner/production-identity'
import type { ProducerDraft, ProductionResultBinding } from '../../src/runtime/runner/production-profile'

const databases: Database.Database[] = [], roots: string[] = []
afterEach(() => { for (const db of databases.splice(0)) if (db.open) db.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function setup(path = ':memory:') {
  const db = new Database(path); databases.push(db)
  db.pragma('foreign_keys=ON')
  db.exec(readFileSync(new URL('../../src/shared/contracts/001-core.sql', import.meta.url), 'utf8'))
  upgradeCandidate(db, null)
  return db
}
function seed(db: Database.Database, task = 'task', workId = 'work'): ProductionResultBinding {
  const state = new RunnerWorkState(db, 'epoch'), artifacts = new RunnerArtifactState(db, state)
  const request = `goal-${task}`, run = `run-${task}`, section = `section-${task}`
  let goal: GoalRevision
  if (!db.prepare('SELECT 1 FROM tasks WHERE id=?').get(task)) {
    db.prepare("INSERT INTO tasks(id,title,state,revision) VALUES (?,?,'active',1)").run(task, task)
    db.prepare("INSERT INTO requests(id,task_id,state,config_selection_json,input_json,created_at) VALUES (?,?,'started','{}','{}','time')").run(request, task)
    db.prepare("INSERT INTO records(id,task_id,sequence,kind,payload_json,created_at) VALUES (?,?,1,'message.user','{}','time')").run(`input-record-${task}`, task)
    state.receive({ input_event_id: `input-${task}`, task_id: task, request_id: request, kind: 'request', record_id: `input-record-${task}`, stage: 'received' })
    goal = state.installGoal({ task_id: task, request_id: request, input_event_id: `input-${task}`, intent_revision: 1, state: 'active', requirements: [{ requirement_id: 'answer', kind: 'answer', required: true, provenance_required: false }] })
    new RunnerBudgetLedger(db).create({ budget_id: `budget-${task}`, task_id: task, purpose: 'production', request_id: request })
    db.prepare("INSERT INTO runs(id,task_id,request_id,state,runtime_epoch,limits_json,budget_json,created_at) VALUES (?,?,?,'running','epoch','{}','{}','time')").run(run, task, request)
    state.registerRun({ run_id: run, task_id: task, request_id: request, intent_revision: 1, purpose: 'production', runtime_epoch: 'epoch', budget_id: `budget-${task}`, state: 'running', commit_valid: true })
    artifacts.installOutline({ task_id: task, outline_revision: 1, base_outline_revision: 0, sections: [{ section_id: section, request_id: request, intent_revision: 1, position_revision: 1, order_key: 'first' }] })
    db.prepare("INSERT INTO resources VALUES (?,?, 'fixture',2,'application/json','Bundle','time')").run(`bundle-${task}`, `bundle-${task}.json`)
    db.prepare('INSERT INTO task_resources VALUES (?,?)').run(task, `bundle-${task}`)
  } else goal = state.goal(request)
  const work: LogicalWork = { task_id: task, request_id: request, intent_revision: 1, purpose: 'production', run_id: run, work_id: workId, plan_revision: 1, role: 'producer', state: 'planned', required: true, requirement_ids: ['answer'], dependencies: [{ kind: 'goal', task_id: task, request_id: request, intent_revision: 1 }], max_attempts: 2 }
  state.installPlan([work])
  return attempt(db, workId, `attempt-${workId}`, goal)
}
function attempt(db: Database.Database, workId: string, attemptId: string, goal: GoalRevision, previous?: string): ProductionResultBinding {
  const state = new RunnerWorkState(db, 'epoch'), work = state.work(workId)
  state.createAttempt({ attempt_id: attemptId, task_id: work.task_id, run_id: work.run_id, work_id: workId, runtime_epoch: 'epoch', attempt_number: previous ? 2 : 1, ...(previous ? { previous_attempt_id: previous } : {}), profile_id: 'producer-output-v1', model_config_id: 'model', model_config_revision: 1, input_versions: work.dependencies, state: 'registered', dispatch_state: 'not_dispatched', usage_refs: [], purpose: 'production', request_id: goal.request_id, intent_revision: 1 })
  state.updateAttempt({ ...state.attempt(attemptId), state: 'dispatched', dispatch_state: 'dispatched', operation_id: `operation-${attemptId}` })
  state.updateAttempt({ ...state.attempt(attemptId), state: 'running' })
  const owner: ExecutionScope = { task_id: work.task_id, run_id: work.run_id, work_id: workId, attempt_id: attemptId, role: 'producer', purpose: 'production', request_id: goal.request_id, intent_revision: 1 }
  return { owner, goal, work: state.work(workId), sections: new RunnerArtifactState(db, state).outline(work.task_id)!.sections }
}
function draft(source: ProductionResultBinding, keys = ['shared-key']): ProducerDraft {
  return { version: 1, complete: true, answer: '内容已完成。', requirement_ids: ['answer'], unresolved: [], artifacts: keys.map(output_key => ({ output_key, section_id: source.sections[0]!.section_id, bundle_resource_id: `bundle-${source.owner.task_id}`, presentation_kind: 'managed-v1', width_constraint: 'full', interaction_kind: 'none', provenance_ref: { task_id: source.owner.task_id, kind: 'record', id: `input-record-${source.owner.task_id}` }, requirement_ids: ['answer'], unresolved: [] })) }
}
function recorded(db: Database.Database, source: ProductionResultBinding, value: ProducerDraft): Completion {
  const recordId = randomUUID(), link = { request_id: randomUUID(), evidence_event_id: randomUUID() }
  const response: Completion = { text: JSON.stringify(value), finish: 'stop', calls: [], request_link: link }
  const sequence = (db.prepare('SELECT MAX(sequence)+1 n FROM records WHERE task_id=?').get(source.owner.task_id) as { n: number }).n
  db.prepare("INSERT INTO records(id,task_id,sequence,kind,payload_json,created_at) VALUES (?,?,?,'model.response',?,'time')").run(recordId, source.owner.task_id, sequence, JSON.stringify({ owner: source.owner, message: { role: 'assistant', content: response.text }, finish: response.finish, request_link: link }))
  return response
}

it('isolates identical local keys across tasks and parallel work while supporting multiple outputs', () => {
  const db = setup(), sources = [seed(db), seed(db, 'other', 'other-work'), seed(db, 'task', 'sibling')]
  const host = new RunnerHostProduction(db, 'epoch')
  const results = sources.map(source => { const value = draft(source, ['shared-key', 'second']); return host.normalize(value, source.owner, recorded(db, source, value)) })
  const ids = results.flatMap(result => result.artifacts.flatMap(artifact => [artifact.artifact_id, artifact.candidate_id]))
  expect(new Set(ids).size).toBe(12)
  expect(db.prepare('SELECT COUNT(*) n FROM runner_artifact_slots').get()).toEqual({ n: 6 })
  for (const [index, result] of results.entries()) expect(host.preflight(result, sources[index]!.owner)).toBeNull()
})

it('keeps artifact identity across correction and new attempts but binds candidate identity to the original response', () => {
  const db = setup(), source = seed(db), value = draft(source), host = new RunnerHostProduction(db, 'epoch')
  const originalResponse = recorded(db, source, value), first = host.normalize(value, source.owner, originalResponse)
  const corrected = { ...value, artifacts: [{ ...value.artifacts[0]!, title: 'Corrected' }] }
  const second = host.normalize(corrected, source.owner, recorded(db, source, corrected))
  expect(second.artifacts[0]!.artifact_id).toBe(first.artifacts[0]!.artifact_id)
  expect(second.artifacts[0]!.candidate_id).not.toBe(first.artifacts[0]!.candidate_id)
  expect(host.normalize(value, source.owner, originalResponse)).toEqual(first)
  expect(() => host.normalize(corrected, source.owner, originalResponse)).toThrow(expect.objectContaining({ code: 'RUNNER_OUTPUT_CONFLICT' }))
  const state = new RunnerWorkState(db, 'epoch')
  const { current_attempt_id: _attempt, ...plan } = state.work(source.work.work_id)
  state.updateAttempt({ ...state.attempt(source.owner.attempt_id), state: 'failed' }, { ...plan, plan_revision: plan.plan_revision + 1, state: 'planned' })
  const retry = attempt(db, source.work.work_id, 'retry', source.goal, source.owner.attempt_id)
  const third = host.normalize(value, retry.owner, recorded(db, retry, value))
  expect(third.artifacts[0]!.artifact_id).toBe(first.artifacts[0]!.artifact_id)
  expect(third.artifacts[0]!.candidate_id).not.toBe(first.artifacts[0]!.candidate_id)
  expect(() => host.normalize(value, source.owner, originalResponse)).toThrow()
})

it('retains formal IDs, exact submissions and raw responses across schema installation and reopen', () => {
  const root = mkdtempSync(join(tmpdir(), 'pliuna-production-identities-')); roots.push(root)
  const path = join(root, 'business.sqlite'), db = setup(path), source = seed(db), value = draft(source)
  const response = recorded(db, source, value), host = new RunnerHostProduction(db, 'epoch'), first = host.normalize(value, source.owner, response)
  const records = db.prepare('SELECT * FROM records ORDER BY sequence').all(), slots = db.prepare('SELECT * FROM runner_artifact_slots').all()
  db.close()
  const reopened = new Database(path); databases.push(reopened); reopened.pragma('foreign_keys=ON')
  upgradeCandidate(reopened); installProductionIdentitySchema(reopened)
  expect(new RunnerHostProduction(reopened, 'epoch').normalize(value, source.owner, response)).toEqual(first)
  expect(reopened.prepare('SELECT * FROM records ORDER BY sequence').all()).toEqual(records)
  expect(reopened.prepare('SELECT * FROM runner_artifact_slots').all()).toEqual(slots)
  expect(hasV2Writes(reopened)).toBe(true)
  expect(reopened.pragma('foreign_key_check')).toEqual([])
})

it('preserves legacy artifact IDs and rejects stale, missing or foreign explicit updates', () => {
  const db = setup(), source = seed(db), state = new RunnerWorkState(db, 'epoch'), artifacts = new RunnerArtifactState(db, state), host = new RunnerHostProduction(db, 'epoch')
  const value = draft(source), created = host.normalize(value, source.owner, recorded(db, source, value)).artifacts[0]!
  const legacy = { ...created, artifact_id: 'legacy-artifact', candidate_id: 'legacy-candidate' }
  artifacts.assign([{ task_id: legacy.task_id, artifact_id: legacy.artifact_id, work_id: legacy.work_id, plan_revision: 1, section_id: legacy.section_id, base_artifact_revision: 0 }])
  expect(artifacts.decide(legacy, { state: 'accepted' }).state).toBe('accepted')
  const { output_key: _key, ...body } = value.artifacts[0]!
  const update: ProducerDraft = { ...value, artifacts: [{ ...body, artifact_id: legacy.artifact_id, base_artifact_revision: 1 }] }
  const normalized = host.normalize(update, source.owner, recorded(db, source, update))
  expect(normalized.artifacts[0]).toMatchObject({ artifact_id: legacy.artifact_id, base_artifact_revision: 1 })
  expect(host.preflight(normalized, source.owner)).toBeNull()
  for (const [artifact_id, base_artifact_revision, code] of [['legacy-artifact', 2, 'RUNNER_ARTIFACT_CONFLICT'], ['missing', 1, 'RUNNER_OWNERSHIP_INVALID']] as const) {
    const invalid: ProducerDraft = { ...value, artifacts: [{ ...body, artifact_id, base_artifact_revision }] }
    const result = host.normalize(invalid, source.owner, recorded(db, source, invalid))
    expect(host.preflight(result, source.owner)).toMatchObject({ code })
  }
  const other = seed(db, 'other', 'other-work'), foreign = draft(other)
  const invalid: ProducerDraft = { ...foreign, artifacts: [{ ...foreign.artifacts[0]!, output_key: undefined, artifact_id: legacy.artifact_id, base_artifact_revision: 1 }] }
  const result = host.normalize(JSON.parse(JSON.stringify(invalid)), other.owner, recorded(db, other, invalid))
  expect(host.preflight(result, other.owner)).toMatchObject({ code: 'RUNNER_OWNERSHIP_INVALID' })
  expect(artifacts.artifact('task', legacy.artifact_id)).toMatchObject({ artifact_revision: 1 })
})

it('rejects absent response evidence and revoked sources without allocating identities', () => {
  const db = setup(), source = seed(db), value = draft(source), host = new RunnerHostProduction(db, 'epoch')
  expect(() => host.normalize(value, source.owner, { text: JSON.stringify(value), calls: [], finish: 'stop' })).toThrow(expect.objectContaining({ code: 'RUNNER_RESULT_INVALID' }))
  const response = recorded(db, source, value), state = new RunnerWorkState(db, 'epoch')
  state.updateAttempt({ ...state.attempt(source.owner.attempt_id), state: 'cancelled' })
  expect(() => host.normalize(value, source.owner, response)).toThrow()
  expect(db.prepare('SELECT COUNT(*) n FROM runner_artifact_slots').get()).toEqual({ n: 0 })
})

it('upgrades an existing v2 schema additively and removes identity mappings with their Task', () => {
  const db = setup(), source = seed(db), value = draft(source), response = recorded(db, source, value)
  db.exec('DROP TABLE runner_production_submissions; DROP TABLE runner_artifact_slots')
  const before = db.prepare('SELECT * FROM records').all()
  upgradeCandidate(db)
  expect(db.prepare('SELECT * FROM records').all()).toEqual(before)
  new RunnerHostProduction(db, 'epoch').normalize(value, source.owner, response)
  db.transaction(() => purgeRunnerTask(db, source.owner.task_id))()
  expect(db.prepare('SELECT COUNT(*) n FROM runner_artifact_slots').get()).toEqual({ n: 0 })
  expect(db.prepare('SELECT COUNT(*) n FROM runner_production_submissions').get()).toEqual({ n: 0 })
  expect(db.pragma('foreign_key_check')).toEqual([])
})
