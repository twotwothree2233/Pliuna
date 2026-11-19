import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { afterEach, expect, it } from 'vitest'
import type { ArtifactCandidate, Bundle, ChapterManifest, ChapterProposal, ChapterPublication, ChapterUpdate, ExecutionScope, LogicalWork, PublicationEntry, WorkDependency, WorkOutputDeclaration } from '../../src/shared/contracts.generated'
import type { ModelLease } from '../../src/runtime/model/service'
import { RunnerArtifactState, type ChapterAssemblyInstall } from '../../src/runtime/runner/artifact-state'
import { RunnerBudgetLedger } from '../../src/runtime/runner/budget'
import { ChapterState } from '../../src/runtime/runner/chapter-state'
import { assembleChapterUpdate } from '../../src/runtime/runner/chapter-content'
import { RunnerCompositionState } from '../../src/runtime/runner/composition-state'
import { compositionCompleteness } from '../../src/runtime/runner/completeness'
import { RunnerHostStatus } from '../../src/runtime/runner/host-status'
import { RunnerHostComposition } from '../../src/runtime/runner/host-composition'
import defaults from '../../src/shared/contracts/development-defaults.json'
import { RunnerPublicationState } from '../../src/runtime/runner/publication-state'
import { RunnerWorkState } from '../../src/runtime/runner/work-state'
import { chapterBundle, chapterManifest, chapterRegion } from '../helpers/chapters'

const core = readFileSync(new URL('../../src/shared/contracts/001-core.sql', import.meta.url), 'utf8')
const runner = readFileSync(new URL('../../src/shared/contracts/002-runner.sql', import.meta.url), 'utf8')
const databases: Database.Database[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })

