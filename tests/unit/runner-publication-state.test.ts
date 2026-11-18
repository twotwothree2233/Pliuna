import Database from 'better-sqlite3'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { ArtifactIndex, CompositionBatch, LogicalWork, PresentationPlan, PublicationManifest } from '../../src/shared/contracts.generated'
import { RunnerPublicationState, type PublicationPreparation, type PublicationRegistration, type SurfaceCommitInput } from '../../src/runtime/runner/publication-state'

const coreSql = readFileSync(new URL('../../src/shared/contracts/001-core.sql', import.meta.url), 'utf8')
const runnerSql = readFileSync(new URL('../../src/shared/contracts/002-runner.sql', import.meta.url), 'utf8')
const databases: Database.Database[] = [], directories: string[] = []
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const target = { task_id: 'task', request_id: 'goal', intent_revision: 1 }
const keptLayout = { slots: [{ id: 'main', groups: [{ id: 'kept-group', type: 'column', views: ['kept-view'] }] }] }
function resource(db: Database.Database, id: string, task = 'task'): void {
  if (!db.prepare('SELECT id FROM resources WHERE id=?').get(id)) db.prepare("INSERT INTO resources VALUES (?,?,'fixture',2,'application/vnd.pliuna.bundle+json','Bundle','time')").run(id, `${id}.json`)
  db.prepare('INSERT OR IGNORE INTO task_resources VALUES (?,?)').run(task, id)
}
function open(filename = ':memory:'): Database.Database {
  const db = new Database(filename); databases.push(db)
  db.pragma('foreign_keys=ON')
  return db
}
function setup(filename = ':memory:') {
  const db = open(filename)
  db.exec(coreSql); db.exec(runnerSql)
  db.prepare("INSERT INTO tasks(id,title,state,revision) VALUES ('task','Task','active',1),('other','Other','active',1)").run()
  db.prepare("INSERT INTO requests(id,task_id,state,config_selection_json,input_json,created_at) VALUES ('goal','task','started','{}','{}','time')").run()
  db.prepare("INSERT INTO records VALUES ('input-record','task',1,'message.user','{}','time')").run()
  db.prepare("INSERT INTO runner_budgets VALUES ('production-budget','task','production','goal','{}','time'),('composition-budget','task','composition',NULL,'{}','time')").run()
  db.prepare("INSERT INTO runs(id,task_id,request_id,state,runtime_epoch,limits_json,budget_json,created_at) VALUES ('production-run','task','goal','running','epoch','{}','{}','time')").run()
  db.prepare("INSERT INTO runner_runs(run_id,task_id,purpose,request_id,intent_revision,budget_id,payload_json) VALUES ('production-run','task','production','goal',1,'production-budget','{}')").run()
  const work: LogicalWork = { work_id: 'production-work', task_id: 'task', run_id: 'production-run', plan_revision: 1, role: 'producer', required: true, requirement_ids: ['answer'], dependencies: [], state: 'succeeded', max_attempts: 2, purpose: 'production', request_id: 'goal', intent_revision: 1 }
  db.prepare("INSERT INTO runner_work VALUES ('production-work','task','production-run',1,'succeeded',?)").run(JSON.stringify(work))
  db.prepare("INSERT INTO runner_scopes VALUES ('task',1,?)").run(JSON.stringify({ task_id: 'task', composition_version: 1, targets: [{ request_id: target.request_id, intent_revision: target.intent_revision, required: true, requirement_ids: ['answer'] }], state: 'working', unresolved: [] }))
  db.prepare("INSERT INTO surfaces VALUES ('surface','task',1,?)").run(JSON.stringify(keptLayout))
  resource(db, 'kept-bundle'); resource(db, 'foreign-bundle', 'other')
  db.prepare("INSERT INTO views VALUES ('kept-view','surface',1,'kept-bundle',3,'{}','v1',NULL,0)").run()
  db.prepare("INSERT INTO view_history VALUES ('kept-history','task','kept-view',1,'kept-bundle','{}')").run()
  return { db, state: new RunnerPublicationState(db) }
}

