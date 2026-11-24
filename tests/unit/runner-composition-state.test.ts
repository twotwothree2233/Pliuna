import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, expect, it } from 'vitest'
import type { ArtifactCandidate, ArtifactIndex, CompositionBatch, CompositionScope, ContributionInventory, ExecutionAttempt, ContentPlan, LogicalWork, WorkDependency, WorkOutputDeclaration } from '../../src/shared/contracts.generated'
import { validateRunnerContract } from '../../src/shared/runner-validation'
import { RunnerArtifactState } from '../../src/runtime/runner/artifact-state'
import { RunnerBudgetLedger } from '../../src/runtime/runner/budget'
import { RunnerCompositionState } from '../../src/runtime/runner/composition-state'
import { RunnerWorkState } from '../../src/runtime/runner/work-state'

const coreSql = readFileSync(new URL('../../src/shared/contracts/001-core.sql', import.meta.url), 'utf8')
const runnerSql = readFileSync(new URL('../../src/shared/contracts/002-runner.sql', import.meta.url), 'utf8')
const databases: Database.Database[] = [], directories: string[] = []
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
interface Harness { db: Database.Database; work: RunnerWorkState; artifacts: RunnerArtifactState; state: RunnerCompositionState }

function record(ctx: Harness, id: string): void {
  const row = ctx.db.prepare('SELECT COALESCE(MAX(sequence),0)+1 sequence FROM records WHERE task_id=?').get('task') as { sequence: number }
  ctx.db.prepare("INSERT INTO records(id,task_id,sequence,kind,payload_json,created_at) VALUES (?,'task',?,'message.user','{}','time')").run(id, row.sequence)
}
function addGoal(ctx: Harness, requestId: string, review = false): ContentPlan {
  ctx.db.prepare("INSERT INTO requests(id,task_id,state,config_selection_json,input_json,created_at) VALUES (?,'task','started','{}','{}','time')").run(requestId)
  record(ctx, `record-${requestId}`)
  ctx.work.receive({ input_event_id: `input-${requestId}`, task_id: 'task', kind: 'request', record_id: `record-${requestId}`, request_id: requestId, stage: 'received' })
  return ctx.work.installGoal({ task_id: 'task', request_id: requestId, intent_revision: 1, input_event_id: `input-${requestId}`, state: 'active', requirements: [{ requirement_id: 'content', kind: 'artifact', required: true, provenance_required: true }, ...(review ? [{ requirement_id: 'review', kind: 'content_check' as const, required: true, provenance_required: true }] : [])] })
}
function addRun(ctx: Harness, requestId: string, runId: string): void {
  new RunnerBudgetLedger(ctx.db).create({ budget_id: `budget-${runId}`, task_id: 'task', purpose: 'production', request_id: requestId, limits: { model_requests: 100, tool_requests: 100, tokens: 10000, wall_ms: 60000 } })
  ctx.db.prepare("INSERT INTO runs(id,task_id,request_id,state,runtime_epoch,limits_json,budget_json,created_at) VALUES (?,'task',?,'running','epoch','{}','{}','time')").run(runId, requestId)
  ctx.work.registerRun({ run_id: runId, task_id: 'task', runtime_epoch: 'epoch', state: 'running', commit_valid: true, budget_id: `budget-${runId}`, purpose: 'production', request_id: requestId, intent_revision: 1 })
}
function addWork(ctx: Harness, id: string, options: { role?: LogicalWork['role']; required?: boolean; request?: string; run?: string; dependencies?: WorkDependency[]; start?: boolean } = {}): void {
  const request = options.request ?? 'goal', run = options.run ?? 'run'
  ctx.work.installPlan([{ work_id: id, task_id: 'task', run_id: run, plan_revision: 1, role: options.role ?? 'producer', required: options.required ?? true, requirement_ids: ['content'], dependencies: options.dependencies ?? [{ kind: 'goal', task_id: 'task', request_id: request, intent_revision: 1 }], state: 'planned', max_attempts: 2, purpose: 'production', request_id: request, intent_revision: 1 }])
  const attempt: ExecutionAttempt = { attempt_id: `attempt-${ctx.work.taskWorks('task').length}`, work_id: id, task_id: 'task', run_id: run, runtime_epoch: 'epoch', attempt_number: 1, profile_id: options.role ?? 'producer', model_config_id: 'model', model_config_revision: 1, input_versions: ctx.work.work(id).dependencies, state: 'registered', dispatch_state: 'not_dispatched', usage_refs: [], purpose: 'production', request_id: request, intent_revision: 1 }
  ctx.work.createAttempt(attempt)
  if (options.start !== false) {
    ctx.work.updateAttempt({ ...attempt, state: 'dispatched', dispatch_state: 'dispatched', operation_id: `operation-${attempt.attempt_id}` })
    ctx.work.updateAttempt({ ...ctx.work.attempt(attempt.attempt_id), state: 'running' })
  }
}
function resource(ctx: Harness, id: string): void {
  ctx.db.prepare("INSERT INTO resources(id,storage_key,sha256,byte_length,media_type,display_name,created_at) VALUES (?,?,'fixture',2,'application/json','Body','time')").run(id, `${id}.json`)
  ctx.db.prepare("INSERT INTO task_resources(task_id,resource_id) VALUES ('task',?)").run(id)
}
function setup(options: { file?: string; review?: boolean; producerId?: string } = {}): Harness {
  const db = new Database(options.file ?? ':memory:'); databases.push(db)
  db.pragma('foreign_keys=ON'); db.exec(coreSql); db.exec(runnerSql)
  db.prepare("INSERT INTO tasks(id,title,state,revision) VALUES ('task','Task','active',1),('other','Other','active',1)").run()
  const work = new RunnerWorkState(db, 'epoch'), artifacts = new RunnerArtifactState(db, work)
  const ctx = { db, work, artifacts, state: new RunnerCompositionState(db, work, artifacts) }
  addGoal(ctx, 'goal', options.review); addRun(ctx, 'goal', 'run')
  artifacts.installOutline({ task_id: 'task', outline_revision: 1, base_outline_revision: 0, sections: [{ section_id: 'section', request_id: 'goal', intent_revision: 1, order_key: 'a', position_revision: 1 }] })
  addWork(ctx, options.producerId ?? 'producer')
  addWork(ctx, 'router', { role: 'router', required: false })
  return ctx
}
function assign(ctx: Harness, artifactId: string, workId = 'producer'): void {
  const work = ctx.work.work(workId)
  if (work.purpose !== 'production') throw new Error('Expected production fixture')
  const section = ctx.artifacts.outline('task')!.sections.find(item => item.request_id === work.request_id)!
  ctx.artifacts.assign([{ task_id: 'task', artifact_id: artifactId, work_id: workId, plan_revision: work.plan_revision, section_id: section.section_id, base_artifact_revision: 0 }])
}
function candidate(ctx: Harness, artifactId: string, workId = 'producer', candidateId = `candidate-${artifactId}`): ArtifactCandidate {
  const work = ctx.work.work(workId)
  if (work.purpose !== 'production') throw new Error('Expected production fixture')
  const section = ctx.artifacts.outline('task')!.sections.find(item => item.request_id === work.request_id)!
  const body = `body-${candidateId}`; resource(ctx, body)
  return { candidate_id: candidateId, task_id: 'task', request_id: work.request_id, intent_revision: work.intent_revision, run_id: work.run_id, work_id: workId, attempt_id: work.current_attempt_id!, artifact_id: artifactId, plan_revision: work.plan_revision, base_artifact_revision: ctx.artifacts.owner('task', artifactId)?.current_revision ?? 0, bundle_resource_id: body, section_id: section.section_id, section_position_revision: section.position_revision, order_key: section.order_key, presentation_kind: 'managed-v1', width_constraint: 'full', interaction_kind: 'none', provenance_ref: { task_id: 'task', kind: 'record', id: `record-${work.request_id}` }, dependencies: work.dependencies, requirement_ids: ['content'], unresolved: [] }
}
function accept(ctx: Harness, value: ArtifactCandidate): ArtifactIndex {
  const result = ctx.artifacts.decide(value, { state: 'accepted' })
  if (result.state !== 'accepted') throw new Error(`Unexpected rejection ${result.code}`)
  return result.index
}
function output(ctx: Harness, indexes: ArtifactIndex[], workId = 'producer', unresolved: WorkOutputDeclaration['unresolved'] = [], resultResource?: string): WorkOutputDeclaration {
  const work = ctx.work.work(workId), attempt = ctx.work.attempt(work.current_attempt_id!)
  if (work.purpose !== 'production') throw new Error('Expected production fixture')
  const resultId = `result-${ctx.work.taskWorks('task').findIndex(item => item.work_id === workId)}`
  if (resultResource === undefined) record(ctx, resultId)
  const result_ref: WorkOutputDeclaration['result_ref'] = resultResource === undefined ? { task_id: 'task', kind: 'record', id: resultId } : { task_id: 'task', kind: 'resource', id: resultResource }
  ctx.work.updateAttempt({ ...attempt, state: 'succeeded', result_ref })
  return { task_id: 'task', request_id: work.request_id, intent_revision: work.intent_revision, run_id: work.run_id, work_id: workId, attempt_id: attempt.attempt_id, plan_revision: work.plan_revision, result_revision: ctx.work.work(workId).result_revision!, result_ref, complete: true, artifacts: indexes.map(index => ({ task_id: 'task', artifact_id: index.artifact_id, artifact_revision: index.artifact_revision })), requirement_ids: ['content'], unresolved }
}
function inventory(ctx: Harness, outputs: WorkOutputDeclaration[], sourceId = 'router'): ContributionInventory {
  const source = ctx.work.work(sourceId)
  return { task_id: 'task', request_id: 'goal', intent_revision: 1, inventory_revision: 1, sealed_by: { run_id: source.run_id, work_id: source.work_id, attempt_id: source.current_attempt_id!, plan_revision: source.plan_revision, role: source.role === 'router' ? 'router' : 'producer' }, required_works: outputs, requirement_ids: ['content'], unresolved: [] }
}
function designate(ctx: Harness, sourceId = 'router'): void {
  const source = ctx.work.work(sourceId)
  ctx.state.designateSource({ task_id: 'task', request_id: 'goal', intent_revision: 1, work_id: source.work_id, plan_revision: source.plan_revision })
}
function scope(ctx: Harness, version = 1, sealed?: ContributionInventory): CompositionScope {
  return { task_id: 'task', composition_version: version, ...(version > 1 ? { previous_version: version - 1 } : {}), targets: [{ request_id: 'goal', intent_revision: 1, required: true, requirement_ids: ctx.work.goal('goal').requirements.filter(item => item.required).map(item => item.requirement_id), ...(sealed ? { contribution_inventory: { task_id: 'task', request_id: 'goal', intent_revision: 1, inventory_revision: sealed.inventory_revision } } : {}) }], state: 'working', unresolved: [] }
}
function batch(ctx: Harness, indexes: ArtifactIndex[], id = 'batch', version = 1): CompositionBatch {
  return validateRunnerContract('runner_composition_batch', { task_id: 'task', batch_id: id, composition_version: version, run_id: `composition-${id}`, trigger_request_id: 'goal', model_config_id: 'model', model_config_revision: 1, state: 'prepared', targets: [{ task_id: 'task', request_id: 'goal', intent_revision: 1 }], indexes: indexes.map(index => ({ task_id: 'task', artifact_id: index.artifact_id, artifact_revision: index.artifact_revision })), sections: ctx.artifacts.outline('task')!.sections.filter(section => indexes.some(index => index.section_id === section.section_id)).map(({ section_id, position_revision, order_key }) => ({ section_id, position_revision, order_key })) })
}
function count(ctx: Harness, table: string): number { return (ctx.db.prepare(`SELECT count(*) count FROM ${table}`).get() as { count: number }).count }