function setup(materials: { original?: string[]; updates?: string[]; publishedCopy?: boolean } = {}) {
  const db = new Database(':memory:'); databases.push(db); db.pragma('foreign_keys=ON'); db.exec(core); db.exec(runner)
  db.exec("INSERT INTO tasks(id,title,state,revision) VALUES ('task','Task','active',1); INSERT INTO requests VALUES ('goal','task','started','{}','{}','time')")
  const work = new RunnerWorkState(db, 'epoch'), artifacts = new RunnerArtifactState(db, work), chapters = new ChapterState(db), composition = new RunnerCompositionState(db, work, artifacts), publications = new RunnerPublicationState(db)
  const bundles = new Map<string, Bundle>()
  const record = (id: string, kind = 'message.user', payload: unknown = {}) => {
    const row = db.prepare("SELECT COALESCE(MAX(sequence),0)+1 n FROM records WHERE task_id='task'").get() as { n: number }
    db.prepare("INSERT INTO records VALUES (?,'task',?,?,?,'time')").run(id, row.n, kind, JSON.stringify(payload))
  }
  const resource = (id: string, bundle = chapterBundle()) => {
    db.prepare("INSERT INTO resources VALUES (?,?,'fixture',?,'application/json','Body','time')").run(id, id, Buffer.byteLength(JSON.stringify(bundle)))
    db.prepare("INSERT INTO task_resources VALUES ('task',?)").run(id)
    bundles.set(id, bundle)
  }
  const run = (id: string, update_id?: string) => {
    new RunnerBudgetLedger(db).create({ budget_id: 'budget-goal', task_id: 'task', purpose: 'production', request_id: 'goal' })
    db.prepare("INSERT INTO runs(id,task_id,request_id,state,runtime_epoch,limits_json,budget_json,created_at,chapter_update_id) VALUES (?,'task','goal','running','epoch','{}','{}','time',?)").run(id, update_id ?? null)
    work.registerRun({ run_id: id, task_id: 'task', runtime_epoch: 'epoch', state: 'running', commit_valid: true, budget_id: 'budget-goal', purpose: 'production', request_id: 'goal', intent_revision: 1, ...(update_id ? { update_id } : {}) })
  }
  const start = (id: string, runId: string, update?: ChapterUpdate, publisher = false, dependencies: WorkDependency[] = []): ExecutionScope => {
    const scope: ExecutionScope = { task_id: 'task', request_id: 'goal', intent_revision: 1, run_id: runId, work_id: id, attempt_id: `attempt-${id}`, role: publisher ? 'lightweight' : 'producer', purpose: 'production', ...(update ? { update_id: update.update_id } : {}) }
    const logical: LogicalWork = { task_id: 'task', request_id: 'goal', intent_revision: 1, run_id: runId, work_id: id, plan_revision: 1, role: scope.role, required: !publisher, requirement_ids: ['content'], dependencies: [{ kind: 'goal', task_id: 'task', request_id: 'goal', intent_revision: 1 }, ...(update ? materials.updates ?? ['material'] : []).map(resource_id => ({ kind: 'resource' as const, task_id: 'task', resource_id })), ...(update?.dependencies ?? []), ...dependencies], state: 'planned', max_attempts: 1, purpose: 'production', ...(update ? { update_id: update.update_id } : {}) }
    work.installPlan([logical])
    const { role: _role, ...attemptSource } = scope
    work.createAttempt({ ...attemptSource, runtime_epoch: 'epoch', attempt_number: 1, profile_id: publisher ? 'chapter-host-publisher-v1' : 'producer', model_config_id: 'model', model_config_revision: 1, input_versions: logical.dependencies, state: 'registered', dispatch_state: 'not_dispatched', usage_refs: [] })
    work.updateAttempt({ ...work.attempt(scope.attempt_id), state: 'dispatched', dispatch_state: 'dispatched', operation_id: `operation-${id}` })
    work.updateAttempt({ ...work.attempt(scope.attempt_id), state: 'running' })
    return scope
  }
  const finish = (scope: ExecutionScope, result = `result-${scope.work_id}`) => {
    record(result, 'worker.result')
    work.updateAttempt({ ...work.attempt(scope.attempt_id), state: 'succeeded', result_ref: { task_id: 'task', kind: 'record', id: result } })
  }
  record('record')
  work.receive({ task_id: 'task', input_event_id: 'input', record_id: 'record', request_id: 'goal', kind: 'request', stage: 'received' })
  const goal = work.installGoal({ task_id: 'task', request_id: 'goal', intent_revision: 1, input_event_id: 'input', state: 'active', requirements: [{ requirement_id: 'content', kind: 'artifact', required: true, provenance_required: true }] })
  resource('material')
  for (const id of new Set([...(materials.original ?? []), ...(materials.updates ?? [])])) if (id !== 'material') resource(id)
  run('original-run'); const producer = start('original-producer', 'original-run', undefined, false, (materials.original ?? []).map(resource_id => ({ kind: 'resource', task_id: 'task', resource_id })))
  artifacts.installOutline({ task_id: 'task', outline_revision: 1, base_outline_revision: 0, sections: [{ section_id: 'section', request_id: 'goal', intent_revision: 1, position_revision: 1, order_key: 'a' }] })
  resource('original')
  const publishedOriginal = materials.publishedCopy ? 'original-published' : 'original'
  if (materials.publishedCopy) resource(publishedOriginal)
  artifacts.assign([{ task_id: 'task', artifact_id: 'artifact', section_id: 'section', work_id: producer.work_id, plan_revision: 1, base_artifact_revision: 0 }])
  const originalCandidate: ArtifactCandidate = { candidate_id: 'original-candidate', task_id: 'task', request_id: 'goal', intent_revision: 1, run_id: producer.run_id, work_id: producer.work_id, attempt_id: producer.attempt_id, artifact_id: 'artifact', base_artifact_revision: 0, plan_revision: 1, section_id: 'section', section_position_revision: 1, order_key: 'a', bundle_resource_id: 'original', presentation_kind: 'managed-v1', width_constraint: 'full', interaction_kind: 'none', provenance_ref: { task_id: 'task', kind: 'record', id: 'record' }, requirement_ids: ['content'], unresolved: [], dependencies: work.work(producer.work_id).dependencies }
  const decision = artifacts.decide(originalCandidate, { state: 'accepted' })
  if (decision.state !== 'accepted') throw Error(decision.code)
  const original = decision.index
  finish(producer)
  const output: WorkOutputDeclaration = composition.declareOutputs({ task_id: 'task', request_id: 'goal', intent_revision: 1, run_id: producer.run_id, work_id: producer.work_id, attempt_id: producer.attempt_id, plan_revision: 1, result_revision: 1, result_ref: work.attempt(producer.attempt_id).result_ref!, complete: true, artifacts: [{ task_id: 'task', artifact_id: 'artifact', artifact_revision: 1 }], requirement_ids: ['content'], unresolved: [] })
  composition.designateSource({ task_id: 'task', request_id: 'goal', intent_revision: 1, work_id: producer.work_id, plan_revision: 1 })
  const inventory = composition.sealInventory({ task_id: 'task', request_id: 'goal', intent_revision: 1, inventory_revision: 1, required_works: [output], requirement_ids: ['content'], unresolved: [], sealed_by: { run_id: producer.run_id, work_id: producer.work_id, attempt_id: producer.attempt_id, role: 'producer', plan_revision: 1 } })
  composition.installScope({ task_id: 'task', composition_version: 1, state: 'working', targets: [{ request_id: 'goal', intent_revision: 1, required: true, requirement_ids: ['content'], contribution_inventory: { task_id: 'task', request_id: 'goal', intent_revision: 1, inventory_revision: 1 } }], unresolved: [] })
  db.prepare("UPDATE runs SET state='completed',commit_valid=0 WHERE id='original-run'").run()
  const layout = { slots: [{ id: 'main', groups: [{ id: 'group', type: 'column', gap: 'small', align: 'stretch', views: ['view'] }] }] }
  db.prepare("INSERT INTO surfaces VALUES ('surface','task',1,?)").run(JSON.stringify(layout))
  db.prepare("INSERT INTO views(id,surface_id,revision,bundle_resource_id,state_revision,draft_json,compatibility_version) VALUES ('view','surface',1,?,1,'{}','v1')").run(publishedOriginal)
  db.prepare("INSERT INTO view_history VALUES ('history-1','task','view',1,?,'{}')").run(publishedOriginal)
  const baseline: ChapterManifest = { ...chapterManifest(), bundle_resource_id: publishedOriginal, artifact_id: 'artifact', artifact_revision: 1 }
  chapters.installManifest(baseline, null)
  const batch = { task_id: 'task', batch_id: 'initial-batch', composition_version: 1, run_id: 'initial-composition', trigger_request_id: 'goal', model_config_id: 'model', model_config_revision: 1, state: 'published', targets: [{ task_id: 'task', request_id: 'goal', intent_revision: 1 }], indexes: [{ task_id: 'task', artifact_id: 'artifact', artifact_revision: 1 }], sections: [{ section_id: 'section', position_revision: 1, order_key: 'a' }] }
  db.prepare('INSERT INTO runner_batches(batch_id,task_id,composition_version,payload_json) VALUES (?,?,?,?)').run(batch.batch_id, 'task', 1, JSON.stringify(batch))
  db.exec("INSERT INTO actions(id,task_id,run_id,kind,state,result,source_json,request_json,commit_valid,created_at) VALUES ('initial-action','task','original-run','mutation','ended','success','{}','{}',0,'time'); INSERT INTO runner_surface_history VALUES ('initial-history','task','surface',1,'initial-action','{}')")
  const entry: PublicationEntry = { task_id: 'task', batch_id: batch.batch_id, request_id: 'goal', intent_revision: 1, artifact_id: 'artifact', artifact_revision: 1, section_id: 'section', view_id: 'view', view_revision: 1, state_revision: 1, source_bundle_resource_id: 'original', published_bundle_resource_id: publishedOriginal, surface_history_id: 'initial-history' }
  db.prepare('INSERT INTO runner_view_mappings VALUES (?,?,?,?,?,?,?,?,?)').run('task', 'artifact', 1, batch.batch_id, 'view', 1, 'original', publishedOriginal, JSON.stringify(entry))

  const begin = (id = 'a-update', regionIds = ['a'], nextRegionIds = regionIds) => {
    const base = chapters.manifest('task', 'view')!
    record(`record-${id}`)
    const update = chapters.start({ task_id: 'task', update_id: id, input_event_id: `input-${id}`, record_id: `record-${id}`, request_id: 'goal', intent_revision: 1, view_id: 'view', base_manifest: base, region_ids: regionIds, region_intents: regionIds.map(region_id => ({ region_id, intent_revision: 1 })), previous_update_ids: [], dependencies: [{ kind: 'chapter', task_id: 'task', view_id: 'view', revision: base.shared_revision }], state: 'queued', text: 'Revise this chapter' })
    run(`run-${id}`, id)
    const source = start(`producer-${id}`, `run-${id}`, update), publisher = start(`publisher-${id}`, `run-${id}`, update, true)
    chapters.stage('task', id, 'generating', { source })
    const nextChapters = nextRegionIds.map(region => chapterRegion(region, (base.chapters.find(item => item.region_id === region)?.revision ?? 0) + 1))
    resource(`candidate-${id}`, { ...chapterBundle(), html: nextChapters.map(chapter => `<h2 id="${chapter.region_id}-title">${chapter.title}</h2><div id="${chapter.region_id}-body">Generated ${chapter.region_id}</div>`).join('') })
    const proposal: ChapterProposal = { task_id: 'task', update_id: id, proposal_id: `proposal-${id}`, intent_revision: 1, bundle_resource_id: `candidate-${id}`, replacements: [{ previous_region_ids: regionIds, chapters: nextChapters }], dependencies: update.dependencies, source }
    chapters.recordProposal(proposal)
    finish(source)
    return { update, proposal, publisher, source }
  }
  const commit = (session: ReturnType<typeof begin>, beforeInstall?: (input: ChapterAssemblyInstall) => void) => db.transaction(() => {
    const latestManifest = chapters.manifest('task', 'view')!, { update, proposal, publisher } = session
    const assembled = assembleChapterUpdate({ latest: { bundle: bundles.get(latestManifest.bundle_resource_id)!, manifest: latestManifest }, baseline: update.base_manifest, candidate: bundles.get(proposal.bundle_resource_id)!, replacements: proposal.replacements, dependencies: proposal.dependencies })
    const resourceId = `published-${update.update_id}`, operationId = `publication-${update.update_id}`, actionId = `action-${update.update_id}`
    resource(resourceId, assembled.bundle)
    const assembledResourceId = materials.publishedCopy ? `assembled-${update.update_id}` : resourceId
    if (assembledResourceId !== resourceId) resource(assembledResourceId, assembled.bundle)
    for (const chapter of latestManifest.chapters.filter(chapter => !update.region_ids.includes(chapter.region_id))) chapters.keep({ task_id: 'task', update_id: update.update_id, view_id: 'view', region_id: chapter.region_id, region_revision: chapter.revision, source_bundle_resource_id: latestManifest.bundle_resource_id, source_manifest_revision: latestManifest.manifest_revision, request_id: 'goal', intent_revision: 1, artifact_id: 'artifact', artifact_revision: latestManifest.artifact_revision!, requirement_ids: ['content'], dependencies: chapter.dependencies, valid: chapter.dependencies.every(dependency => chapters.dependencyCurrent(dependency)) })
    const surface = db.prepare("SELECT revision FROM surfaces WHERE id='surface'").get() as { revision: number }
    const published: ChapterAssemblyInstall['published'] = { operation_id: operationId, action_id: actionId, bundle_resource_id: resourceId, view_id: 'view', view_revision: latestManifest.view_revision + 1, state_revision: latestManifest.state_revision + 1, surface_record_id: `record-${operationId}`, surface_revision: surface.revision + 1 }
    const request: ChapterPublication['request'] = { type: 'write', input: { type: 'surface.update', surface_id: 'surface', expected_revision: surface.revision, operations: [{ type: 'view.replace', view_id: 'view', expected_view_revision: latestManifest.view_revision, bundle: { type: 'resource', resource: { kind: 'resource', id: assembledResourceId } }, state_transition: { type: 'preserve', expected_state_revision: latestManifest.state_revision, compatibility_version: 'v1' } }] } }
    chapters.registerPublication({ task_id: 'task', operation_id: operationId, update_id: update.update_id, proposal_id: proposal.proposal_id, base_manifest_revision: latestManifest.manifest_revision, assembled_bundle_resource_id: assembledResourceId, view_id: 'view', expected_view_revision: latestManifest.view_revision, expected_state_revision: latestManifest.state_revision, request, source_bundle_resource_ids: [latestManifest.bundle_resource_id, proposal.bundle_resource_id], action_id: actionId, state: 'registered' })
    chapters.publicationStage('task', operationId, 'prepared'); chapters.publicationStage('task', operationId, 'dispatched')
    chapters.stage('task', update.update_id, 'publishing')
    db.prepare("INSERT INTO actions(id,task_id,run_id,kind,state,source_json,request_json,commit_valid,created_at) VALUES (?,'task',?,'mutation','executing',?,?,1,'time')").run(actionId, publisher.run_id, JSON.stringify({ owner: publisher }), JSON.stringify(request.input))
    db.prepare("UPDATE views SET revision=?,state_revision=?,bundle_resource_id=? WHERE id='view'").run(published.view_revision, published.state_revision, resourceId)
    db.prepare("INSERT INTO view_history VALUES (?,'task','view',?,?,'{}')").run(`history-${published.view_revision}`, published.view_revision, resourceId)
    db.prepare("UPDATE surfaces SET revision=? WHERE id='surface'").run(published.surface_revision)
    record(published.surface_record_id, 'surface.published', { action_id: actionId, revision: published.surface_revision })
    work.updateAttempt({ ...work.attempt(publisher.attempt_id), state: 'succeeded', result_ref: { task_id: 'task', kind: 'record', id: published.surface_record_id } })
    chapters.installManifest({ ...latestManifest, view_revision: published.view_revision, state_revision: published.state_revision, bundle_resource_id: resourceId, manifest_revision: latestManifest.manifest_revision + 1, artifact_revision: latestManifest.artifact_revision! + 1, chapters: assembled.chapters }, latestManifest.manifest_revision)
    chapters.publicationStage('task', operationId, 'published', { view_revision: published.view_revision })
    chapters.stage('task', update.update_id, 'succeeded')
    const input: ChapterAssemblyInstall = { update, latestManifest, proposal, publisherOwner: publisher, published }
    beforeInstall?.(input)
    const index = artifacts.installChapterAssembly(input)
    return { input, index }
  })()
  const completeness = () => compositionCompleteness(db, work, composition, publications, 'task', 1, 'surface')
  return { db, work, artifacts, chapters, composition, publications, goal, original, originalCandidate, output, inventory, producer, bundles, record, resource, run, start, finish, begin, commit, completeness }
}