interface Fixture {
  db: Database.Database
  state: RunnerPublicationState
  registration: PublicationRegistration
  preparation: PublicationPreparation
  input: SurfaceCommitInput
}
function publication(base: ReturnType<typeof setup>, suffix = '', options: { artifactId?: string; artifactRevision?: number; viewId?: string; reuseView?: boolean; publishedId?: string } = {}): Fixture {
  const { db, state } = base
  const artifactId = options.artifactId ?? 'artifact', artifactRevision = options.artifactRevision ?? 1, viewId = options.viewId ?? 'artifact-view'
  const sourceId = `${artifactId}-source-${artifactRevision}`, publishedId = options.publishedId ?? `published${suffix}`
  resource(db, sourceId); resource(db, publishedId)
  const index: ArtifactIndex = { ...target, run_id: 'production-run', work_id: 'production-work', attempt_id: 'production-attempt', artifact_id: artifactId, artifact_revision: artifactRevision, bundle_resource_id: sourceId, section_id: 'section', order_key: 'a', presentation_kind: 'managed-v1', width_constraint: 'full', interaction_kind: 'none', provenance_ref: { task_id: 'task', kind: 'record', id: 'input-record' }, acceptance_state: 'accepted' }
  db.prepare("INSERT INTO runner_artifact_owners VALUES (?,'task','production-work',1,'section',?) ON CONFLICT(artifact_id) DO UPDATE SET current_revision=excluded.current_revision").run(artifactId, artifactRevision)
  if (!db.prepare('SELECT artifact_id FROM runner_artifacts WHERE artifact_id=? AND artifact_revision=?').get(artifactId, artifactRevision)) {
    const candidateId = `${artifactId}-candidate-${artifactRevision}`
    db.prepare("INSERT INTO runner_candidates VALUES (?,'task',?,'{}',?)").run(candidateId, artifactId, JSON.stringify({ state: 'accepted', index }))
    db.prepare("INSERT INTO runner_artifacts VALUES ('task',?,?,?,?,?)").run(artifactId, artifactRevision, candidateId, sourceId, JSON.stringify(index))
  }
  const batchId = `batch${suffix}`, runId = `composition-run${suffix}`, workId = `composition-work${suffix}`, attemptId = `composition-attempt${suffix}`, actionId = `action${suffix}`
  db.prepare("INSERT INTO runs(id,task_id,request_id,state,runtime_epoch,limits_json,budget_json,created_at) VALUES (?,'task',NULL,'running','epoch','{}','{}','time')").run(runId)
  db.prepare("INSERT INTO runner_runs(run_id,task_id,purpose,batch_id,composition_version,budget_id,payload_json) VALUES (?,'task','composition',?,1,'composition-budget','{}')").run(runId, batchId)
  const work: LogicalWork = { work_id: workId, task_id: 'task', run_id: runId, plan_revision: 1, role: 'collator', required: true, requirement_ids: [], dependencies: [{ kind: 'artifact', task_id: 'task', artifact_id: artifactId, artifact_revision: artifactRevision }], state: 'running', max_attempts: 2, purpose: 'composition', batch_id: batchId, composition_version: 1, trigger_request_id: 'goal' }
  db.prepare("INSERT INTO runner_work VALUES (?,'task',?,1,'running',?)").run(workId, runId, JSON.stringify(work))
  db.prepare("INSERT INTO runner_attempts VALUES (?,'task',?,?,1,'running','{}')").run(attemptId, workId, runId)
  const reference = { task_id: 'task', artifact_id: artifactId, artifact_revision: artifactRevision }
  const batch: CompositionBatch = { task_id: 'task', batch_id: batchId, composition_version: 1, run_id: runId, trigger_request_id: 'goal', model_config_id: 'model', model_config_revision: 1, state: 'prepared', targets: [target], indexes: [reference], sections: [{ section_id: 'section', position_revision: 1, order_key: 'a' }] }
  db.prepare("INSERT INTO runner_batches VALUES (?,'task',1,?)").run(batchId, JSON.stringify(batch))
  db.prepare("INSERT INTO actions(id,task_id,run_id,kind,state,source_json,request_json,commit_valid,created_at) VALUES (?,'task',?,'mutation','registered','{}','{}',1,'time')").run(actionId, runId)
  const plan: PresentationPlan = { task_id: 'task', run_id: runId, batch_id: batchId, composition_version: 1, intents: [{ artifact: reference, section_id: 'section', section_position_revision: 1, order_key: 'a', slot_id: 'main', layout_mode: 'column', width_constraint: 'full' }] }
  const registration: PublicationRegistration = { task_id: 'task', operation_id: `operation${suffix}`, batch_id: batchId, action_id: actionId, plan }
  const baseline = (db.prepare("SELECT revision FROM surfaces WHERE id='surface'").get() as { revision: number }).revision
  const previous = db.prepare('SELECT revision,state_revision FROM views WHERE id=?').get(viewId) as { revision: number; state_revision: number } | undefined
  const viewRevision = previous ? previous.revision + Number(!options.reuseView) : 1, stateRevision = previous ? previous.state_revision + Number(!options.reuseView) : 1
  const preparation: PublicationPreparation = { surface_id: 'surface', base_surface_revision: baseline, resources: [{ artifact_id: artifactId, artifact_revision: artifactRevision, source_bundle_resource_id: sourceId, published_bundle_resource_id: publishedId }] }
  const input: SurfaceCommitInput = { task_id: 'task', operation_id: registration.operation_id, action_id: actionId, surface_id: 'surface', surface_revision: baseline + 1, surface_history_id: `surface-history${suffix}`, surface_record_id: `surface-record${suffix}`, entries: [{ ...target, batch_id: batchId, artifact_id: artifactId, artifact_revision: artifactRevision, section_id: 'section', source_bundle_resource_id: sourceId, published_bundle_resource_id: publishedId, view_id: viewId, view_revision: viewRevision, state_revision: stateRevision, surface_history_id: `surface-history${suffix}` }], delivery: { delivery_id: `delivery${suffix}`, task_id: 'task', run_id: runId, work_id: workId, attempt_id: attemptId, role: 'collator', record_id: `surface-record${suffix}`, purpose: 'composition', batch_id: batchId, composition_version: 1 } }
  return { db, state, registration, preparation, input }
}
function ready(fixture: Fixture): void {
  fixture.state.register(fixture.registration)
  fixture.state.prepare('task', fixture.registration.operation_id, fixture.preparation)
}
function applySurface({ db, input }: Fixture, layout?: unknown): void {
  const entry = input.entries[0]!
  db.prepare("INSERT INTO views VALUES (?,'surface',?,?,?,'{}','v1',NULL,0) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,bundle_resource_id=excluded.bundle_resource_id,state_revision=excluded.state_revision").run(entry.view_id, entry.view_revision, entry.published_bundle_resource_id, entry.state_revision)
  db.prepare("INSERT OR IGNORE INTO view_history VALUES (?,'task',?,?,?,'{}')").run(`view-history-${entry.view_id}-${entry.view_revision}`, entry.view_id, entry.view_revision, entry.published_bundle_resource_id)
  const current = (db.prepare("SELECT id FROM views WHERE surface_id='surface' ORDER BY id").all() as { id: string }[]).map(view => view.id)
  db.prepare("UPDATE surfaces SET revision=?,layout_json=? WHERE id='surface'").run(input.surface_revision, JSON.stringify(layout ?? { slots: [{ id: 'main', groups: [{ id: 'all', type: 'column', views: current }] }] }))
  db.prepare("INSERT INTO records SELECT ?,'task',COALESCE(MAX(sequence),0)+1,'surface.published',?,'time' FROM records WHERE task_id='task'").run(input.surface_record_id, JSON.stringify({ action_id: input.action_id, revision: input.surface_revision, views: [{ view_id: entry.view_id, revision: entry.view_revision }] }))
}
function commit(fixture: Fixture) {
  return fixture.db.transaction(() => {
    applySurface(fixture)
    const result = fixture.state.installCommittedSurface(fixture.input)
    fixture.db.prepare("UPDATE actions SET state='ended',result='success',commit_valid=0,result_json=? WHERE id=?").run(JSON.stringify(result), fixture.input.action_id)
    return result
  })()
}
function unchanged(fixture: Fixture): void {
  const { db, state, input } = fixture
  expect((db.prepare("SELECT revision FROM surfaces WHERE id='surface'").get() as { revision: number }).revision).toBe(fixture.preparation.base_surface_revision)
  expect(db.prepare('SELECT id FROM records WHERE id=?').get(input.surface_record_id)).toBeUndefined()
  expect(state.history('task', input.surface_history_id)).toBeNull()
  expect(db.prepare("SELECT source_id FROM object_references WHERE source_kind='runner_surface_history' AND source_id=?").get(input.surface_history_id)).toBeUndefined()
  expect(state.mapping('task', input.entries[0]!.artifact_id, input.entries[0]!.artifact_revision, input.entries[0]!.batch_id)).toBeNull()
  expect(state.delivery('task', input.delivery.delivery_id)).toBeNull()
  expect(state.operation('task', input.operation_id)?.state).toBe('prepared')
}
function manifest(fixture: Fixture): PublicationManifest {
  return { manifest_id: `manifest-${fixture.input.operation_id}`, task_id: 'task', composition_version: 1, operation_id: fixture.input.operation_id, action_id: fixture.input.action_id, surface_id: 'surface', surface_revision: fixture.input.surface_revision, state: 'partial', targets: [target], contributions: fixture.input.entries, unresolved: [] }
}