it('requires the final assigned fragment, even after the work has succeeded', () => {
  const ctx = setup(); assign(ctx, 'first'); assign(ctx, 'last')
  const first = accept(ctx, candidate(ctx, 'first')), partial = output(ctx, [first])
  expect(() => ctx.state.declareOutputs(partial)).toThrow('every assigned final fragment')
  expect(count(ctx, 'runner_work_outputs')).toBe(0)
  const last = accept(ctx, candidate(ctx, 'last'))
  const complete = { ...partial, artifacts: [...partial.artifacts, { task_id: 'task', artifact_id: last.artifact_id, artifact_revision: last.artifact_revision }] }
  expect(ctx.state.declareOutputs(complete)).toEqual(complete)
  expect(ctx.state.output('task', 'producer', 1, 1)?.artifacts).toHaveLength(2)
})

it('does not let a reassigned pointer pass old content as the new work output', () => {
  const ctx = setup(); assign(ctx, 'fragment')
  const index = accept(ctx, candidate(ctx, 'fragment'))
  addWork(ctx, 'replacement')
  ctx.artifacts.assign([{ task_id: 'task', artifact_id: 'fragment', work_id: 'replacement', plan_revision: 1, section_id: 'section', base_artifact_revision: 1, previous_owner: { work_id: 'producer', plan_revision: 1 } }])
  const replacement = output(ctx, [index], 'replacement')
  expect(() => ctx.state.declareOutputs(replacement)).toThrow('exact declared result')
  expect(() => ctx.state.declareOutputs(output(ctx, [], 'producer'))).toThrow('previously produced fragment')
})

