import type Database from 'better-sqlite3'
import type { ArtifactIndex, CompositionBatch, DeliveryRecord, PresentationPlan, PublicationEntry, PublicationManifest } from '../../shared/contracts.generated'
import { validateRunnerContract } from '../../shared/runner-validation'
import { ContractError } from '../../shared/validation'
import { assertRunnerId } from './limits'
import { registerRunnerResources } from './resource-references'

export interface PublicationRegistration {
  task_id: string
  operation_id: string
  batch_id: string
  action_id: string
  plan: PresentationPlan
}
export interface PublicationResourceBinding {
  artifact_id: string
  artifact_revision: number
  source_bundle_resource_id: string
  published_bundle_resource_id: string
}
export interface PublicationPreparation {
  surface_id: string
  base_surface_revision: number
  resources: PublicationResourceBinding[]
}
export interface SurfaceLayoutHistory {
  surface_history_id: string
  task_id: string
  surface_id: string
  surface_revision: number
  action_id: string
  layout: Record<string, unknown>
  views: { view_id: string; view_revision: number; view_history_id: string; state_revision: number }[]
}
export type CompositionDelivery = Extract<DeliveryRecord, { purpose: 'composition' }>
export interface SurfaceCommitInput {
  task_id: string
  operation_id: string
  action_id: string
  surface_id: string
  surface_revision: number
  surface_history_id: string
  surface_record_id: string
  entries: PublicationEntry[]
  delivery: CompositionDelivery
  manifest?: PublicationManifest
}
export interface PublicationInstallResult {
  operation_id: string
  state: 'published'
  action_id: string
  batch_id: string
  surface_id: string
  surface_revision: number
  surface_history_id: string
  delivery_id: string
  manifest_id?: string
}
export interface PublicationUnsuccessfulResult {
  operation_id: string
  state: 'failure' | 'cancelled' | 'unknown'
  code: string
}
export type PublicationResult = PublicationInstallResult | PublicationUnsuccessfulResult
export interface PublicationOperation {
  registration: PublicationRegistration
  preparation: PublicationPreparation | null
  state: 'registered' | 'prepared' | PublicationResult['state']
  result: PublicationResult | null
}
interface PublicationPayload {
  registration: PublicationRegistration
  preparation?: PublicationPreparation
  installation?: SurfaceCommitInput
}
type PayloadRow = { payload_json: string }
type PublicationRow = PayloadRow & { task_id: string; state: PublicationOperation['state']; result_json: string | null }
type SurfaceView = { view_id: string; view_revision: number; state_revision: number; bundle_resource_id: string; view_history_id: string | null; history_task_id: string | null; history_resource_id: string | null }

function fail(code: string, message: string): never { throw new ContractError(code, message) }
function conflict(message: string): never { return fail('RUNNER_PUBLICATION_CONFLICT', message) }
function revision(value: unknown): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail('INVALID_RUNNER_CONTRACT', 'Publication revisions must be positive safe integers')
}
function json(value: unknown): string {
  try {
    const result = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'number' && !Number.isFinite(item) || !['object', 'string', 'boolean', 'number'].includes(typeof item)) throw Error()
      return item
    })
    if (result !== undefined) return result
  } catch { /* Rejected metadata must not expose content. */ }
  return fail('INVALID_RUNNER_CONTRACT', 'Publication state must be finite JSON')
}
function copy<T>(value: T): T { return JSON.parse(json(value)) as T }
function equivalent(left: unknown, right: unknown): boolean {
  const normalize = (value: any): any => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])])) : value
  return json(normalize(left)) === json(normalize(right))
}
function keys(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('INVALID_RUNNER_CONTRACT', 'Invalid publication fields')
}
function distinct(values: string[]): void {
  if (new Set(values).size !== values.length) conflict('Publication identities must be distinct')
}

// The host still owns execution, approval and source qualification. This Module
// stores their exact publication binding and joins the existing final transaction.
// Completeness verification is synchronous and joins this same installation.
export class RunnerPublicationState {
  constructor(private readonly db: Database.Database, private readonly verifyComplete?: (input: SurfaceCommitInput) => void) {}

