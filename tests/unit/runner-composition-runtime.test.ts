import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import type { ArtifactCandidate, Bundle, ExecutionAttempt, InputEvent, LogicalWork, ModelConfiguration, WorkOutputDeclaration } from '../../src/shared/contracts.generated'
import { ModelService, type ModelLease } from '../../src/runtime/model/service'
import { RuntimeStore } from '../../src/runtime/store'
import { RunnerWorkState } from '../../src/runtime/runner/work-state'
import { RunnerArtifactState } from '../../src/runtime/runner/artifact-state'
import { RunnerCompositionState } from '../../src/runtime/runner/composition-state'
import { RunnerBudgetLedger } from '../../src/runtime/runner/budget'
import { RunnerHostRecovery } from '../../src/runtime/runner/host-recovery'
import { RunnerHostComposition } from '../../src/runtime/runner/host-composition'
import { liveRunnerFlow } from '../../src/runtime/runner/live-flow'
import { conversationDependencyResult } from '../../src/runtime/runner/conversation-query'
import type { LiveFlowSnapshot } from '../../src/shared/types'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.restoreAllMocks() })
function bundle(title = 'Original', compatibility = 'form-v1'): Bundle {
  return { profile: 'managed-v1', html: `<section><h2>${title}</h2><textarea id="answer"></textarea></section>`, css: '', state: { schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false }, initial: { answer: '' }, compatibility_version: compatibility }, forms: [], behaviors: [{ type: 'input', element_id: 'answer', field: '/answer', control: 'textarea' }], references: [], export: [] }
}
function setup(enabled = true) {
  const directory = mkdtempSync(join(tmpdir(), 'pliuna-composition-runtime-')), models = new ModelService()
  const config: ModelConfiguration = { id: 'model', base_url: 'https://example.invalid/v1', wire_model_id: 'synthetic', context_tokens: 1000000, max_output_tokens: 1024, compatibility_profile: 'chat-max-tokens' }
  const releases: ReturnType<typeof vi.fn>[] = []
  vi.spyOn(models, 'acquire').mockImplementation((id): ModelLease => { const release = vi.fn(); releases.push(release); return { id, revision: 1, config: { ...config, id }, release } })
  vi.spyOn(models, 'acquireCompaction').mockReturnValue(undefined)
  const store = new RuntimeStore(directory, models, { viewReplacement: enabled })
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  const internal = store as unknown as { db: Database.Database; epoch: string; record(task: string, kind: string, payload: unknown): string; pumpRunnerWorkers(task: string): void; aggregateWorkerRun(task: string, run: string): void; executeAutomaticComposition(task: string, trigger: string, previousBatchId?: string): Promise<void> }
  const { db, epoch } = internal, task = store.create('Composition').task.id
  const state = new RunnerWorkState(db, epoch), artifacts = new RunnerArtifactState(db, state), composition = new RunnerCompositionState(db, state, artifacts)
  const records = (kind: string) => db.prepare('SELECT * FROM records WHERE task_id=? AND kind=?').all(task, kind)
  function source(name = 'goal', contents = bundle(), sealed = true, completed = true, configId = 'model', fragments = 1) {
    const run = `run-${name}`, workId = `work-${name}`, attemptId = `attempt-${name}`, artifactId = `artifact-${name}`
    db.prepare("INSERT INTO requests(id,task_id,state,config_selection_json,input_json,created_at) VALUES (?,?,'started',?,?,?)").run(name, task, JSON.stringify({ id: configId, revision: 1, approval_mode: 'manual' }), JSON.stringify({ text: `Explicit request ${name}` }), 'time')
    const inputRecord = internal.record(task, 'message.user', { text: name })
    state.receive({ input_event_id: `input-${name}`, task_id: task, kind: 'request', record_id: inputRecord, request_id: name, stage: 'received' })
    state.installGoal({ task_id: task, request_id: name, input_event_id: `input-${name}`, intent_revision: 1, state: 'active', requirements: [{ requirement_id: 'content', kind: 'artifact', required: true, provenance_required: true }] })
    new RunnerBudgetLedger(db).create({ budget_id: `budget-${name}`, task_id: task, purpose: 'production', request_id: name, limits: { model_requests: 20, tool_requests: 100, tokens: 100000, wall_ms: 60000 } })
    db.prepare("INSERT INTO runs(id,task_id,request_id,state,runtime_epoch,limits_json,budget_json,created_at) VALUES (?,?,?,'running',?,'{}','{}','time')").run(run, task, name, epoch)
    state.registerRun({ run_id: run, task_id: task, runtime_epoch: epoch, state: 'running', commit_valid: true, budget_id: `budget-${name}`, purpose: 'production', request_id: name, intent_revision: 1 })
    const work: LogicalWork = { work_id: workId, task_id: task, run_id: run, plan_revision: 1, role: 'producer', required: true, requirement_ids: ['content'], dependencies: [{ kind: 'goal', task_id: task, request_id: name, intent_revision: 1 }], state: 'planned', max_attempts: 2, purpose: 'production', request_id: name, intent_revision: 1 }
    state.installPlan([work])
    const attempt: ExecutionAttempt = { attempt_id: attemptId, work_id: workId, task_id: task, run_id: run, runtime_epoch: epoch, attempt_number: 1, profile_id: 'producer', model_config_id: configId, model_config_revision: 1, input_versions: work.dependencies, state: 'registered', dispatch_state: 'not_dispatched', usage_refs: [], purpose: 'production', request_id: name, intent_revision: 1 }
    state.createAttempt(attempt); state.updateAttempt({ ...attempt, state: 'dispatched', dispatch_state: 'dispatched', operation_id: `operation-${name}` })
    state.updateAttempt({ ...state.attempt(attemptId), state: 'running' })
    const priorOutline = artifacts.outline(task)
    artifacts.installOutline({ task_id: task, outline_revision: (priorOutline?.outline_revision ?? 0) + 1, base_outline_revision: priorOutline?.outline_revision ?? 0, sections: [...(priorOutline?.sections ?? []), { section_id: `section-${name}`, request_id: name, intent_revision: 1, order_key: name, position_revision: 1 }] })
    artifacts.assign([{ task_id: task, artifact_id: artifactId, work_id: workId, plan_revision: 1, section_id: `section-${name}`, base_artifact_revision: 0 }])
    const resource = (next: Bundle) => (store.modelTool(task, run, { type: 'write', input: { type: 'resource.create', display_name: 'Accepted bundle', content: { type: 'json', value: next } } }) as { data: { id: string } }).data.id
    const resourceId = resource(contents)
    const candidate: ArtifactCandidate = { candidate_id: `candidate-${name}`, task_id: task, request_id: name, intent_revision: 1, run_id: run, work_id: workId, attempt_id: attemptId, artifact_id: artifactId, base_artifact_revision: 0, plan_revision: 1, bundle_resource_id: resourceId, section_id: `section-${name}`, section_position_revision: 1, order_key: name, presentation_kind: 'managed-v1', width_constraint: 'full', interaction_kind: 'input', provenance_ref: { task_id: task, kind: 'record', id: inputRecord }, requirement_ids: ['content'], unresolved: [], dependencies: work.dependencies }
    const accepted = artifacts.decide(candidate, { state: 'accepted' })
    if (accepted.state !== 'accepted') throw Error(accepted.code)
    const indexes = [accepted.index]
    for (let n = 1; n < fragments; n++) {
      const fragmentId = `${artifactId}-${n}`
      artifacts.assign([{ task_id: task, artifact_id: fragmentId, work_id: workId, plan_revision: 1, section_id: `section-${name}`, base_artifact_revision: 0 }])
      const result = artifacts.decide({ ...candidate, candidate_id: `candidate-${name}-${n}`, artifact_id: fragmentId }, { state: 'accepted' })
      if (result.state !== 'accepted') throw Error(result.code)
      indexes.push(result.index)
    }
    composition.designateSource({ task_id: task, request_id: name, intent_revision: 1, work_id: workId, plan_revision: 1 })
    function finishSource() {
      const resultRef = { task_id: task, kind: 'record' as const, id: internal.record(task, 'worker.result', { name }) }
      state.updateAttempt({ ...state.attempt(attemptId), state: 'succeeded', result_ref: resultRef })
      const output: WorkOutputDeclaration = { task_id: task, request_id: name, intent_revision: 1, run_id: run, work_id: workId, attempt_id: attemptId, plan_revision: 1, result_revision: state.work(workId).result_revision!, complete: true, result_ref: resultRef, artifacts: indexes.map(index => ({ task_id: task, artifact_id: index.artifact_id, artifact_revision: index.artifact_revision })), requirement_ids: ['content'], unresolved: [] }
      composition.declareOutputs(output)
      composition.sealInventory({ task_id: task, request_id: name, intent_revision: 1, inventory_revision: 1, sealed_by: { run_id: run, work_id: workId, attempt_id: attemptId, plan_revision: 1, role: 'producer' }, required_works: [output], requirement_ids: ['content'], unresolved: [] })
    }
    if (sealed) finishSource()
    if (completed) db.prepare("UPDATE runs SET state='completed',commit_valid=0 WHERE id=?").run(run)
    return { run, workId, attemptId, artifactId, resourceId, candidate, index: accepted.index, indexes, resource, finishSource }
  }
  let nextInput = 0
  function input(kind: InputEvent['kind'], target: Partial<InputEvent>) {
    const event: InputEvent = { input_event_id: `host-input-${++nextInput}`, task_id: task, kind, record_id: internal.record(task, 'message.user', { text: kind }), stage: 'received', ...target }
    store.receiveRunnerInput(event)
    return store.advanceRunnerInput(event.input_event_id)
  }
  return { store, models, db, epoch, task, state, artifacts, composition, source, records, releases, input, pump: () => internal.pumpRunnerWorkers(task), aggregate: (run: string) => internal.aggregateWorkerRun(task, run), automatic: (trigger: string, previousBatchId?: string) => internal.executeAutomaticComposition(task, trigger, previousBatchId) }
}
async function tick() { for (let n = 0; n < 16; n++) await Promise.resolve() }
async function approveAndConfirm(s: ReturnType<typeof setup>, actionId?: string) {
  await tick()
  const approval = s.store.snapshot(s.task).approvals.find(item => actionId ? item.action_id === actionId : item.decision === 'pending' && item.validity === 'valid')!
  s.store.handle({ type: 'approval.decide', task_id: s.task, approval_id: approval.id, decision: 'approve' })
  await tick()
  const pending = s.store.snapshot(s.task).surface_updates.find(item => item.action_id === approval.action_id)!
  try { await s.store.handle({ type: 'surface.respond', task_id: s.task, action_id: pending.action_id, proceed: true, confirm_discard: false }) }
  catch { throw Error((s.db.prepare('SELECT result_json FROM actions WHERE id=?').get(pending.action_id) as { result_json: string }).result_json) }
}

