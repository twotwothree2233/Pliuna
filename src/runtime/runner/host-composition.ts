import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { ArtifactIndex, Bundle, CollatorIssue, CompositionBatch, CompositionScope, ExecutionScope, LogicalWork, PresentationPlan, PublicationEntry, PublicationManifest } from '../../shared/contracts.generated'
import defaults from '../../shared/contracts/development-defaults.json'
import { validateRunnerContract } from '../../shared/runner-validation'
import { ContractError } from '../../shared/validation'
import type { ModelLease } from '../model/service'
import { canonical } from '../surface-transition'
import { createCollator, type Collator } from './collator'
import { compositionCompleteness } from './completeness'
import { RUNNER_LIMITS, assertRunnerId } from './limits'
import { RunnerBudgetLedger } from './budget'
import { compilePresentation, type CompiledPresentation, type PresentationSurfaceWrite, type PresentationView } from './presentation'
import { RunnerPublicationState, type PublicationOperation, type PublicationResult } from './publication-state'
import type { RunnerArtifactState } from './artifact-state'
import type { RunnerCompositionState } from './composition-state'
import type { RunnerWorkState } from './work-state'
import { fragmentHasFeedback, requirementHasFeedback } from './repair-state'

type Row = Record<string, any>
const id = () => randomUUID()
const json = JSON.stringify
const fail = (code: string, message: string): never => { throw new ContractError(code, message) }
export interface PrepareRunnerCompositionOptions { artifact_ids?: string[]; previous_batch_id?: string; feedback_only?: boolean }
export interface PreparedRunnerComposition { batch: CompositionBatch; run_id: string; attempt_id: string; publisher_attempt_id: string; collator: Collator }
export interface PublishRunnerCompositionOptions { signal?: AbortSignal; reset_artifact_ids?: string[] }
export interface CompositionSurfacePrepared { op: PresentationSurfaceWrite['input']['operations'][number]; viewId: string; resourceId: string }
export interface CompositionPublicationHooks {
  approvalOperations?: readonly ('content.delete' | 'content.move')[]
  check(): void
  prepared(prepared: CompositionSurfacePrepared[]): void
  committed(recordId: string, revision: number): unknown
}
export interface CompositionPublication { request: PresentationSurfaceWrite; owner: ExecutionScope; hooks: CompositionPublicationHooks; operation_id: string; action_id: string }