  private row(taskId: string, operationId: string): PublicationRow | undefined {
    assertRunnerId(taskId, 'task_id'); assertRunnerId(operationId, 'operation_id')
    return this.db.prepare('SELECT task_id,state,payload_json,result_json FROM runner_publications WHERE task_id=? AND operation_id=?').get(taskId, operationId) as PublicationRow | undefined
  }
  private required(taskId: string, operationId: string): PublicationRow {
    return this.row(taskId, operationId) ?? fail('RUNNER_PUBLICATION_NOT_FOUND', 'Publication operation is unavailable')
  }
  operation(taskId: string, operationId: string): PublicationOperation | null {
    const row = this.row(taskId, operationId)
    if (!row) return null
    const payload = JSON.parse(row.payload_json) as PublicationPayload
    return { registration: payload.registration, preparation: payload.preparation ?? null, state: row.state, result: row.result_json ? JSON.parse(row.result_json) as PublicationResult : null }
  }
  private activeTask(taskId: string): void {
    if (!this.db.prepare("SELECT id FROM tasks WHERE id=? AND state='active'").get(taskId)) fail('RUNNER_OWNERSHIP_INVALID', 'Publication Task is not active')
  }
  private batch(registration: PublicationRegistration): CompositionBatch {
    const row = this.db.prepare('SELECT payload_json FROM runner_batches WHERE task_id=? AND batch_id=?').get(registration.task_id, registration.batch_id) as PayloadRow | undefined
    if (!row) fail('RUNNER_OWNERSHIP_INVALID', 'Publication batch does not belong to this Task')
    const batch = validateRunnerContract('runner_composition_batch', JSON.parse(row.payload_json))
    const plan = registration.plan
    if (plan.task_id !== batch.task_id || plan.batch_id !== batch.batch_id || plan.run_id !== batch.run_id || plan.composition_version !== batch.composition_version || batch.operation_id && batch.operation_id !== registration.operation_id || batch.action_id && batch.action_id !== registration.action_id) conflict('Publication must retain its exact batch and action binding')
    distinct(plan.intents.map(intent => intent.artifact.artifact_id))
    if (plan.intents.some(intent => !batch.indexes.some(index => equivalent(index, intent.artifact)))) conflict('Publication plan must use the frozen batch read set')
    return batch
  }
  private action(registration: PublicationRegistration, batch: CompositionBatch, committing = false): void {
    const action = this.db.prepare('SELECT task_id,run_id,kind,state,result,commit_valid FROM actions WHERE id=?').get(registration.action_id) as { task_id: string; run_id: string | null; kind: string; state: string; result: string | null; commit_valid: number } | undefined
    if (!action || action.task_id !== registration.task_id || action.run_id !== batch.run_id || action.kind !== 'mutation') fail('RUNNER_OWNERSHIP_INVALID', 'Publication action does not belong to this composition source')
    if (committing && (action.state === 'ended' ? action.result !== 'success' : !action.commit_valid)) fail('RUNNER_OWNERSHIP_INVALID', 'Publication action cannot install a successful result')
  }
  private resource(taskId: string, resourceId: string): void {
    if (!this.db.prepare('SELECT r.id FROM resources r JOIN task_resources t ON t.resource_id=r.id WHERE t.task_id=? AND r.id=?').get(taskId, resourceId)) fail('RUNNER_RESOURCE_INVALID', 'Publication resource must be associated with this Task')
  }
  private artifact(taskId: string, artifactId: string, artifactRevision: number, current = false): ArtifactIndex {
    const row = this.db.prepare('SELECT a.payload_json,a.bundle_resource_id,o.current_revision FROM runner_artifacts a JOIN runner_artifact_owners o ON o.artifact_id=a.artifact_id AND o.task_id=a.task_id WHERE a.task_id=? AND a.artifact_id=? AND a.artifact_revision=?').get(taskId, artifactId, artifactRevision) as PayloadRow & { bundle_resource_id: string; current_revision: number } | undefined
    if (!row || current && row.current_revision !== artifactRevision) fail('RUNNER_OWNERSHIP_INVALID', 'Publication artifact is not an exact accepted version')
    const index = validateRunnerContract('runner_artifact_index', JSON.parse(row.payload_json))
    if (index.task_id !== taskId || index.artifact_id !== artifactId || index.artifact_revision !== artifactRevision || index.bundle_resource_id !== row.bundle_resource_id || index.acceptance_state !== 'accepted') fail('RUNNER_OWNERSHIP_INVALID', 'Publication artifact identity is inconsistent')
    this.resource(taskId, index.bundle_resource_id)
    return index
  }