it('attributes one shared approval only to the messages that contributed to its batch', async () => {
  const s = setup(), first = s.source('alpha'), second = s.source('beta')
  s.source('trigger')
  const live = () => s.store.handle({ type: 'host.runner.flow', task_id: s.task }) as LiveFlowSnapshot
  expect(Object.values(live().lanes).every(lane => lane.total === 0)).toBe(true)
  const prepared = s.store.prepareRunnerComposition(s.task, 'trigger', { artifact_ids: [first.artifactId, second.artifactId] })
  const batchId = `batch:${prepared.batch.batch_id}`
  expect(live().lanes.Collator.items).toMatchObject([{ id: batchId, state: 'queued',
    sources: [{ run_id: first.run }, { run_id: second.run }], handoff: { from: 'Worker', kind: 'indexes' } }])
  const publishing = s.store.publishRunnerComposition(s.task, prepared.batch.batch_id, prepared.collator.rulePlan())
  await tick()
  const pending = s.store.snapshot(s.task).approvals.filter(item => item.decision === 'pending')
  const originals = ['alpha', 'beta'].map(request => s.state.input(`input-${request}`).record_id)
  expect(pending).toEqual([expect.objectContaining({ action_id: prepared.batch.action_id, run_id: prepared.run_id, message_ids: originals })])
  expect(live().lanes.Host.items).toMatchObject([{ id: batchId, state: 'approval', approval_id: pending[0]?.id,
    handoff: { from: 'Collator', kind: 'plan' } }])
  expect(live().lanes.Collator.total).toBe(0)
  expect(JSON.stringify(live())).not.toContain('proposed_surface')
  await approveAndConfirm(s, prepared.batch.action_id)
  expect((await publishing).state).toBe('published')
  expect(Object.values(live().lanes).every(lane => lane.total === 0)).toBe(true)
  expect(() => s.store.handle({ type: 'approval.decide', task_id: s.task, approval_id: pending[0]!.id, decision: 'approve' })).toThrow(expect.objectContaining({ code: 'APPROVAL_INVALID' }))
  expect(s.records('approval.decided')).toHaveLength(1)
})

it('publishes after production ended through an independent rule Run and returns the original operation', async () => {
  const s = setup(), source = s.source(), prepared = s.store.prepareRunnerComposition(s.task, 'goal')
  expect(s.state.run(source.run)).toMatchObject({ state: 'completed', commit_valid: false })
  expect(s.state.run(prepared.run_id)).toMatchObject({ purpose: 'composition', commit_valid: true })
  const publishing = s.store.publishRunnerComposition(s.task, prepared.batch.batch_id, prepared.collator.rulePlan())
  await approveAndConfirm(s, prepared.batch.action_id)
  const result = await publishing
  expect(result.state).toBe('published')
  expect(s.store.runnerPublicationOperation(s.task, prepared.batch.operation_id!)?.result).toEqual(result)
  const snapshot = s.store.snapshot(s.task), view = snapshot.views[0]!
  const mapping = JSON.parse((s.db.prepare('SELECT payload_json FROM runner_view_mappings WHERE task_id=? AND artifact_id=?').get(s.task, source.artifactId) as { payload_json: string }).payload_json)
  const publishedResource = (s.db.prepare('SELECT bundle_resource_id FROM views WHERE id=?').get(view.id) as { bundle_resource_id: string }).bundle_resource_id
  expect(mapping).toMatchObject({ source_bundle_resource_id: source.resourceId, published_bundle_resource_id: publishedResource, view_id: view.id, view_revision: 1, state_revision: 1 })
  expect(mapping.published_bundle_resource_id).not.toBe(source.resourceId)
  expect((s.db.prepare('SELECT state FROM runs WHERE id=?').get(prepared.run_id) as { state: string }).state).toBe('completed')
  expect(s.composition.scope(s.task)).toMatchObject({ state: 'complete' })
  expect(await s.store.publishRunnerComposition(s.task, prepared.batch.batch_id, prepared.collator.rulePlan())).toEqual(result)
  expect(s.store.snapshot(s.task).views).toHaveLength(1)
  expect(s.records('surface.published')).toHaveLength(1)
})