it('retains immutable registration and returns it before current Task or batch checks', () => {
  const fixture = publication(setup()), { db, state, registration } = fixture
  const original = state.register(registration)
  db.prepare("UPDATE tasks SET state='stopped' WHERE id='task'").run()
  db.prepare("UPDATE runner_batches SET payload_json=json_set(payload_json,'$.state','cancelled') WHERE batch_id='batch'").run()
  expect(state.register({ action_id: registration.action_id, plan: registration.plan, operation_id: registration.operation_id, task_id: registration.task_id, batch_id: registration.batch_id })).toEqual(original)
  original.registration.plan.intents[0]!.order_key = 'mutated'
  expect(state.operation('task', registration.operation_id)?.registration.plan.intents[0]!.order_key).toBe('a')
})

it.each(['action_id', 'batch_id', 'plan'] as const)('rejects changed registration %s under the original operation', field => {
  const fixture = publication(setup()), { state, registration } = fixture
  state.register(registration)
  const changed = structuredClone(registration)
  if (field === 'plan') changed.plan.intents[0]!.layout_mode = 'responsive_columns'
  else changed[field] = 'other-identity'
  expect(() => state.register(changed)).toThrow(expect.objectContaining({ code: 'RUNNER_PUBLICATION_CONFLICT' }))
  expect(state.operation('task', registration.operation_id)?.registration).toEqual(registration)
})