  register(raw: PublicationRegistration): PublicationOperation {
    const registration = copy(raw)
    keys(registration, ['task_id', 'operation_id', 'batch_id', 'action_id', 'plan'])
    for (const name of ['task_id', 'operation_id', 'batch_id', 'action_id'] as const) assertRunnerId(registration[name], name)
    validateRunnerContract('runner_presentation_plan', registration.plan)
    return this.db.transaction(() => {
      const previous = this.db.prepare('SELECT task_id,payload_json FROM runner_publications WHERE operation_id=?').get(registration.operation_id) as PayloadRow & { task_id: string } | undefined
      if (previous) {
        if (previous.task_id !== registration.task_id || !equivalent((JSON.parse(previous.payload_json) as PublicationPayload).registration, registration)) conflict('Publication operation cannot change its original registration')
        return this.operation(registration.task_id, registration.operation_id)!
      }
      if (this.db.prepare('SELECT operation_id FROM runner_publications WHERE batch_id=? OR action_id=?').get(registration.batch_id, registration.action_id)) conflict('Publication batch and action retain their original operation')
      this.activeTask(registration.task_id)
      const batch = this.batch(registration)
      this.action(registration, batch)
      if (['published', 'failed', 'unknown', 'cancelled', 'invalidated'].includes(batch.state)) conflict('A terminal or unknown batch cannot acquire another publication operation')
      for (const intent of registration.plan.intents) this.artifact(registration.task_id, intent.artifact.artifact_id, intent.artifact.artifact_revision)
      this.db.prepare("INSERT INTO runner_publications(operation_id,task_id,batch_id,action_id,state,payload_json) VALUES (?,?,?,?,'registered',?)").run(registration.operation_id, registration.task_id, registration.batch_id, registration.action_id, json({ registration }))
      return this.operation(registration.task_id, registration.operation_id)!
    }).immediate()
  }

  prepare(taskId: string, operationId: string, raw: PublicationPreparation): PublicationOperation {
    const preparation = copy(raw)
    keys(preparation, ['surface_id', 'base_surface_revision', 'resources'])
    assertRunnerId(preparation.surface_id, 'surface_id'); revision(preparation.base_surface_revision)
    if (!Array.isArray(preparation.resources)) fail('INVALID_RUNNER_CONTRACT', 'Publication preparation requires resource bindings')
    for (const binding of preparation.resources) {
      keys(binding, ['artifact_id', 'artifact_revision', 'source_bundle_resource_id', 'published_bundle_resource_id'])
      for (const name of ['artifact_id', 'source_bundle_resource_id', 'published_bundle_resource_id'] as const) assertRunnerId(binding[name], name)
      revision(binding.artifact_revision)
    }
    distinct(preparation.resources.map(binding => binding.artifact_id))
    return this.db.transaction(() => {
      const row = this.required(taskId, operationId), payload = JSON.parse(row.payload_json) as PublicationPayload
      if (payload.preparation) {
        if (!equivalent(payload.preparation, preparation)) conflict('Publication preparation cannot replace its original resources or baseline')
        return this.operation(taskId, operationId)!
      }
      if (row.state !== 'registered') conflict('Publication preparation requires its original registered operation')
      this.activeTask(taskId)
      const batch = this.batch(payload.registration)
      this.action(payload.registration, batch)
      const surface = this.db.prepare('SELECT revision FROM surfaces WHERE id=? AND task_id=?').get(preparation.surface_id, taskId) as { revision: number } | undefined
      if (!surface || surface.revision !== preparation.base_surface_revision) conflict('Publication preparation must bind the actual Surface baseline')
      if (preparation.resources.length !== payload.registration.plan.intents.length) conflict('Publication preparation must bind every intended artifact')
      for (const binding of preparation.resources) {
        if (!payload.registration.plan.intents.some(intent => intent.artifact.artifact_id === binding.artifact_id && intent.artifact.artifact_revision === binding.artifact_revision)) conflict('Prepared resources must match the original presentation plan')
        const index = this.artifact(taskId, binding.artifact_id, binding.artifact_revision)
        if (index.bundle_resource_id !== binding.source_bundle_resource_id) conflict('Prepared source must retain the accepted resource identity')
        this.resource(taskId, binding.published_bundle_resource_id)
      }
      payload.preparation = preparation
      registerRunnerResources(this.db, taskId, 'runner_publication', operationId, preparation.resources.flatMap(binding => [binding.source_bundle_resource_id, binding.published_bundle_resource_id]))
      this.db.prepare("UPDATE runner_publications SET state='prepared',payload_json=? WHERE operation_id=?").run(json(payload), operationId)
      return this.operation(taskId, operationId)!
    }).immediate()
  }