it('inherits actual original materials without restoring the completed producer Run', () => {
  const ctx = setup({ original: ['source-material'], updates: [] })
  const expected = [{ kind: 'resource', task_id: 'task', resource_id: 'source-material' }]
  expect(ctx.work.run(ctx.original.run_id)).toMatchObject({ state: 'completed', commit_valid: false })
  expect(() => ctx.work.qualify(ctx.original.attempt_id)).toThrow('no longer permits')
  expect(ctx.artifacts.chapterMaterialDependencies(ctx.original)).toEqual(expected)
  const { index } = ctx.commit(ctx.begin())
  expect(ctx.artifacts.checkChapterAssembly(index)).not.toBeNull()
  expect(ctx.artifacts.chapterMaterialDependencies(index)).toEqual(expected)
  expect(ctx.artifacts.resolveChapterReference(ctx.original)).toEqual(index)
})

it('inherits the accepted source through its distinct published Bundle copy', () => {
  const ctx = setup({ original: ['source-material'], updates: [], publishedCopy: true })
  expect(ctx.original.bundle_resource_id).toBe('original')
  expect(ctx.chapters.manifest('task', 'view')!.bundle_resource_id).toBe('original-published')
  const { index } = ctx.commit(ctx.begin())
  expect(ctx.artifacts.checkChapterAssembly(index)).not.toBeNull()
  expect(ctx.artifacts.resolveChapterReference(ctx.original)).toEqual(index)
  expect(ctx.artifacts.chapterMaterialDependencies(index)).toEqual([{ kind: 'resource', task_id: 'task', resource_id: 'source-material' }])
})