it.each(['cleanup', 'usage'] as const)('publishes settled contributions while preserving source %s evidence without restoring its commit permission', async blocker => {
  const s = setup(), source = s.source('goal', bundle(), true, false), ledger = new RunnerBudgetLedger(s.db)
  if (blocker === 'cleanup') {
    const action = s.db.prepare("SELECT id FROM actions WHERE run_id=? AND result='success'").get(source.run) as { id: string }
    s.db.prepare("INSERT INTO cleanup_jobs(id,task_id,owner_kind,owner_id,necessary,state,detail_json) VALUES ('source-cleanup',?,'action',?,1,'pending','{}')").run(s.task, action.id)
  } else {
    ledger.reserve('source-usage', s.state.run(source.run).budget_id, 'source-model-operation', { model_requests: 1, tokens: 1 }, source.attemptId)
    ledger.markDispatched('source-usage')
    ledger.markUnknown('source-usage')
  }
  s.aggregate(source.run)
  const closing = () => s.db.prepare('SELECT state,commit_valid,intended_terminal,wait_reason FROM runs WHERE id=?').get(source.run)
  const sourceState = blocker === 'cleanup' ? 'closing' : 'completed'
  const coreState = { state: blocker === 'cleanup' ? 'waiting' : 'completed', commit_valid: 0, intended_terminal: 'completed', wait_reason: blocker === 'cleanup' ? 'ending_cleanup' : null }
  expect(closing()).toEqual(coreState)
  expect(s.state.run(source.run)).toMatchObject({ state: sourceState, commit_valid: false })
  expect(() => s.state.qualify(source.attemptId)).toThrow(expect.objectContaining({ code: 'RUNNER_OWNERSHIP_INVALID' }))
  const prepared = s.store.prepareRunnerComposition(s.task, 'goal')
  expect(prepared.batch.indexes).toEqual([{ task_id: s.task, artifact_id: source.artifactId, artifact_revision: 1 }])
  expect(s.composition.checkInventory(s.task, 'goal', 1, 1).required_works[0]?.work_id).toBe(source.workId)
  const publishing = s.store.publishRunnerComposition(s.task, prepared.batch.batch_id, prepared.collator.rulePlan())
  await approveAndConfirm(s, prepared.batch.action_id)
  expect((await publishing).state).toBe('published')
  expect(s.store.snapshot(s.task).views).toHaveLength(1)
  expect(s.composition.scope(s.task)).toMatchObject({ state: 'complete' })
  expect(closing()).toEqual(coreState)
  expect(s.state.run(source.run)).toMatchObject({ state: sourceState, commit_valid: false })
  if (blocker === 'cleanup') expect(s.db.prepare("SELECT state FROM cleanup_jobs WHERE id='source-cleanup'").get()).toEqual({ state: 'pending' })
  else expect(ledger.query('source-usage')).toMatchObject({ state: 'unknown', dispatched_at: expect.any(String), usage: null })
})

it.each(['cancel_run', 'correction'] as const)('rejects a settled closing source after %s before publication', kind => {
  const s = setup(), source = s.source('goal', bundle(), true, false)
  const action = s.db.prepare("SELECT id FROM actions WHERE run_id=? AND result='success'").get(source.run) as { id: string }
  s.db.prepare("INSERT INTO cleanup_jobs(id,task_id,owner_kind,owner_id,necessary,state,detail_json) VALUES ('source-cleanup',?,'action',?,1,'pending','{}')").run(s.task, action.id)
  s.aggregate(source.run)
  expect(s.state.run(source.run)).toMatchObject({ state: 'closing', commit_valid: false })
  const prepared = s.store.prepareRunnerComposition(s.task, 'goal')
  s.input(kind, kind === 'cancel_run' ? { run_id: source.run } : { request_id: 'goal' })
  expect(() => s.composition.checkBatch(s.task, prepared.batch.batch_id)).toThrow()
  expect(() => s.composition.checkInventory(s.task, 'goal', 1, 1)).toThrow()
  expect(() => s.state.qualify(source.attemptId)).toThrow(expect.objectContaining({ code: 'RUNNER_OWNERSHIP_INVALID' }))
  expect(s.artifacts.artifact(s.task, source.artifactId)).toEqual(source.index)
  expect(s.db.prepare('SELECT operation_id FROM runner_publications WHERE batch_id=?').all(prepared.batch.batch_id)).toEqual([])
  expect(s.store.snapshot(s.task).views).toEqual([])
})

it('publishes an independent goal automatically while retaining a cancelled unpublished contribution', async () => {
  const s = setup(), alpha = s.source('alpha', bundle('Cancelled content'), false, false)
  s.input('cancel_run', { run_id: alpha.run })
  expect(s.state.run(alpha.run)).toMatchObject({ state: 'cancelled', commit_valid: false })
  expect(() => s.store.prepareRunnerComposition(s.task, 'alpha')).toThrow(expect.objectContaining({ code: 'COMPOSITION_NOT_READY' }))
  expect(() => s.store.prepareRunnerComposition(s.task, 'alpha', { artifact_ids: [alpha.artifactId] })).toThrow(expect.objectContaining({ code: 'RUNNER_DEPENDENCY_INVALID' }))

  const beta = s.source('beta', bundle('Independent content')), publishing = s.automatic('beta')
  await approveAndConfirm(s)
  await publishing
  const snapshot = s.store.snapshot(s.task), scope = s.composition.scope(s.task)!
  expect(snapshot.views).toHaveLength(1)
  expect(scope.state).toBe('working')
  expect(scope.targets.map(target => target.request_id)).toEqual(['alpha', 'beta'])
  expect(scope.unresolved).toContainEqual({ task_id: s.task, request_id: 'alpha', intent_revision: 1, requirement_id: 'content' })
  expect(s.artifacts.artifact(s.task, alpha.artifactId)).toEqual(alpha.index)
  expect(s.db.prepare('SELECT artifact_id FROM runner_view_mappings WHERE task_id=?').all(s.task)).toEqual([{ artifact_id: beta.artifactId }])
  const manifest = JSON.parse((s.db.prepare('SELECT payload_json FROM runner_manifests ORDER BY rowid DESC LIMIT 1').get() as { payload_json: string }).payload_json)
  expect(manifest.state).toBe('partial')
  expect(manifest.contributions.map((entry: { artifact_id: string }) => entry.artifact_id)).toEqual([beta.artifactId])
  expect(conversationDependencyResult(s.db, s.task, s.state.input('input-beta').record_id, 'beta')).toMatchObject({ publication: { manifest_id: manifest.manifest_id } })
  expect(conversationDependencyResult(s.db, s.task, s.state.input('input-alpha').record_id, 'alpha')).toBeNull()
})

it('keeps an unsealed required contribution partial while publishing its accepted first piece', async () => {
  const s = setup(); s.source('goal', bundle(), false, false)
  const prepared = s.store.prepareRunnerComposition(s.task, 'goal')
  const publishing = s.store.publishRunnerComposition(s.task, prepared.batch.batch_id, prepared.collator.rulePlan())
  await approveAndConfirm(s)
  expect((await publishing).state).toBe('published')
  const manifest = JSON.parse((s.db.prepare('SELECT payload_json FROM runner_manifests').get() as { payload_json: string }).payload_json)
  expect(manifest).toMatchObject({ state: 'partial', unresolved: [{ request_id: 'goal', requirement_id: 'content' }] })
  expect(s.composition.scope(s.task)?.state).toBe('working')
})

it('blocks cross-configuration indexes without sending them to another model', () => {
  const s = setup(); s.source('alpha'); const beta = s.source('beta', bundle(), true, true, 'other-model')
  expect(() => s.store.prepareRunnerComposition(s.task, 'alpha')).toThrow(expect.objectContaining({ code: 'COMPOSITION_INPUT_CONFIRMATION_REQUIRED' }))
  expect(s.artifacts.artifact(s.task, beta.artifactId)).toEqual(beta.index)
  expect(s.db.prepare('SELECT operation_id FROM runner_publications').all()).toEqual([])
  expect(s.records('runner.composition.blocked')).toHaveLength(1)
})