it('checks successful attempt, plan, result revision and result reference before declaring', () => {
  const ctx = setup(); assign(ctx, 'fragment')
  const index = accept(ctx, candidate(ctx, 'fragment'))
  const running = ctx.work.attempt(ctx.work.work('producer').current_attempt_id!)
  const value: WorkOutputDeclaration = { task_id: 'task', request_id: 'goal', intent_revision: 1, run_id: 'run', work_id: 'producer', attempt_id: running.attempt_id, plan_revision: 1, result_revision: 1, result_ref: { task_id: 'task', kind: 'record', id: 'record-goal' }, complete: true, artifacts: [{ task_id: 'task', artifact_id: index.artifact_id, artifact_revision: 1 }], requirement_ids: ['content'], unresolved: [] }
  expect(() => ctx.state.declareOutputs(value)).toThrow('successful final work')
  const final = output(ctx, [index])
  for (const invalid of [{ ...final, plan_revision: 2 }, { ...final, result_revision: 2 }, { ...final, result_ref: value.result_ref }, { ...final, attempt_id: ctx.work.work('router').current_attempt_id! }]) expect(() => ctx.state.declareOutputs(invalid)).toThrow('successful final work')
  expect(ctx.state.declareOutputs(final)).toEqual(final)
})

it('closes new assignments and candidates while retaining original retry results', () => {
  const ctx = setup(); assign(ctx, 'fragment')
  const value = candidate(ctx, 'fragment'), index = accept(ctx, value), final = output(ctx, [index])
  ctx.state.declareOutputs(final)
  expect(ctx.artifacts.decide(value, { state: 'rejected', code: 'NEW_REVIEW' })).toEqual({ state: 'accepted', index })
  expect(ctx.artifacts.assign([{ task_id: 'task', artifact_id: 'fragment', work_id: 'producer', plan_revision: 1, section_id: 'section', base_artifact_revision: 0 }])[0]?.current_revision).toBe(1)
  expect(() => assign(ctx, 'new-fragment')).toThrow('complete work output')
  expect(ctx.artifacts.decide(candidate(ctx, 'fragment', 'producer', 'new-candidate'), { state: 'accepted' })).toEqual({ state: 'rejected', code: 'RUNNER_OUTPUT_CLOSED' })
  ctx.db.prepare("UPDATE runs SET state='cancelled',commit_valid=0 WHERE id='run'").run()
  ctx.db.prepare("UPDATE tasks SET state='stopped' WHERE id='task'").run()
  expect(ctx.state.declareOutputs(final)).toEqual(final)
  expect(() => ctx.state.declareOutputs({ ...final, artifacts: [] })).toThrow('original payload')
})

it('retains unresolved candidate requirements in the complete output declaration', () => {
  const ctx = setup(); assign(ctx, 'fragment')
  const missing = { task_id: 'task', request_id: 'goal', intent_revision: 1, requirement_id: 'content' }
  const index = accept(ctx, { ...candidate(ctx, 'fragment'), unresolved: [missing] }), final = output(ctx, [index])
  expect(() => ctx.state.declareOutputs(final)).toThrow('unresolved fragment')
  expect(ctx.state.declareOutputs({ ...final, unresolved: [missing] }).unresolved).toEqual([missing])
})