it('prevents a new identity from bypassing an unknown operation or reusing its action', () => {
  const base = setup(), first = publication(base)
  ready(first)
  first.state.recordOutcome('task', 'operation', { state: 'unknown', code: 'CONNECTION_LOST' })
  expect(() => first.state.register({ ...first.registration, operation_id: 'replacement' })).toThrow(expect.objectContaining({ code: 'RUNNER_PUBLICATION_CONFLICT' }))
  const second = publication(base, '-second')
  expect(() => second.state.register({ ...second.registration, action_id: first.registration.action_id })).toThrow(expect.objectContaining({ code: 'RUNNER_PUBLICATION_CONFLICT' }))
  expect(first.state.operation('task', 'operation')?.result).toEqual({ operation_id: 'operation', state: 'unknown', code: 'CONNECTION_LOST' })
})

it('stores distinct accepted and normalized resources without marking preparation as published', () => {
  const fixture = publication(setup()); ready(fixture)
  const operation = fixture.state.operation('task', 'operation')!
  expect(operation.preparation).toEqual(fixture.preparation)
  expect(operation.preparation!.resources[0]!.source_bundle_resource_id).not.toBe(operation.preparation!.resources[0]!.published_bundle_resource_id)
  expect(operation.state).toBe('prepared'); expect(operation.result).toBeNull()
  expect(fixture.db.prepare("SELECT target_id,protects_resource FROM object_references WHERE source_kind='runner_publication' AND source_id='operation' ORDER BY target_id").all()).toEqual([{ target_id: 'artifact-source-1', protects_resource: 1 }, { target_id: 'published', protects_resource: 1 }])
  expect(fixture.state.mapping('task', 'artifact')).toBeNull()
  expect(fixture.db.prepare("SELECT id FROM views WHERE id='artifact-view'").get()).toBeUndefined()
})

it.each(['source', 'published', 'baseline'] as const)('rejects preparation with an invalid %s binding', field => {
  const fixture = publication(setup()), { db, state, registration, preparation } = fixture
  state.register(registration)
  if (field === 'source') preparation.resources[0]!.source_bundle_resource_id = 'kept-bundle'
  if (field === 'published') preparation.resources[0]!.published_bundle_resource_id = 'foreign-bundle'
  if (field === 'baseline') preparation.base_surface_revision++
  expect(() => state.prepare('task', 'operation', preparation)).toThrow()
  expect(state.operation('task', 'operation')?.state).toBe('registered')
  expect((db.prepare("SELECT revision FROM surfaces WHERE id='surface'").get() as { revision: number }).revision).toBe(1)
})