it('keeps a disabled presentation capability as a delivery obstruction', async () => {
  const s = setup(false), source = s.source(), prepared = s.store.prepareRunnerComposition(s.task, 'goal')
  const result = await s.store.publishRunnerComposition(s.task, prepared.batch.batch_id, prepared.collator.rulePlan())
  expect(result).toMatchObject({ state: 'failure', code: 'CAPABILITY_DISABLED' })
  expect(s.store.snapshot(s.task).views).toEqual([])
  expect(s.artifacts.artifact(s.task, source.artifactId)).toEqual(source.index)
  expect(s.store.runnerPublicationOperation(s.task, prepared.batch.operation_id!)?.result).toEqual(result)
  expect(s.store.runnerGoals({ task_id: s.task }).goals.find(goal => goal.request_id === 'goal')?.waits).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'CAPABILITY_DISABLED', batch_id: prepared.batch.batch_id, operation_id: prepared.batch.operation_id, run_id: prepared.run_id })]))
})

it('rejects an old prepared draft and preserves current input when a bounded rebuild publishes', async () => {
  const s = setup(), source = s.source('goal', bundle(), false, false)
  const first = s.store.prepareRunnerComposition(s.task, 'goal')
  const initialPublication = s.store.publishRunnerComposition(s.task, first.batch.batch_id, first.collator.rulePlan())
  await approveAndConfirm(s); expect((await initialPublication).state).toBe('published')
  const originalView = s.store.snapshot(s.task).views[0]!
  const nextResource = source.resource(bundle('Updated'))
  const accepted = s.artifacts.decide({ ...source.candidate, candidate_id: 'updated-candidate', base_artifact_revision: 1, bundle_resource_id: nextResource }, { state: 'accepted' })
  expect(accepted.state).toBe('accepted')
  const second = s.store.prepareRunnerComposition(s.task, 'goal')
  const stale = s.store.publishRunnerComposition(s.task, second.batch.batch_id, second.collator.rulePlan())
  await tick()
  s.store.handle({ type: 'draft.save', task_id: s.task, view_id: originalView.id, view_revision: originalView.revision, expected_state_revision: originalView.state_revision, fields: [{ path: '/answer', value: 'New user input' }] })
  const approval = s.store.snapshot(s.task).approvals.find(item => item.action_id === second.batch.action_id)!
  s.store.handle({ type: 'approval.decide', task_id: s.task, approval_id: approval.id, decision: 'approve' })
  expect(await stale).toMatchObject({ state: 'failure', code: 'VERSION_CONFLICT' })
  expect(s.store.snapshot(s.task).views[0]).toMatchObject({ id: originalView.id, revision: 1, state_revision: 2, draft: { answer: 'New user input' } })
  const rebuilt = s.store.prepareRunnerComposition(s.task, 'goal', { previous_batch_id: second.batch.batch_id })
  expect(s.state.run(rebuilt.run_id).budget_id).toBe(s.state.run(second.run_id).budget_id)
  const publishing = s.store.publishRunnerComposition(s.task, rebuilt.batch.batch_id, rebuilt.collator.rulePlan())
  await approveAndConfirm(s)
  expect((await publishing).state).toBe('published')
  expect(s.store.snapshot(s.task).views[0]).toMatchObject({ id: originalView.id, revision: 2, state_revision: 3, draft: { answer: 'New user input' } })
})

it('rebuilds in the grown scope with the original budget without losing either View', async () => {
  const s = setup(), alpha = s.source('alpha')
  const a = s.store.prepareRunnerComposition(s.task, 'alpha', { artifact_ids: [alpha.artifactId] })
  const waiting = s.store.publishRunnerComposition(s.task, a.batch.batch_id, a.collator.rulePlan())
  const budgetId = s.state.run(a.run_id).budget_id, beta = s.source('beta')
  const b = s.store.prepareRunnerComposition(s.task, 'beta', { artifact_ids: [beta.artifactId] })
  expect(b.batch.composition_version).toBeGreaterThan(a.batch.composition_version)
  const current = s.store.publishRunnerComposition(s.task, b.batch.batch_id, b.collator.rulePlan())
  await approveAndConfirm(s, b.batch.action_id)
  expect((await current).state).toBe('published')
  const approval = s.store.snapshot(s.task).approvals.find(item => item.action_id === a.batch.action_id)!
  s.store.handle({ type: 'approval.decide', task_id: s.task, approval_id: approval.id, decision: 'approve' })
  expect(await waiting).toMatchObject({ state: 'failure', code: 'VERSION_CONFLICT' })
  const oldView = s.store.snapshot(s.task).views[0]!
  const next = s.store.prepareRunnerComposition(s.task, 'alpha', { previous_batch_id: a.batch.batch_id })
  expect(next.batch).toMatchObject({ previous_batch_id: a.batch.batch_id, composition_version: b.batch.composition_version, indexes: a.batch.indexes })
  expect(s.state.run(next.run_id).budget_id).toBe(budgetId)
  const publishing = s.store.publishRunnerComposition(s.task, next.batch.batch_id, next.collator.rulePlan())
  await approveAndConfirm(s, next.batch.action_id)
  expect((await publishing).state).toBe('published')
  expect(s.store.snapshot(s.task).views.find(view => view.id === oldView.id)).toEqual(oldView)
  expect(s.store.snapshot(s.task).views).toHaveLength(2)
  const manifest = JSON.parse((s.db.prepare('SELECT payload_json FROM runner_manifests ORDER BY rowid DESC LIMIT 1').get() as { payload_json: string }).payload_json)
  expect(manifest.state).toBe('complete')
  expect(manifest.composition_version).toBe(next.batch.composition_version)
  expect(s.composition.scope(s.task)).toMatchObject({ composition_version: next.batch.composition_version, state: 'complete' })
  expect(manifest.contributions.map((entry: { artifact_id: string }) => entry.artifact_id).sort()).toEqual([alpha.artifactId, beta.artifactId])
})