it('requires explicit host designation and compares source replacements', () => {
  const ctx = setup(), final = output(ctx, []); ctx.state.declareOutputs(final)
  const value = inventory(ctx, [final])
  expect(() => ctx.state.sealInventory(value)).toThrow('designated')
  addWork(ctx, 'integrator', { role: 'integrator', required: false })
  expect(() => designate(ctx, 'integrator')).toThrow('Router or direct Producer')
  designate(ctx)
  addWork(ctx, 'other-router', { role: 'router', required: false })
  const replacement = { task_id: 'task', request_id: 'goal', intent_revision: 1, work_id: 'other-router', plan_revision: 1 }
  expect(() => ctx.state.designateSource(replacement)).toThrow('exact predecessor')
  ctx.state.designateSource(replacement, { work_id: 'router', plan_revision: 1 })
  expect(() => ctx.state.sealInventory(value)).toThrow('designated')
  expect(ctx.state.sealInventory(inventory(ctx, [final], 'other-router')).sealed_by.work_id).toBe('other-router')
})

it('allows a designated direct Producer and denies an undispatched planning attempt', () => {
  const ctx = setup(), final = output(ctx, []); ctx.state.declareOutputs(final); designate(ctx, 'producer')
  expect(ctx.state.sealInventory(inventory(ctx, [final], 'producer')).sealed_by.role).toBe('producer')
  addWork(ctx, 'queued-router', { role: 'router', required: false, start: false })
  ctx.state.designateSource({ task_id: 'task', request_id: 'goal', intent_revision: 1, work_id: 'queued-router', plan_revision: 1 }, { work_id: 'producer', plan_revision: 1 })
  const next = { ...inventory(ctx, [final], 'queued-router'), inventory_revision: 2, previous_revision: 1 }
  expect(() => ctx.state.sealInventory(next)).toThrow('designated')
})

it('matches every required work to its persisted final declaration', () => {
  const ctx = setup(), first = output(ctx, []); designate(ctx)
  expect(() => ctx.state.sealInventory(inventory(ctx, [first]))).toThrow('persisted complete output')
  ctx.state.declareOutputs(first)
  addWork(ctx, 'second')
  expect(() => ctx.state.sealInventory(inventory(ctx, [first]))).toThrow('every current required work')
  const second = output(ctx, [], 'second'); ctx.state.declareOutputs(second)
  expect(() => ctx.state.sealInventory(inventory(ctx, [first, { ...second, result_revision: 2 }]))).toThrow('every current required work')
  expect(ctx.state.sealInventory(inventory(ctx, [first, second])).required_works).toEqual([first, second])
})

it('keeps missing required coverage unresolved without granting semantic acceptance', () => {
  const ctx = setup({ review: true }), final = output(ctx, []); ctx.state.declareOutputs(final); designate(ctx)
  const value = inventory(ctx, [final])
  expect(() => ctx.state.sealInventory(value)).toThrow('Uncovered required outcomes')
  const missing = { task_id: 'task', request_id: 'goal', intent_revision: 1, requirement_id: 'review' }
  expect(ctx.state.sealInventory({ ...value, unresolved: [missing] }).unresolved).toEqual([missing])
  expect(() => ctx.state.installScope({ ...scope(ctx, 1, value), state: 'complete', publication_manifest_id: 'invented' })).toThrow('does not install publication completeness')
  expect(count(ctx, 'runner_manifests')).toBe(0)
})

it('keeps sealed identities immutable and returns them after normal completion', () => {
  const ctx = setup(), final = output(ctx, []); ctx.state.declareOutputs(final); designate(ctx)
  const value = ctx.state.sealInventory(inventory(ctx, [final]))
  expect(() => ctx.state.sealInventory({ ...value, requirement_ids: [] })).toThrow('cannot be overwritten')
  expect(() => ctx.state.sealInventory({ ...value, inventory_revision: 3, previous_revision: 1 })).toThrow('exact current predecessor')
  ctx.db.prepare("UPDATE runs SET state='completed',commit_valid=0 WHERE id='run'").run()
  expect(ctx.state.sealInventory(value)).toEqual(value)
  expect(ctx.state.declareOutputs(final)).toEqual(final)
  expect(ctx.state.installScope(scope(ctx, 1, value)).targets[0]?.contribution_inventory?.inventory_revision).toBe(1)
  expect(() => ctx.state.sealInventory({ ...value, inventory_revision: 2, previous_revision: 1 })).toThrow('no longer permits')
})

it('forms new scope versions for new inventories and preserves old scope bindings', () => {
  const ctx = setup(), final = output(ctx, []); ctx.state.declareOutputs(final); designate(ctx)
  const first = ctx.state.sealInventory(inventory(ctx, [final])), original = ctx.state.installScope(scope(ctx, 1, first))
  const second = ctx.state.sealInventory({ ...first, inventory_revision: 2, previous_revision: 1 })
  expect(() => ctx.state.installScope(scope(ctx, 1, second))).toThrow('cannot change its bindings')
  expect(() => ctx.state.installScope(scope(ctx, 2, first))).toThrow('current sealed inventory')
  expect(ctx.state.installScope(scope(ctx, 2, second)).composition_version).toBe(2)
  expect(ctx.state.scope('task', 1)).toEqual(original)
  expect(ctx.state.inventory('task', 'goal', 1, 1)).toEqual(first)
})

it('rejects rebinding a stale required-work inventory into a new scope', () => {
  const ctx = setup(), final = output(ctx, []); ctx.state.declareOutputs(final); designate(ctx)
  const sealed = ctx.state.sealInventory(inventory(ctx, [final])), original = ctx.state.installScope(scope(ctx, 1, sealed))
  addWork(ctx, 'new-required')
  expect(() => ctx.state.installScope(scope(ctx, 2, sealed))).toThrow('every current required work')
  expect(ctx.state.installScope(scope(ctx, 2)).targets[0]?.contribution_inventory).toBeUndefined()
  expect(ctx.state.installScope(original)).toEqual(original)
})