it('requires actual historical View evidence for the distinct published source copy', () => {
  const ctx = setup({ original: ['source-material'], updates: [], publishedCopy: true }), { index } = ctx.commit(ctx.begin())
  ctx.db.prepare("DELETE FROM view_history WHERE id='history-1'").run()
  expect(() => ctx.artifacts.checkChapterAssembly(index)).toThrow('published manifest')
  expect(() => ctx.artifacts.resolveChapterReference(ctx.original)).toThrow('published manifest')
})

it('invalidates inherited content and its consumers when an original material is detached', () => {
  const ctx = setup({ original: ['source-material'], updates: [] }), { index } = ctx.commit(ctx.begin())
  ctx.run('consumer-run')
  const consumer = ctx.start('consumer', 'consumer-run', undefined, false, [{ kind: 'artifact', task_id: 'task', artifact_id: index.artifact_id, artifact_revision: index.artifact_revision }])
  expect(() => ctx.work.qualify(consumer.attempt_id)).not.toThrow()
  expect(ctx.composition.checkArtifact('task', index.artifact_id, index.artifact_revision)).toEqual(index)
  ctx.db.prepare("DELETE FROM task_resources WHERE task_id='task' AND resource_id='source-material'").run()
  expect(() => ctx.artifacts.checkChapterAssembly(index)).toThrow('material dependency')
  expect(() => ctx.artifacts.resolveChapterReference(ctx.original)).toThrow('material dependency')
  expect(() => ctx.work.qualify(consumer.attempt_id)).toThrow('Artifact dependency')
  expect(() => ctx.composition.checkArtifact('task', index.artifact_id, index.artifact_revision)).toThrow('material dependency')
})