it.each(['cleanup', 'usage-unknown', 'legacy-budget-exceeded'] as const)('rebuilds a conflicted composition after real cleanup while preserving %s evidence', async blocker => {
  const s = setup(), alpha = s.source('alpha'), beta = s.source('beta'), ledger = new RunnerBudgetLedger(s.db)
  const original = s.store.prepareRunnerComposition(s.task, 'alpha', { artifact_ids: [alpha.artifactId] })
  const other = s.store.prepareRunnerComposition(s.task, 'beta', { artifact_ids: [beta.artifactId] })
  const stale = s.store.publishRunnerComposition(s.task, original.batch.batch_id, original.collator.rulePlan())
  const current = s.store.publishRunnerComposition(s.task, other.batch.batch_id, other.collator.rulePlan())
  await approveAndConfirm(s, other.batch.action_id)
  expect((await current).state).toBe('published')
  const budgetId = s.state.run(original.run_id).budget_id
  if (blocker !== 'usage-unknown') s.db.prepare("INSERT INTO cleanup_jobs(id,task_id,owner_kind,owner_id,necessary,state,detail_json) VALUES ('composition-cleanup',?,'action',?,1,'pending','{}')").run(s.task, original.batch.action_id)
  if (blocker !== 'cleanup') {
    ledger.reserve('composition-usage', budgetId, 'original-model-operation', { model_requests: 1, tokens: 1 }, original.attempt_id)
    ledger.markDispatched('composition-usage')
    if (blocker === 'usage-unknown') ledger.markUnknown('composition-usage')
  }
  const approval = s.store.snapshot(s.task).approvals.find(item => item.action_id === original.batch.action_id)!
  s.store.handle({ type: 'approval.decide', task_id: s.task, approval_id: approval.id, decision: 'approve' })
  expect(await stale).toMatchObject({ state: 'failure', code: 'VERSION_CONFLICT' })
  expect(s.state.run(original.run_id)).toMatchObject({ state: blocker === 'usage-unknown' ? 'failed' : 'closing', commit_valid: false })
  const live = () => liveRunnerFlow(s.db, { task_id: s.task }, s.epoch).lanes.Host.items
  if (blocker !== 'usage-unknown') expect(live()).toMatchObject([{ id: `batch:${original.batch.batch_id}`, state: 'closing' }])
  const batches = () => (s.db.prepare('SELECT batch_id FROM runner_batches WHERE task_id=? ORDER BY rowid').all(s.task) as { batch_id: string }[]).map(row => s.composition.batch(s.task, row.batch_id)!)
  const rebuilding = s.automatic('alpha', original.batch.batch_id)
  s.pump(); await tick()
  if (blocker === 'usage-unknown') {
    expect(ledger.query('composition-usage').state).toBe('unknown')
    expect(s.db.prepare('SELECT state,intended_terminal FROM runs WHERE id=?').get(original.run_id)).toEqual({ state: 'failed', intended_terminal: 'failed' })
  } else {
    expect(batches()).toHaveLength(2)
    expect(s.state.run(original.run_id).state).toBe('closing')
    s.aggregate(original.run_id); await tick()
    expect(batches()).toHaveLength(2)
    if (blocker === 'legacy-budget-exceeded') {
      s.db.prepare('UPDATE runner_budgets SET limits_json=? WHERE budget_id=?').run(JSON.stringify({ model_requests: 0, tool_requests: 0, tokens: 1, wall_ms: 1 }), budgetId)
      expect(ledger.settle('composition-usage', { tokens: 2 }).state).toBe('settled')
    }
    s.db.prepare("UPDATE cleanup_jobs SET state='done' WHERE id='composition-cleanup'").run()
    s.aggregate(original.run_id); await tick()
  }
  expect(s.state.run(original.run_id)).toMatchObject({ state: 'failed', commit_valid: false })
  expect(live().some(item => item.id === `batch:${original.batch.batch_id}`)).toBe(false)
  expect(s.store.runnerPublicationOperation(s.task, original.batch.operation_id!)?.result).toMatchObject({ state: 'failure', code: 'VERSION_CONFLICT' })
  expect(batches()).toHaveLength(3)
  const next = batches()[2]!
  expect(next.previous_batch_id).toBe(original.batch.batch_id)
  expect(s.state.run(next.run_id).budget_id).toBe(budgetId)
  await approveAndConfirm(s, next.action_id); await rebuilding; await tick()
  expect(s.store.runnerPublicationOperation(s.task, next.operation_id!)?.result?.state).toBe('published')
  expect(s.store.snapshot(s.task).views).toHaveLength(2)
})

it('retains denial causality across new composition identities and accepts a new explicit request', async () => {
  const s = setup(), original = s.source('goal', bundle(), true, true, 'model', 2)
  const denied = s.store.prepareRunnerComposition(s.task, 'goal')
  const publishing = s.store.publishRunnerComposition(s.task, denied.batch.batch_id, denied.collator.rulePlan())
  await tick()
  const approval = s.store.snapshot(s.task).approvals.find(item => item.action_id === denied.batch.action_id)!
  s.store.handle({ type: 'approval.decide', task_id: s.task, approval_id: approval.id, decision: 'deny' })
  expect(await publishing).toMatchObject({ state: 'failure', code: 'APPROVAL_INVALID' })
  const retry = s.store.prepareRunnerComposition(s.task, 'goal', { previous_batch_id: denied.batch.batch_id })
  const reordered = retry.collator.rulePlan(); reordered.intents.reverse()
  expect(await s.store.publishRunnerComposition(s.task, retry.batch.batch_id, reordered)).toMatchObject({ state: 'failure', code: 'APPROVAL_DENIED' })
  expect(s.store.snapshot(s.task).approvals).toHaveLength(1)
  expect(s.store.snapshot(s.task).views).toEqual([])
  s.source('explicit-new-request')
  const explicit = s.store.prepareRunnerComposition(s.task, 'explicit-new-request', { artifact_ids: original.indexes.map(index => index.artifact_id) })
  const accepted = s.store.publishRunnerComposition(s.task, explicit.batch.batch_id, explicit.collator.rulePlan())
  await approveAndConfirm(s, explicit.batch.action_id)
  expect((await accepted).state).toBe('published')
  expect(s.store.snapshot(s.task).views).toHaveLength(2)
})

it('requires exact host discard confirmation before a composition can reset a saved draft', async () => {
  const s = setup(), source = s.source('goal', bundle(), false, false)
  const first = s.store.prepareRunnerComposition(s.task, 'goal')
  const initial = s.store.publishRunnerComposition(s.task, first.batch.batch_id, first.collator.rulePlan())
  await approveAndConfirm(s, first.batch.action_id); expect((await initial).state).toBe('published')
  const view = s.store.snapshot(s.task).views[0]!
  s.store.handle({ type: 'draft.save', task_id: s.task, view_id: view.id, view_revision: view.revision, expected_state_revision: view.state_revision, fields: [{ path: '/answer', value: 'Saved user answer' }] })
  expect(s.artifacts.decide({ ...source.candidate, candidate_id: 'new-form-schema', base_artifact_revision: 1, bundle_resource_id: source.resource(bundle('New form', 'form-v2')) }, { state: 'accepted' }).state).toBe('accepted')
  const preserve = s.store.prepareRunnerComposition(s.task, 'goal')
  expect(await s.store.publishRunnerComposition(s.task, preserve.batch.batch_id, preserve.collator.rulePlan())).toMatchObject({ state: 'failure', code: 'STATE_INCOMPATIBLE' })
  const reset = s.store.prepareRunnerComposition(s.task, 'goal', { previous_batch_id: preserve.batch.batch_id })
  const publishing = s.store.publishRunnerComposition(s.task, reset.batch.batch_id, reset.collator.rulePlan(), { reset_artifact_ids: [source.artifactId] })
  await tick()
  const approval = s.store.snapshot(s.task).approvals.find(item => item.action_id === reset.batch.action_id)!
  s.store.handle({ type: 'approval.decide', task_id: s.task, approval_id: approval.id, decision: 'approve' }); await tick()
  await expect(s.store.handle({ type: 'surface.respond', task_id: s.task, action_id: reset.batch.action_id!, proceed: true, confirm_discard: false })).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' })
  expect(s.store.snapshot(s.task).views[0]).toMatchObject({ id: view.id, revision: 1, draft: { answer: 'Saved user answer' } })
  await s.store.handle({ type: 'surface.respond', task_id: s.task, action_id: reset.batch.action_id!, proceed: true, confirm_discard: true })
  expect((await publishing).state).toBe('published')
  expect(s.store.snapshot(s.task).views[0]).toMatchObject({ id: view.id, revision: 2, state_revision: 3, draft: { answer: '' } })
})