it('reads the entire forty-fragment inventory while publishing through multiple fixed batches', () => {
  const ctx = setup(), indexes: ArtifactIndex[] = []
  for (let position = 0; position < 40; position++) { assign(ctx, `fragment-${position}`); indexes.push(accept(ctx, candidate(ctx, `fragment-${position}`))) }
  const final = output(ctx, indexes); ctx.state.declareOutputs(final); designate(ctx)
  const sealed = ctx.state.sealInventory(inventory(ctx, [final])); ctx.state.installScope(scope(ctx, 1, sealed))
  const sizes: number[] = []
  for (let offset = 0; offset < indexes.length; offset += 16) {
    const value = batch(ctx, indexes.slice(offset, offset + 16), `batch-${offset}`)
    ctx.state.installBatch(value); sizes.push(ctx.state.checkBatch('task', value.batch_id).indexes.length)
  }
  expect(sizes).toEqual([16, 16, 8])
  expect(ctx.state.inventory('task', 'goal', 1)?.required_works[0]?.artifacts).toHaveLength(40)
  expect(ctx.state.scope('task')?.state).toBe('working')
  expect(count(ctx, 'runner_batches')).toBe(3)
})

it('exposes bounded index pages through the host composition API', () => {
  const ctx = setup(), indexes: ArtifactIndex[] = []
  for (let position = 0; position < 33; position++) { assign(ctx, `fragment-${position}`); indexes.push(accept(ctx, candidate(ctx, `fragment-${position}`))) }
  ctx.state.installScope(scope(ctx))
  ctx.state.installBatch(batch(ctx, indexes.slice(0, 16)))
  const first = ctx.state.pageIndexes('task', 1)
  expect(first.items).toEqual(indexes.slice(0, 32))
  assign(ctx, 'late'); accept(ctx, candidate(ctx, 'late'))
  expect(ctx.state.pageIndexes('task', 1, first.next_cursor!).items).toEqual(indexes.slice(32))
  expect(ctx.state.pageBatchIndexes('task', 'batch')).toEqual({ task_id: 'task', composition_version: 1, batch_id: 'batch', items: indexes.slice(0, 16), next_cursor: null })
  expect(() => ctx.state.pageBatchIndexes('other', 'batch')).toThrow('does not exist')
})

it('grants an Integrator only its declared artifact and resource navigation without reading bodies', () => {
  const ctx = setup(); assign(ctx, 'declared'); assign(ctx, 'unmentioned')
  const declared = accept(ctx, candidate(ctx, 'declared')), unmentioned = accept(ctx, candidate(ctx, 'unmentioned'))
  output(ctx, [declared, unmentioned]); resource(ctx, 'declared-resource'); resource(ctx, 'unmentioned-resource')
  ctx.db.prepare("UPDATE resources SET storage_key='/missing/private-body.json'").run()
  const dependencies: WorkDependency[] = [{ kind: 'goal', task_id: 'task', request_id: 'goal', intent_revision: 1 }, { kind: 'artifact', task_id: 'task', artifact_id: 'declared', artifact_revision: 1 }, { kind: 'resource', task_id: 'task', resource_id: 'declared-resource' }]
  addWork(ctx, 'integrator', { role: 'integrator', required: false, dependencies })
  const attemptId = ctx.work.work('integrator').current_attempt_id!
  expect(ctx.state.integrationInputs(attemptId)).toEqual({ task_id: 'task', run_id: 'run', work_id: 'integrator', attempt_id: attemptId, dependencies, artifacts: [declared], results: [], resources: [declared.bundle_resource_id, 'declared-resource'] })
})

it('resolves a declared exact work result and its complete artifact set without duplicates', () => {
  const ctx = setup(); assign(ctx, 'first'); assign(ctx, 'second')
  const first = accept(ctx, candidate(ctx, 'first')), second = accept(ctx, candidate(ctx, 'second'))
  resource(ctx, 'final-result')
  const final = output(ctx, [first, second], 'producer', [], 'final-result'); ctx.state.declareOutputs(final)
  addWork(ctx, 'integrator', { role: 'integrator', required: false, dependencies: [{ kind: 'work', task_id: 'task', work_id: 'producer', result_revision: 1 }, { kind: 'artifact', task_id: 'task', artifact_id: 'first', artifact_revision: 1 }, { kind: 'resource', task_id: 'task', resource_id: first.bundle_resource_id }] })
  const inputs = ctx.state.integrationInputs(ctx.work.work('integrator').current_attempt_id!)
  expect(inputs.results).toEqual([{ work_id: 'producer', result_revision: 1, result_ref: final.result_ref }])
  expect(inputs.artifacts).toEqual([first, second])
  expect(inputs.resources).toEqual(['final-result', first.bundle_resource_id, second.bundle_resource_id])
})

it('does not discover unenumerated fragments through an ordinary work result', () => {
  const ctx = setup(); assign(ctx, 'fragment')
  const index = accept(ctx, candidate(ctx, 'fragment')), final = output(ctx, [index])
  addWork(ctx, 'integrator', { role: 'integrator', required: false, dependencies: [{ kind: 'work', task_id: 'task', work_id: 'producer', result_revision: 1 }] })
  const inputs = ctx.state.integrationInputs(ctx.work.work('integrator').current_attempt_id!)
  expect(inputs.results).toEqual([{ work_id: 'producer', result_revision: 1, result_ref: final.result_ref }])
  expect(inputs.artifacts).toEqual([])
  expect(inputs.resources).toEqual([])
})