export class RunnerHostComposition {
  readonly publications: RunnerPublicationState
  constructor(private readonly db: Database.Database, private readonly work: RunnerWorkState, private readonly artifacts: RunnerArtifactState, private readonly composition: RunnerCompositionState) {
    this.publications = new RunnerPublicationState(db, input => {
      const expected = compositionCompleteness(db, work, composition, this.publications, input.task_id, input.manifest!.composition_version, input.surface_id, input.entries)
      if (expected.state !== 'complete' || json(expected) !== json({ state: input.manifest!.state, targets: input.manifest!.targets, contributions: input.manifest!.contributions, unresolved: input.manifest!.unresolved })) fail('RUNNER_COMPLETENESS_REQUIRED', 'Complete publication requires the current full contribution inventory and exact deliveries')
    })
  }
  private indexes(batch: CompositionBatch): ArtifactIndex[] {
    this.composition.checkBatch(batch.task_id, batch.batch_id)
    return batch.indexes.map(reference => this.artifacts.artifact(batch.task_id, reference.artifact_id, reference.artifact_revision)!)
  }
  private publishable(index: ArtifactIndex): boolean {
    try {
      this.composition.checkArtifact(index.task_id, index.artifact_id, index.artifact_revision)
      return this.composition.publicationArtifact(index)
    } catch (error) {
      if (error instanceof ContractError && ['RUNNER_DEPENDENCY_INVALID', 'RUNNER_OWNERSHIP_INVALID'].includes(error.code)) return false
      throw error
    }
  }
  private mappings(task: string): PublicationEntry[] {
    return this.publications.mappings(task)
  }
  private outline(task: string) { return this.artifacts.outline(task) ?? fail('RUNNER_NOT_FOUND', 'Composition requires a shared outline') }
  private surface(task: string): Row { return this.db.prepare('SELECT * FROM surfaces WHERE task_id=? ORDER BY rowid LIMIT 1').get(task) as Row ?? fail('RUNNER_NOT_FOUND', 'Task Surface is unavailable') }
  setBatchState(task: string, batchId: string, state: CompositionBatch['state']): void {
    const batch = this.composition.batch(task, batchId) ?? fail('RUNNER_NOT_FOUND', 'Composition batch is unavailable')
    this.db.prepare('UPDATE runner_batches SET payload_json=? WHERE task_id=? AND batch_id=?').run(json({ ...batch, state }), task, batchId)
  }
  completeness(task: string, version = this.composition.scope(task)?.composition_version): ReturnType<typeof compositionCompleteness> {
    if (version === undefined) fail('RUNNER_NOT_FOUND', 'Composition scope is unavailable')
    return compositionCompleteness(this.db, this.work, this.composition, this.publications, task, version!, this.surface(task).id)
  }
  private rebuildBudget(task: string, previous: CompositionBatch, lease: ModelLease): string {
    const run = this.work.run(previous.run_id), operation = previous.operation_id ? this.publications.operation(task, previous.operation_id) : null
    if (!run.commit_valid && run.state === 'closing') fail('RUN_BUSY', 'The original composition Run is still settling')
    if (run.commit_valid || !['completed', 'failed', 'cancelled', 'interrupted'].includes(run.state)) fail('RUNNER_BATCH_CONFLICT', 'Rebuild requires the original Run to have ended without commit authority')
    if (previous.model_config_id !== lease.id || previous.model_config_revision !== lease.revision) fail('MODEL_CONFIGURATION_CHANGED', 'A rebuild retains the original composition configuration')
    if (operation) {
      if (!['failed', 'invalidated'].includes(previous.state) || !operation.result || !['failure', 'cancelled'].includes(operation.result.state)) fail('RUNNER_PUBLICATION_CONFLICT', 'Rebuild cannot bypass the original publication outcome')
    } else {
      // Restart recovery may revoke a frozen batch before any publication was
      // registered. Only a fully undispatched opportunity can acquire new IDs.
      const attempts = this.work.taskWorks(task).filter(work => work.run_id === run.run_id).flatMap(work => this.work.attempts(work.work_id))
      const reservations = this.db.prepare('SELECT state,dispatched_at FROM runner_budget_reservations WHERE budget_id=? AND (attempt_id IN (SELECT attempt_id FROM runner_attempts WHERE run_id=?) OR attempt_id IS NULL)').all(run.budget_id, run.run_id) as Row[]
      const calls = this.db.prepare("SELECT 1 FROM calls WHERE run_id=? AND (dispatch!='not_sent' OR execution IS NOT NULL AND execution!='not_executed') LIMIT 1").get(run.run_id)
      const actions = this.db.prepare("SELECT 1 FROM actions WHERE run_id=? AND (state!='ended' OR result IS NULL OR result!='not_executed') LIMIT 1").get(run.run_id)
      if (!['preparing', 'prepared', 'failed', 'invalidated'].includes(previous.state) || !attempts.length || attempts.some(attempt => attempt.state !== 'revoked' || attempt.dispatch_state !== 'not_dispatched') || reservations.some(reservation => reservation.state !== 'released' || reservation.dispatched_at !== null) || calls || actions) fail('RUNNER_PUBLICATION_CONFLICT', 'Original dispatch must be reconciled before creating a successor batch')
    }
    const count = (this.db.prepare("SELECT count(*) count FROM runner_runs WHERE task_id=? AND purpose='composition' AND budget_id=?").get(task, run.budget_id) as { count: number }).count
    if (count > RUNNER_LIMITS.composition.rebuilds) fail('RUNNER_REBUILD_LIMIT', 'Composition opportunity exhausted its bounded rebuilds')
    return run.budget_id
  }
  checkInputs(task: string, trigger: string, indexes: ArtifactIndex[], config: Pick<ModelLease, 'id' | 'revision'>): void {
    const request = this.db.prepare('SELECT config_selection_json,input_json FROM requests WHERE task_id=? AND id=?').get(task, trigger) as Row | undefined
    const selected = request ? JSON.parse(request.config_selection_json) : null
    if (!selected || selected.id !== config.id || selected.revision !== config.revision) fail('MODEL_CONFIGURATION_CHANGED', 'Composition must retain the trigger request configuration')
    const input = JSON.parse(request!.input_json)
    const authorized = new Set<string>(input.binding_version === 1 ? [...(input.resource_ids ?? []), ...(input.bound_materials ?? []).map((item: Row) => item.id)] : [])
    for (const index of indexes) {
      const origin = this.db.prepare('SELECT config_selection_json FROM requests WHERE task_id=? AND id=?').get(task, index.request_id) as Row | undefined
      const source = origin ? JSON.parse(origin.config_selection_json) : null
      if (!source || source.id !== config.id || source.revision !== config.revision) {
        if (!authorized.has(index.bundle_resource_id)) fail('COMPOSITION_INPUT_CONFIRMATION_REQUIRED', 'Cross-configuration composition requires an explicit request binding for every exact source resource')
      }
    }
  }
  missingRequirements(scope: CompositionScope, targets: CompositionBatch['targets']): CompositionScope['unresolved'] {
    return scope.unresolved.filter(requirement => targets.some(target => target.request_id === requirement.request_id && target.intent_revision === requirement.intent_revision)
      && !requirementHasFeedback(this.db, requirement)
      && scope.targets.some(target => target.request_id === requirement.request_id && target.intent_revision === requirement.intent_revision && target.contribution_inventory)
      && this.work.goal(requirement.request_id).requirements.some(item => item.requirement_id === requirement.requirement_id && item.kind !== 'answer'))
  }
  prepare(task: string, trigger: string, lease: ModelLease, options: PrepareRunnerCompositionOptions = {}): PreparedRunnerComposition {
    assertRunnerId(task, 'task_id'); assertRunnerId(trigger, 'trigger_request_id')
    const scope = this.composition.scope(task) ?? fail('RUNNER_NOT_FOUND', 'Composition scope is unavailable')
    const existing = this.db.prepare("SELECT r.run_id FROM runner_runs r JOIN runs c ON c.id=r.run_id WHERE r.task_id=? AND r.purpose='composition' AND c.state IN ('running','waiting')").all(task) as Row[]
    if (existing.length >= RUNNER_LIMITS.admission.composition_batches_per_task) fail('RUN_BUSY', 'Composition admission is currently occupied')
    const all: ArtifactIndex[] = []
    let cursor: string | undefined
    do { const page = this.composition.pageIndexes(task, scope.composition_version, cursor); all.push(...page.items); cursor = page.next_cursor ?? undefined } while (cursor)
    const previous = options.previous_batch_id ? this.composition.batch(task, options.previous_batch_id) : null
    if (options.previous_batch_id && !previous) fail('RUNNER_BATCH_CONFLICT', 'A rebuild requires its exact original batch')
    const budgetId = previous ? this.rebuildBudget(task, previous, lease) : id()
    const feedbackOnly = options.feedback_only || previous?.indexes.length === 0
    const requested = feedbackOnly ? [] : options.artifact_ids ?? previous?.indexes.map(item => item.artifact_id)
    if (requested && (new Set(requested).size !== requested.length || requested.some(value => !all.some(index => index.artifact_id === value)))) fail('RUNNER_DEPENDENCY_INVALID', 'Requested composition fragments must be exact current accepted contributions')
    const occupied = new Set((this.db.prepare("SELECT b.payload_json FROM runner_batches b JOIN runs r ON r.id=json_extract(b.payload_json,'$.run_id') WHERE b.task_id=? AND r.state IN ('running','waiting')").all(task) as Row[]).flatMap(row => (JSON.parse(row.payload_json) as CompositionBatch).indexes.map(item => item.artifact_id)))
    const candidates = all.filter(index => requested ? requested.includes(index.artifact_id) : !occupied.has(index.artifact_id) && this.publications.mapping(task, index.artifact_id)?.artifact_revision !== index.artifact_revision)
    if (requested && candidates.some(index => fragmentHasFeedback(this.db, task, index.artifact_id, index.artifact_revision))) fail('COMPOSITION_FEEDBACK_PENDING', 'Requested fragment has an unresolved structural defect')
    const eligible = candidates.filter(index => !fragmentHasFeedback(this.db, task, index.artifact_id, index.artifact_revision))
    const indexes = (requested ? eligible.filter(index => this.composition.publicationArtifact(index)) : eligible.filter(index => this.publishable(index))).slice(0, RUNNER_LIMITS.composition.batch_fragments)
    if (requested && requested.some(artifact => !candidates.some(index => index.artifact_id === artifact && this.composition.publicationArtifact(index)))) fail('RUNNER_DEPENDENCY_INVALID', 'Requested fragment is not designated for publication')
    if (!indexes.length && !feedbackOnly) fail('COMPOSITION_NOT_READY', 'No new accepted fragment is ready for composition')
    this.checkInputs(task, trigger, indexes, lease)
    const outline = this.outline(task), sections = outline.sections.filter(section => indexes.some(index => index.section_id === section.section_id))
    const targets = scope.targets.filter(target => target.request_id === trigger || indexes.some(index => index.request_id === target.request_id)).map(target => ({ task_id: task, request_id: target.request_id, intent_revision: target.intent_revision }))
    if (!targets.some(target => target.request_id === trigger)) fail('RUNNER_OWNERSHIP_INVALID', 'Composition trigger must be a current goal')
    const missing = this.missingRequirements(scope, targets)
    if (feedbackOnly && !missing.length) fail('COMPOSITION_NOT_READY', 'No unresolved requirement is ready for feedback')
    const batch = validateRunnerContract('runner_composition_batch', { task_id: task, batch_id: id(), composition_version: scope.composition_version, run_id: id(), trigger_request_id: trigger, model_config_id: lease.id, model_config_revision: lease.revision, state: 'preparing', targets, indexes: indexes.map(index => ({ task_id: task, artifact_id: index.artifact_id, artifact_revision: index.artifact_revision })), sections: sections.map(section => ({ section_id: section.section_id, position_revision: section.position_revision, order_key: section.order_key })), operation_id: id(), action_id: id(), ...(previous ? { previous_batch_id: previous.batch_id } : {}) })
    const issues: CollatorIssue[] = []
    for (const [position, index] of indexes.entries()) {
      const artifact = batch.indexes[position]!, mapping = this.publications.mapping(task, index.artifact_id)
      const resource = this.db.prepare('SELECT byte_length FROM resources WHERE id=?').get(index.bundle_resource_id) as { byte_length: number } | undefined
      if (mapping && mapping.section_id !== index.section_id) issues.push({ evidence_id: id(), kind: 'artifact_section_mismatch', artifact, expected_section_id: mapping.section_id })
      else if (resource && resource.byte_length > defaults.surface.inline_bundle_bytes) issues.push({ evidence_id: id(), kind: 'artifact_size_limit', artifact, observed_bytes: resource.byte_length, max_bytes: defaults.surface.inline_bundle_bytes })
    }
    for (const requirement of missing) {
      if (issues.length >= RUNNER_LIMITS.composition.batch_fragments) break
      issues.push({ evidence_id: id(), kind: 'missing_requirement', requirement })
    }
    const collator = createCollator({ batch, outline, indexes, currentLayout: null, issues })
    const common = { task_id: task, run_id: batch.run_id, purpose: 'composition' as const, batch_id: batch.batch_id, composition_version: batch.composition_version, trigger_request_id: trigger }
    const dependencies = indexes.map(index => ({ kind: 'artifact' as const, task_id: task, artifact_id: index.artifact_id, artifact_revision: index.artifact_revision }))
    const works: LogicalWork[] = [collator.profile.id, 'composition-host-publisher-v1'].map(() => ({ ...common, work_id: id(), plan_revision: 1, role: 'collator', required: true, requirement_ids: [], dependencies, state: 'planned', max_attempts: 1 }))
    const attempts = works.map((work, position) => ({ ...common, attempt_id: id(), work_id: work.work_id, runtime_epoch: this.work.epoch, attempt_number: 1, profile_id: position === 0 ? collator.profile.id : 'composition-host-publisher-v1', model_config_id: lease.id, model_config_revision: lease.revision, input_versions: dependencies, state: 'registered' as const, dispatch_state: 'not_dispatched' as const, usage_refs: [] }))
    this.db.transaction(() => {
      if (previous && !this.publications.operation(task, previous.operation_id!)) this.setBatchState(task, previous.batch_id, 'invalidated')
      if (!previous) new RunnerBudgetLedger(this.db).create({ budget_id: budgetId, task_id: task, purpose: 'composition', request_id: null })
      this.composition.installBatch(batch)
      this.db.prepare("INSERT INTO runs(id,task_id,request_id,state,runtime_epoch,limits_json,budget_json,created_at) VALUES (?,?,NULL,'running',?,?,?,?)").run(batch.run_id, task, this.work.epoch, json({ ...defaults, run: lease.config.limits ?? {} }), json({ model_requests: 0, tool_requests: 0, tokens: 0 }), new Date().toISOString())
      this.work.registerRun({ ...common, runtime_epoch: this.work.epoch, state: 'running', commit_valid: true, budget_id: budgetId })
      this.work.installPlan(works)
      for (const attempt of attempts) this.work.createAttempt(attempt)
    })()
    return { batch, run_id: batch.run_id, attempt_id: attempts[0]!.attempt_id, publisher_attempt_id: attempts[1]!.attempt_id, collator }
  }
  publisher(task: string, batchId: string): ExecutionScope {
    const batch = this.composition.batch(task, batchId) ?? fail('RUNNER_NOT_FOUND', 'Composition batch is unavailable')
    const work = this.work.taskWorks(task).find(work => work.run_id === batch.run_id && work.current_attempt_id && this.work.attempt(work.current_attempt_id).profile_id === 'composition-host-publisher-v1')
    if (!work?.current_attempt_id) fail('RUNNER_OWNERSHIP_INVALID', 'Composition host publisher is unavailable')
    return { task_id: task, run_id: batch.run_id, work_id: work!.work_id, attempt_id: work!.current_attempt_id!, role: 'collator', purpose: 'composition', batch_id: batchId, composition_version: batch.composition_version, trigger_request_id: batch.trigger_request_id }
  }
  recordFailure(task: string, batchId: string, plan: PresentationPlan, code: string, cancelled: boolean): PublicationResult {
    const batch = this.composition.batch(task, batchId) ?? fail('RUNNER_NOT_FOUND', 'Composition batch is unavailable')
    const previous = this.operation(task, batch.operation_id!)
    if (previous?.result) return previous.result
    if (!previous) {
      // Failure bookkeeping retains frozen historical bindings even when a
      // dependency has changed since preparation. It cannot authorize execution.
      const checked = validateRunnerContract('runner_presentation_plan', plan)
      if (!this.db.prepare('SELECT id FROM actions WHERE id=?').get(batch.action_id)) this.db.prepare("INSERT INTO actions(id,task_id,run_id,kind,state,source_json,request_json,commit_valid,created_at,result,result_json,ended_at) VALUES (?,?,?,'mutation','ended',?,?,0,?,'not_executed',?,?)").run(batch.action_id, task, batch.run_id, json({ type: 'run', id: batch.run_id, level: 'task', owner: this.publisher(task, batchId) }), json({ type: 'composition.prepare', plan: checked }), new Date().toISOString(), json({ code }), new Date().toISOString())
      this.publications.register({ task_id: task, operation_id: batch.operation_id!, batch_id: batchId, action_id: batch.action_id!, plan: checked })
    }
    return this.publications.recordOutcome(task, batch.operation_id!, { state: cancelled ? 'cancelled' : 'failure', code })
  }
  publication(task: string, batchId: string, raw: PresentationPlan, features: { viewReplacement: boolean }, load: (resource: string) => { bundle: Bundle; byte_length: number }, options: PublishRunnerCompositionOptions = {}): CompositionPublication {
    const batch = this.composition.batch(task, batchId) ?? fail('RUNNER_NOT_FOUND', 'Composition batch is unavailable'), indexes = this.indexes(batch)
    const collator = createCollator({ batch, outline: this.outline(task), indexes, currentLayout: null }), plan = collator.validatePlan(raw)
    if (plan.intents.length !== batch.indexes.length) fail('INVALID_PRESENTATION_PLAN', 'Publication must account for every fragment in its frozen batch')
    const surface = this.surface(task), mappings = this.mappings(task), rows = this.db.prepare('SELECT * FROM views WHERE surface_id=? ORDER BY rowid').all(surface.id) as Row[]
    const views: PresentationView[] = rows.map(row => ({ view_id: row.id, view_revision: row.revision, state_revision: row.state_revision, bundle_resource_id: row.bundle_resource_id, ...(plan.intents.some(intent => mappings.some(mapping => mapping.artifact_id === intent.artifact.artifact_id && mapping.view_id === row.id && mapping.artifact_revision !== intent.artifact.artifact_revision)) ? { bundle: load(row.bundle_resource_id).bundle, draft: JSON.parse(row.draft_json) } : {}) }))
    const sourceIds = new Set(indexes.filter(index => mappings.find(mapping => mapping.artifact_id === index.artifact_id)?.artifact_revision !== index.artifact_revision).map(index => index.bundle_resource_id))
    const sources = [...sourceIds].map(resource_id => ({ task_id: task, resource_id, ...load(resource_id) }))
    const compiled: CompiledPresentation = compilePresentation({ plan, indexes, sections: this.outline(task).sections, surface: { task_id: task, surface_id: surface.id, revision: surface.revision, layout: JSON.parse(surface.layout_json) }, views, mappings, sources, features, ...(options.reset_artifact_ids ? { reset_artifact_ids: options.reset_artifact_ids } : {}) })
    const owner = this.publisher(task, batchId), operationId = batch.operation_id!, actionId = batch.action_id!
    const goal = this.work.goal(batch.trigger_request_id)
    const cause = canonical({ input_event_id: goal.input_event_id, intents: [...plan.intents].sort((left, right) => left.artifact.artifact_id.localeCompare(right.artifact.artifact_id)), reset_artifact_ids: [...new Set(options.reset_artifact_ids ?? [])].sort() })
    const denials = this.db.prepare("SELECT a.source_json FROM actions a JOIN approvals p ON p.action_id=a.id WHERE a.task_id=? AND p.decision='deny' AND json_extract(a.source_json,'$.composition_cause') IS NOT NULL").all(task) as Row[]
    if (denials.some(row => JSON.parse(row.source_json).composition_cause === cause)) fail('APPROVAL_DENIED', 'This exact publication was denied; a new explicit user request is required')
    const old = this.db.prepare('SELECT request_json FROM actions WHERE id=?').get(actionId) as Row | undefined
    if (old && old.request_json !== json(compiled.request.input)) fail('RUNNER_PUBLICATION_CONFLICT', 'The original publication action retains its exact request')
    if (!old) this.db.prepare("INSERT INTO actions(id,task_id,run_id,kind,state,source_json,request_json,commit_valid,created_at) VALUES (?,?,?,'mutation','registered',?,?,1,?)").run(actionId, task, batch.run_id, json({ type: 'run', id: batch.run_id, level: 'task', owner, composition_cause: cause }), json(compiled.request.input), new Date().toISOString())
    this.publications.register({ task_id: task, operation_id: operationId, batch_id: batchId, action_id: actionId, plan })
    const historyId = id(), manifestId = id(), deliveryId = id()
    let resources: { artifact_id: string; artifact_revision: number; source_bundle_resource_id: string; published_bundle_resource_id: string; view_id: string }[] = []
    const check = () => {
      this.composition.checkBatch(task, batchId); this.work.qualify(owner.attempt_id)
      if (indexes.some(index => fragmentHasFeedback(this.db, task, index.artifact_id, index.artifact_revision))) fail('COMPOSITION_FEEDBACK_PENDING', 'The frozen batch contains a fragment with an unresolved structural defect')
    }
    const hooks: CompositionPublicationHooks = {
      check,
      prepared: prepared => {
        check()
        resources = compiled.bindings.map(binding => {
          const locator = binding.view
          const view = locator.type === 'created' ? prepared.find(item => item.op.type === 'view.create' && item.op.client_ref === locator.client_ref) : prepared.find(item => item.viewId === locator.view_id)
          const view_id = view?.viewId ?? (binding.view.type === 'existing' ? binding.view.view_id : fail('RUNNER_PUBLICATION_CONFLICT', 'Prepared publication is missing its created View'))
          const published_bundle_resource_id = view?.resourceId ?? binding.published_bundle_resource_id ?? fail('RUNNER_PUBLICATION_CONFLICT', 'Prepared publication is missing its normalized resource')
          return { artifact_id: binding.artifact_id, artifact_revision: binding.artifact_revision, source_bundle_resource_id: binding.source_bundle_resource_id, published_bundle_resource_id, view_id }
        })
        this.publications.prepare(task, operationId, { surface_id: surface.id, base_surface_revision: surface.revision, resources: resources.map(({ view_id: _view, ...resource }) => resource) })
      },
      committed: (recordId, revision) => {
        check()
        const entries: PublicationEntry[] = resources.map(resource => {
          const index = indexes.find(index => index.artifact_id === resource.artifact_id)!, view = this.db.prepare('SELECT revision,state_revision,bundle_resource_id FROM views WHERE id=? AND surface_id=?').get(resource.view_id, surface.id) as Row
          return { task_id: task, batch_id: batchId, request_id: index.request_id, intent_revision: index.intent_revision, ...resource, section_id: index.section_id, view_revision: view.revision, state_revision: view.state_revision, surface_history_id: historyId }
        })
        const completeness = compositionCompleteness(this.db, this.work, this.composition, this.publications, task, batch.composition_version, surface.id, entries)
        const manifest: PublicationManifest = { manifest_id: manifestId, task_id: task, composition_version: batch.composition_version, operation_id: operationId, action_id: actionId, surface_id: surface.id, surface_revision: revision, ...completeness }
        const result = this.publications.installCommittedSurface({ task_id: task, operation_id: operationId, action_id: actionId, surface_id: surface.id, surface_revision: revision, surface_history_id: historyId, surface_record_id: recordId, entries, manifest, delivery: { delivery_id: deliveryId, task_id: task, run_id: owner.run_id, work_id: owner.work_id, attempt_id: owner.attempt_id, role: owner.role, record_id: recordId, purpose: 'composition', batch_id: batchId, composition_version: batch.composition_version, publication_manifest_id: manifestId } })
        this.setBatchState(task, batchId, 'published')
        if (manifest.state === 'complete') {
          const scope = this.composition.scope(task, batch.composition_version)!
          this.db.prepare('UPDATE runner_scopes SET payload_json=? WHERE task_id=? AND composition_version=?').run(json({ ...scope, state: 'complete', publication_manifest_id: manifestId }), task, scope.composition_version)
        }
        return result
      }
    }
    return { request: compiled.request, owner, hooks, operation_id: operationId, action_id: actionId }
  }
  operation(task: string, operation: string): PublicationOperation | null { return this.publications.operation(task, operation) }
}