it('checks every sealed fragment across batches before marking a single goal complete', async () => {
  const s = setup(), source = s.source('goal', bundle(), true, true, 'model', 17)
  const preceding = () => conversationDependencyResult(s.db, s.task, s.state.input('input-goal').record_id, 'goal')
  const first = s.store.prepareRunnerComposition(s.task, 'goal')
  expect(first.batch.indexes).toHaveLength(16)
  const initial = s.store.publishRunnerComposition(s.task, first.batch.batch_id, first.collator.rulePlan())
  await approveAndConfirm(s, first.batch.action_id); expect((await initial).state).toBe('published')
  expect(s.composition.scope(s.task)?.state).toBe('working')
  expect(preceding()).toBeNull()
  const next = s.store.prepareRunnerComposition(s.task, 'goal')
  expect(next.batch.indexes).toHaveLength(1)
  expect(next.batch.composition_version).toBe(first.batch.composition_version)
  const final = s.store.publishRunnerComposition(s.task, next.batch.batch_id, next.collator.rulePlan())
  await approveAndConfirm(s, next.batch.action_id); expect((await final).state).toBe('published')
  const manifest = JSON.parse((s.db.prepare('SELECT payload_json FROM runner_manifests ORDER BY rowid DESC LIMIT 1').get() as { payload_json: string }).payload_json)
  expect(manifest).toMatchObject({ state: 'complete', unresolved: [] })
  expect(preceding()).toMatchObject({ publication: { manifest_id: manifest.manifest_id, operation_id: next.batch.operation_id } })
  expect(manifest.targets).toEqual([{ task_id: s.task, request_id: 'goal', intent_revision: 1 }])
  expect(manifest.contributions.map((entry: { artifact_id: string }) => entry.artifact_id).sort()).toEqual(source.indexes.map(index => index.artifact_id).sort())
  expect(s.db.prepare('SELECT count(*) count FROM views').get()).toEqual({ count: 17 })
})

it('keeps an old valid batch publishable when another goal grows the necessary scope', async () => {
  const s = setup(), alpha = s.source('alpha')
  const first = s.store.prepareRunnerComposition(s.task, 'alpha')
  const initial = s.store.publishRunnerComposition(s.task, first.batch.batch_id, first.collator.rulePlan())
  await tick()
  const beta = s.source('beta'), next = s.store.prepareRunnerComposition(s.task, 'beta', { artifact_ids: [beta.artifactId] })
  expect(next.batch.composition_version).toBeGreaterThan(first.batch.composition_version)
  await approveAndConfirm(s, first.batch.action_id); expect((await initial).state).toBe('published')
  expect(s.composition.scope(s.task)).toMatchObject({ state: 'working', composition_version: next.batch.composition_version })
  const later = s.store.publishRunnerComposition(s.task, next.batch.batch_id, next.collator.rulePlan())
  await approveAndConfirm(s, next.batch.action_id); expect((await later).state).toBe('published')
  expect(s.composition.scope(s.task)?.state).toBe('complete')
  expect(s.store.snapshot(s.task).views).toHaveLength(2)
  expect(s.artifacts.artifact(s.task, alpha.artifactId)).toEqual(alpha.index)
})

it('creates a new immutable batch after recovery proves the original opportunity never dispatched', () => {
  const s = setup(); s.source()
  const original = s.store.prepareRunnerComposition(s.task, 'goal'), ledger = new RunnerBudgetLedger(s.db)
  const budget = s.state.run(original.run_id).budget_id
  ledger.reserve('before-dispatch', budget, 'reserved-original-operation', { model_requests: 1, tokens: 10 }, original.attempt_id)
  const nextEpoch = `${s.epoch}-next`, report = new RunnerHostRecovery(s.db, nextEpoch).recover()
  expect(report.released_reservation_ids).toContain('before-dispatch')
  const work = new RunnerWorkState(s.db, nextEpoch), artifacts = new RunnerArtifactState(s.db, work), composition = new RunnerCompositionState(s.db, work, artifacts)
  const host = new RunnerHostComposition(s.db, work, artifacts, composition), lease = s.models.acquire('model', 'main')
  const next = host.prepare(s.task, 'goal', lease, { previous_batch_id: original.batch.batch_id }); lease.release()
  expect(next.batch).toMatchObject({ previous_batch_id: original.batch.batch_id })
  expect(next.run_id).not.toBe(original.run_id)
  expect(composition.batch(s.task, original.batch.batch_id)).toMatchObject({ run_id: original.run_id, state: 'invalidated' })
  expect(work.run(next.run_id)).toMatchObject({ budget_id: budget, purpose: 'composition', batch_id: next.batch.batch_id })
  expect(ledger.query('before-dispatch')).toMatchObject({ state: 'released', dispatched_at: null })
})

it('refuses successor IDs when the original dispatched reservation remains unknown', () => {
  const s = setup(); s.source()
  const original = s.store.prepareRunnerComposition(s.task, 'goal'), ledger = new RunnerBudgetLedger(s.db)
  ledger.reserve('already-dispatched', s.state.run(original.run_id).budget_id, 'original-operation', { model_requests: 1, tokens: 10 }, original.attempt_id)
  ledger.markDispatched('already-dispatched')
  const nextEpoch = `${s.epoch}-next`, report = new RunnerHostRecovery(s.db, nextEpoch).recover()
  expect(report.unknown_attempt_ids).toContain(original.attempt_id)
  expect(liveRunnerFlow(s.db, { task_id: s.task }, nextEpoch).lanes.Host.items).toMatchObject([{ id: `batch:${original.batch.batch_id}`, state: 'unknown' }])
  const work = new RunnerWorkState(s.db, nextEpoch), artifacts = new RunnerArtifactState(s.db, work), composition = new RunnerCompositionState(s.db, work, artifacts)
  const host = new RunnerHostComposition(s.db, work, artifacts, composition), lease = s.models.acquire('model', 'main')
  expect(() => host.prepare(s.task, 'goal', lease, { previous_batch_id: original.batch.batch_id })).toThrow(expect.objectContaining({ code: 'RUNNER_PUBLICATION_CONFLICT' })); lease.release()
  expect(ledger.query('already-dispatched').state).toBe('unknown')
  expect(s.db.prepare("SELECT run_id FROM runner_runs WHERE purpose='composition'").all()).toHaveLength(1)
})

it('caps all successor branches of one composition budget instead of granting fresh rebuild quotas', async () => {
  const s = setup(false); s.source()
  const original = s.store.prepareRunnerComposition(s.task, 'goal')
  expect((await s.store.publishRunnerComposition(s.task, original.batch.batch_id, original.collator.rulePlan())).state).toBe('failure')
  for (let n = 0; n < 3; n++) {
    const next = s.store.prepareRunnerComposition(s.task, 'goal', { previous_batch_id: original.batch.batch_id })
    expect(s.state.run(next.run_id).budget_id).toBe(s.state.run(original.run_id).budget_id)
    expect((await s.store.publishRunnerComposition(s.task, next.batch.batch_id, next.collator.rulePlan())).state).toBe('failure')
  }
  expect(() => s.store.prepareRunnerComposition(s.task, 'goal', { previous_batch_id: original.batch.batch_id })).toThrow(expect.objectContaining({ code: 'RUNNER_REBUILD_LIMIT' }))
})

it('allows cross-configuration composition only with the exact source resource explicitly bound', async () => {
  const s = setup(); s.source('alpha')
  const other = s.source('beta', bundle(), true, true, 'other-model')
  s.db.prepare('UPDATE requests SET input_json=? WHERE id=?').run(JSON.stringify({ text: 'Explicitly combine both results', binding_version: 1, resource_ids: [other.resourceId] }), 'alpha')
  const prepared = s.store.prepareRunnerComposition(s.task, 'alpha')
  expect(prepared.batch).toMatchObject({ model_config_id: 'model', model_config_revision: 1 })
  const publishing = s.store.publishRunnerComposition(s.task, prepared.batch.batch_id, prepared.collator.rulePlan())
  await approveAndConfirm(s, prepared.batch.action_id)
  expect((await publishing).state).toBe('published')
  expect(s.store.snapshot(s.task).views).toHaveLength(2)
})