it('repeats original preparation and rejects replacement resources after the Task stops', () => {
  const fixture = publication(setup()); ready(fixture)
  fixture.db.prepare("UPDATE tasks SET state='stopped' WHERE id='task'").run()
  expect(fixture.state.prepare('task', 'operation', fixture.preparation).preparation).toEqual(fixture.preparation)
  expect(() => fixture.state.prepare('task', 'operation', { ...fixture.preparation, base_surface_revision: 2 })).toThrow(expect.objectContaining({ code: 'RUNNER_PUBLICATION_CONFLICT' }))
})

it('requires the existing final transaction for a new publication installation', () => {
  const fixture = publication(setup()); ready(fixture)
  expect(() => fixture.state.installCommittedSurface(fixture.input)).toThrow(expect.objectContaining({ code: 'RUNNER_TRANSACTION_REQUIRED' }))
  unchanged(fixture)
})

it('captures the real full layout and exact history for changed and retained Views', () => {
  const fixture = publication(setup()); ready(fixture)
  const result = commit(fixture), history = fixture.state.history('task', result.surface_history_id)!
  expect(result).toEqual({ operation_id: 'operation', state: 'published', action_id: 'action', batch_id: 'batch', surface_id: 'surface', surface_revision: 2, surface_history_id: 'surface-history', delivery_id: 'delivery' })
  expect(history.layout).toEqual(JSON.parse((fixture.db.prepare("SELECT layout_json FROM surfaces WHERE id='surface'").get() as { layout_json: string }).layout_json))
  expect(history.views).toEqual([{ view_id: 'artifact-view', view_revision: 1, view_history_id: 'view-history-artifact-view-1', state_revision: 1 }, { view_id: 'kept-view', view_revision: 1, view_history_id: 'kept-history', state_revision: 3 }])
  expect(fixture.state.mapping('task', 'artifact')).toEqual(fixture.input.entries[0])
  expect(fixture.state.delivery('task', 'delivery')).toEqual(fixture.input.delivery)
  expect(fixture.db.prepare("SELECT target_id FROM object_references WHERE source_kind='runner_surface_history' AND source_id='surface-history' ORDER BY target_id").all()).toEqual([{ target_id: 'kept-bundle' }, { target_id: 'published' }])
  history.views.length = 0
  expect(fixture.state.history('task', result.surface_history_id)?.views).toHaveLength(2)
})

it('queries the original committed result after reopen and acknowledges it without another transaction', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pliuna-publication-')); directories.push(directory)
  const filename = join(directory, 'state.sqlite'), fixture = publication(setup(filename)); ready(fixture)
  const result = commit(fixture)
  fixture.db.prepare("UPDATE tasks SET state='stopped' WHERE id='task'").run()
  fixture.db.prepare("UPDATE runner_artifact_owners SET current_revision=2 WHERE artifact_id='artifact'").run()
  fixture.db.close()
  const db = open(filename), state = new RunnerPublicationState(db)
  expect(state.operation('task', 'operation')?.result).toEqual(result)
  expect(state.register(fixture.registration).result).toEqual(result)
  expect(state.installCommittedSurface(fixture.input)).toEqual(result)
  expect(state.recordOutcome('task', 'operation', { state: 'unknown', code: 'LATE_NOTIFICATION' })).toEqual(result)
  expect(state.mapping('task', 'artifact')?.view_id).toBe('artifact-view')
  expect((db.prepare('SELECT COUNT(*) count FROM runner_surface_history').get() as { count: number }).count).toBe(1)
  expect((db.prepare('SELECT COUNT(*) count FROM views').get() as { count: number }).count).toBe(2)
})

it('rejects different installation payloads after publication', () => {
  const fixture = publication(setup()); ready(fixture); commit(fixture)
  expect(() => fixture.state.installCommittedSurface({ ...fixture.input, surface_history_id: 'replacement-history' })).toThrow(expect.objectContaining({ code: 'RUNNER_PUBLICATION_CONFLICT' }))
})