it('preserves first-generation materials across successive chapter publications with distinct Bundle copies', () => {
  const ctx = setup({ original: ['source-material'], updates: [], publishedCopy: true }), first = ctx.begin()
  ctx.commit(first)
  const mapping = ctx.publications.mapping('task', 'artifact', 2)!
  expect(mapping.source_bundle_resource_id).not.toBe(mapping.published_bundle_resource_id)
  ctx.db.prepare("UPDATE runs SET state='completed',commit_valid=0 WHERE id=?").run(first.publisher.run_id)
  ctx.work.reconcileDependencies('task')
  const { index } = ctx.commit(ctx.begin('b-update', ['b']))
  expect(ctx.artifacts.checkChapterAssembly(index)).not.toBeNull()
  expect(ctx.artifacts.resolveChapterReference(ctx.original)).toEqual(index)
  expect(ctx.artifacts.chapterMaterialDependencies(index)).toEqual([{ kind: 'resource', task_id: 'task', resource_id: 'source-material' }])
  ctx.db.prepare("DELETE FROM task_resources WHERE task_id='task' AND resource_id='source-material'").run()
  expect(() => ctx.artifacts.checkChapterAssembly(index)).toThrow('material dependency')
})

it('rolls back publication when the inherited original material is no longer available', () => {
  const ctx = setup({ original: ['source-material'], updates: [] }), session = ctx.begin()
  ctx.db.prepare("DELETE FROM task_resources WHERE task_id='task' AND resource_id='source-material'").run()
  expect(() => ctx.commit(session)).toThrow('material dependency')
  expect(ctx.artifacts.artifact('task', 'artifact')).toEqual(ctx.original)
  expect(ctx.chapters.manifest('task', 'view')).toMatchObject({ manifest_revision: 1, artifact_revision: 1, bundle_resource_id: 'original' })
  expect(ctx.db.prepare("SELECT revision,bundle_resource_id FROM views WHERE id='view'").get()).toEqual({ revision: 1, bundle_resource_id: 'original' })
})

it('requires the exact accepted original artifact before granting material access', () => {
  const ctx = setup({ original: ['source-material'], updates: [] })
  expect(() => ctx.artifacts.chapterMaterialDependencies({ ...ctx.original, bundle_resource_id: 'material' })).toThrow('exact accepted')
  ctx.commit(ctx.begin())
  expect(() => ctx.artifacts.resolveChapterReference({ ...ctx.original, bundle_resource_id: 'material' })).toThrow('exact accepted')
})

it.each(['work', 'artifact'] as const)('inherits resource inputs through an original %s dependency', kind => {
  const ctx = setup(), dependency: WorkDependency = { kind: 'resource', task_id: 'task', resource_id: 'indirect-material' }
  ctx.resource('indirect-material')
  const accept = (scope: ExecutionScope, name: string) => {
    ctx.resource(name)
    ctx.artifacts.assign([{ task_id: 'task', artifact_id: name, section_id: 'section', work_id: scope.work_id, plan_revision: 1, base_artifact_revision: 0 }])
    const result = ctx.artifacts.decide({ ...ctx.originalCandidate, candidate_id: `${name}-candidate`, artifact_id: name, bundle_resource_id: name, run_id: scope.run_id, work_id: scope.work_id, attempt_id: scope.attempt_id, dependencies: ctx.work.work(scope.work_id).dependencies }, { state: 'accepted' })
    if (result.state !== 'accepted') throw Error(result.code)
    ctx.finish(scope)
    ctx.db.prepare("UPDATE runs SET state='completed',commit_valid=0 WHERE id=?").run(scope.run_id)
    return result.index
  }
  ctx.run('upstream-run')
  const upstream = ctx.start('upstream', 'upstream-run', undefined, false, [dependency]), upstreamIndex = accept(upstream, 'upstream-artifact')
  const input: WorkDependency = kind === 'work'
    ? { kind, task_id: 'task', work_id: upstream.work_id, result_revision: ctx.work.work(upstream.work_id).result_revision! }
    : { kind, task_id: 'task', artifact_id: upstreamIndex.artifact_id, artifact_revision: upstreamIndex.artifact_revision }
  ctx.run('dependent-run')
  const dependent = ctx.start('dependent', 'dependent-run', undefined, false, [input]), index = accept(dependent, 'dependent-artifact')
  expect(ctx.artifacts.chapterMaterialDependencies(index)).toEqual([dependency])
  ctx.db.prepare("DELETE FROM task_resources WHERE task_id='task' AND resource_id='indirect-material'").run()
  expect(() => ctx.artifacts.chapterMaterialDependencies(index)).toThrow('material dependency')
})

it('enumerates settled replacement and inherited contributions without regenerating old producers', () => {
  const ctx = setup(); expect(ctx.completeness().state).toBe('complete')
  const session = ctx.begin()
  expect(ctx.completeness().state).toBe('partial')
  expect(ctx.artifacts.owner('task', 'artifact')!.work_id).toBe(ctx.producer.work_id)
  const result = ctx.commit(session)
  expect(result.index.artifact_revision).toBe(2)
  expect(ctx.composition.currentArtifacts(ctx.inventory)).toEqual([result.index])
  expect(ctx.completeness()).toMatchObject({ state: 'complete', contributions: [{ artifact_revision: 2, chapter_update_id: session.update.update_id }] })
  expect(ctx.composition.output('task', ctx.producer.work_id, 1, 1)).toEqual(ctx.output)
  expect(ctx.work.run(ctx.producer.run_id)).toMatchObject({ state: 'completed', commit_valid: false })
  expect(() => ctx.work.qualify(ctx.producer.attempt_id)).toThrow()
  expect(ctx.chapters.inheritance('task', session.update.update_id)).toMatchObject([{ region_id: 'b', region_revision: 1, valid: true }])
  expect(ctx.db.pragma('foreign_key_check')).toEqual([])
})