  recordOutcome(taskId: string, operationId: string, outcome: Omit<PublicationUnsuccessfulResult, 'operation_id'>): PublicationResult {
    return this.db.transaction(() => {
      const row = this.required(taskId, operationId)
      if (row.state === 'published') return JSON.parse(row.result_json!) as PublicationInstallResult
      const value = copy(outcome)
      keys(value, ['state', 'code'])
      if (!['failure', 'cancelled', 'unknown'].includes(value.state) || typeof value.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(value.code)) fail('INVALID_RUNNER_CONTRACT', 'Publication outcome requires a bounded reason code')
      const result: PublicationUnsuccessfulResult = { operation_id: operationId, ...value }
      if (row.result_json) {
        if (!equivalent(JSON.parse(row.result_json), result)) conflict('Publication outcome cannot overwrite the original result')
        return JSON.parse(row.result_json) as PublicationUnsuccessfulResult
      }
      this.db.prepare('UPDATE runner_publications SET state=?,result_json=? WHERE operation_id=?').run(result.state, json(result), operationId)
      return result
    }).immediate()
  }

  mapping(taskId: string, artifactId: string, artifactRevision?: number, batchId?: string): PublicationEntry | null {
    assertRunnerId(taskId, 'task_id'); assertRunnerId(artifactId, 'artifact_id')
    if (artifactRevision !== undefined) revision(artifactRevision)
    if (batchId !== undefined) assertRunnerId(batchId, 'batch_id')
    const row = this.db.prepare('SELECT payload_json FROM runner_view_mappings WHERE task_id=? AND artifact_id=? AND (? IS NULL OR artifact_revision=?) AND (? IS NULL OR batch_id=?) ORDER BY rowid DESC LIMIT 1').get(taskId, artifactId, artifactRevision ?? null, artifactRevision ?? null, batchId ?? null, batchId ?? null) as PayloadRow | undefined
    return row ? validateRunnerContract('runner_publication_entry', JSON.parse(row.payload_json)) : null
  }
  history(taskId: string, historyId: string): SurfaceLayoutHistory | null {
    assertRunnerId(taskId, 'task_id'); assertRunnerId(historyId, 'surface_history_id')
    const row = this.db.prepare('SELECT payload_json FROM runner_surface_history WHERE task_id=? AND surface_history_id=?').get(taskId, historyId) as PayloadRow | undefined
    return row ? JSON.parse(row.payload_json) as SurfaceLayoutHistory : null
  }
  manifest(taskId: string, manifestId: string): PublicationManifest | null {
    assertRunnerId(taskId, 'task_id'); assertRunnerId(manifestId, 'manifest_id')
    const row = this.db.prepare('SELECT payload_json FROM runner_manifests WHERE task_id=? AND manifest_id=?').get(taskId, manifestId) as PayloadRow | undefined
    return row ? validateRunnerContract('runner_publication_manifest', JSON.parse(row.payload_json)) : null
  }
  delivery(taskId: string, deliveryId: string): CompositionDelivery | null {
    assertRunnerId(taskId, 'task_id'); assertRunnerId(deliveryId, 'delivery_id')
    const row = this.db.prepare("SELECT payload_json FROM runner_deliveries WHERE task_id=? AND delivery_id=? AND purpose='composition'").get(taskId, deliveryId) as PayloadRow | undefined
    return row ? validateRunnerContract('runner_delivery_record', JSON.parse(row.payload_json)) as CompositionDelivery : null
  }