it('rolls back Surface, View history, mapping, delivery and result together after a late fault', () => {
  const fixture = publication(setup()); ready(fixture)
  expect(() => fixture.db.transaction(() => {
    applySurface(fixture)
    fixture.state.installCommittedSurface(fixture.input)
    throw Error('after publication installation')
  })()).toThrow('after publication installation')
  unchanged(fixture)
  expect(fixture.db.prepare("SELECT id FROM views WHERE id='artifact-view'").get()).toBeUndefined()
  expect(fixture.db.prepare("SELECT id FROM view_history WHERE view_id='artifact-view'").get()).toBeUndefined()
  expect(commit(fixture).state).toBe('published')
})

it('keeps one stable View across revisions while preserving earlier exact layout and resource history', () => {
  const base = setup(), first = publication(base); ready(first); commit(first)
  const original = first.state.history('task', 'surface-history')!
  const second = publication(base, '-second', { artifactRevision: 2 }); ready(second); commit(second)
  expect(second.state.mapping('task', 'artifact')?.view_id).toBe('artifact-view')
  expect(second.state.mapping('task', 'artifact', 1, 'batch')).toEqual(first.input.entries[0])
  expect(second.state.history('task', 'surface-history')).toEqual(original)
  expect(second.state.history('task', 'surface-history-second')?.views[0]).toEqual({ view_id: 'artifact-view', view_revision: 2, view_history_id: 'view-history-artifact-view-2', state_revision: 2 })
  expect((second.db.prepare('SELECT bundle_resource_id FROM view_history WHERE id=?').get(original.views[0]!.view_history_id) as { bundle_resource_id: string }).bundle_resource_id).toBe('published')
})

it('captures a layout-only publication by reusing exact existing View history', () => {
  const base = setup(), first = publication(base); ready(first); commit(first)
  const second = publication(base, '-layout', { reuseView: true, publishedId: 'published' }); ready(second)
  const layout = { slots: [{ id: 'main', groups: [{ id: 'moved', type: 'column', views: ['kept-view', 'artifact-view'] }] }] }
  second.db.transaction(() => { applySurface(second, layout); second.state.installCommittedSurface(second.input) })()
  expect(second.state.history('task', 'surface-history-layout')?.layout).toEqual(layout)
  expect(second.state.history('task', 'surface-history-layout')?.views[0]!.view_history_id).toBe('view-history-artifact-view-1')
  expect(second.state.mapping('task', 'artifact', 1, 'batch')?.surface_history_id).toBe('surface-history')
  expect((second.db.prepare("SELECT COUNT(*) count FROM view_history WHERE view_id='artifact-view'").get() as { count: number }).count).toBe(1)
})

it.each(['replace-stable-view', 'reuse-other-artifact-view'] as const)('rejects %s atomically', reason => {
  const base = setup(), first = publication(base); ready(first); commit(first)
  const second = publication(base, '-second', reason === 'replace-stable-view' ? { artifactRevision: 2, viewId: 'replacement-view' } : { artifactId: 'other-artifact' })
  ready(second)
  expect(() => commit(second)).toThrow(expect.objectContaining({ code: 'RUNNER_PUBLICATION_CONFLICT' }))
  unchanged(second)
  expect(second.state.mapping('task', 'artifact', 1, 'batch')).toEqual(first.input.entries[0])
})

it.each(['missing-kept-view', 'duplicate-view', 'missing-exact-history', 'foreign-history', 'wrong-history-resource'] as const)('rejects a false Surface snapshot with %s', reason => {
  const fixture = publication(setup()); ready(fixture)
  expect(() => fixture.db.transaction(() => {
    applySurface(fixture)
    if (reason === 'missing-kept-view' || reason === 'duplicate-view') fixture.db.prepare("UPDATE surfaces SET layout_json=? WHERE id='surface'").run(JSON.stringify({ slots: [{ id: 'main', groups: [{ id: 'g', type: 'column', views: reason === 'missing-kept-view' ? ['artifact-view'] : ['artifact-view', 'artifact-view', 'kept-view'] }] }] }))
    if (reason === 'missing-exact-history') fixture.db.prepare("DELETE FROM view_history WHERE view_id='artifact-view'").run()
    if (reason === 'foreign-history') fixture.db.prepare("UPDATE view_history SET task_id='other' WHERE view_id='artifact-view'").run()
    if (reason === 'wrong-history-resource') fixture.db.prepare("UPDATE view_history SET bundle_resource_id='kept-bundle' WHERE view_id='artifact-view'").run()
    fixture.state.installCommittedSurface(fixture.input)
  })()).toThrow()
  unchanged(fixture)
})