it('keeps independent producer proposals away from the whole artifact owner', () => {
  const ctx = setup(), a = ctx.begin('a-update', ['a']), b = ctx.begin('b-update', ['b'])
  for (const session of [a, b]) expect(() => ctx.artifacts.assign([{ task_id: 'task', artifact_id: 'artifact', section_id: 'section', work_id: session.source.work_id, plan_revision: 1, base_artifact_revision: 1, previous_owner: { work_id: ctx.producer.work_id, plan_revision: 1 } }])).toThrow('scoped proposals')
  ctx.commit(a)
  expect(ctx.completeness().state).toBe('partial')
  const result = ctx.commit(b)
  expect(ctx.chapters.manifest('task', 'view')!.chapters.map(chapter => [chapter.region_id, chapter.revision])).toEqual([['a', 2], ['b', 2]])
  expect(ctx.composition.currentArtifacts(ctx.inventory)).toEqual([result.index])
  expect(ctx.completeness().state).toBe('complete')
})

it.each(['failed', 'cancelled', 'interrupted'] as const)('keeps the necessary scope incomplete after an update is %s', state => {
  const ctx = setup(), session = ctx.begin()
  ctx.chapters.stage('task', session.update.update_id, state)
  expect(ctx.completeness()).toMatchObject({ state: 'partial', unresolved: [{ requirement_id: 'content' }] })
  expect(ctx.artifacts.artifact('task', 'artifact')!.artifact_revision).toBe(1)
  const status = new RunnerHostStatus(ctx.db, 'epoch').page({ task_id: 'task' })
  expect(status.scope).toMatchObject({ state: 'partial', pending_update_count: 1 })
})

it('reads a published assembly after its publisher Run loses execution authority', () => {
  const ctx = setup(), session = ctx.begin(), { index } = ctx.commit(session)
  ctx.db.prepare("UPDATE runs SET state='completed',commit_valid=0 WHERE id=?").run(session.publisher.run_id)
  ctx.work.reconcileDependencies('task')
  expect(ctx.composition.checkArtifact('task', index.artifact_id, index.artifact_revision)).toEqual(index)
  expect(ctx.completeness().state).toBe('complete')
  expect(() => ctx.work.qualify(session.publisher.attempt_id)).toThrow()
  const status = new RunnerHostStatus(ctx.db, 'epoch').page({ task_id: 'task' })
  expect(status.goals[0]).toMatchObject({ delivery: 'published', artifact_count: 1 })
  expect(status.scope).toMatchObject({ state: 'complete', pending_update_count: 0, published_count: 1 })
})

it('rechecks the settled publisher material dependencies for future consumers', () => {
  const ctx = setup(), { index } = ctx.commit(ctx.begin())
  ctx.db.prepare('DELETE FROM task_resources WHERE task_id=? AND resource_id=?').run('task', 'material')
  expect(() => ctx.composition.checkArtifact('task', index.artifact_id, index.artifact_revision)).toThrow('actual material dependency')
  expect(ctx.completeness().state).toBe('partial')
})

it('requires explicit inheritance for the entire retained contribution set', () => {
  const ctx = setup(), session = ctx.begin()
  expect(() => ctx.commit(session, () => { ctx.db.prepare("DELETE FROM runner_chapter_inheritance WHERE update_id=?").run(session.update.update_id) })).toThrow('enumerate every replacement')
  expect(ctx.artifacts.owner('task', 'artifact')!.current_revision).toBe(1)
  expect(ctx.chapters.manifest('task', 'view')!.manifest_revision).toBe(1)
  expect(ctx.chapters.update('task', session.update.update_id)!.state).toBe('assembling')
  expect(ctx.db.prepare("SELECT revision FROM views WHERE id='view'").get()).toEqual({ revision: 1 })
})

it('rejects an inherited chapter when its actual dependency changes', () => {
  const ctx = setup(), current = ctx.chapters.manifest('task', 'view')!
  current.chapters[1]!.dependencies = [{ kind: 'chapter', task_id: 'task', view_id: 'view', region_id: 'a', revision: 1 }]
  ctx.db.prepare('UPDATE runner_chapter_manifests SET payload_json=? WHERE task_id=? AND view_id=? AND manifest_revision=1').run(JSON.stringify(current), 'task', 'view')
  const session = ctx.begin(), { index } = ctx.commit(session)
  expect(() => ctx.composition.checkArtifact('task', 'artifact', index.artifact_revision)).toThrow('inherited contribution')
  expect(ctx.completeness().state).toBe('partial')
})

it('retains one immutable assembly receipt for repeated installation', () => {
  const ctx = setup(), session = ctx.begin(), { input, index } = ctx.commit(session)
  expect(ctx.db.transaction(() => ctx.artifacts.installChapterAssembly(input))()).toEqual(index)
  expect(ctx.db.prepare('SELECT COUNT(*) n FROM runner_chapter_assemblies').get()).toEqual({ n: 1 })
  expect(() => ctx.db.transaction(() => ctx.artifacts.installChapterAssembly({ ...input, published: { ...input.published, action_id: 'different' } }))()).toThrow('original binding')
  expect(() => ctx.db.transaction(() => ctx.artifacts.installChapterAssembly({ ...input, latestManifest: { ...input.latestManifest, bundle_resource_id: 'different' } }))()).toThrow('original binding')
  expect(() => ctx.db.transaction(() => ctx.artifacts.installChapterAssembly({ ...input, requirement_ids: ['unknown'] }))()).toThrow('original binding')
  expect(() => ctx.db.transaction(() => ctx.artifacts.installChapterAssembly({ ...input, update: { ...input.update, text: 'Different request' } }))()).toThrow('persisted update')
  expect(() => ctx.artifacts.installChapterAssembly(input)).toThrow('final Surface transaction')
})