it('invalidates current completeness after a correction while preserving the frozen complete publication', async () => {
  const s = setup(); s.source()
  const prepared = s.store.prepareRunnerComposition(s.task, 'goal'), publishing = s.store.publishRunnerComposition(s.task, prepared.batch.batch_id, prepared.collator.rulePlan())
  await approveAndConfirm(s); expect((await publishing).state).toBe('published')
  const original = s.composition.scope(s.task)!, views = s.store.snapshot(s.task).views
  const manifest = s.db.prepare('SELECT payload_json FROM runner_manifests WHERE manifest_id=?').get(original.publication_manifest_id) as { payload_json: string }
  s.input('correction', { request_id: 'goal' })
  expect(s.composition.scope(s.task)).toMatchObject({ state: 'working', previous_version: original.composition_version, targets: [{ request_id: 'goal', intent_revision: 2 }] })
  const host = new RunnerHostComposition(s.db, s.state, s.artifacts, s.composition)
  expect(host.completeness(s.task)).toMatchObject({ state: 'partial', unresolved: [{ request_id: 'goal', intent_revision: 2, requirement_id: 'content' }] })
  expect(host.completeness(s.task, original.composition_version).state).toBe('partial')
  expect(s.db.prepare('SELECT payload_json FROM runner_manifests WHERE manifest_id=?').get(original.publication_manifest_id)).toEqual(manifest)
  expect(s.store.snapshot(s.task).views).toEqual(views)
})

it.each(['planned', 'failed', 'cancelled'] as const)('removes an invalid sealed binding when new required work is %s', async state => {
  const s = setup(), source = s.source('goal', bundle(), true, false)
  const prepared = s.store.prepareRunnerComposition(s.task, 'goal'), publishing = s.store.publishRunnerComposition(s.task, prepared.batch.batch_id, prepared.collator.rulePlan())
  await approveAndConfirm(s); expect((await publishing).state).toBe('published')
  const original = s.composition.scope(s.task)!, work = s.state.work(source.workId)
  if (work.purpose !== 'production') throw Error('Expected production work')
  const extra: LogicalWork = { task_id: s.task, request_id: 'goal', intent_revision: 1, purpose: 'production', run_id: source.run, work_id: 'new-required-work', plan_revision: 1, role: 'producer', required: true, requirement_ids: ['content'], dependencies: work.dependencies, state: 'planned', max_attempts: 1 }
  s.state.installPlan([extra])
  if (state !== 'planned') {
    const attempt: ExecutionAttempt = { task_id: s.task, request_id: 'goal', intent_revision: 1, purpose: 'production', run_id: source.run, work_id: extra.work_id, attempt_id: 'new-required-attempt', runtime_epoch: s.epoch, attempt_number: 1, profile_id: 'producer', model_config_id: 'model', model_config_revision: 1, input_versions: extra.dependencies, state: 'registered', dispatch_state: 'not_dispatched', usage_refs: [] }
    s.state.createAttempt(attempt)
    if (state === 'failed') s.state.updateAttempt({ ...attempt, state: 'dispatched', dispatch_state: 'dispatched', operation_id: 'new-required-operation' })
    s.state.updateAttempt({ ...s.state.attempt(attempt.attempt_id), state })
  }
  expect(() => s.store.prepareRunnerComposition(s.task, 'goal')).toThrow(expect.objectContaining({ code: 'COMPOSITION_NOT_READY' }))
  expect(s.composition.scope(s.task)).toMatchObject({ state: 'working', previous_version: original.composition_version, unresolved: [{ request_id: 'goal', requirement_id: 'content' }] })
  expect(s.composition.scope(s.task)?.targets[0]?.contribution_inventory).toBeUndefined()
  expect(new RunnerHostComposition(s.db, s.state, s.artifacts, s.composition).completeness(s.task).state).toBe('partial')
  expect(s.composition.inventory(s.task, 'goal', 1)?.inventory_revision).toBe(1)
  expect(s.store.snapshot(s.task).views).toHaveLength(1)
})

it('keeps a cancelled source partial without discarding its previously published content', async () => {
  const s = setup(), source = s.source('goal', bundle(), true, false)
  const prepared = s.store.prepareRunnerComposition(s.task, 'goal'), publishing = s.store.publishRunnerComposition(s.task, prepared.batch.batch_id, prepared.collator.rulePlan())
  await approveAndConfirm(s); expect((await publishing).state).toBe('published')
  const original = s.composition.scope(s.task)!, views = s.store.snapshot(s.task).views
  s.input('cancel_run', { run_id: source.run })
  expect(s.state.run(source.run).state).toBe('cancelled')
  expect(() => s.store.prepareRunnerComposition(s.task, 'goal')).toThrow(expect.objectContaining({ code: 'COMPOSITION_NOT_READY' }))
  expect(s.composition.scope(s.task)).toMatchObject({ state: 'working', previous_version: original.composition_version })
  expect(new RunnerHostComposition(s.db, s.state, s.artifacts, s.composition).completeness(s.task)).toMatchObject({ state: 'partial', unresolved: [{ request_id: 'goal', requirement_id: 'content' }] })
  expect(s.store.snapshot(s.task).views).toEqual(views)
})

it('treats an unchanged complete composition as no new work without recording an obstruction', async () => {
  const s = setup(); s.source()
  const prepared = s.store.prepareRunnerComposition(s.task, 'goal'), publishing = s.store.publishRunnerComposition(s.task, prepared.batch.batch_id, prepared.collator.rulePlan())
  await approveAndConfirm(s); expect((await publishing).state).toBe('published')
  const scope = s.composition.scope(s.task)
  expect(() => s.store.prepareRunnerComposition(s.task, 'goal')).toThrow(expect.objectContaining({ code: 'COMPOSITION_NOT_READY' }))
  expect(s.composition.scope(s.task)).toEqual(scope)
  expect(s.records('runner.composition.blocked')).toEqual([])
})

it('waits at six active Task works and publishes after an admitted work releases its slot', async () => {
  const s = setup(), alpha = s.source('alpha', bundle(), false, false), beta = s.source('beta', bundle(), false, false)
  for (const source of [alpha, beta]) {
    const current = s.state.work(source.workId), previous = s.state.attempt(source.attemptId)
    const extra = { ...current, work_id: `${source.workId}-sibling`, state: 'planned' as const }
    delete extra.current_attempt_id
    s.state.installPlan([extra])
    const attempt = { ...previous, attempt_id: `${source.attemptId}-sibling`, work_id: extra.work_id, state: 'registered' as const, dispatch_state: 'not_dispatched' as const }
    delete attempt.operation_id
    s.state.createAttempt(attempt)
    s.state.updateAttempt({ ...attempt, state: 'dispatched', dispatch_state: 'dispatched', operation_id: `${attempt.attempt_id}-operation` })
  }
  const first = s.store.prepareRunnerComposition(s.task, 'alpha', { artifact_ids: [alpha.artifactId] })
  const occupied = s.store.prepareRunnerComposition(s.task, 'beta', { artifact_ids: [beta.artifactId] })
  for (const id of [occupied.attempt_id, occupied.publisher_attempt_id]) {
    s.state.updateAttempt({ ...s.state.attempt(id), state: 'dispatched', dispatch_state: 'dispatched', operation_id: `${id}-operation` })
  }
  const publishing = s.store.publishRunnerComposition(s.task, first.batch.batch_id, first.collator.rulePlan())
  await tick()
  expect(s.state.attempt(first.publisher_attempt_id)).toMatchObject({ state: 'queued', dispatch_state: 'not_dispatched' })
  expect(s.store.snapshot(s.task).approvals).toEqual([])
  expect(s.store.runnerPublicationOperation(s.task, first.batch.operation_id!)).toBeNull()
  s.state.updateAttempt({ ...s.state.attempt(occupied.attempt_id), state: 'succeeded' })
  s.pump()
  await approveAndConfirm(s, first.batch.action_id)
  expect((await publishing).state).toBe('published')
  expect(s.store.snapshot(s.task).views).toHaveLength(1)
})