  private capture(input: SurfaceCommitInput): { history: SurfaceLayoutHistory; views: SurfaceView[] } {
    const surface = this.db.prepare('SELECT revision,layout_json FROM surfaces WHERE task_id=? AND id=?').get(input.task_id, input.surface_id) as { revision: number; layout_json: string } | undefined
    if (!surface || surface.revision !== input.surface_revision) conflict('Publication history must capture the committed Surface version')
    const layout = JSON.parse(surface.layout_json) as Record<string, unknown>, layoutViews: string[] = []
    if (!layout || !Array.isArray(layout.slots)) conflict('Committed Surface layout is invalid')
    for (const slot of layout.slots) {
      if (!slot || !Array.isArray(slot.groups)) conflict('Committed Surface layout is invalid')
      for (const group of slot.groups) {
        if (!group || !Array.isArray(group.views)) conflict('Committed Surface layout is invalid')
        for (const viewId of group.views) { assertRunnerId(viewId, 'view_id'); layoutViews.push(viewId) }
      }
    }
    distinct(layoutViews)
    const views = this.db.prepare('SELECT v.id view_id,v.revision view_revision,v.state_revision,v.bundle_resource_id,h.id view_history_id,h.task_id history_task_id,h.bundle_resource_id history_resource_id FROM views v LEFT JOIN view_history h ON h.view_id=v.id AND h.view_revision=v.revision WHERE v.surface_id=? ORDER BY v.id').all(input.surface_id) as SurfaceView[]
    if (layoutViews.length !== views.length || views.some(view => !layoutViews.includes(view.view_id))) conflict('Surface history must retain every remaining View exactly once')
    for (const view of views) {
      revision(view.view_revision); revision(view.state_revision)
      if (!view.view_history_id || view.history_task_id !== input.task_id || view.history_resource_id !== view.bundle_resource_id) conflict('Surface history requires exact same-Task View history')
      this.resource(input.task_id, view.bundle_resource_id)
    }
    const history: SurfaceLayoutHistory = { surface_history_id: input.surface_history_id, task_id: input.task_id, surface_id: input.surface_id, surface_revision: input.surface_revision, action_id: input.action_id, layout, views: views.map(view => ({ view_id: view.view_id, view_revision: view.view_revision, view_history_id: view.view_history_id!, state_revision: view.state_revision })) }
    return { history, views }
  }
  private checkDelivery(input: SurfaceCommitInput, batch: CompositionBatch): void {
    const delivery = input.delivery
    validateRunnerContract('runner_delivery_record', delivery)
    if (delivery.purpose !== 'composition' || delivery.task_id !== input.task_id || delivery.batch_id !== batch.batch_id || delivery.composition_version !== batch.composition_version || delivery.run_id !== batch.run_id || delivery.record_id !== input.surface_record_id || delivery.role !== 'collator' || delivery.publication_manifest_id !== input.manifest?.manifest_id) conflict('Publication delivery must bind this exact composition and Surface record')
    const source = this.db.prepare('SELECT w.payload_json FROM runner_attempts a JOIN runner_work w ON w.work_id=a.work_id JOIN runner_runs r ON r.run_id=a.run_id WHERE a.attempt_id=? AND a.task_id=? AND a.work_id=? AND a.run_id=? AND w.task_id=a.task_id AND w.run_id=a.run_id AND r.task_id=a.task_id AND r.purpose=\'composition\' AND r.batch_id=? AND r.composition_version=?').get(delivery.attempt_id, input.task_id, delivery.work_id, delivery.run_id, batch.batch_id, batch.composition_version) as PayloadRow | undefined
    if (!source || validateRunnerContract('runner_logical_work', JSON.parse(source.payload_json)).role !== delivery.role) fail('RUNNER_OWNERSHIP_INVALID', 'Composition delivery does not retain its exact execution source')
    if (delivery.input_event_id && !this.db.prepare('SELECT input_event_id FROM runner_inputs WHERE task_id=? AND input_event_id=?').get(input.task_id, delivery.input_event_id)) fail('RUNNER_OWNERSHIP_INVALID', 'Composition delivery input belongs to another Task')
    const record = this.db.prepare("SELECT payload_json FROM records WHERE id=? AND task_id=? AND kind='surface.published'").get(input.surface_record_id, input.task_id) as PayloadRow | undefined
    const payload = record ? JSON.parse(record.payload_json) as { action_id?: string; revision?: number } : null
    if (!payload || payload.action_id !== input.action_id || payload.revision !== input.surface_revision) conflict('Publication delivery requires the actual Surface publication record')
  }
  private checkManifest(input: SurfaceCommitInput, batch: CompositionBatch, views: SurfaceView[]): void {
    if (!input.manifest) return
    const manifest = validateRunnerContract('runner_publication_manifest', input.manifest)
    if (manifest.state === 'complete') {
      if (!this.verifyComplete) fail('RUNNER_COMPLETENESS_REQUIRED', 'Complete publication requires host inventory and delivery verification')
      this.verifyComplete(input)
    }
    const scope = this.db.prepare('SELECT payload_json FROM runner_scopes WHERE task_id=? AND composition_version=?').get(input.task_id, batch.composition_version) as PayloadRow | undefined
    const targets = scope ? (validateRunnerContract('runner_composition_scope', JSON.parse(scope.payload_json))).targets.map(target => ({ task_id: input.task_id, request_id: target.request_id, intent_revision: target.intent_revision })) : null
    if (manifest.task_id !== input.task_id || manifest.composition_version !== batch.composition_version || manifest.operation_id !== input.operation_id || manifest.action_id !== input.action_id || manifest.surface_id !== input.surface_id || manifest.surface_revision !== input.surface_revision || !equivalent(manifest.targets, targets)) conflict('Publication manifest must retain its exact scope and Surface version')
    for (const entry of manifest.contributions) {
      const installed = this.mapping(input.task_id, entry.artifact_id, entry.artifact_revision, entry.batch_id)
      const view = views.find(item => item.view_id === entry.view_id)
      if (!installed || !equivalent(installed, entry) || !view || view.view_revision !== entry.view_revision || view.bundle_resource_id !== entry.published_bundle_resource_id || !this.history(input.task_id, entry.surface_history_id)) conflict('Manifest contributions must retain exact installed mappings and history')
    }
  }