it.each(['task-stopped', 'accepted-pointer', 'resource-association', 'batch-cancelled', 'action-unknown'] as const)('rechecks %s before installing the prepared operation', reason => {
  const fixture = publication(setup()); ready(fixture)
  if (reason === 'task-stopped') fixture.db.prepare("UPDATE tasks SET state='stopped' WHERE id='task'").run()
  if (reason === 'accepted-pointer') fixture.db.prepare("UPDATE runner_artifact_owners SET current_revision=2 WHERE artifact_id='artifact'").run()
  if (reason === 'resource-association') fixture.db.prepare("DELETE FROM task_resources WHERE task_id='task' AND resource_id='published'").run()
  if (reason === 'batch-cancelled') fixture.db.prepare("UPDATE runner_batches SET payload_json=json_set(payload_json,'$.state','cancelled') WHERE batch_id='batch'").run()
  if (reason === 'action-unknown') fixture.db.prepare("UPDATE actions SET state='ended',result='unknown',commit_valid=0 WHERE id='action'").run()
  expect(() => commit(fixture)).toThrow()
  unchanged(fixture)
})

it.each(['failure', 'cancelled', 'unknown'] as const)('retains %s as an original queryable outcome without an installed mapping', state => {
  const fixture = publication(setup()); ready(fixture)
  const outcome = { state, code: 'NOT_PUBLISHED' }, expected = { operation_id: 'operation', ...outcome }
  expect(fixture.state.recordOutcome('task', 'operation', outcome)).toEqual(expected)
  expect(fixture.state.recordOutcome('task', 'operation', outcome)).toEqual(expected)
  expect(() => fixture.state.recordOutcome('task', 'operation', { ...outcome, code: 'OTHER_RESULT' })).toThrow(expect.objectContaining({ code: 'RUNNER_PUBLICATION_CONFLICT' }))
  expect(() => commit(fixture)).toThrow(expect.objectContaining({ code: 'RUNNER_PUBLICATION_CONFLICT' }))
  expect(fixture.state.operation('task', 'operation')?.result).toEqual(expected)
  expect(fixture.state.mapping('task', 'artifact')).toBeNull()
})

it.each(['wrong-attempt', 'wrong-record', 'wrong-versions'] as const)('rejects delivery with %s', reason => {
  const fixture = publication(setup()); ready(fixture)
  if (reason === 'wrong-attempt') fixture.input.delivery.attempt_id = 'missing-attempt'
  if (reason === 'wrong-record') fixture.input.delivery.record_id = 'input-record'
  if (reason === 'wrong-versions') fixture.input.delivery.composition_version = 2
  expect(() => commit(fixture)).toThrow()
  unchanged(fixture)
})

it('installs a partial immutable manifest with its real final Surface history', () => {
  const fixture = publication(setup()); ready(fixture)
  fixture.input.manifest = manifest(fixture)
  fixture.input.delivery.publication_manifest_id = fixture.input.manifest.manifest_id
  const result = commit(fixture)
  expect(fixture.state.manifest('task', result.manifest_id!)).toEqual(fixture.input.manifest)
  expect(fixture.state.history('task', result.surface_history_id)?.surface_revision).toBe(fixture.input.manifest.surface_revision)
  expect(fixture.db.prepare("SELECT target_id FROM object_references WHERE source_kind='runner_manifest' AND source_id=? ORDER BY target_id").all(result.manifest_id)).toEqual([{ target_id: 'artifact-source-1' }, { target_id: 'published' }])
})

it.each(['complete-assertion', 'foreign-history', 'wrong-final-surface'] as const)('rejects a manifest with %s and rolls back all publication rows', reason => {
  const fixture = publication(setup()); ready(fixture)
  fixture.input.manifest = structuredClone(manifest(fixture))
  fixture.input.delivery.publication_manifest_id = fixture.input.manifest.manifest_id
  if (reason === 'complete-assertion') fixture.input.manifest.state = 'complete'
  if (reason === 'foreign-history') fixture.input.manifest.contributions[0]!.surface_history_id = 'invented-history'
  if (reason === 'wrong-final-surface') fixture.input.manifest.surface_revision++
  expect(() => commit(fixture)).toThrow()
  unchanged(fixture)
  expect(fixture.state.manifest('task', fixture.input.manifest.manifest_id)).toBeNull()
})