it('persists a queryable original failure when a frozen artifact changes before publication', async () => {
  const s = setup(), source = s.source('goal', bundle(), false, false)
  const prepared = s.store.prepareRunnerComposition(s.task, 'goal')
  expect(s.artifacts.decide({ ...source.candidate, candidate_id: 'newest-fragment', base_artifact_revision: 1, bundle_resource_id: source.resource(bundle('Latest accepted')) }, { state: 'accepted' }).state).toBe('accepted')
  const result = await s.store.publishRunnerComposition(s.task, prepared.batch.batch_id, prepared.collator.rulePlan())
  expect(result).toMatchObject({ state: 'failure', code: 'RUNNER_DEPENDENCY_INVALID' })
  expect(s.store.runnerPublicationOperation(s.task, prepared.batch.operation_id!)?.result).toEqual(result)
  expect(s.artifacts.artifact(s.task, source.artifactId)?.artifact_revision).toBe(2)
  expect(s.store.snapshot(s.task).views).toEqual([])
})

function exportableBundle(text: string): Bundle {
  return { profile: 'managed-v1', html: `<section id="lesson"><p>${text}</p></section>`, css: '', state: { schema: { type: 'object', properties: {}, additionalProperties: false }, initial: {}, compatibility_version: 'export-v1' }, forms: [], behaviors: [], references: [], export: [{ id: 'lesson', category: 'learning', source: { type: 'element', element_id: 'lesson' } }] }
}
async function publishForExport(s: ReturnType<typeof setup>, request: string) {
  const prepared = s.store.prepareRunnerComposition(s.task, request)
  const publishing = s.store.publishRunnerComposition(s.task, prepared.batch.batch_id, prepared.collator.rulePlan())
  await approveAndConfirm(s, prepared.batch.action_id)
  expect((await publishing).state).toBe('published')
  return prepared
}

it('freezes an exact complete composition export while later publications continue without model generation', async () => {
  const s = setup(); s.source('alpha', exportableBundle('FIRST_FROZEN_RESULT'))
  await publishForExport(s, 'alpha')
  const request = vi.spyOn(s.models, 'request').mockRejectedValue(Error('Export must not invoke a model'))
  const result = s.store.handle({ type: 'export.prepare', task_id: s.task, answer_ids: [] }) as { id: string; html: string; issues: string[]; selection: { composition_version: number; state: string; published_count: number } }
  expect(result.selection).toMatchObject({ state: 'complete', published_count: 1 })
  expect(result.issues).toEqual([])
  expect(result.html).toContain('FIRST_FROZEN_RESULT')
  expect(result.html).toContain('冻结发布清单与完整性')
  expect(result.html).toContain('source_bundle_resource_id')
  const prior = result.selection.composition_version
  s.source('beta', exportableBundle('LATER_PUBLICATION_MUST_STAY_OUT'))
  await publishForExport(s, 'beta')
  expect(s.composition.scope(s.task)!.composition_version).toBeGreaterThan(prior)
  const saving = s.store.handle({ type: 'export.internal.begin', task_id: s.task, operation_id: result.id, partial: false, target: '/synthetic/output', temporary: '/synthetic/temporary' }) as { html: string; selection: unknown }
  expect(saving.html).toBe(result.html)
  expect(saving.html).not.toContain('LATER_PUBLICATION_MUST_STAY_OUT')
  expect(saving.selection).toEqual(result.selection)
  expect(request).not.toHaveBeenCalled()
})

it('requires partial confirmation for an unsealed working draft and retains exact missing requirements in HTML', async () => {
  const s = setup(); s.source('alpha', exportableBundle('READABLE_FIRST_PART'), false, false)
  await publishForExport(s, 'alpha')
  const request = vi.spyOn(s.models, 'request').mockRejectedValue(Error('No generation'))
  const check = s.store.handle({ type: 'export.check', task_id: s.task, answer_ids: [] }) as { complete: boolean; issues: { code: string; source: string }[] }
  expect(check.complete).toBe(false)
  expect(check.issues).toContainEqual({ code: 'RUNNER_COMPOSITION_PARTIAL', source: 'composition' })
  const result = s.store.handle({ type: 'export.prepare', task_id: s.task, answer_ids: [] }) as { id: string; html: string; issues: string[]; selection: unknown }
  expect(result.selection).toMatchObject({ state: 'partial', unresolved_count: 1 })
  expect(result.issues).toContain('RUNNER_COMPOSITION_PARTIAL')
  expect(result.html).toContain('READABLE_FIRST_PART')
  expect(result.html).toContain('目标 alpha · 修订 1 · 缺项 content')
  expect(() => s.store.handle({ type: 'export.internal.begin', task_id: s.task, operation_id: result.id, partial: false, target: '/synthetic/output', temporary: '/synthetic/temporary' })).toThrow(expect.objectContaining({ code: 'EXPORT_CONFIRMATION_REQUIRED' }))
  expect(s.store.handle({ type: 'export.internal.begin', task_id: s.task, operation_id: result.id, partial: true, target: '/synthetic/output', temporary: '/synthetic/temporary' })).toMatchObject({ phase: 'saving', selection: result.selection, html: result.html })
  expect(request).not.toHaveBeenCalled()
})

it('marks a selected subset partial even when the entire current composition is complete', async () => {
  const s = setup(); s.source('alpha', exportableBundle('A')); s.source('beta', exportableBundle('B'))
  await publishForExport(s, 'alpha')
  expect(s.composition.scope(s.task)?.state).toBe('complete')
  const snapshot = s.store.snapshot(s.task), result = s.store.handle({ type: 'export.prepare', task_id: s.task, answer_ids: [], view_ids: [snapshot.views[0]!.id], expected_revision: snapshot.surface.revision }) as { html: string; selection: unknown }
  expect(result.selection).toMatchObject({ state: 'partial', published_count: 1, omitted_count: 1 })
  expect(result.html).toContain('本次未完整选择片段')
})

it('preserves the old readable publication after correction and freezes the new missing target revision', async () => {
  const s = setup(); s.source('alpha', exportableBundle('OLD_READABLE_PUBLICATION'))
  await publishForExport(s, 'alpha')
  const original = s.state.goal('alpha')
  const record = (s.store as unknown as { record(task: string, kind: string, payload: unknown): string }).record(s.task, 'message.user', { text: 'Correction' })
  s.state.receive({ input_event_id: 'correct-alpha', task_id: s.task, request_id: 'alpha', record_id: record, kind: 'correction', stage: 'received' })
  s.state.installGoal({ ...original, input_event_id: 'correct-alpha', intent_revision: 2, previous_revision: 1 })
  const result = s.store.handle({ type: 'export.prepare', task_id: s.task, answer_ids: [] }) as { html: string; selection: unknown }
  expect(result.selection).toMatchObject({ state: 'partial', scope_pending: true, unresolved_count: 1, published_count: 1 })
  expect(result.html).toContain('OLD_READABLE_PUBLICATION')
  expect(result.html).toContain('目标 alpha · 修订 2 · 缺项 content')
})