it('denies non-integrators and Integrators without explicit content inputs', () => {
  const ctx = setup()
  expect(() => ctx.state.integrationInputs(ctx.work.work('producer').current_attempt_id!)).toThrow('production Integrator')
  addWork(ctx, 'integrator', { role: 'integrator', required: false })
  expect(() => ctx.state.integrationInputs(ctx.work.work('integrator').current_attempt_id!)).toThrow('explicit versioned content inputs')
})

it.each(['cancelled-run', 'reassigned-artifact', 'missing-result', 'removed-resource'] as const)('rechecks %s before exposing integration content', change => {
  const ctx = setup(); addGoal(ctx, 'upstream'); addRun(ctx, 'upstream', 'source-run')
  const outline = ctx.artifacts.outline('task')!
  ctx.artifacts.installOutline({ ...outline, outline_revision: 2, base_outline_revision: 1, sections: [...outline.sections, { section_id: 'upstream-section', request_id: 'upstream', intent_revision: 1, order_key: 'b', position_revision: 1 }] })
  addWork(ctx, 'source', { request: 'upstream', run: 'source-run' }); assign(ctx, 'source-fragment', 'source')
  const index = accept(ctx, candidate(ctx, 'source-fragment', 'source'))
  const final = output(ctx, [index], 'source'); ctx.state.declareOutputs(final)
  resource(ctx, 'source-resource')
  const dependency: WorkDependency = change === 'removed-resource' ? { kind: 'resource', task_id: 'task', resource_id: 'source-resource' } : change === 'reassigned-artifact' ? { kind: 'artifact', task_id: 'task', artifact_id: index.artifact_id, artifact_revision: 1 } : { kind: 'work', task_id: 'task', work_id: 'source', result_revision: 1 }
  addWork(ctx, 'integrator', { role: 'integrator', required: false, dependencies: [dependency] })
  const attemptId = ctx.work.work('integrator').current_attempt_id!
  expect(ctx.state.integrationInputs(attemptId).work_id).toBe('integrator')
  if (change === 'cancelled-run') ctx.db.prepare("UPDATE runs SET state='cancelled',commit_valid=0 WHERE id='source-run'").run()
  else if (change === 'reassigned-artifact') {
    addWork(ctx, 'replacement', { request: 'upstream', run: 'source-run' })
    ctx.artifacts.assign([{ task_id: 'task', artifact_id: index.artifact_id, work_id: 'replacement', plan_revision: 1, section_id: 'upstream-section', base_artifact_revision: 1, previous_owner: { work_id: 'source', plan_revision: 1 } }])
  } else if (change === 'missing-result') ctx.db.prepare('DELETE FROM records WHERE id=?').run(final.result_ref.id)
  else ctx.db.prepare("DELETE FROM task_resources WHERE task_id='task' AND resource_id='source-resource'").run()
  expect(() => ctx.state.integrationInputs(attemptId)).toThrow()
})

it('does not invalidate a fixed batch for unrelated indexes, goals or outline additions', () => {
  const ctx = setup(); assign(ctx, 'first')
  const index = accept(ctx, candidate(ctx, 'first')); ctx.state.installScope(scope(ctx))
  const value = ctx.state.installBatch(batch(ctx, [index]))
  assign(ctx, 'second'); accept(ctx, candidate(ctx, 'second'))
  addGoal(ctx, 'other-goal')
  const outline = ctx.artifacts.outline('task')!
  ctx.artifacts.installOutline({ ...outline, outline_revision: 2, base_outline_revision: 1, sections: [...outline.sections, { section_id: 'other-section', request_id: 'other-goal', intent_revision: 1, order_key: 'b', position_revision: 1 }] })
  ctx.state.installScope({ ...scope(ctx, 2), targets: [...scope(ctx, 2).targets, { request_id: 'other-goal', intent_revision: 1, required: true, requirement_ids: ['content'] }] })
  expect(ctx.state.checkBatch('task', 'batch')).toEqual(value)
  expect(ctx.state.batch('task', 'batch')?.indexes).toHaveLength(1)
})

it.each(['later-scope', 'missing'] as const)('rejects a %s predecessor without installing a successor batch', kind => {
  const ctx = setup(); assign(ctx, 'fragment')
  const index = accept(ctx, candidate(ctx, 'fragment')); ctx.state.installScope(scope(ctx)); ctx.state.installScope(scope(ctx, 2))
  const original = ctx.state.installBatch(batch(ctx, [index], 'original', 2))
  const successor = { ...batch(ctx, [index], 'successor', kind === 'later-scope' ? 1 : 2), previous_batch_id: kind === 'missing' ? 'absent' : original.batch_id }
  expect(() => ctx.state.installBatch(successor)).toThrow(expect.objectContaining({ code: 'RUNNER_BATCH_CONFLICT' }))
  expect(ctx.state.batch('task', 'successor')).toBeNull()
  expect(ctx.state.batch('task', 'original')).toEqual(original)
  expect(count(ctx, 'runner_batches')).toBe(1)
})

it('rejects stale actual fragment versions and preserves the original batch retry result', () => {
  const ctx = setup(); assign(ctx, 'fragment')
  const first = accept(ctx, candidate(ctx, 'fragment')); ctx.state.installScope(scope(ctx))
  const original = ctx.state.installBatch(batch(ctx, [first]))
  expect(() => ctx.state.installBatch({ ...original, indexes: [] })).toThrow('fixed read set')
  const second = accept(ctx, candidate(ctx, 'fragment', 'producer', 'updated-candidate'))
  expect(() => ctx.state.checkBatch('task', 'batch')).toThrow('current accepted contribution')
  expect(() => ctx.state.installBatch(batch(ctx, [first], 'stale-batch'))).toThrow('current accepted contribution')
  expect(ctx.state.installBatch(original)).toEqual(original)
  expect(ctx.state.installBatch(batch(ctx, [second], 'fresh-batch')).indexes[0]?.artifact_revision).toBe(2)
})