it.each(['artifact', 'revision', 'coverage'] as const)('rejects inherited %s evidence from another accepted contribution', field => {
  const ctx = setup(), session = ctx.begin()
  expect(() => ctx.commit(session, () => {
    const keep = ctx.chapters.inheritance('task', session.update.update_id)[0]!
    if (field === 'artifact') keep.artifact_id = 'other-artifact'
    if (field === 'revision') keep.artifact_revision = 7
    if (field === 'coverage') keep.requirement_ids = ['unknown']
    ctx.db.prepare('UPDATE runner_chapter_inheritance SET payload_json=? WHERE task_id=? AND update_id=? AND region_id=?').run(JSON.stringify(keep), 'task', session.update.update_id, keep.region_id)
  })).toThrow('exact inherited chapter')
  expect(ctx.artifacts.artifact('task', 'artifact')).toEqual(ctx.original)
})

it.each(['publisher', 'surface-record', 'manifest', 'coverage'] as const)('rejects a forged %s and rolls back all final pointers', field => {
  const ctx = setup(), session = ctx.begin()
  expect(() => ctx.commit(session, input => {
    if (field === 'publisher') input.publisherOwner = session.source
    if (field === 'surface-record') input.published.surface_record_id = 'record'
    if (field === 'manifest') input.latestManifest = { ...input.latestManifest, manifest_revision: 9 }
    if (field === 'coverage') input.requirement_ids = ['unknown']
  })).toThrow()
  expect(ctx.artifacts.artifact('task', 'artifact')).toEqual(ctx.original)
  expect(ctx.publications.mapping('task', 'artifact')!.artifact_revision).toBe(1)
  expect(ctx.db.prepare('SELECT COUNT(*) n FROM runner_chapter_assemblies').get()).toEqual({ n: 0 })
})

it('returns exact historical and current publication sources without inventing a batch', () => {
  const ctx = setup(), { index } = ctx.commit(ctx.begin())
  expect(ctx.publications.mapping('task', 'artifact', 1)).toMatchObject({ batch_id: 'initial-batch', artifact_revision: 1 })
  const current = ctx.publications.mapping('task', 'artifact')!
  expect(current).toMatchObject({ chapter_update_id: 'a-update', chapter_operation_id: 'publication-a-update', artifact_revision: index.artifact_revision })
  expect(current).not.toHaveProperty('batch_id')
  expect(ctx.publications.history('task', current.surface_history_id)).toMatchObject({ surface_revision: 2, views: [{ view_id: 'view', view_revision: 2 }] })
})

it('uses the current chapter assembly in later composition and never reloads the old Bundle', () => {
  const ctx = setup(), session = ctx.begin(), { index } = ctx.commit(session)
  ctx.db.prepare("UPDATE runs SET state='completed',commit_valid=0 WHERE id=?").run(session.publisher.run_id)
  ctx.work.reconcileDependencies('task')
  const host = new RunnerHostComposition(ctx.db, ctx.work, ctx.artifacts, ctx.composition)
  const lease: ModelLease = { id: 'model', revision: 1, config: { id: 'model', base_url: 'https://example.invalid/v1', wire_model_id: 'synthetic', context_tokens: 1000000, max_output_tokens: 1024, compatibility_profile: 'chat-max-tokens' }, release() {} }
  ctx.db.prepare('UPDATE requests SET config_selection_json=? WHERE id=?').run(JSON.stringify({ id: lease.id, revision: lease.revision, approval_mode: 'manual' }), 'goal')
  expect(ctx.composition.pageIndexes('task', 1).items).toEqual([index])
  expect(() => ctx.composition.checkBatch('task', 'initial-batch')).toThrow('current accepted contribution')
  expect(() => host.prepare('task', 'goal', lease)).toThrow('No new accepted fragment')
  const prepared = host.prepare('task', 'goal', lease, { artifact_ids: ['artifact'] })
  expect(prepared.batch.indexes).toEqual([{ task_id: 'task', artifact_id: 'artifact', artifact_revision: 2 }])
  const compiled = host.publication('task', prepared.batch.batch_id, prepared.collator.rulePlan(), { viewReplacement: true }, () => { throw Error('A placement must preserve the current published Bundle') })
  expect(compiled.request.input.operations.map(operation => operation.type)).toEqual(['layout.set'])
  expect(ctx.db.prepare("SELECT revision,bundle_resource_id FROM views WHERE id='view'").get()).toEqual({ revision: 2, bundle_resource_id: 'published-a-update' })
})

const replacementGroups = [
  { name: 'split', previous: ['a'], next: ['one', 'two'], complete: ['one', 'two', 'b'], kept: ['b'] },
  { name: 'merge', previous: ['a', 'b'], next: ['combined'], complete: ['combined'], kept: [] }
]