  installCommittedSurface(raw: SurfaceCommitInput): PublicationInstallResult {
    const input = copy(raw)
    keys(input, ['task_id', 'operation_id', 'action_id', 'surface_id', 'surface_revision', 'surface_history_id', 'surface_record_id', 'entries', 'delivery', 'manifest'])
    for (const name of ['task_id', 'operation_id', 'action_id', 'surface_id', 'surface_history_id', 'surface_record_id'] as const) assertRunnerId(input[name], name)
    revision(input.surface_revision)
    const original = this.required(input.task_id, input.operation_id), originalPayload = JSON.parse(original.payload_json) as PublicationPayload
    if (original.state === 'published') {
      if (!equivalent(originalPayload.installation, input)) conflict('Published operation cannot change its installed payload')
      return JSON.parse(original.result_json!) as PublicationInstallResult
    }
    if (!this.db.inTransaction) fail('RUNNER_TRANSACTION_REQUIRED', 'Publication installation must join the final Surface transaction')
    return this.db.transaction(() => {
      if (original.state !== 'prepared' || !originalPayload.preparation) conflict('Publication installation requires the original prepared operation')
      const { registration, preparation } = originalPayload
      if (input.action_id !== registration.action_id || input.surface_id !== preparation.surface_id || input.surface_revision !== preparation.base_surface_revision + 1) conflict('Publication must retain its original action and Surface baseline')
      this.activeTask(input.task_id)
      const batch = this.batch(registration)
      if (['failed', 'unknown', 'cancelled', 'invalidated'].includes(batch.state)) conflict('Publication cannot install a terminal or unknown batch')
      this.action(registration, batch, true)
      if (!Array.isArray(input.entries) || input.entries.length !== preparation.resources.length) conflict('Publication must install its entire prepared mapping set')
      distinct(input.entries.map(entry => entry.artifact_id)); distinct(input.entries.map(entry => entry.view_id))
      const { history, views } = this.capture(input)
      this.checkDelivery(input, batch)
      for (const entry of input.entries) {
        validateRunnerContract('runner_publication_entry', entry)
        const binding = preparation.resources.find(item => item.artifact_id === entry.artifact_id && item.artifact_revision === entry.artifact_revision)
        const index = this.artifact(input.task_id, entry.artifact_id, entry.artifact_revision, true), view = views.find(item => item.view_id === entry.view_id)
        if (!binding || entry.task_id !== input.task_id || entry.batch_id !== registration.batch_id || entry.request_id !== index.request_id || entry.intent_revision !== index.intent_revision || entry.section_id !== index.section_id || entry.source_bundle_resource_id !== binding.source_bundle_resource_id || entry.published_bundle_resource_id !== binding.published_bundle_resource_id || entry.surface_history_id !== input.surface_history_id || !view || view.view_revision !== entry.view_revision || view.state_revision !== entry.state_revision || view.bundle_resource_id !== entry.published_bundle_resource_id) conflict('Publication mapping must match exact accepted, prepared and committed versions')
        this.resource(input.task_id, entry.source_bundle_resource_id); this.resource(input.task_id, entry.published_bundle_resource_id)
        const previous = this.mapping(input.task_id, entry.artifact_id)
        if (previous && previous.view_id !== entry.view_id || this.db.prepare('SELECT artifact_id FROM runner_view_mappings WHERE task_id=? AND view_id=? AND artifact_id!=?').get(input.task_id, entry.view_id, entry.artifact_id)) conflict('Logical artifacts must retain distinct stable View identities')
      }
      this.db.prepare('INSERT INTO runner_surface_history(surface_history_id,task_id,surface_id,surface_revision,action_id,payload_json) VALUES (?,?,?,?,?,?)').run(input.surface_history_id, input.task_id, input.surface_id, input.surface_revision, input.action_id, json(history))
      registerRunnerResources(this.db, input.task_id, 'runner_surface_history', input.surface_history_id, views.map(view => view.bundle_resource_id))
      for (const entry of input.entries) this.db.prepare('INSERT INTO runner_view_mappings(task_id,artifact_id,artifact_revision,batch_id,view_id,view_revision,source_bundle_resource_id,published_bundle_resource_id,payload_json) VALUES (?,?,?,?,?,?,?,?,?)').run(entry.task_id, entry.artifact_id, entry.artifact_revision, entry.batch_id, entry.view_id, entry.view_revision, entry.source_bundle_resource_id, entry.published_bundle_resource_id, json(entry))
      this.checkManifest(input, batch, views)
      const delivery = input.delivery
      this.db.prepare("INSERT INTO runner_deliveries(delivery_id,task_id,purpose,record_id,payload_json) VALUES (?,?,'composition',?,?)").run(delivery.delivery_id, delivery.task_id, delivery.record_id, json(delivery))
      if (input.manifest) {
        this.db.prepare('INSERT INTO runner_manifests(manifest_id,task_id,composition_version,operation_id,payload_json) VALUES (?,?,?,?,?)').run(input.manifest.manifest_id, input.manifest.task_id, input.manifest.composition_version, input.operation_id, json(input.manifest))
        registerRunnerResources(this.db, input.task_id, 'runner_manifest', input.manifest.manifest_id, input.manifest.contributions.flatMap(entry => [entry.source_bundle_resource_id, entry.published_bundle_resource_id]))
      }
      const result: PublicationInstallResult = { operation_id: input.operation_id, state: 'published', action_id: input.action_id, batch_id: registration.batch_id, surface_id: input.surface_id, surface_revision: input.surface_revision, surface_history_id: input.surface_history_id, delivery_id: delivery.delivery_id, ...(input.manifest ? { manifest_id: input.manifest.manifest_id } : {}) }
      originalPayload.installation = input
      this.db.prepare("UPDATE runner_publications SET state='published',payload_json=?,result_json=? WHERE operation_id=?").run(json(originalPayload), json(result), input.operation_id)
      return result
    })()
  }
}