it('checks only used section positions and permits title changes', () => {
  const ctx = setup(); assign(ctx, 'fragment')
  const index = accept(ctx, candidate(ctx, 'fragment')); ctx.state.installScope(scope(ctx)); ctx.state.installBatch(batch(ctx, [index]))
  const outline = ctx.artifacts.outline('task')!
  ctx.artifacts.installOutline({ ...outline, outline_revision: 2, base_outline_revision: 1, sections: outline.sections.map(section => ({ ...section, title: 'Renamed' })) })
  expect(ctx.state.checkBatch('task', 'batch').batch_id).toBe('batch')
  ctx.artifacts.installOutline({ ...outline, outline_revision: 3, base_outline_revision: 2, sections: outline.sections.map(section => ({ ...section, order_key: 'b', position_revision: 2 })) })
  expect(() => ctx.state.checkBatch('task', 'batch')).toThrow('position is no longer current')
  expect(ctx.state.installBatch(batch(ctx, [index], 'moved')).sections[0]?.position_revision).toBe(2)
})

it('reuses sealed inventories after a rename and invalidates only batches using a moved section', () => {
  const ctx = setup(), original = ctx.artifacts.outline('task')!
  ctx.artifacts.installOutline({ ...original, outline_revision: 2, base_outline_revision: 1, sections: [...original.sections, { ...original.sections[0]!, section_id: 'second-section', order_key: 'b' }] })
  assign(ctx, 'first')
  ctx.artifacts.assign([{ task_id: 'task', artifact_id: 'second', work_id: 'producer', plan_revision: 1, section_id: 'second-section', base_artifact_revision: 0 }])
  const first = accept(ctx, candidate(ctx, 'first')), second = accept(ctx, { ...candidate(ctx, 'second'), section_id: 'second-section', order_key: 'b' })
  const final = output(ctx, [first, second]); ctx.state.declareOutputs(final); designate(ctx)
  const sealed = ctx.state.sealInventory(inventory(ctx, [final])), frozenScope = ctx.state.installScope(scope(ctx, 1, sealed))
  ctx.state.installBatch(batch(ctx, [first], 'first-batch')); ctx.state.installBatch(batch(ctx, [second], 'second-batch'))
  const before = ctx.artifacts.outline('task')!
  ctx.artifacts.installOutline({ ...before, outline_revision: 3, base_outline_revision: 2, sections: before.sections.map(section => ({ ...section, title: 'Renamed' })) })
  expect(ctx.state.checkBatch('task', 'first-batch').batch_id).toBe('first-batch')
  expect(ctx.state.checkBatch('task', 'second-batch').batch_id).toBe('second-batch')
  const renamed = ctx.artifacts.outline('task')!
  ctx.artifacts.installOutline({ ...renamed, outline_revision: 4, base_outline_revision: 3, sections: renamed.sections.map(section => section.section_id === 'section' ? { ...section, order_key: 'c', position_revision: 2 } : section) })
  expect(() => ctx.state.checkBatch('task', 'first-batch')).toThrow('position is no longer current')
  expect(ctx.state.checkBatch('task', 'second-batch').batch_id).toBe('second-batch')
  expect(ctx.state.inventory('task', 'goal', 1)).toEqual(sealed)
  expect(ctx.state.scope('task', 1)).toEqual(frozenScope)
  expect(ctx.state.installScope(scope(ctx, 2, sealed)).targets[0]?.contribution_inventory?.inventory_revision).toBe(1)
  expect(ctx.artifacts.artifact('task', 'first')).toEqual(first)
  expect(ctx.artifacts.artifact('task', 'second')).toEqual(second)
  expect(count(ctx, 'runner_artifacts')).toBe(2)
})

it('rejects duplicate or mismatched batch targets and missing section constraints', () => {
  const ctx = setup(); assign(ctx, 'fragment')
  const index = accept(ctx, candidate(ctx, 'fragment')); addGoal(ctx, 'other-goal')
  ctx.state.installScope({ ...scope(ctx), targets: [...scope(ctx).targets, { request_id: 'other-goal', intent_revision: 1, required: true, requirement_ids: ['content'] }] })
  const value = batch(ctx, [index])
  expect(() => ctx.state.installBatch({ ...value, targets: [...value.targets, ...value.targets] })).toThrow('Duplicate batch targets')
  const duplicateSections = structuredClone(value)
  const sections: CompositionBatch['sections'][number][] = duplicateSections.sections
  sections.push(...value.sections)
  expect(() => ctx.state.installBatch(duplicateSections)).toThrow('Duplicate batch sections')
  expect(() => ctx.state.installBatch({ ...value, sections: [] })).toThrow('fixed targets or sections')
  expect(() => ctx.state.installBatch({ ...value, trigger_request_id: 'other-goal', targets: [{ task_id: 'task', request_id: 'other-goal', intent_revision: 1 }] })).toThrow()
  expect(count(ctx, 'runner_batches')).toBe(0)
})