it.each(replacementGroups)('persists every chapter, pointer and source for an explicit $name', group => {
  const ctx = setup(), session = ctx.begin(`${group.name}-update`, group.previous, group.next), { index } = ctx.commit(session)
  const manifest = ctx.chapters.manifest('task', 'view')!, entry = ctx.publications.mapping('task', 'artifact')!
  expect(manifest).toMatchObject({ manifest_revision: 2, artifact_revision: 2, view_revision: 2, state_revision: 2, bundle_resource_id: index.bundle_resource_id })
  expect(manifest.chapters.map(chapter => chapter.region_id)).toEqual(group.complete)
  expect(ctx.chapters.inheritance('task', session.update.update_id).map(item => item.region_id)).toEqual(group.kept)
  expect(ctx.chapters.proposal('task', session.proposal.proposal_id)!.replacements).toEqual([{ previous_region_ids: group.previous, chapters: session.proposal.replacements[0]!.chapters }])
  const body = ctx.bundles.get(index.bundle_resource_id)!.html
  for (const chapter of group.next) expect(body).toContain(`Generated ${chapter}`)
  for (const chapter of group.previous) expect(body).not.toContain(`id="${chapter}-body"`)
  if (group.kept.includes('b')) expect(body).toContain('<h2 id="b-title">B</h2><div id="b-body">Old B</div>')
  expect(entry).toMatchObject({ chapter_update_id: session.update.update_id, artifact_revision: 2, view_revision: 2, state_revision: 2, published_bundle_resource_id: index.bundle_resource_id })
  expect(ctx.completeness().state).toBe('complete')
  expect(ctx.chapters.manifest('task', 'view', 1)!.chapters.map(chapter => chapter.region_id)).toEqual(['a', 'b'])
  expect(ctx.artifacts.artifact('task', 'artifact', 1)).toEqual(ctx.original)
  expect(ctx.db.pragma('foreign_key_check')).toEqual([])
})

it.each(replacementGroups)('rolls back the entire $name when final history persistence fails', group => {
  const ctx = setup(), session = ctx.begin(`${group.name}-update`, group.previous, group.next)
  ctx.db.exec("CREATE TEMP TRIGGER reject_final_history BEFORE INSERT ON runner_surface_history BEGIN SELECT RAISE(ABORT,'injected_history_failure'); END")
  expect(() => ctx.commit(session)).toThrow('injected_history_failure')
  expect(ctx.artifacts.artifact('task', 'artifact')).toEqual(ctx.original)
  expect(ctx.chapters.manifest('task', 'view')!.chapters.map(chapter => chapter.region_id)).toEqual(['a', 'b'])
  expect(ctx.chapters.update('task', session.update.update_id)).toMatchObject({ state: 'assembling' })
  expect(ctx.work.attempt(session.publisher.attempt_id).state).toBe('running')
  expect(ctx.db.prepare("SELECT revision,state_revision,bundle_resource_id FROM views WHERE id='view'").get()).toEqual({ revision: 1, state_revision: 1, bundle_resource_id: 'original' })
  expect(ctx.db.prepare("SELECT revision FROM surfaces WHERE id='surface'").get()).toEqual({ revision: 1 })
  for (const table of ['runner_artifacts', 'runner_candidates', 'runner_chapter_manifests', 'view_history', 'runner_surface_history']) expect(ctx.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).toEqual({ n: 1 })
  for (const table of ['runner_chapter_assemblies', 'runner_chapter_inheritance', 'runner_chapter_publications']) expect(ctx.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).toEqual({ n: 0 })
  expect(ctx.db.prepare('SELECT id FROM resources WHERE id=?').get(`published-${session.update.update_id}`)).toBeUndefined()
  expect(ctx.db.prepare('SELECT id FROM records WHERE id=?').get(`record-publication-${session.update.update_id}`)).toBeUndefined()
  expect(ctx.publications.mapping('task', 'artifact')!.artifact_revision).toBe(1)
  expect(ctx.db.pragma('foreign_key_check')).toEqual([])
})

it('keeps all published pointers unchanged when full Bundle capacity rejects the assembly', () => {
  const ctx = setup(), session = ctx.begin(), original = ctx.bundles.get('original')!, candidate = ctx.bundles.get(session.proposal.bundle_resource_id)!
  const half = defaults.surface.inline_bundle_bytes / 2 + 1024
  original.html = original.html.replace('Old B', 'b'.repeat(half))
  candidate.html = candidate.html.replace('Generated a', 'a'.repeat(half))
  for (const [id, bundle] of [['original', original], [session.proposal.bundle_resource_id, candidate]] as const) ctx.db.prepare('UPDATE resources SET byte_length=? WHERE id=?').run(Buffer.byteLength(JSON.stringify(bundle)), id)
  expect(Buffer.byteLength(JSON.stringify(original))).toBeLessThan(defaults.surface.inline_bundle_bytes)
  expect(Buffer.byteLength(JSON.stringify(candidate))).toBeLessThan(defaults.surface.inline_bundle_bytes)
  expect(() => ctx.commit(session)).toThrow(expect.objectContaining({ code: 'BUNDLE_SIZE_LIMIT' }))
  expect(ctx.artifacts.artifact('task', 'artifact')).toEqual(ctx.original)
  expect(ctx.chapters.manifest('task', 'view')!.manifest_revision).toBe(1)
  expect(ctx.publications.mapping('task', 'artifact')!.artifact_revision).toBe(1)
  expect(ctx.db.prepare("SELECT revision,bundle_resource_id FROM views WHERE id='view'").get()).toEqual({ revision: 1, bundle_resource_id: 'original' })
  expect(ctx.db.prepare('SELECT COUNT(*) n FROM runner_chapter_assemblies').get()).toEqual({ n: 0 })
})