it('rechecks work dependencies after upstream commit authority is revoked', () => {
  const ctx = setup(); addGoal(ctx, 'upstream'); addRun(ctx, 'upstream', 'upstream-run')
  addWork(ctx, 'upstream-work', { request: 'upstream', run: 'upstream-run' })
  const attempt = ctx.work.attempt(ctx.work.work('upstream-work').current_attempt_id!)
  ctx.work.updateAttempt({ ...attempt, state: 'succeeded', result_ref: { task_id: 'task', kind: 'record', id: 'record-upstream' } })
  addWork(ctx, 'dependent', { dependencies: [{ kind: 'work', task_id: 'task', work_id: 'upstream-work', result_revision: 1 }] })
  assign(ctx, 'dependent-fragment', 'dependent')
  const index = accept(ctx, candidate(ctx, 'dependent-fragment', 'dependent')); ctx.state.installScope(scope(ctx)); ctx.state.installBatch(batch(ctx, [index]))
  ctx.db.prepare("UPDATE runs SET commit_valid=0 WHERE id='upstream-run'").run()
  expect(() => ctx.state.checkBatch('task', 'batch')).toThrow('Work dependency')
  ctx.db.prepare("UPDATE runs SET state='completed' WHERE id='upstream-run'").run()
  expect(ctx.state.checkBatch('task', 'batch').batch_id).toBe('batch')
})

it('rechecks exact goal dependency revisions rather than a global watermark', () => {
  const ctx = setup(); addGoal(ctx, 'reference')
  addWork(ctx, 'dependent', { dependencies: [{ kind: 'goal', task_id: 'task', request_id: 'reference', intent_revision: 1 }] })
  assign(ctx, 'dependent-fragment', 'dependent')
  const index = accept(ctx, candidate(ctx, 'dependent-fragment', 'dependent')); ctx.state.installScope(scope(ctx)); ctx.state.installBatch(batch(ctx, [index]))
  record(ctx, 'correction')
  ctx.work.receive({ input_event_id: 'correction', task_id: 'task', kind: 'correction', record_id: 'correction', request_id: 'reference', stage: 'received' })
  ctx.work.installGoal({ ...ctx.work.goal('reference'), intent_revision: 2, previous_revision: 1, input_event_id: 'correction' })
  expect(() => ctx.state.checkBatch('task', 'batch')).toThrow('goal revision is no longer current')
})

it('rolls source, output, inventory, scope, batch and resource roots back with the outer installation', () => {
  const ctx = setup(); assign(ctx, 'fragment')
  const index = accept(ctx, candidate(ctx, 'fragment')); resource(ctx, 'result-resource')
  const final = output(ctx, [index], 'producer', [], 'result-resource')
  expect(() => ctx.db.transaction(() => {
    designate(ctx); ctx.state.declareOutputs(final)
    const sealed = ctx.state.sealInventory(inventory(ctx, [final])); ctx.state.installScope(scope(ctx, 1, sealed)); ctx.state.installBatch(batch(ctx, [index]))
    throw new Error('outer installation interrupted')
  }).immediate()).toThrow('outer installation interrupted')
  for (const table of ['runner_inventory_sources', 'runner_work_outputs', 'runner_contribution_inventories', 'runner_scopes', 'runner_batches']) expect(count(ctx, table)).toBe(0)
  expect(ctx.db.prepare("SELECT * FROM object_references WHERE source_kind IN ('runner_work_output','runner_batch')").all()).toEqual([])
  expect(ctx.artifacts.artifact('task', 'fragment')).toEqual(index)
})

it('retains exact records through reopen and keeps old epochs from new installations', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pliuna-composition-')); directories.push(directory)
  const file = join(directory, 'state.sqlite'), ctx = setup({ file }); assign(ctx, 'fragment')
  const index = accept(ctx, candidate(ctx, 'fragment')), final = output(ctx, [index]); ctx.state.declareOutputs(final); designate(ctx)
  const sealed = ctx.state.sealInventory(inventory(ctx, [final])), frozenScope = ctx.state.installScope(scope(ctx, 1, sealed)), frozenBatch = ctx.state.installBatch(batch(ctx, [index]))
  ctx.db.close()
  const db = new Database(file); databases.push(db); db.pragma('foreign_keys=ON')
  const work = new RunnerWorkState(db, 'new-epoch'), artifacts = new RunnerArtifactState(db, work), state = new RunnerCompositionState(db, work, artifacts)
  expect(state.output('task', 'producer', 1, 1)).toEqual(final)
  expect(state.inventory('task', 'goal', 1)).toEqual(sealed)
  expect(state.scope('task')).toEqual(frozenScope)
  expect(state.batch('task', 'batch')).toEqual(frozenBatch)
  expect(state.declareOutputs(final)).toEqual(final)
  expect(state.sealInventory(sealed)).toEqual(sealed)
  expect(state.installScope(frozenScope)).toEqual(frozenScope)
  expect(state.installBatch(frozenBatch)).toEqual(frozenBatch)
  expect(() => state.checkBatch('task', 'batch')).toThrow('current accepted contribution')
  expect(() => state.sealInventory({ ...sealed, inventory_revision: 2, previous_revision: 1 })).toThrow('no longer permits')
})

it('accepts maximum-length work IDs and protects resource results without another ID limit', () => {
  const id = 'w'.repeat(128), ctx = setup({ producerId: id }); assign(ctx, 'fragment', id)
  const value = candidate(ctx, 'fragment', id); resource(ctx, 'source-proof')
  const index = accept(ctx, { ...value, provenance_ref: { task_id: 'task', kind: 'resource', id: 'source-proof' } }); resource(ctx, 'result-resource')
  const final = output(ctx, [index], id, [], 'result-resource'); ctx.state.declareOutputs(final)
  expect(ctx.state.output('task', id, 1, 1)).toEqual(final)
  const roots = ctx.db.prepare("SELECT target_id FROM object_references WHERE source_kind IN ('runner_artifact','runner_work_output') ORDER BY target_id").all() as { target_id: string }[]
  expect(roots.map(row => row.target_id)).toEqual([index.bundle_resource_id, 'result-resource', 'source-proof'].sort())
})
