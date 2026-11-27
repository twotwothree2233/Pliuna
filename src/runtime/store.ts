import { newTestIdentityEncoding } from './file-format'
import { assertDirectorySync } from '../platform/files'
import { MontyCalls } from './monty/calls'
import { MONTY_ID, montyContract } from './monty/contract'
import Database from 'better-sqlite3'
import { randomUUID, createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { openBusinessDatabase, prepareBusinessDatabase, purgeRunnerTask } from './schema-upgrade'
import { productionRunsPerTask } from './features'
import Ajv2020 from 'ajv/dist/2020.js'
import approvalTemplate from './model/prompts/approval-v0.1.txt?raw'
import coreSchema from '../shared/contracts/core.schema.json'
import { TaskSync } from './sync'
import { ModelService, type ModelLease } from './model/service'
import { annotateReads, compactContext, interactions, recordedMessage, restoreMessages, summaryMessage, type InstalledSummary, type HistoryRecord } from './model/context'
import agentTemplate from './model/prompts/agent-v0.1.txt?raw'
import { modelTools } from './model/tools'
import { assertReadDispatch } from './model/read-policy'
import { messageEvidence, type RequestEvidence } from './model/request-evidence'
import type { RequestAccounting } from './model/accounting'
import { RunBudget, runAgent, type WorkerExecution, type WorkerResultIssue } from './model/agent'
import { ContextRejectedError } from './model/capacity'
import { modelReadOptions } from './model/tool-input'
import { RepresentationPager } from './model/representation'
import { ReadCursors } from './model/read-cursor'
import { ModelError, type ChatMessage } from './model/adapter'
import defaults from '../shared/contracts/development-defaults.json'
import type { Bundle, IpcRequest, ModelRequest } from '../shared/contracts.generated'
import type { Snapshot, Task, RunnerProjection } from '../shared/types'
import { ContractError, assertContract, validateIpc, validateModel } from '../shared/validation'
import { answerValues, checkBundle, checkDraft, fieldSchema, getField, setField, schemaCheck } from './managed'
import { canonical, replacementDraft } from './surface-transition'
import { ObjectQueries } from './queries'
import { digest, resourceBody, resourceValue } from './resources'
import { captureEvidence, checkEvidence, historyValue, saveHistory } from './evidence'
import { StorageLifecycle } from './storage-lifecycle'
import { RecoveryManager, ownDirectory } from './recovery'
import { RestoreJournal } from './restore-journal'
import { RestrictedGc } from './gc'
import { ReplicaRetirement } from './replicas'
import { ResourceCleanupManager } from './resource-cleanup'
import { MaterialImports } from './material-imports'
import { RequestQueue } from './request-queue'
import { PluginControl } from './plugins/control'
import { PluginDirectory } from './plugins/directory'
import { PluginProcesses, type PluginIdentity, type PluginInstanceEvent } from './plugins/process'
import { PluginActions, type PluginActionContext } from './plugins/actions'
import { PluginUploads } from './plugins/uploads'
import { PluginCalls } from './plugins/calls'
import { PluginDrafts } from './plugins/drafts'
import { PluginQueries } from './plugins/queries'
import { readPluginResource, readPluginBytes } from './plugins/resource-reader'
import { PluginDerivations } from './plugins/derivations'
import { bundleResources, imageUrl } from './view-resources'
import { loadBundleSource, checkPersonalBindings, type BundleSource } from './bundle-source'
import { ExportControl } from './export-control'
import { generateExport, type ExportRunner, type ExportGeneration, type ExportInput } from './export-generation'
import { captureCheck, ExportChecks, type CheckRunner } from './export-check'
import { backgroundCheck } from './export-check-runner'
import { RpcError } from './plugins/rpc'
import { boundedRecent, snapshotValue } from './snapshot-summary'
import { runActivity } from './run-activity'
import { RunnerWorkState, type AssignmentSupplement, type QualifiedAttempt } from './runner/work-state'
import { WorkerContext } from './runner/worker-context'
import { captureConversation, fitConversation, loadConversation, precedingDelivery, type ConversationBinding, type ConversationHistory, type ConversationResult } from './runner/conversation'
import { liveRunnerFlow } from './runner/live-flow'
import { approvalMessages, conversationContentPlan, conversationDependencyResult, conversationDependencyRunning, conversationPublicationRun, conversationReference, runMessage, type BoundConversationDependency } from './runner/conversation-query'
import type { WorkerGrant, WorkerProfile } from './runner/worker-profile'
import { dispatchOrchestrationTool, DISCOVER_INPUTS, InitialWorkDraft, orchestrationCapability, READ_BOUND_INPUT, READ_WORK_OUTPUT, REPORT_MISSING_INPUT, WORK_OUTPUT_REPEAT_NOTICE, type DispatchWork, type OrchestrationInstallation } from './runner/orchestration-tool'
import { assignmentRevisions, bindOutput, checkAssignmentRequirements, initialDeliveryRequirements, installableAssignments, propagateAssignmentRevisions } from './runner/orchestration-plan'
import { AssignmentContent, BoundContentReader, boundContentInputs } from './runner/assignment-content'
import { RoutingInputCatalog, type CatalogOutput } from './runner/routing-input-catalog'
import { captureExecutionScope } from './model/request-evidence'
import type { ExecutionScope, ExecutionAttempt, InputEvent, ContentPlan, ReportMissingInput, RouteWork } from '../shared/contracts.generated'
import { aggregateRunOutcome, type WorkRunState } from './runner/run-outcome'
import { runnerFailureReason } from './runner/failure-reason'
import { TaskRunner, type TaskRunnerRoute, type TaskRunnerInstallation, type TaskRunnerEffect, type TaskRunnerStatusQuery, type TaskRunnerStatusPage } from './runner/task-runner'
import { RunnerArtifactState } from './runner/artifact-state'
import { RunnerCompositionState } from './runner/composition-state'
import { RunnerBudgetLedger } from './runner/budget'
import { RunnerBudgetAccounting, type ToolAccountingPhase } from './runner/budget-accounting'
import type { Collator } from './runner/collator'
import { RunnerAdmission, admissionWork, type RunnerAdmissionWork } from './runner/admission'
import { createProducerProfile, ruleRouterOutline, validateProducerBundle, type ProducerResult } from './runner/production-profile'
import { RunnerHostProduction } from './runner/host-production'
import { RunnerHostRecovery } from './runner/host-recovery'
import { RunnerHostProgress } from './runner/host-progress'
import { deliveryHasUnsettledExecution, requestDelivery } from './runner/delivery-state'
import { artifactRepair, installedRepairDispatch, repairRequestId, repairRoutingWork, RunnerRepairState, unresolvedDeliveryRequirements, type ArtifactRepair, type PendingRepair } from './runner/repair-state'
import { createRunnerDiagnostic, type RunnerDiagnostic } from './runner/diagnostic'
import type { ProgressDiagnosis } from './runner/progress-observer'
import { RunnerHostStatus } from './runner/host-status'
import { assertRunnerId, compositionReadyAt, RUNNER_LIMITS } from './runner/limits'
import { RunnerHostComposition, type PrepareRunnerCompositionOptions, type PreparedRunnerComposition, type PublishRunnerCompositionOptions, type CompositionPublicationHooks } from './runner/host-composition'
import type { PublicationOperation, PublicationResult } from './runner/publication-state'
import { freezeExportComposition } from './runner/export-selection'
import { exportCompositionIssue, exportCompositionSummary, type FrozenExportComposition } from './export-composition'
import type { LogicalWork, PresentationPlan, RouteWorkRunnerOutputBinding } from '../shared/contracts.generated'
import type { ChapterManifest, ChapterProposal, ChapterPublication, ChapterUpdate } from '../shared/contracts.generated'
import { ChapterHost } from './runner/chapter-host'
import { chapterTerminal } from './runner/chapter-state'
import { assembleChapterUpdate, chapterCandidateTemplate, chapterContext, chapterInput, validateChapterCandidate } from './runner/chapter-content'
import { createChapterProfile, createContentProfile } from './runner/chapter-profile'
import { createChapterRouterProfile, createConversationReadingProfile, createConversationRouterProfile, createWorkRouterProfile, validateChapterRoute, validateConversationRoute, type ConversationRoute } from './runner/chapter-router'
import { ContentTreeState } from './runner/content-tree-state'
import { ContentTreeQueries } from './runner/content-tree-queries'
import { isCorrectableContentError } from './runner/content-errors'
import { CONTENT_OPERATIONS, assembleContentUpdate, assertContentAuthority, contentUpdatesOverlap, parseContentRequest, reconcileRetainedContentScope, updateContentScope } from './runner/content-tree-host'
import type { ContentOperation } from '../shared/contracts.generated'
import { validateRunnerContract } from '../shared/runner-validation'

const id = () => randomUUID()
const now = () => new Date().toISOString()
const json = JSON.stringify
function fail(code: string, message: string): never { throw new ContractError(code, message) }
type Row = Record<string, any>
type RoutedAdmission = { input: Row; route: ConversationRoute; draft?: DispatchWork; chapterQuery?: { manifest: ChapterManifest; region_ids: string[] } }
type ExecutionActionContext = (PluginActionContext | { id: string; signal: AbortSignal; owner: ExecutionScope; authorize(request: unknown): void; valid(): void; identity?: never }) & { hostPublication?: boolean }
type WorkerAgent = { owner: ExecutionScope; controller: AbortController; main: ModelLease; compact?: ModelLease; approval?: ModelLease; budget: RunBudget; mode: 'manual' | 'assisted'; context: WorkerContext; profile: WorkerProfile<unknown>; collator?: Collator; diagnostic?: RunnerDiagnostic; orchestration?: OrchestrationInstallation; prefix?: ChatMessage[]; messages?: ChatMessage[]; state: 'running' | 'waiting'; reason?: string }
type WorkerInput = { text: string; conversation?: ConversationHistory; bound?: unknown; orchestration?: OrchestrationInstallation; waitReport?: () => string | undefined; checkpoint?: ReturnType<typeof WorkerContext.checkpoint> }
type AssignedWork = Extract<LogicalWork, { purpose: 'production' }>
type MissingInputEvent = { run_id: string; request_id: string; work_id: string; attempt_id: string; plan_revision: number; report: ReportMissingInput }
type PendingWorkerInput = Omit<AssignmentSupplement, 'clarification_id' | 'source_request_id' | 'message_id' | 'resource_ids'> & { id: string; question: string }
type SurfaceWrite = Extract<ModelRequest, { type: 'write' }> & { input: Extract<Extract<ModelRequest, { type: 'write' }>['input'], { type: 'surface.update' }> }
type SurfaceOperation = SurfaceWrite['input']['operations'][number]
type PreparedView = { op: Extract<SurfaceOperation, { type: 'view.create' | 'view.replace' | 'view.remove' }>; viewId: string; resourceId: string; stageId: string; hash: string; body: Buffer; bundle: Bundle; draft: Record<string, unknown>; hasLocalInput: boolean; answers: number; direct: import('./export-control').ExportResource[]; source?: BundleSource }
export class RuntimeStore {
  private summaryPager = new RepresentationPager()
  private readCursors = new ReadCursors()
  private boundContentReader = new BoundContentReader()
  private db!: Database.Database
  private owner: Database.Database
  private recovery!: RecoveryManager
  private journal!: RestoreJournal
  private exports!: ExportControl
  private exportReaders = new Map<string, { generation: ExportGeneration; cancelling: boolean }>()
  private exportChecks: ExportChecks
  private gc!: RestrictedGc
  private replicas!: ReplicaRetirement
  private resourceCleanup!: ResourceCleanupManager
  private materials!: MaterialImports
  private requests!: RequestQueue
  private plugins!: PluginControl
  private pluginDirectory!: PluginDirectory
  private pluginQueries!: PluginQueries
  private pluginProcesses!: PluginProcesses
  private pluginCalls!: PluginCalls
  private monty!: MontyCalls
  private pluginActions!: PluginActions
  private pluginUploads!: PluginUploads
  private pluginDrafts!: PluginDrafts
  private derivations!: PluginDerivations
  private pluginInvocationSources = new Map<string, PluginActionContext>()
  private pluginIndependentCalls = new Map<string, { task: string; context: PluginActionContext; controller: AbortController }>()
  private pluginChildOwners = new Map<string, string>()
  epoch = id()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private storage!: StorageLifecycle
  private queries: ObjectQueries
  private root: string
  private sync = new TaskSync()
  private syncFacts = new Map<string, { key: string; snapshot: Snapshot }>()
  private closed = false
  private closing = false
  private acceptWork(): void { if (this.closing || this.closed) fail('SHUTTING_DOWN', 'Host is shutting down; no new work is accepted') }
  private agents = new Map<string, { controller: AbortController; main: ModelLease; compact?: ModelLease; manualCompact?: boolean; compactOnly?: boolean; compactUnchanged?: string; messages?: ChatMessage[]; approval?: ModelLease; budget: RunBudget; mode: 'manual' | 'assisted'; managed?: boolean }>()
  private workers = new Map<string, WorkerAgent>()
  private taskRunner?: TaskRunner
  private runnerArtifactState?: RunnerArtifactState
  private runnerCompositionState?: RunnerCompositionState
  private compositionPublications = new Map<string, Promise<PublicationResult>>()
  private chapterFlights = new Map<string, Promise<void>>()
  private continuingContentRemainders = new Set<string>()
  private chapterRoutes = new Map<string, { taskId: string; controller: AbortController; runId: string }>()
  private runnerAdmission = new RunnerAdmission()
  private pendingWorkers = new Map<string, { task: string; work: RunnerAdmissionWork; start(): void; reject(error: unknown): void }>()
  private pumpingWorkers = new Set<string>()
  private preparingRunnerGoals = new Set<string>()
  private recoveringRunnerInputs = new Set<string>()
  private runnerRecoveryFlight?: Promise<void>
  private runnerProgressObservedAt = new Map<string, number>()
  private runnerCompositionMerges = new Map<string, { first: number; latest: number; trigger: string; timer: ReturnType<typeof setTimeout> }>()
  private runnerCompositionWaiting = new Map<string, { trigger: string; previousBatchId?: string }>()
  private runnerCompositionPublishing = new Map<string, PreparedRunnerComposition['batch']>()
  private approvalMode: 'manual' | 'assisted' = 'manual'
  private approvalModel = ''
  private approvalWaiters = new Map<string, { resolve: () => void; timer: ReturnType<typeof setTimeout> }>()
  private surfaceWaiters = new Map<string, { taskId: string; runId: string | null; context?: ExecutionActionContext; request: SurfaceWrite; reset: boolean; expires: string; check(): void; resolve: (proceed: boolean | ContractError) => void; timer: ReturnType<typeof setTimeout> }>()
  private surfaceCompletions = new Map<string, { promise: Promise<void>; resolve(): void }>()
  constructor(directory: string, readonly models = new ModelService(), private features: { viewReplacement: boolean; monty?: boolean; runner?: { productionRuns: 1 | 2; collator?: 'rule' | 'model'; diagnostics?: boolean; conversationRouting?: boolean } } = { viewReplacement: false }, private exportRunner?: ExportRunner, private appRuntime?: string, checkRunner: CheckRunner = backgroundCheck) {
    this.exportChecks = new ExportChecks(checkRunner)
    this.root = directory
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const createEncoding = newTestIdentityEncoding(directory)
    this.owner = ownDirectory(directory)
    try {
    mkdirSync(join(directory, 'resources'), { recursive: true, mode: 0o700 }); assertDirectorySync(join(directory, 'resources'))
    this.plugins = new PluginControl(directory)
    if (this.plugins.error) fail('PLUGIN_CONTROL_INVALID', 'Plugin authority requires inspection; startup is closed')
    this.journal = new RestoreJournal(directory, createEncoding)
    this.journal.selected()
    this.exports = new ExportControl(directory, true, true, this.journal.identityEncoding)
    this.db = prepareBusinessDatabase(directory, this.journal, () => this.plugins.list(), !!this.features.runner?.conversationRouting)
    this.storage = new StorageLifecycle(this.db, this.root, this.epoch, (action, task) => this.pluginActions?.owner(action, task) || this.pluginUploads?.owns(action, task) || false)
    this.recovery = new RecoveryManager(this.db, this.root, () => this.executionBusy(), held => this.storage.pause(held), () => ({ models: this.models.recoverySettings(), approval: { mode: this.approvalMode, model_id: this.approvalModel }, features: { ...this.features } }), this.journal, file => this.rebindDatabase(file), () => this.plugins.list(), () => this.pluginProcesses.stopForRebind(), !!this.features.runner?.conversationRouting)
    this.gc = new RestrictedGc(this.root, () => this.db, () => this.journal.selected(), () => this.journal.retainedDatabases(), key => this.exports.protects(key) || this.journal.resourceRetired(key) || this.recovery.protects(key), () => this.recovery.retainedPointIds(), file => this.journal.retired(file), file => this.journal.released(file), this.journal.identityEncoding)
    this.resourceCleanup = new ResourceCleanupManager(this.root, () => this.db, this.journal, this.recovery, this.gc)
    this.replicas = new ReplicaRetirement(this.root, this.journal, this.recovery, (exclude?: string) => this.gc.assertDependencies(exclude))
    this.materials = new MaterialImports(this.db, this.root, this.epoch, this.storage, this.journal, (task, kind, data) => { this.record(task, kind, data) })
    if ((this.recovery.status() as Row).phase !== 'blocked') this.db.transaction(() => {
      new RunnerHostRecovery(this.db, this.epoch).recover()
      this.db.prepare("UPDATE runs SET state=COALESCE(intended_terminal,'interrupted'), primary_reason=COALESCE(primary_reason,'runtime_restart'), commit_valid=0,ended_at=? WHERE state IN ('running','waiting')").run(now())
      this.db.prepare("UPDATE calls SET state='ended',commit_valid=0,execution=COALESCE(execution,CASE WHEN dispatch='not_sent' THEN 'not_executed' ELSE 'unknown' END),ended_at=? WHERE state!='ended'").run(now())
      this.db.prepare("UPDATE actions SET state='ended',result=COALESCE(result,CASE WHEN state IN ('registered','waiting') AND NOT EXISTS (SELECT 1 FROM calls c WHERE c.id=actions.call_id AND c.dispatch!='not_sent') THEN 'not_executed' ELSE 'unknown' END),commit_valid=0,ended_at=? WHERE state!='ended'").run(now())
      this.db.prepare("UPDATE approvals SET validity='revoked' WHERE validity='valid'").run()
      this.db.prepare("UPDATE requests SET state='cancelled' WHERE state IN ('queued','confirmation_required')").run()
      this.db.prepare("UPDATE tasks SET state='stopped' WHERE state='stopping'").run()
    })()
    if ((this.recovery.status() as Row).phase !== 'blocked') this.storage.recover()
    if ((this.recovery.status() as Row).phase !== 'blocked') for (const taskId of this.journal.deleted()) this.db.prepare("UPDATE tasks SET state='deleting' WHERE id=?").run(taskId)
    if ((this.recovery.status() as Row).phase !== 'blocked') for (const task of this.db.prepare("SELECT id FROM tasks WHERE state='deleting'").all() as Row[]) { this.recovery.invalidateForDelete(task.id); this.purge(task.id) }
    this.initializeRequests()
    this.initializePlugins()
    if ((this.recovery.status() as Row).phase !== 'blocked' && !(this.storage.status() as Row).maintenance_error) this.journal.markStartupVerified(this.db)
    this.queries = new ObjectQueries(this.db, row => ({ id: row.id, revision: row.revision, state_revision: row.state_revision, bundle: this.bundle(row.bundle_resource_id), draft: JSON.parse(row.draft_json) }), objectId => {
      const definitions: Record<string, unknown> = { task_data: { create: coreSchema.$defs.data_value, replace: coreSchema.$defs.write.oneOf[2], remove: coreSchema.$defs.write.oneOf[3], references: 'Same-task resource IDs without revision or task_data IDs with exact expected_revision. No automatic following or recursive expansion. All incoming business references, including stale/self references, block removal; explicitly unlink first. Removal always needs an independent approval.' }, surface: { create: coreSchema.$defs.bundle, update: coreSchema.$defs.write.oneOf[0], state_transition: coreSchema.$defs.state_transition, bundle_input: 'Inline bundle or same-task immutable application/json/application/vnd.pliuna.bundle+json resource; original capacity and full managed validation apply. Resource source is rechecked at commit; approvals bind original request plus resolved content and exact source fingerprint.', personal_export: 'New answer/feedback/mixed_personal export fragments require personal_binding version:1 with an existing same-task answer_id and its exact original view_history_id. Do not bind draft input as an answer.' }, view: coreSchema.$defs.bundle, view_history: { readonly: true, evidence: 'Immutable declared task_data revisions, direct immutable resources only; no recursive following. Saved evidence is not verified truth.', max_sources: defaults.evidence.max_sources, snapshot_bytes: defaults.evidence.snapshot_bytes }, resource: { create: coreSchema.$defs.write.oneOf[4], immutable: true, inline_bytes: defaults.resource.inline_bytes, references: 'task_data may reference same-task immutable resource IDs; no expected_revision on resource targets' } }
      if (!['task', 'surface', 'view', 'view_history', 'task_data', 'answer', 'message', 'event', 'run', 'action', 'approval', 'call', 'resource'].includes(objectId)) return undefined
      return { id: objectId, contract: definitions[objectId] ?? { readonly: true }, enabled: ['surface.update:view.create', ...(this.features.viewReplacement ? ['surface.update:view.replace', 'surface.update:view.remove', 'surface.update:layout.set'] : []), 'task_data.create', 'task_data.replace', 'task_data.remove', 'resource.create', 'surface.update:snapshot_sources'], disabled: [...(!this.monty.available ? ['Monty'] : []), 'scripts', ...(!this.features.viewReplacement ? ['surface.update:view.replace', 'surface.update:view.remove', 'surface.update:layout.set'] : [])] }
    }, row => { this.journal.assertResource(row); return resourceValue(this.root, row as Parameters<typeof resourceValue>[1]) }, row => historyValue(this.db, this.root, row), (row, offset) => this.materials.readText(row, offset), this.root, row => this.journal.assertResource(row), (task, resource) => this.derivations.navigation(task, resource), (task, resource) => this.derivations.fromInput(task, resource), (task, row) => this.checkViewExport(task, row))
    } catch (error) { this.exports?.close(); this.gc?.close(); this.storage?.close(); this.recovery?.close(); this.journal?.close(); this.pluginUploads?.close(); this.pluginActions?.close(); this.pluginCalls?.close(); this.pluginProcesses?.close(); this.plugins?.close(); if (this.db?.open) this.db.close(); this.owner.close(); throw error }
  }
  private initializePlugins(): void {
    this.derivations = new PluginDerivations(this.db, this.root)
    this.derivations.validateStored()
    this.pluginDrafts = new PluginDrafts(defaults.approval.ttl_ms, (identity, task) => this.qualifyPlugin(identity, task))
    this.monty = new MontyCalls(this.db,this.root,this.storage,(task,run)=>{this.qualify(task,run)},(task,refs)=>this.validateDataReferences(task,refs),(task,kind,value)=>this.operationEvent(task,kind,value),this.appRuntime ?? process.execPath,!!this.features.monty)
    this.pluginDirectory = new PluginDirectory(this.root, this.plugins, this.monty.available ? {id:MONTY_ID,description:montyContract.description,contract:montyContract} : undefined)
    this.pluginQueries = new PluginQueries(this.pluginDirectory)
    this.pluginProcesses = new PluginProcesses(this.root, async (copy, task) => {
      this.acceptWork()
      this.task(task)
      if (!this.plugins.available(task, copy.digest)) fail('PLUGIN_DISABLED', 'Plugin is not currently enabled for this task')
      await this.plugins.executable(copy.digest)
    }, (identity, method, params) => this.pluginCallback(identity, method, params), () => { if (!this.closed) { this.pluginActions?.check(); this.pluginUploads?.check(); for (const pending of this.pluginIndependentCalls.values()) { try { pending.context.valid() } catch { pending.controller.abort() } }; this.settlePluginCleanup() } }, this.appRuntime, event => this.pluginInstanceEvent(event))
    this.pluginActions = new PluginActions(this.db, this.epoch, (identity, task) => this.qualifyPlugin(identity, task), (task, raw, context) => this.executePluginAction(task, raw, context), (identity, action, status) => this.pluginProcesses.changed(identity, action, status), identity => identity.call_id ? this.pluginCalls.source(identity.call_id)?.source : undefined)
    this.pluginUploads = new PluginUploads(this.db, this.root, this.epoch, this.storage, (identity, task, call) => {
      this.qualifyPlugin({ ...identity, call_id: call }, task)
      if (identity.call_id !== call) fail('PLUGIN_UPLOAD_SOURCE_INVALID', 'Upload must belong to the active call on this connection')
      const source = this.pluginCalls.source(call), row = this.db.prepare('SELECT commit_valid,state FROM calls WHERE id=?').get(call) as Row | undefined
      if (!source || source.digest !== identity.digest || !row?.commit_valid || !['executing', 'finalizing'].includes(row.state)) fail('PLUGIN_UPLOAD_SOURCE_INVALID', 'Call is no longer executable')
    }, resource => this.journal.assertResource({ id: resource, storage_key: resource }), (identity, task) => this.qualifyPlugin(identity, task))
    this.pluginCalls = new PluginCalls(this.db, this.epoch, this.plugins, this.pluginDirectory, this.pluginProcesses, (task, references) => this.validateDataReferences(task, references as any), (task, kind, data) => { this.operationEvent(task, kind, data) }, call => this.pluginUploads.commit(call), (call, success) => { this.pluginUploads.settled(call, success); this.pluginActions.check() }, (task, call, instance, digest, global, bytes) => this.pluginUploads.receiveResult({ instance_id: instance, digest, task_id: global ? null : task, call_id: call }, task, call, bytes), this.derivations)
  }
  private qualifyPlugin(identity: PluginIdentity, task: string): void {
    this.acceptWork()
    this.recovery.assertWrite()
    if (this.closed || !this.pluginProcesses.live(identity) || (identity.task_id !== null && identity.task_id !== task) || !this.plugins.available(task, identity.digest) || this.task(task).state !== 'active') fail('PLUGIN_SOURCE_INVALID', 'Plugin connection, scope or task is no longer valid')
    if (identity.call_id) {
      const source = this.pluginCalls.source(identity.call_id)
      if (!source || source.instance !== identity.instance_id || source.task !== task || source.controller.signal.aborted) fail('PLUGIN_SOURCE_INVALID', 'Parent call ended; late actions are rejected')
      source.source.valid()
    }
  }
  private executePluginAction(task: string, raw: unknown, context: PluginActionContext): Promise<unknown> {
    context.valid()
    const request = validateModel({ type: 'write', input: raw })
    context.authorize?.(request)
    if (request.type !== 'write') fail('INVALID_REQUEST', 'Mutation required')
    if (request.input.type === 'task_data.create' || request.input.type === 'task_data.replace' || request.input.type === 'task_data.remove') return this.dataWrite(task, null, request.input, context.signal, context)
    if (request.input.type === 'resource.create') return Promise.resolve(this.resourceCreate(task, null, request.input, context))
    if (request.input.type === 'surface.update') {
      const surface = request as SurfaceWrite
      if (surface.input.operations.some(op => op.type !== 'view.create')) return this.replaceSurface(task, null, surface, context.signal, context)
      return Promise.resolve(this.publish(task, null, request, context))
    }
    return Promise.reject(new ContractError('PLUGIN_ACTION_UNSUPPORTED', 'Mutation unsupported'))
  }
  private sourceValid(task: string, run: string | null, context?: ExecutionActionContext): void {
    if (context) context.valid()
    else if (run) this.qualify(task, run)
    else fail('SOURCE_INVALID', 'No live execution source')
  }
  private actionState(runId: string | null, state: 'running' | 'waiting', reason?: string, context?: ExecutionActionContext): void {
    if (context?.hostPublication && context.owner) {
      context.valid()
      const work = new RunnerWorkState(this.db, this.epoch), attempt = work.attempt(context.owner.attempt_id)
      work.updateAttempt({ ...attempt, state })
      this.db.prepare('UPDATE runs SET state=?,wait_reason=? WHERE id=? AND commit_valid=1').run(state, reason ?? null, runId)
      if (context.owner.purpose === 'production' && context.owner.update_id) {
        this.chapters().state.stage(context.owner.task_id, context.owner.update_id, state === 'waiting' ? reason === 'approval' ? 'waiting_approval' : 'waiting_input' : 'publishing')
        this.record(context.owner.task_id, 'chapter.update.stage', { update_id: context.owner.update_id, state, reason })
      }
    } else if (context?.owner) {
      const worker = this.workers.get(context.owner.attempt_id)
      if (!worker) fail('RUNNER_OWNERSHIP_INVALID', 'Action attempt is unavailable')
      this.workerState(worker!, state, reason)
    } else this.db.prepare('UPDATE runs SET state=?,wait_reason=? WHERE id=? AND commit_valid=1').run(state, reason ?? null, runId)
  }
  private restoreActionState(runId: string | null, context?: ExecutionActionContext): void {
    if (this.closed) return
    try { this.actionState(runId, 'running', undefined, context) } catch (error) {
      if (!context?.owner || !(error instanceof ContractError)) throw error
    }
  }
  private invokePlugin(task: string, run: string, input: Extract<ModelRequest, { type: 'call' }>['input'], signal: AbortSignal, worker?: WorkerAgent): Promise<unknown> {
    const valid = () => { this.qualify(task, run); if (worker) this.qualifyWorker(worker.owner.attempt_id) }
    const context = (action: string, cancellation: AbortSignal): ExecutionActionContext | undefined => worker ? { id: action, signal: cancellation, owner: worker.owner, valid, authorize: (request: ModelRequest) => worker.profile.authorize(request) } : undefined
    return this.pluginCalls.call(task, input.capability, input.arguments, input.references, { run_id: run, chain: [], signal, valid, ...(worker ? { owner: worker.owner, authorize: (request: ModelRequest) => worker.profile.authorize(request) } : {}), approve: (action, request, cancellation) => this.awaitApproval(task, run, action, request, cancellation, 'plugin-invoke-v1', context(action, cancellation)), checkApproval: (action, request) => this.checkApproval(action, request, task, run, 'plugin-invoke-v1') })
  }
  private pluginCallback(identity: { instance_id: string; digest: string; task_id: string | null; call_id: string | null }, method: string, params: Record<string, unknown>): unknown {
    if (!this.pluginProcesses.live(identity)) fail('PLUGIN_SOURCE_INVALID', 'Connection is no longer valid')
    const schemas: Record<string, string> = { 'host.describe': 'plugin_host_describe', 'objects.list': 'plugin_objects_list', 'objects.read': 'plugin_objects_read', 'resources.read_bytes': 'plugin_resource_bytes', 'materials.derive': 'plugin_derivation', 'tools.call': 'plugin_tools_call', 'tools.get': 'plugin_call_selector', 'tools.cancel': 'plugin_call_selector', 'actions.submit': 'plugin_actions_submit', 'actions.get': 'plugin_action_selector', 'surface.stage': 'plugin_surface_stage', 'execution.wait': 'plugin_execution_wait', 'upload.begin': 'upload_begin', 'upload.chunk': 'upload_chunk', 'upload.finish': 'plugin_upload_selector', 'upload.abort': 'plugin_upload_selector' }
    if (!schemas[method]) throw new RpcError(-32601, 'Plugin method is not enabled')
    try { assertContract(schemas[method]!, params) } catch { throw new RpcError(-32602, 'Parameters do not match the declared method schema') }
    const task = params.task_id
    const allowed = (target: unknown): string => {
      if (typeof target !== 'string' || (identity.task_id !== null && identity.task_id !== target) || !this.plugins.available(target, identity.digest)) fail('PLUGIN_SCOPE_DENIED', 'Connection cannot access this task')
      if (identity.call_id) { const source = this.pluginCalls.source(identity.call_id); if (!source || source.task !== target || source.instance !== identity.instance_id || source.controller.signal.aborted) fail('PLUGIN_SCOPE_DENIED', 'A tool service connection is bound to its current call task'); source.source.valid() }
      this.task(target as string); return target as string
    }
    if (method === 'host.describe') {
      if (Object.keys(params).join(',') !== 'protocol_version' || params.protocol_version !== '0.1') throw new RpcError(-32602, 'Unsupported protocol or params')
      return { protocol_version: '0.1', access_level: identity.task_id === null ? 'global' : 'task', profiles: ['managed-v1'], limits_version: defaults.version, quotas: defaults.transport }
    }
    if (method === 'objects.list' || method === 'objects.read') {
      if (Object.keys(params).sort().join(',') !== 'input,task_id') throw new RpcError(-32602, 'Invalid query params')
      const target = allowed(task), query = validateModel({ type: method === 'objects.list' ? 'list' : 'read', input: params.input })
      if (query.type !== 'list' && query.type !== 'read') throw new RpcError(-32602, 'Invalid query')
      const source = identity.call_id ? this.pluginCalls.source(identity.call_id)?.source : undefined
      source?.authorize?.(query)
      return Promise.resolve(this.query(target, query, source?.owner?.attempt_id ?? 'plugin:' + identity.instance_id)).then(result => { if (!this.pluginProcesses.live(identity)) fail('PLUGIN_SOURCE_INVALID', 'Connection ended during query'); allowed(target); source?.authorize?.(query); return result })
    }
    if (method === 'resources.read_bytes' || method === 'materials.derive') {
      const target = allowed(task)
      if (!identity.call_id) fail('PLUGIN_SOURCE_INVALID', 'Binary reads and derivation require a live Call')
      const call = identity.call_id!
      const source = this.pluginCalls.source(call)?.source
      if (source?.authorize) {
        if (method === 'materials.derive') fail('WORKER_CAPABILITY_DENIED', 'Worker profile does not grant this host operation')
        source.authorize(validateModel({ type: 'read', input: { target: { kind: 'resource', id: params.resource_id } } }))
      }
      const valid = () => {
        allowed(target); this.qualifyPlugin(identity, target)
        const row = this.db.prepare('SELECT state,commit_valid FROM calls WHERE id=?').get(call) as Row | undefined
        if (!row?.commit_valid || row.state !== 'executing') fail('PLUGIN_SOURCE_INVALID', 'Call is no longer accepting material work')
      }
      valid()
      if (method === 'materials.derive') return this.derivations.propose(call, params)
      const database = this.db, epoch = this.epoch
      const resource = this.one('SELECT r.* FROM resources r JOIN task_resources t ON t.resource_id=r.id WHERE t.task_id=? AND r.id=?', target, params.resource_id)
      const check = () => {
        if (this.db !== database || this.epoch !== epoch) fail('PLUGIN_SOURCE_INVALID', 'Runtime changed during binary read')
        valid(); this.journal.assertResource(resource)
        const current = database.prepare('SELECT r.* FROM resources r JOIN task_resources t ON t.resource_id=r.id WHERE t.task_id=? AND r.id=?').get(target, resource.id)
        if (!current || json(current) !== json(resource)) fail('PLUGIN_SOURCE_INVALID', 'Resource association changed during read')
      }
      return readPluginBytes(this.root, resource as any, params.offset as number, params.length as number, check).then(result => { check(); this.derivations.read(call, resource); return result })
    }
    if (method === 'execution.wait') {
      if (Object.keys(params).join(',') !== 'waiting' || typeof params.waiting !== 'boolean' || !identity.call_id) throw new RpcError(-32602, 'A live call and waiting flag are required')
      const call = this.pluginCalls.source(identity.call_id)
      if (!call || call.instance !== identity.instance_id) fail('PLUGIN_SOURCE_INVALID', 'Call connection changed')
      const pending = this.db.prepare("SELECT p.id FROM approvals p JOIN actions a ON a.id=p.action_id LEFT JOIN calls c ON c.id=a.call_id WHERE p.decision='pending' AND p.validity='valid' AND p.expires_at>? AND a.state='waiting' AND (a.call_id=? OR c.parent_call_id=?) LIMIT 1").get(now(), identity.call_id, identity.call_id)
      if (params.waiting && !pending) fail('PLUGIN_WAIT_INVALID', 'No current related approval is pending')
      this.pluginProcesses.waiting(identity.call_id, params.waiting)
      this.db.prepare('UPDATE calls SET wait_reason=? WHERE id=?').run(params.waiting ? 'plugin_approval' : null, identity.call_id)
      return { waiting: params.waiting, wall_clock_continues: true }
    }
    if (identity.call_id && (method === 'actions.submit' || method === 'surface.stage' || method === 'tools.call' || method.startsWith('upload.'))) {
      const call = this.db.prepare('SELECT wait_reason FROM calls WHERE id=?').get(identity.call_id) as Row | undefined
      if (call?.wait_reason === 'plugin_approval' || call?.wait_reason === 'result_storage') fail('PLUGIN_SOURCE_WAITING', 'Exit validated waiting or finalization before submitting business work')
    }
    if (method.startsWith('tools.')) return this.pluginToolCallback(identity, method, params)
    if (method.startsWith('upload.')) return this.pluginUploads.handle(identity, method, params)
    if (method === 'surface.stage') {
      if (Object.keys(params).sort().join(',') !== 'mutation,task_id') throw new RpcError(-32602, 'Invalid Surface draft params')
      const target = allowed(task), request = validateModel({ type: 'write', input: params.mutation })
      if (request.type !== 'write' || request.input.type !== 'surface.update') throw new RpcError(-32602, 'Surface mutation required')
      const source = identity.call_id ? this.pluginCalls.source(identity.call_id)?.source : undefined
      source?.authorize?.(request)
      if (request.input.operations.some(op => op.type !== 'view.create') && !this.features.viewReplacement) fail('CAPABILITY_DISABLED', 'View replacement remains disabled')
      const context: PluginActionContext = { id: '', identity, signal: new AbortController().signal, ...(source?.owner ? { owner: source.owner } : {}), ...(source?.authorize ? { authorize: source.authorize } : {}), valid: () => { this.qualifyPlugin(identity, target); source?.authorize?.(request) } }
      return this.pluginDrafts.stage(identity, target, request.input, () => {
        const prepared = this.inspectReplacement(target, null, request.input as SurfaceWrite['input'], context)
        captureEvidence(this.db, this.root, target, request.input.type === 'surface.update' ? request.input.snapshot_sources : undefined)
        return () => { for (const p of prepared) if (p.source && p.op.type !== 'view.remove') { const current = loadBundleSource(this.db, this.root, target, p.op.bundle, resource => this.journal.assertResource(resource)); if (json(current.source) !== json(p.source) || json(current.bundle) !== json(p.bundle)) fail('RESOURCE_CHANGED', 'Bundle source changed since staging; stage a new draft') } }
      })
    }
    if (method === 'actions.submit') {
      if (Object.keys(params).sort().join(',') === 'invocation,task_id') {
        if (identity.call_id) throw new RpcError(-32602, 'Use tools.call for a live parent call')
        const target = allowed(task), request = validateModel({ type: 'call', input: params.invocation })
        if (request.type !== 'call') throw new RpcError(-32602, 'Invocation required')
        return this.submitPluginInvocation(identity, target, request.input)
      }
      if (Object.keys(params).sort().join(',') === 'action,task_id') {
        const action = params.action as Row | null
        if (action?.type === 'resource.upload') {
          const source = identity.call_id ? this.pluginCalls.source(identity.call_id)?.source : undefined
          if (source?.authorize) fail('WORKER_CAPABILITY_DENIED', 'Worker profile does not grant this host operation')
          const { type: _, ...declaration } = action; return this.pluginUploads.register(identity, allowed(task), declaration)
        }
        if (!action || Object.keys(action).sort().join(',') !== 'draft_id,type' || action.type !== 'surface.commit' || typeof action.draft_id !== 'string') throw new RpcError(-32602, 'Immutable Surface draft selector required')
        const target = allowed(task)
        const draft = action.draft_id
        return this.pluginDrafts.submit(identity, target, draft, (value, check) => this.pluginActions.submit(identity, target, value, check))
      }
      if (Object.keys(params).sort().join(',') !== 'mutation,task_id') throw new RpcError(-32602, 'Invalid action params')
      const target = allowed(task), request = validateModel({ type: 'write', input: params.mutation })
      if (request.type !== 'write') throw new RpcError(-32602, 'Mutation required')
      if (request.input.type === 'surface.update') throw new RpcError(-32602, 'Surface changes require surface.stage followed by a surface.commit action')
      this.qualifyPlugin(identity, target)
      return this.pluginActions.submit(identity, target, request.input)
    }
    if (method === 'actions.get') {
      if (Object.keys(params).join(',') !== 'action_id' || typeof params.action_id !== 'string') throw new RpcError(-32602, 'Invalid action selector')
      return this.pluginActions.get(identity, params.action_id)
    }
    throw new RpcError(-32601, 'Plugin method is not enabled')
  }
  private submitPluginInvocation(identity: PluginIdentity, task: string, input: Extract<ModelRequest, { type: 'call' }>['input']): unknown {
    this.qualifyPlugin(identity, task)
    if (this.pluginIndependentCalls.size >= 100 || [...this.pluginIndependentCalls.values()].filter(p => p.context.identity.instance_id === identity.instance_id).length >= 20) fail('PLUGIN_ACTION_LIMIT', 'Too many independent invocations')
    const action = id(), controller = new AbortController()
    const valid = () => { if (controller.signal.aborted || this.closed) fail('PLUGIN_SOURCE_INVALID', 'Independent invocation ended'); this.qualifyPlugin(identity, task) }
    const context: PluginActionContext = { id: action, identity, signal: controller.signal, valid }
    this.db.prepare("INSERT INTO actions (id,task_id,kind,state,source_json,request_json,commit_valid,created_at) VALUES (?,?,'invocation','registered',?,?,1,?)").run(action, task, json({ type: 'plugin', instance_id: identity.instance_id, package_digest: identity.digest, epoch: this.epoch }), json(input), now())
    this.pluginIndependentCalls.set(action, { task, context, controller })
    setImmediate(() => {
      if (this.closed) return
      void this.pluginCalls.call(task, input.capability, input.arguments, input.references, {
        run_id: null, action_id: action, instance_id: identity.instance_id, chain: [], signal: controller.signal, valid,
        approve: async (owner, request, signal) => {
          this.pluginInvocationSources.set(owner, context)
          try { await this.awaitApproval(task, null, owner, request, signal, 'plugin-invoke-v1', context) }
          finally { this.pluginInvocationSources.delete(owner) }
        },
        checkApproval: (owner, request) => this.checkApproval(owner, request, task, null, 'plugin-invoke-v1')
      }, call => { if (this.pluginChildOwners.size >= 1000) this.pluginChildOwners.delete(this.pluginChildOwners.keys().next().value!); this.pluginChildOwners.set(call, identity.instance_id) }).catch(error => {
        if (!this.closed) this.db.prepare("UPDATE actions SET state='ended',result='not_executed',commit_valid=0,result_json=?,ended_at=? WHERE id=? AND state!='ended'").run(json({ code: error instanceof ContractError ? error.code : 'PLUGIN_CALL_FAILED' }), now(), action)
      }).finally(() => {
        controller.abort(); this.pluginIndependentCalls.delete(action)
        if (!this.closed) { const row = this.one('SELECT result FROM actions WHERE id=?', action); this.pluginProcesses.changed(identity, action, row.result ?? 'unknown') }
      })
    })
    return { action_id: action, status: 'registered' }
  }
  private pluginToolCallback(identity: PluginIdentity, method: string, params: Record<string, unknown>): unknown {
    if (method === 'tools.get' || method === 'tools.cancel') {
      if (Object.keys(params).join(',') !== 'call_id' || typeof params.call_id !== 'string' || this.pluginChildOwners.get(params.call_id) !== identity.instance_id || !this.pluginProcesses.live(identity)) throw new RpcError(-32602, 'Call does not belong to this connection')
      const unavailable = (): never => { throw new RpcError(-32602, 'Call does not belong to this connection') }
      const row = this.db.prepare('SELECT task_id,parent_call_id,limits_json FROM calls WHERE id=?').get(params.call_id) as Row | undefined
      if (!row || identity.task_id !== null && identity.task_id !== row.task_id) return unavailable()
      const source = identity.call_id ? this.pluginCalls.source(identity.call_id) : undefined
      if (source && (source.task !== row.task_id || source.instance !== identity.instance_id)) return unavailable()
      let current: ExecutionScope | undefined, stored: ExecutionScope | undefined
      try {
        current = captureExecutionScope(source?.source.owner, row.task_id)
        stored = captureExecutionScope(JSON.parse(row.limits_json).owner, row.task_id)
      } catch { return unavailable() }
      if (current) {
        if (!stored || Object.keys(current).length !== Object.keys(stored).length || Object.entries(current).some(([key, value]) => Reflect.get(stored!, key) !== value)) return unavailable()
      } else if (stored && row.parent_call_id !== identity.call_id) return unavailable()
      this.qualifyPlugin(identity, row.task_id)
      source?.source.valid()
      if (method === 'tools.cancel') this.pluginCalls.cancel(params.call_id)
      return this.pluginCalls.status(params.call_id)
    }
    if (method !== 'tools.call') throw new RpcError(-32601, 'Unknown tool method')
    if (Object.keys(params).sort().join(',') !== 'arguments,capability,references,task_id' || typeof params.task_id !== 'string') throw new RpcError(-32602, 'Invalid call parameters')
    const request = validateModel({ type: 'call', input: { capability: params.capability, arguments: params.arguments, references: params.references } })
    if (request.type !== 'call') throw new RpcError(-32602, 'Call required')
    const task = params.task_id
    this.qualifyPlugin(identity, task)
    if (!identity.call_id) throw new RpcError(-32602, 'Nested tool call requires a live parent; independent invocation must be an action')
    const parent = this.pluginCalls.source(identity.call_id)
    if (!parent || parent.instance !== identity.instance_id || parent.task !== task) fail('PLUGIN_SOURCE_INVALID', 'Parent call unavailable')
    const active = parent!
    const valid = () => {
      this.qualifyPlugin(identity, task)
      const row = this.db.prepare('SELECT state,commit_valid FROM calls WHERE id=?').get(identity.call_id!) as Row | undefined
      if (!row?.commit_valid || row.state === 'ended' || active.controller.signal.aborted) fail('PLUGIN_SOURCE_INVALID', 'Parent call ended or was cancelled')
    }
    const owner = active.source.owner
    const accounting = owner ? new RunnerBudgetAccounting(new RunnerBudgetLedger(this.db), { task_id: task, budget_id: new RunnerWorkState(this.db, this.epoch).run(owner.run_id).budget_id, attempt_id: owner.attempt_id }) : undefined
    return new Promise((resolve, reject) => {
      void this.pluginCalls.call(task, request.input.capability, request.input.arguments, request.input.references, {
        run_id: active.source.run_id, parent_call_id: identity.call_id!, instance_id: identity.instance_id, chain: active.source.chain, signal: active.controller.signal, valid, ...(active.source.owner ? { owner: active.source.owner } : {}), ...(active.source.authorize ? { authorize: active.source.authorize } : {}),
        ...(accounting ? { accountTool: (operation: string, phase: ToolAccountingPhase) => { accounting.tool(operation, phase) } } : {}),
        approve: async (action, input, signal) => {
          const context: PluginActionContext = { id: action, identity, signal, valid, ...(active.source.owner ? { owner: active.source.owner } : {}), ...(active.source.authorize ? { authorize: active.source.authorize } : {}) }
          this.pluginInvocationSources.set(action, context)
          try { await this.awaitApproval(task, active.source.run_id, action, input, signal, 'plugin-invoke-v1', context) }
          finally { this.pluginInvocationSources.delete(action) }
        },
        checkApproval: (action, input) => this.checkApproval(action, input, task, active.source.run_id, 'plugin-invoke-v1')
      }, call => { if (this.pluginChildOwners.size >= 1000) this.pluginChildOwners.delete(this.pluginChildOwners.keys().next().value!); this.pluginChildOwners.set(call, identity.instance_id); resolve({ call_id: call, status: 'registered' }) }).then(result => {
        // Results stay on the durable Call and are retrieved by ID; no tool is re-executed for delivery.
        if (!this.closed) this.pluginProcesses.changed(identity, String((result as Row).operation_id), 'call_ended')
      }, reject)
    })
  }
  private async pluginConfiguration(raw: unknown): Promise<unknown> {
    this.acceptWork()
    assertContract<import('../shared/contracts.generated').HostPluginRequest>('host_plugin_request', raw)
    const request = raw
    const idle = (task: string | null): void => {
      this.recovery.assertWrite()
      if (task === null ? this.executionBusy() : this.pluginProcesses.cleaning(task) || this.db.prepare("SELECT id FROM runs WHERE task_id=? AND state IN ('running','waiting') UNION ALL SELECT id FROM actions WHERE task_id=? AND state!='ended' UNION ALL SELECT id FROM calls WHERE task_id=? AND state!='ended' LIMIT 1").get(task, task, task)) fail('PLUGIN_CONFIGURATION_BUSY', 'Wait for related executions and approvals before changing plugins')
    }
    if (request.type === 'plugin.list') { this.task(request.task_id); const page = this.pluginDirectory.list(request.task_id, request.before) as Row; return { ...page, items: page.items.map((p: Row) => ({ ...p, instances: this.pluginProcesses.status(request.task_id, p.digest), unsupported: this.plugins.unsupported(p.digest) })) } }
    if (request.type === 'plugin.content') { this.task(request.task_id); return this.pluginDirectory.content(request.task_id, request.digest, request.contribution_id, request.offset) }
    if (request.type === 'plugin.plan') { this.task(request.task_id); return this.plugins.plan(request.task_id, request.digest, request.choices) }
    if (request.type !== 'plugin.disable' && request.type !== 'plugin.revoke') this.recovery.assertWrite()
    switch (request.type) {
      case 'plugin.internal.install': idle(null); { const copy = await this.plugins.install(request.source); this.requests.invalidateConfiguration(); return { digest: copy.digest, manifest: copy.manifest } }
      case 'plugin.trust': await this.plugins.grant(request.digest, { local_code: request.confirm_local_code, cross_task: request.confirm_cross_task }); break
      case 'plugin.enable': this.task(request.task_id); await this.plugins.enable(request.task_id, request.digest, request.choices ?? [], request.fingerprint, request.confirm_cross_task, idle); break
      case 'plugin.workflow': this.task(request.task_id); this.plugins.selectWorkflow(request.task_id, request.selection, idle); break
      case 'plugin.disable': this.plugins.disable(request.digest, request.task_id); this.pluginDrafts.revoke(request.digest); for (const pending of this.pluginIndependentCalls.values()) { try { pending.context.valid() } catch { pending.controller.abort() } }; this.pluginCalls.revoke(); this.pluginActions.check(); this.pluginUploads.check(); this.pluginProcesses.revoke(request.digest, request.task_id); this.pluginProcesses.reconcile((task, digest) => this.plugins.available(task, digest)); break
      case 'plugin.revoke': this.plugins.revoke(request.digest); this.pluginDrafts.revoke(request.digest); for (const pending of this.pluginIndependentCalls.values()) { try { pending.context.valid() } catch { pending.controller.abort() } }; this.pluginCalls.revoke(); this.pluginActions.check(); this.pluginUploads.check(); this.pluginProcesses.revoke(request.digest); this.pluginProcesses.reconcile((task, digest) => this.plugins.available(task, digest)); break
      default: fail('PLUGIN_HOST_ONLY', 'Select a plugin directory through the native host picker')
    }
    this.requests.invalidateConfiguration(); return { updated: true }
  }
  private initializeRequests(): void {
    this.requests = new RequestQueue(this.db, this.epoch, config => this.requestSelection(config), (task, resource) => this.requestMaterial(task, resource), (task, text, config, attachments, request) => this.startQueuedRequest(task, text, config, attachments, request), () => !this.closing && !this.closed && (this.recovery.status() as Row).phase === 'idle', async (task, resources) => {
      for (const resource of resources) {
        this.acceptWork()
        const row = this.one('SELECT r.* FROM resources r JOIN task_resources t ON t.resource_id=r.id WHERE t.task_id=? AND r.id=?', task, resource.id)
        await readPluginResource(this.root, row as any, 0, true)
        this.acceptWork()
        this.journal.assertResource(row)
        const current = this.one('SELECT r.* FROM resources r JOIN task_resources t ON t.resource_id=r.id WHERE t.task_id=? AND r.id=?', task, resource.id)
        if (json(current) !== json(row)) fail('REQUEST_MATERIAL_UNAVAILABLE', 'Material changed during final verification')
      }
    }, (task, request) => this.requestAdmissionAvailable(task, request), this.features.runner ? (task, request, input) => {
      const conversation = captureConversation(this.db, task)
      const record = this.record(task, 'message.user', { text: input.text, request_id: request, resource_ids: input.resource_ids, import_ids: input.import_ids })
      return { conversation, user_record_id: record }
    } : undefined)
    if (this.closing) this.requests.close()
  }
  private requestAdmissionAvailable(task: string, request: string): boolean {
    if (!this.features.runner?.conversationRouting) return this.runnerRunAvailable(task, request)
    const row = this.one('SELECT input_json,config_selection_json FROM requests WHERE task_id=? AND id=?', task, request)
    const input = JSON.parse(row.input_json)
    if (input.correction_pending) return this.runnerRunAvailable(task, input.corrects_request_id)
    if (input.admission_route || JSON.parse(row.config_selection_json).id === 'fixture') return this.runnerRunAvailable(task, request)
    // Routing does not occupy a production slot. The shared scheduler owns network limits.
    return [...this.chapterRoutes.values()].filter(route => route.taskId === task).length < defaults.queues.model_active_app
  }
  private publishedChapterManifests(task: string): ChapterManifest[] {
    return (this.db.prepare('SELECT v.id,v.revision,v.bundle_resource_id FROM views v JOIN surfaces s ON s.id=v.surface_id WHERE s.task_id=? ORDER BY v.rowid').all(task) as Row[]).flatMap(view => {
      const manifest = this.chapters().state.manifest(task, view.id)
      if (!manifest || manifest.view_revision !== view.revision || manifest.bundle_resource_id !== view.bundle_resource_id) return []
      return [manifest]
    })
  }
  private startQueuedRequest(task: string, text: string, config: string, attachments: Row[], requestId: string): string | Promise<string> {
    if (!this.features.runner) return this.start(task, text, config, attachments, requestId)
    if (this.features.runner.conversationRouting) {
      const row = this.one("SELECT input_json,config_selection_json FROM requests WHERE task_id=? AND id=? AND state='queued'", task, requestId)
      const input = JSON.parse(row.input_json), dependency = input.conversation_dependency
      if (input.correction_pending) {
        if (config === 'fixture') fail('MODEL_NOT_CONFIGURED', 'Select a configured model to continue the correction')
        const plan = conversationContentPlan(this.db, task, input.user_record_id)
        if (!plan || plan.request_id !== input.corrects_request_id) fail('CONVERSATION_REFERENCE_INVALID', 'Correction no longer identifies a saved content plan')
        return this.startRunnerGoal(task, plan.request_id, plan.intent_revision, { id: requestId, row, materials: attachments.map(item => this.requestMaterial(task, item.id)) }).then(run => run ?? '')
      }
      if (config === 'fixture') return this.start(task, text, config, attachments, requestId)
      if (dependency && !dependency.result_id) {
        const result = conversationDependencyResult(this.db, task, dependency.message_id, dependency.request_id)
        if (!result) {
          const parent = this.one('SELECT state FROM requests WHERE task_id=? AND id=?', task, dependency.request_id)
          const live = conversationDependencyRunning(this.db, task, dependency.message_id, dependency.request_id)
          if (!live && !['queued', 'confirmation_required'].includes(parent.state) && !this.awaitingContentPublication(task, dependency.message_id)) {
            this.db.transaction(() => {
              this.db.prepare("UPDATE requests SET state='rejected',input_json=? WHERE task_id=? AND id=? AND state='queued'").run(json({ ...input, code: 'CONVERSATION_DEPENDENCY_UNAVAILABLE' }), task, requestId)
              this.record(task, 'conversation.dependency.ended', { request_id: requestId, preceding_request_id: dependency.request_id, preceding_message_id: dependency.message_id, code: 'CONVERSATION_DEPENDENCY_UNAVAILABLE' })
            })()
          }
          return ''
        }
        this.db.prepare("UPDATE requests SET input_json=? WHERE task_id=? AND id=? AND state='queued' AND input_json=?").run(json({ ...input, code: null, conversation_dependency: { ...dependency, result_id: result.id } }), task, requestId, row.input_json)
        // The next sweep uses the updated input for both admission and errors.
        return ''
      }
    }
    if (config === 'fixture') return this.start(task, text, config, attachments, requestId)
    const views = this.db.prepare('SELECT v.id AS viewId FROM views v JOIN surfaces s ON s.id=v.surface_id WHERE s.task_id=?').all(task) as { viewId: string }[]
    if (!views.length && !this.features.runner.conversationRouting) return this.start(task, text, config, attachments, requestId)
    this.registerPublishedChapters(task, views)
    const manifests = this.publishedChapterManifests(task)
    return this.routeChapterRequest(task, text, config, attachments, requestId, manifests)
  }
  private async routeChapterRequest(task: string, text: string, config: string, attachments: Row[], requestId: string, manifests: ChapterManifest[]): Promise<string> {
    const row = this.one("SELECT id,input_json,config_selection_json FROM requests WHERE task_id=? AND id=? AND state='queued'", task, requestId)
    const input = JSON.parse(row.input_json), selection = JSON.parse(row.config_selection_json), dialogue = this.features.runner?.conversationRouting === true
    const history = loadConversation(this.db, task, input.conversation)
    const boundResult = this.boundConversationResult(task, input.conversation_dependency)
    const clarifications = dialogue ? this.db.prepare(`SELECT r.id,q.id AS request_id,substr(json_extract(r.payload_json,'$.text'),1,250) AS question FROM records r JOIN requests q
      ON q.task_id=r.task_id AND q.id=json_extract(r.payload_json,'$.request_id') WHERE r.task_id=? AND r.kind='chapter.route.clarification'
      AND r.sequence<=? AND q.state='confirmation_required' AND json_extract(q.input_json,'$.code')='CHAPTER_SCOPE_REQUIRED'
      ORDER BY r.sequence DESC LIMIT 16`).all(task, input.conversation.through_sequence) : []
    const pendingWorkerInputs = dialogue ? this.pendingWorkerInputs(task, input.conversation.through_sequence) : []
    const materials = dialogue ? attachments.map(item => this.requestMaterial(task, item.id)) : []
    const grants: WorkerGrant[] = []
    if (materials.length) grants.push({ type: 'read', kind: 'resource', ids: materials.map(item => item.id) })
    if (dialogue) grants.push({ type: 'list', kind: 'event' }, { type: 'read', kind: 'event' })
    const profile = dialogue ? createConversationRouterProfile(manifests, grants) : createChapterRouterProfile(manifests)
    const savedRoute = input.admission_route as ConversationRoute | undefined
    const priorDelivery = dialogue && !savedRoute ? precedingDelivery(this.db, task, input.conversation) : undefined
    const workTable = dialogue && !savedRoute ? this.routingWorkTable(new RunnerWorkState(this.db, this.epoch), task, { model_config_id: selection.id, model_config_revision: selection.revision }) : []
    const lease = this.models.acquire(config, 'main'), controller = new AbortController(), operation = id()
    let routingRun: string | undefined
    if (!savedRoute) this.chapterRoutes.set(requestId, { taskId: task, controller, runId: operation })
    const valid = () => {
      this.acceptWork(); this.recovery.assertWrite()
      if (controller.signal.aborted || this.task(task).state !== 'active') fail('SOURCE_INVALID', 'Chapter routing was cancelled')
      if (routingRun) this.qualify(task, routingRun)
      const current = this.one('SELECT state,input_json,config_selection_json FROM requests WHERE task_id=? AND id=?', task, requestId)
      if (current.state !== 'queued' || current.input_json !== row.input_json || current.config_selection_json !== row.config_selection_json || lease.revision !== selection.revision) fail('REQUEST_SOURCE_INVALID', 'Chapter routing no longer matches its accepted input')
    }
    lease.evidence = event => { valid(); return this.record(task, 'model.request.evidence', { ...event, routing_operation_id: operation, input_request_id: requestId }) }
    lease.accounting = event => { if (['reserved', 'dispatched'].includes(event.phase)) valid(); this.record(task, 'model.request.accounting', { ...event, routing_operation_id: operation }) }
    try {
      valid()
      const content = new AssignmentContent(this.db), contentScope = content.scope(task, requestId, materials.map(material => material.id))
      const catalog = new RoutingInputCatalog(this.db, contentScope, () => this.catalogOutputs(task))
      const workState = new RunnerWorkState(this.db, this.epoch)
      const checkOutput = (binding: RouteWorkRunnerOutputBinding, assignment: string) => {
        try { this.routedOutputSource(workState, task, binding) }
        catch (error) {
          if (!(error instanceof ContractError)) throw error
          fail(error.code, `Assignment ${assignment}: output ${binding.work_id}/${binding.output_key}: ${error.message}`)
        }
      }
      const draft = new InitialWorkDraft(savedRoute ? input.admission_dispatch?.plan : undefined, checkpoint => {
        WorkerContext.checkpoint(this.db, task, checkpoint, { model_config_id: lease.id, model_config_revision: lease.revision })
      }, (binding, assignment) => content.checkNew(contentScope, binding, assignment), checkOutput)
      if (input.admission_dispatch && !isDeepStrictEqual(input.admission_dispatch.materials, materials)) fail('REQUEST_MATERIAL_UNAVAILABLE', 'Draft materials changed before production admission')
      if (dialogue && !savedRoute) {
        this.db.prepare("INSERT INTO runs(id,task_id,request_id,state,runtime_epoch,limits_json,budget_json,created_at) VALUES (?,?,?,'running',?,?,?,?)")
          .run(operation, task, requestId, this.epoch, json({ ...defaults, run: lease.config.limits ?? {} }), json({ model_requests: 0, tool_requests: 0, tokens: 0 }), now())
        routingRun = operation
        this.accountLease(task, operation, lease)
      }
      const budget = new RunBudget(lease.config)
      const runPhase = async <T>(phase: WorkerProfile<T>, allowBody: boolean, source: string, publishedContext?: unknown, validateResult?: (value: T) => WorkerResultIssue | null): Promise<T> => {
        const messages = (candidate: ConversationHistory): ChatMessage[] => [...candidate.messages.map(item => item.message), { role: 'user', content: dialogue ? json({
          request: text, materials: materials.map(({ sha256: _sha256, ...metadata }) => metadata), conversation_records: candidate.refs,
          prior_messages: candidate.messages.map(({ source, message }) => ({ id: source.id, role: message.role, excerpt: message.content?.slice(0, 120) })),
          ...(candidate.truncated ? { conversation_truncated: true } : {}), pending_clarifications: clarifications,
          ...(phase === profile && pendingWorkerInputs.length ? { pending_worker_inputs: pendingWorkerInputs.map(({ id, question, request_id, work_id }) => ({ id, question, request_id, work_id })) } : {}),
          ...(phase === profile && priorDelivery ? { preceding_delivery: priorDelivery } : {}),
          ...(phase === profile && workTable.length ? { work_table: workTable } : {}),
          ...(boundResult ? { preceding_result: boundResult } : {}), ...(publishedContext === undefined ? {} : { published_context: publishedContext })
        }) : text }]
        const fitted = fitConversation(history, candidate => !budget.plan([{ role: 'system', content: phase.system }, ...messages(candidate)], phase.tools).needsCompaction)
        let result!: T
        await runAgent(this.models, lease, task, messages(fitted), {
          valid, state: (state, reason) => { if (routingRun) { valid(); this.actionState(routingRun, state, reason) } },
          budget: value => { if (routingRun) this.db.prepare('UPDATE runs SET budget_json=? WHERE id=?').run(json(value), routingRun) },
          record: (kind, payload) => { this.record(task, kind, { ...payload, routing_operation_id: operation, input_request_id: requestId, ...(routingRun ? { run_id: routingRun } : {}) }) },
          tool: async request => {
            valid(); phase.authorize(request)
            const query = validateModel(request)
            if (query.type === 'call' && routingRun && phase === profile && dialogue) {
              if (query.input.capability === DISCOVER_INPUTS) {
                if (query.input.references.length) fail('INVALID_RUNNER_CONTRACT', 'The catalog uses the current routing scope, not references')
                return { request_type: 'call', execution: 'success', delivery: 'delivered', data: catalog.page(query.input.arguments) }
              }
              return { request_type: 'call', execution: 'success', delivery: 'delivered', data: draft.propose(query.input) }
            }
            if (query.type !== 'read' && query.type !== 'list') fail('WORKER_CAPABILITY_DENIED', 'This routing context cannot execute the operation')
            const kind = query.type === 'list' ? query.input.kind : query.input.target.kind
            if (dialogue && kind === 'event') {
              if (query.type === 'list') {
                if (Object.keys(query.input.filters ?? {}).length) fail('UNSUPPORTED_FILTER', 'Conversation navigation filters are fixed at acceptance')
                const page = this.queries.messages(task, query.input.cursor, undefined, input.conversation.through_sequence, query.input.limit ?? 8)
                return { request_type: 'list', execution: 'success', delivery: 'delivered', truncated: false,
                  data: { items: page.items.map(({ id, role, text }) => ({ id, role, excerpt: text.slice(0, 120) })), next_cursor: page.older_cursor } }
              }
              const event = query.input.target.id
              if (event !== boundResult?.id && !conversationReference(this.db, task, event, input.conversation.through_sequence)) fail('CONVERSATION_REFERENCE_INVALID', 'Event is outside the accepted conversation history')
            }
            const result = await (kind === 'content_tree' || kind === 'content_node' ? this.contentTreeQuery(task, query, source, allowBody) : this.query(task, query, source))
            valid(); return result
          }
        }, controller.signal, budget, { profile: phase, validateResult, onResult: value => { valid(); result = value } })
        return result
      }
      if (!savedRoute) this.record(task, 'chapter.route.started', { request_id: requestId, operation_id: operation })
      let replacementRevision: number | undefined
      const raw = savedRoute ?? await runPhase(profile, false, `chapter-route:${operation}`, undefined, route => {
        if (!dialogue || route.kind !== 'new' && route.kind !== 'delegate') return null
        const decision = draft.decision()
        try {
          if (decision) {
            checkAssignmentRequirements(decision, initialDeliveryRequirements(route.kind, decision))
            for (const assignment of decision.assignments) for (const binding of assignment.inputs ?? []) {
              if ('work_id' in binding) checkOutput(binding, assignment.assignment_key)
              else if ('kind' in binding) content.checkNew(contentScope, binding, assignment.assignment_key)
            }
          }
          else if (replacementRevision !== undefined) fail('RUNNER_PLAN_CONFLICT', 'The rejected work draft has not been replaced')
          else if (route.kind === 'delegate') fail('RUNNER_PLAN_CONFLICT', 'Delegated answers require a work draft')
          return null
        } catch (error) {
          if (!(error instanceof ContractError)) throw error
          if (decision) replacementRevision = draft.discard()
          return { code: error.code, path: 'dispatch', value: { route: route.kind, conflict: error.message }, message: `${error.message}. No assignments were installed. Submit a corrected draft with base_revision: ${replacementRevision ?? 0} before returning this route.` }
        }
      })
      valid()
      const route = (dialogue ? validateConversationRoute : validateChapterRoute)(raw, this.publishedChapterManifests(task))
      const dispatch = route.kind === 'new' || route.kind === 'delegate' ? draft.decision() : undefined
      if (route.kind === 'delegate' && !dispatch) fail('RUNNER_PLAN_CONFLICT', 'Delegated answers require a work draft')
      if (!savedRoute) this.record(task, 'chapter.route.resolved', { request_id: requestId, operation_id: operation, route: route.kind === 'reply' ? { kind: route.kind } : route })
      const reference = (refId: string) => conversationReference(this.db, task, refId, input.conversation.through_sequence) ?? fail('CONVERSATION_REFERENCE_INVALID', 'Reference must identify a saved message within the accepted history')
      if (routingRun && route.kind === 'supply_input') {
        const target = pendingWorkerInputs.find(item => item.id === route.message_id)
        if (!target) fail('CONVERSATION_REFERENCE_INVALID', 'Reply must identify one pending Worker clarification from the accepted history')
        const run = routingRun
        this.db.transaction(() => {
          this.bindAssignmentReply(task, row, input, target, route.checkpoint_id, materials)
          this.db.prepare("UPDATE requests SET state='started',input_json=? WHERE task_id=? AND id=? AND state='queued'")
            .run(json({ ...input, code: null, conversation_run_id: run, conversation_route: route.kind, conversation_reference: target.id, supplements_request_id: target.request_id }), task, requestId)
          this.finish(task, run, 'completed', 'conversation_replied')
        }).immediate()
        this.pumpRunnerWorkers(task)
        return run
      }
      if (routingRun && route.kind === 'depends') {
        if (input.conversation_dependency) fail('CONVERSATION_REFERENCE_INVALID', 'The request already has its exact preceding result')
        const parent = reference(route.message_id)
        if (parent.kind !== 'message.user' || !parent.request_id || parent.request_id === requestId || !this.db.prepare('SELECT 1 FROM requests WHERE task_id=? AND id=?').get(task, parent.request_id)) fail('CONVERSATION_REFERENCE_INVALID', 'A dependency must identify one preceding user request')
        this.db.transaction(() => {
          this.db.prepare("UPDATE requests SET input_json=? WHERE task_id=? AND id=? AND state='queued'").run(json({ ...input, code: 'CONVERSATION_WAITING_FOR_RESULT', conversation_dependency: { message_id: parent.id, request_id: parent.request_id } }), task, requestId)
          this.record(task, 'conversation.dependency.bound', { request_id: requestId, preceding_request_id: parent.request_id, preceding_message_id: parent.id })
          this.finish(task, operation, 'completed', 'conversation_routed')
        })()
        return ''
      }
      if (routingRun && route.kind === 'remove_pending') {
        const parent = reference(route.message_id)
        if (parent.kind !== 'message.user' || !parent.request_id) fail('CONVERSATION_REFERENCE_INVALID', 'Select the message that requested the pending content')
        const run = routingRun
        this.db.transaction(() => {
          const plan = conversationContentPlan(this.db, task, parent.id)
          this.removePendingContent(task, plan?.request_id ?? parent.request_id!, parent.id, input.user_record_id)
          this.record(task, 'conversation.reply', { text: '已将这项未交付内容移出成稿范围。', request_id: requestId, run_id: run, reply_to: input.user_record_id })
          this.db.prepare("UPDATE requests SET state='started',input_json=? WHERE task_id=? AND id=? AND state='queued'").run(json({ ...input, code: null, conversation_run_id: run, conversation_route: route.kind, conversation_reference: parent.id }), task, requestId)
          this.finish(task, run, 'completed', 'conversation_replied')
        }).immediate()
        return run
      }
      if (routingRun && route.kind === 'correct_pending') {
        const parent = reference(route.message_id)
        if (parent.kind !== 'message.user' || !parent.request_id) fail('CONVERSATION_REFERENCE_INVALID', 'Select the user message with the undelivered content')
        const eventId = `correction:${requestId}`, run = routingRun
        const affectedBatches = this.db.transaction(() => {
          const target = this.pendingCorrectionTarget(task, parent.request_id!, parent.id)
          const batches = this.db.prepare(`SELECT c.id FROM runner_batches b JOIN runs c ON c.task_id=b.task_id AND c.id=json_extract(b.payload_json,'$.run_id')
            JOIN json_each(b.payload_json,'$.targets') t WHERE b.task_id=? AND c.state IN ('running','waiting')
            AND json_extract(t.value,'$.request_id')=? AND json_extract(t.value,'$.intent_revision')=?`).all(task, target.request_id, target.intent_revision) as { id: string }[]
          const boundMaterials = attachments.map(item => this.requestMaterial(task, item.id))
          this.db.prepare(`UPDATE requests SET state='rejected',input_json=json_set(input_json,'$.code','CONTENT_REQUIREMENT_UNAVAILABLE')
            WHERE task_id=? AND state IN ('queued','confirmation_required') AND json_extract(input_json,'$.correction_pending')=1
              AND json_extract(input_json,'$.corrects_request_id')=?`).run(task, target.request_id)
          this.db.prepare("UPDATE requests SET input_json=? WHERE task_id=? AND id=? AND state='queued'").run(json({ ...input, code: 'PRODUCTION_ADMISSION_PENDING', conversation_run_id: run, conversation_route: route.kind, conversation_reference: parent.id, corrects_request_id: target.request_id, correction_pending: true, bound_materials: boundMaterials }), task, requestId)
          this.runner().receive({ input_event_id: eventId, task_id: task, kind: 'correction', record_id: input.user_record_id, request_id: target.request_id, caused_by_event_id: target.input_event_id, stage: 'received' })
          this.runner().advance(eventId)
          this.runnerGoalText(task, target.request_id, target.intent_revision + 1)
          this.record(task, 'conversation.reply', { text: '已将更正应用到该项未发布的内容。', request_id: requestId, run_id: run, reply_to: input.user_record_id, reference_message_id: parent.id })
          this.finish(task, run, 'completed', 'conversation_replied')
          return batches
        }).immediate()
        for (const batch of affectedBatches) this.finish(task, batch.id, 'cancelled', 'content_requirement_corrected')
        this.advanceRunnerInput(eventId)
        const reusable = this.runnerComposition().scope(task)?.targets.find(target => target.contribution_inventory)
        if (reusable) this.scheduleRunnerComposition(task, reusable.request_id)
        return run
      }
      if (routingRun && ['reply', 'progress', 'query', 'explanation'].includes(route.kind)) {
        let answer: string
        let cited = route.kind === 'reply' && route.references ? reference(route.references).id : undefined
        if (route.kind === 'reply') answer = route.text
        else if (route.kind === 'progress') {
          const target = route.message_id ? reference(route.message_id) : undefined
          if (target && (target.kind !== 'message.user' || !target.request_id)) fail('CONVERSATION_REFERENCE_INVALID', 'Progress requires an original user request')
          cited = target?.id
          answer = this.conversationProgress(task, routingRun, target?.id, target?.request_id ?? undefined)
        } else {
          const manifest = 'view_id' in route && route.view_id ? this.chapters().state.manifest(task, route.view_id) : null
          const legacy = manifest && !manifest.content_tree && 'region_ids' in route && route.region_ids
          const boundViews = this.precedingViewGrants(boundResult)
          answer = await runPhase(createConversationReadingProfile([...grants, ...boundViews], boundViews.length > 0), true, `conversation-read:${operation}`, legacy && !boundViews.length ? chapterContext(this.bundle(manifest.bundle_resource_id), manifest, route.region_ids!) : undefined)
        }
        valid()
        this.db.transaction(() => {
          this.record(task, 'conversation.reply', { text: answer, request_id: requestId, run_id: operation, reply_to: input.user_record_id, ...(cited ? { reference_message_id: cited } : {}) })
          this.db.prepare("UPDATE requests SET state='started',input_json=? WHERE task_id=? AND id=? AND state='queued'").run(json({ ...input, code: null, conversation_run_id: operation, conversation_route: route.kind, ...(cited ? { conversation_reference: cited } : {}) }), task, requestId)
          this.finish(task, operation, 'completed', 'conversation_replied')
        })()
        return operation
      }
      if (routingRun) { this.finish(task, routingRun, 'completed', 'conversation_routed'); routingRun = undefined }
      if (dialogue && ['new', 'delegate', 'update', 'clarify'].includes(route.kind) && !this.runnerRunAvailable(task, requestId)) {
        this.db.prepare("UPDATE requests SET input_json=? WHERE task_id=? AND id=? AND state='queued'").run(json({ ...input, admission_route: route, ...(dispatch ? { admission_dispatch: { plan: dispatch, materials } } : {}), code: 'PRODUCTION_ADMISSION_PENDING' }), task, requestId)
        return ''
      }
      delete input.admission_route
      delete input.admission_dispatch
      if (route.kind === 'clarify') {
        const original = reference(route.message_id)
        if (original.kind !== 'chapter.route.clarification' || !original.request_id) fail('CONVERSATION_REFERENCE_INVALID', 'Reply does not identify a saved clarification')
        const scope = route.update, manifest = this.chapters().state.manifest(task, scope.view_id)!
        const view = this.one('SELECT revision,state_revision FROM views WHERE id=?', scope.view_id)
        const update = this.db.transaction(() => {
          const result = this.startChapterUpdate({ type: 'chapter.update', task_id: task, input_event_id: `chapter-input:${requestId}`, update_id: `chapter-update:${requestId}`, view_id: scope.view_id, view_revision: view.revision, state_revision: view.state_revision, region_ids: scope.region_ids ?? [manifest.content_tree?.root_id ?? manifest.chapters[0]!.region_id], text, model_config_id: config, source_request_id: original.request_id!, ...(scope.tree_operations ? { tree_operations: scope.tree_operations } : {}) }, { record_id: input.user_record_id, conversation: input.conversation, material_resource_ids: attachments.map(item => item.id) })
          this.db.prepare("UPDATE requests SET state='started',input_json=? WHERE task_id=? AND id=? AND state='queued'").run(json({ ...input, code: null, conversation_reference: original.id, clarifies_request_id: original.request_id, chapter_run_id: result.source?.run_id }), task, requestId)
          return result
        })()
        return update.source!.run_id
      }
      if (route.kind === 'update') {
        const current = this.chapters().state.manifest(task, route.view_id)!
        const view = this.one('SELECT revision,state_revision FROM views WHERE id=?', route.view_id)
        const candidates = route.region_ids?.length ? route.region_ids : [current.content_tree?.root_id ?? current.chapters[0]!.region_id]
        const update = this.startChapterUpdate({ type: 'chapter.update', task_id: task, input_event_id: `chapter-input:${requestId}`, update_id: `chapter-update:${requestId}`, view_id: route.view_id, view_revision: view.revision, state_revision: view.state_revision, region_ids: candidates, text, model_config_id: config, ...(route.tree_operations ? { tree_operations: route.tree_operations } : {}) }, { record_id: input.user_record_id, conversation: input.conversation, material_resource_ids: attachments.map(item => item.id), conversation_dependency: input.conversation_dependency, ...(current.content_tree ? { content_authority: { region_ids: [current.content_tree.root_id] } } : {}) })
        if (current.request_id !== update.request_id) fail('CHAPTER_CONFLICT', 'Chapter goal changed while routing')
        this.db.prepare("UPDATE requests SET state='started',input_json=? WHERE task_id=? AND id=? AND state='queued'").run(json({ ...input, chapter_route: route, chapter_update_id: update.update_id, chapter_run_id: update.source?.run_id, code: null }), task, requestId)
        return update.source!.run_id
      }
      if (route.kind === 'ambiguous') {
        this.db.transaction(() => {
          this.db.prepare("UPDATE requests SET state='confirmation_required',input_json=? WHERE task_id=? AND id=? AND state='queued'").run(json({ ...input, code: 'CHAPTER_SCOPE_REQUIRED', chapter_route: route }), task, requestId)
          this.record(task, 'chapter.route.clarification', { request_id: requestId, text: '请说明要修改哪部分内容。' })
        })()
        return ''
      }
      const chapterQuery = (route.kind === 'query' || route.kind === 'explanation') && route.view_id && route.region_ids
        ? { manifest: this.chapters().state.manifest(task, route.view_id)!, region_ids: route.region_ids }
        : undefined
      return this.start(task, text, config, attachments, requestId, { input, route, draft: dispatch, chapterQuery })
    } catch (error) {
      if (routingRun && !this.closed && this.db.open) this.finish(task, routingRun, controller.signal.aborted ? 'cancelled' : 'failed', error instanceof ModelError || error instanceof ContractError ? error.code : 'REQUEST_START_FAILED')
      throw error
    } finally { this.chapterRoutes.delete(requestId); lease.release() }
  }
  private requestSelection(config: string): Row {
    const list = this.models.list() as Row[]
    const available = (id: string) => {
      const model = list.find(m => m.id === id)
      if (!model) fail('MODEL_NOT_CONFIGURED', 'Select a configured model')
      if (model.credential_missing) fail('CREDENTIAL_REQUIRED', 'Restore the channel credential before use')
      return model
    }
    const main = config === 'fixture' ? undefined : available(config)
    const approval = this.approvalMode === 'assisted' ? available(this.approvalModel) : undefined
    return { id: config, revision: main?.revision ?? 1, ...(main ? { base_url: main.base_url, wire_model_id: main.wire_model_id, compatibility_profile: main.compatibility_profile } : {}), approval_mode: this.approvalMode, ...(approval ? { approval_id: approval.id, approval_revision: approval.revision } : {}) }
  }
  private runnerRunAvailable(task: string, request: string): boolean {
    const active = (this.db.prepare("SELECT r.id run_id,r.task_id,r.request_id FROM runs r LEFT JOIN runner_runs n ON n.run_id=r.id WHERE r.task_id=? AND r.state IN ('running','waiting') AND (n.purpose IS NULL OR n.purpose='production')").all(task) as { task_id: string; run_id: string; request_id: string }[])
    const routing = new Set([...this.chapterRoutes.values()].filter(route => route.taskId === task).map(route => route.runId))
    return this.runnerAdmission.runWait(task, request, active.filter(run => !routing.has(run.run_id)), this.features.runner?.productionRuns ?? productionRunsPerTask) === null
  }
  private awaitingContentPublication(task: string, message: string): boolean {
    const plan = conversationContentPlan(this.db, task, message)
    if (!plan) return false
    const target = this.runnerComposition().scope(task)?.targets.find(target => target.request_id === plan.request_id && target.intent_revision === plan.intent_revision)
    if (!target?.contribution_inventory) return false
    const batch = conversationPublicationRun(this.db, task, plan.request_id, plan.intent_revision)
    return !!(batch?.commit_valid && ['running', 'waiting'].includes(batch.state) || batch?.publication_state === 'unknown' || this.runnerCompositionMerges.has(task) || this.runnerCompositionWaiting.has(task))
  }
  private conversationProgress(task: string, routing: string, message?: string, request?: string): string {
    const labels: Record<string, string> = { queued: '排队中', confirmation_required: '等待确认', started: '已受理', rejected: '未能执行', running: '执行中', waiting: '等待中', completed: '已完成', failed: '失败', cancelled: '已停止', interrupted: '已中断' }
    if (!message || !request) {
      const states = this.db.prepare(`SELECT c.state,count(*) AS count FROM runs c
        LEFT JOIN requests q ON q.task_id=c.task_id AND q.id=c.request_id
        WHERE c.task_id=? AND c.id!=? AND COALESCE(c.primary_reason,'')!='conversation_routed'
        AND NOT (c.id IS json_extract(q.input_json,'$.conversation_run_id') AND json_extract(q.input_json,'$.conversation_route') IS 'progress')
        GROUP BY c.state`).all(task, routing) as { state: string; count: number }[]
      return states.length ? states.map(({ state, count }) => `${labels[state] ?? state}：${count} 次`).join('\n') : '当前任务还没有其他执行记录。'
    }
    const saved = this.one('SELECT state,input_json FROM requests WHERE task_id=? AND id=?', task, request), input = JSON.parse(saved.input_json)
    const plan = conversationContentPlan(this.db, task, message)
    if (plan) {
      const current = this.runnerComposition().scope(task)?.targets.find(target => target.request_id === plan.request_id)
      if (current && current.intent_revision > plan.intent_revision) return '此请求已被后续消息纠正。'
      const batch = conversationPublicationRun(this.db, task, plan.request_id, plan.intent_revision)
      if (batch?.publication_state === 'unknown') return '发布结果待核实。'
      if (conversationDependencyResult(this.db, task, message, request)) return '此请求的内容已发布。'
      if (this.awaitingContentPublication(task, message)) return batch?.wait_reason === 'approval' ? '内容已生成，正在等待发布审批。' : '内容已生成，正在等待发布。'
      if (batch && ['failed', 'cancelled', 'interrupted'].includes(batch.state)) return `发布${labels[batch.state]}。`
    }
    const run = saved.state === 'started' ? this.db.prepare(`SELECT c.state,c.wait_reason FROM runs c WHERE c.task_id=@task
      AND (c.id=@chapter OR c.id=@conversation OR (${runMessage('c')}=@message AND c.request_id=@request))
      AND COALESCE(c.primary_reason,'')!='conversation_routed' ORDER BY c.rowid DESC LIMIT 1`)
      .get({ task, request: plan?.request_id ?? request, message, chapter: input.chapter_run_id ?? null, conversation: plan ? null : input.conversation_run_id ?? null }) as Row | undefined : undefined
    if (run?.wait_reason === 'approval') return '此请求正在等待审批。'
    return `此请求：${labels[run?.state ?? saved.state] ?? '等待处理'}。`
  }
  private requestMaterial(task: string, id: string): Row {
    const row = this.one('SELECT r.* FROM resources r JOIN task_resources t ON t.resource_id=r.id WHERE r.id=? AND t.task_id=?', id, task)
    this.journal.assertResource(row)
    if (row.byte_length <= 262144) this.materials.readText(row, 0)
    return { id: row.id, display_name: row.display_name, byte_length: row.byte_length, media_type: row.media_type, sha256: row.sha256 }
  }
  private rebindDatabase(file: string): Database.Database {
    void this.exportChecks.stop().catch(() => {})
    if(this.monty?.busy()) fail('MONTY_CLEANUP_ACTIVE','Calculation cleanup must end before database switch')
    for (const merge of this.runnerCompositionMerges.values()) clearTimeout(merge.timer)
    this.runnerCompositionMerges.clear(); this.runnerCompositionWaiting.clear(); this.runnerCompositionPublishing.clear()
    for (const pending of this.pendingWorkers.values()) pending.reject(new ContractError('SOURCE_INVALID', 'Database changed before dispatch'))
    this.pendingWorkers.clear(); this.preparingRunnerGoals.clear(); this.recoveringRunnerInputs.clear(); this.runnerProgressObservedAt.clear()
    this.runnerRecoveryFlight = undefined
    this.runnerAdmission = new RunnerAdmission()
    this.requests?.close()
    this.materials.close()
    this.pluginDrafts.close(); for (const pending of this.pluginIndependentCalls.values()) pending.controller.abort(); this.pluginIndependentCalls.clear(); this.pluginUploads.close(); this.pluginActions.close(); this.pluginCalls.close(); this.pluginProcesses.close()
    this.storage.close()
    if (this.db.open) this.db.close()
    this.db = openBusinessDatabase(this.root, file)
    this.epoch = id(); this.sync.clear(); this.syncFacts.clear()
    new RunnerHostRecovery(this.db, this.epoch).recover()
    this.taskRunner = undefined
    this.runnerArtifactState = undefined; this.runnerCompositionState = undefined
    this.storage = new StorageLifecycle(this.db, this.root, this.epoch, (action, task) => this.pluginActions?.owner(action, task) || this.pluginUploads?.owns(action, task) || false)
    this.materials = new MaterialImports(this.db, this.root, this.epoch, this.storage, this.journal, (task, kind, data) => { this.record(task, kind, data) })
    this.storage.pause(true)
    this.queries.rebind(this.db)
    this.summaryPager.reset()
    this.readCursors.reset()
    this.initializePlugins()
    this.initializeRequests()
    setImmediate(() => { if (!this.closed && !this.closing) void this.recoverRunnerWork().catch(() => {}) })
    return this.db
  }
  private executionBusy(): boolean {
    return !!(this.pluginProcesses?.cleaning() || this.monty?.busy() || this.exports?.busy() || this.requests?.busy() || this.agents.size || this.surfaceWaiters.size || this.surfaceCompletions.size || this.approvalWaiters.size || this.models.busy() || this.db.prepare("SELECT id FROM runs WHERE state IN ('running','waiting') UNION ALL SELECT id FROM actions WHERE state!='ended' UNION ALL SELECT id FROM calls WHERE state!='ended' UNION ALL SELECT id FROM cleanup_jobs WHERE necessary=1 AND state!='done' LIMIT 1").get())
  }
  private pluginInstanceEvent(event: PluginInstanceEvent): void {
    if (this.closed || !this.db?.open) return
    const affected = event.call_ids.flatMap(call => {
      const row = this.db.prepare('SELECT id,task_id,run_id FROM calls WHERE id=?').get(call) as Row | undefined
      return row ? [row] : []
    })
    this.db.transaction(() => {
      for (const task of new Set(affected.map(call => call.task_id as string))) {
        const job = this.db.prepare("SELECT id,state,detail_json FROM cleanup_jobs WHERE task_id=? AND owner_kind='plugin_instance' AND owner_id=?").get(task, event.instance_id) as Row | undefined
        const state = event.kind === 'cleanup_confirmed' ? 'done' : event.kind === 'cleanup_failed' ? 'failed' : 'pending'
        const detail = json({ instance_id: event.instance_id, instance_key: event.instance_key, call_ids: event.call_ids, reason: event.reason })
        if (job?.state === 'done') continue
        if (job) this.db.prepare('UPDATE cleanup_jobs SET state=?,detail_json=?,next_attempt_at=NULL WHERE id=?').run(state, detail, job.id)
        else this.db.prepare("INSERT INTO cleanup_jobs(id,task_id,owner_kind,owner_id,necessary,state,detail_json) VALUES (?,?,'plugin_instance',?,1,?,?)").run(id(), task, event.instance_id, state, detail)
        this.record(task, `plugin.instance.${event.kind}`, { ...event })
      }
    })()
    setImmediate(() => {
      if (this.closed || !this.db.open) return
      for (const call of affected) if (call.run_id) this.aggregateWorkerRun(call.task_id, call.run_id)
      this.settlePluginCleanup()
    })
  }
  private settlePluginCleanup(): void {
    if (this.closed || !this.db?.open) return
    for (const row of this.db.prepare("SELECT id,task_id FROM runs WHERE commit_valid=0 AND intended_terminal IS NOT NULL AND state IN ('running','waiting')").all() as Row[]) {
      if (this.db.prepare('SELECT 1 FROM runner_runs WHERE run_id=?').get(row.id)) { this.aggregateWorkerRun(row.task_id, row.id); continue }
      if (!this.agents.has(row.id) && !this.pluginCalls.busyRun(row.id) && !this.pluginProcesses.cleaning(row.task_id)) this.db.prepare("UPDATE runs SET state=intended_terminal,wait_reason=NULL,ended_at=? WHERE id=?").run(now(), row.id)
    }
    for (const row of this.db.prepare("SELECT id FROM tasks WHERE state='stopping'").all() as Row[]) {
      if (!this.pluginProcesses.cleaning(row.id) && !this.pluginCalls.busy(row.id) && !this.pluginActions.busy(row.id) && !this.db.prepare("SELECT 1 FROM runs WHERE task_id=? AND state IN ('running','waiting')").get(row.id)) this.db.prepare("UPDATE tasks SET state='stopped',revision=revision+1 WHERE id=? AND state='stopping'").run(row.id)
    }
  }
  async shutdown(): Promise<void> {
    this.closing = true
    for (const { controller } of this.chapterRoutes.values()) controller.abort()
    if (this.shutdownFlight) { this.pluginProcesses.retryCleanup(); return this.shutdownFlight }
    this.shutdownFlight = this.shutdownOnce()
    try { await this.shutdownFlight } catch (error) { this.shutdownFlight = undefined; throw error }
  }
  private shutdownFlight?: Promise<void>
  private async shutdownOnce(): Promise<void> {
    if (this.closed) return
    this.requests.close()
    // Recovery can replace managers and the selected database; drain it before taking cleanup references.
    await this.recovery.settled()
    for (const run of this.db.prepare("SELECT id,task_id FROM runs WHERE state IN ('running','waiting')").all() as Row[]) this.finish(run.task_id, run.id, 'interrupted', 'host_shutdown')
    for (const pending of this.pluginIndependentCalls.values()) pending.controller.abort()
    this.pluginDrafts.close(); this.pluginActions.close(); this.pluginCalls.cancelAll(); this.pluginUploads.close()
    await Promise.all([...this.exportReaders.keys()].map(id => this.cancelExport(id)))
    await this.exportChecks.stop()
    await this.pluginProcesses.shutdown()
    await this.pluginCalls.drain()
    await this.monty.shutdown()
    this.close()
  }
  close(): void {
    if (this.closed) return
    for (const { controller } of this.chapterRoutes.values()) controller.abort()
    this.chapterRoutes.clear()
    for (const merge of this.runnerCompositionMerges.values()) clearTimeout(merge.timer)
    this.runnerCompositionMerges.clear(); this.runnerCompositionWaiting.clear(); this.runnerCompositionPublishing.clear()
    for (const pending of this.pendingWorkers.values()) pending.reject(new ContractError('SOURCE_INVALID', 'Runtime closed before worker dispatch'))
    this.pendingWorkers.clear()
    void this.exportChecks.stop().catch(() => {})
    if (this.monty?.busy()) fail('MONTY_CLEANUP_ACTIVE', 'Wait for calculation shutdown before closing storage')
    if (this.exportReaders.size) fail('EXPORT_GENERATION_ACTIVE', 'Wait for shutdown before closing an active export reader')
    this.pluginDrafts?.close(); for (const pending of this.pluginIndependentCalls.values()) pending.controller.abort(); this.pluginIndependentCalls.clear(); this.pluginUploads?.close(); this.pluginActions?.close(); this.pluginCalls?.close(); this.pluginProcesses?.close()
    this.closed = true
    this.requests?.close()
    this.materials.close()
    this.storage.close()
    for (const agent of this.agents.values()) agent.controller.abort()
    for (const worker of this.workers.values()) worker.controller.abort()
    for (const waiter of this.approvalWaiters.values()) { clearTimeout(waiter.timer); waiter.resolve() }
    this.approvalWaiters.clear(); this.models.close()
    for (const waiter of this.surfaceWaiters.values()) { clearTimeout(waiter.timer); waiter.resolve(false) }; this.surfaceWaiters.clear()
    for (const completion of this.surfaceCompletions.values()) completion.resolve(); this.surfaceCompletions.clear()
    for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); this.exports.close(); this.gc.close(); this.recovery.close(); this.journal.close(); this.plugins.close(); if (this.db.open) this.db.close(); this.owner.close() }
  private one(sql: string, ...args: unknown[]): Row { const row = this.db.prepare(sql).get(...args) as Row | undefined; if (!row) fail('NOT_FOUND', 'Object not found'); return row }
  private task(taskId: string): Row { const t = this.one('SELECT * FROM tasks WHERE id=?', taskId); if (t.state === 'deleting') fail('NOT_FOUND', 'Task deleted'); return t }
  tasks(): Task[] { return this.db.prepare("SELECT id,title,state,revision FROM tasks WHERE state!='deleting' ORDER BY rowid DESC").all() as Task[] }
  private record(taskId: string, kind: string, payload: unknown): string {
    const t = this.task(taskId), eventId = id()
    this.db.prepare('INSERT INTO records VALUES (?,?,?,?,?,?)').run(eventId, taskId, t.next_sequence, kind, json(payload), now())
    this.db.prepare('UPDATE tasks SET next_sequence=next_sequence+1,revision=revision+1 WHERE id=?').run(taskId)
    return eventId
  }
  private recordRunnerAnswer(taskId: string, payload: {
    owner: ExecutionScope; purpose: 'final_answer'; text: string; request_id: string; input_event_id: string;
    run_id: string; intent_revision: number
  } & ({ result_ref: { id: string; task_id: string; kind: string } } | { update_id: string; operation_id: string })): string {
    // Called inside the transaction that accepts the result or publishes the update.
    // Reconfirming that outcome returns the same message without a new record.
    const identity = 'result_ref' in payload ? '$.result_ref.id' : '$.operation_id'
    const key = 'result_ref' in payload ? payload.result_ref.id : payload.operation_id
    const saved = this.db.prepare(`SELECT id,payload_json FROM records WHERE task_id=? AND kind='runner.answer'
      AND json_extract(payload_json,?)=? ORDER BY sequence LIMIT 1`).get(taskId, identity, key) as Row | undefined
    if (saved) {
      if (!isDeepStrictEqual(JSON.parse(saved.payload_json), payload)) fail('RUNNER_RESULT_INVALID', 'Visible answer must retain its original result identity and text')
      return saved.id
    }
    return this.record(taskId, 'runner.answer', payload)
  }
  private operationEvent(taskId: string, kind: string, payload: Row): string {
    const eventId = this.record(taskId, kind, payload)
    if (payload.owner && kind.endsWith('.ended') && typeof payload.call_id === 'string') {
      const inputId = `operation:${payload.call_id}`
      if (!this.db.prepare('SELECT 1 FROM runner_inputs WHERE input_event_id=?').get(inputId)) {
        const owner = captureExecutionScope(payload.owner, taskId)!
        this.runner().receive({ input_event_id: inputId, task_id: taskId, kind: 'operation_completed', record_id: eventId, operation_id: payload.call_id, run_id: owner.run_id, work_id: owner.work_id, ...(owner.purpose === 'production' ? { request_id: owner.request_id } : {}), stage: 'received' })
      }
      this.runner().advance(inputId)
    }
    if (payload.owner?.run_id) setImmediate(() => {
      if (!this.closed && this.db.open) this.aggregateWorkerRun(taskId, payload.owner.run_id)
    })
    return eventId
  }
  create(title: string): Snapshot {
    this.acceptWork()
    this.recovery.assertWrite()
    const taskId = id()
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO tasks VALUES (?,?,'active',1,1)").run(taskId, title)
      this.db.prepare('INSERT INTO surfaces VALUES (?,?,1,?)').run(id(), taskId, json({ slots: [{ id: 'main', groups: [] }] }))
    })()
    return this.snapshot(taskId)
  }
  private bundle(resourceId: string): Bundle {
    const resource = this.one('SELECT * FROM resources WHERE id=?', resourceId)
    this.journal.assertResource(resource)
    if (resource.byte_length > defaults.surface.inline_bundle_bytes) fail('BUNDLE_SIZE_LIMIT', 'Saved bundle exceeds the enabled inline limit')
    const body = resourceBody(this.root, resource as Parameters<typeof resourceBody>[1])
    return JSON.parse(body.toString()) as Bundle
  }
  private checkedBundle(taskId: string, bundle: Bundle, scope: string) {
    const resources = bundleResources(this.db, taskId, bundle)
    const byName = new Map(bundle.references.map((ref, i) => [ref.name, resources[i]!]))
    let imageBytes = 0
    return checkBundle(bundle, scope, name => { const r = byName.get(name); if (!r) fail('RESOURCE_MISSING', 'Resource name is unavailable'); this.journal.assertResource(r); imageBytes += Math.ceil(r.byte_length / 3) * 4; if (imageBytes > 16 * 1024 * 1024) fail('SURFACE_PAGE_SIZE_LIMIT', 'Expanded View images exceed enabled page limit'); return imageUrl(this.root, r) })
  }
  private cancelExport(id: string): void | Promise<void> {
    const reader = this.exportReaders.get(id)
    if (reader) { reader.cancelling = true; return reader.generation.stop().then(() => { this.exportReaders.delete(id); this.exports.cancel(id) }) }
    this.exports.cancel(id)
  }
  private collectExportResources(task: string, history: string, bundleId: string, resources: Map<string, any>): string[] {
    const frozen = JSON.parse(this.one('SELECT evidence_snapshot_json FROM view_history WHERE id=? AND task_id=?', history, task).evidence_snapshot_json)
    if (frozen.resources !== undefined && !Array.isArray(frozen.resources)) fail('EXPORT_HISTORY_INVALID', 'Historical resource facts are invalid')
    for (const resource of [this.one('SELECT * FROM resources WHERE id=?', bundleId), ...(frozen.resources ?? [])]) {
      const current = this.one('SELECT r.* FROM resources r JOIN task_resources t ON t.resource_id=r.id WHERE t.task_id=? AND r.id=?', task, resource.id)
      if (json(current) !== json(resource)) fail('EXPORT_RESOURCE_CHANGED', 'Historical resource metadata changed')
      this.journal.assertResource(resource); resources.set(resource.id, resource)
    }
    return (frozen.resources ?? []).map((r: Row) => r.id)
  }
  private checkViewExport(task: string, view: Row): Row {
    const historical = view.view_id !== undefined
    const history = historical ? view : this.one('SELECT id FROM view_history WHERE task_id=? AND view_id=? AND view_revision=?', task, view.id, view.revision)
    const revision = historical ? view.view_revision : view.revision
    const resources = new Map<string, any>(), resourceIds = this.collectExportResources(task, history.id, view.bundle_resource_id, resources)
    if ([...resources.values()].reduce((bytes, resource) => bytes + resource.byte_length, 0) > 8 * 1024 * 1024) fail('EXPORT_RESOURCE_SIZE_LIMIT', 'Selected immutable resources exceed the enabled 8 MiB source limit; reduce the selection')
    const bundle = this.bundle(view.bundle_resource_id)
    checkPersonalBindings(this.db, task, bundle)
    const diagnostics: import('./static-export').ExportIssue[] = []
    const generated = generateExport({ root: this.root, title: this.task(task).title, resources: [...resources.values()], views: [{ bundle_id: view.bundle_resource_id, resource_ids: resourceIds, fragment_ids: bundle.export.filter(f => f.category === 'learning').map(f => f.id) }], answers: [] }, issue => diagnostics.push(issue))
    return { id: view.id, revision, view_id: historical ? view.view_id : view.id, history_id: history.id, selection: 'default-learning-only', complete: generated.issues.length === 0, issues: diagnostics, issue_codes: generated.issues, excluded_personal_fragments: bundle.export.filter(f => ['answer', 'feedback', 'mixed_personal'].includes(f.category)).map(f => f.id), notice: 'Checks this View revision only, not a saved file or semantic classification. No export job was created.' }
  }
  private resolveExportSelection(r: Row): { rows: Row[]; selected: Row[]; resources: Map<string, any>; input: ExportInput; composition?: FrozenExportComposition } {
    if (!['answer_ids,task_id,type', 'answer_ids,task_id,type,view_ids', 'answer_ids,expected_revision,task_id,type,view_ids', 'answer_ids,expected_revision,fragment_selection,task_id,type,view_ids'].includes(Object.keys({ ...r, type: 'export.prepare' }).filter(key => key !== 'offset').sort().join(',')) || (r.view_ids !== undefined && (!Array.isArray(r.view_ids) || !r.view_ids.length || r.view_ids.length > 50 || new Set(r.view_ids).size !== r.view_ids.length || r.view_ids.some((value: unknown) => typeof value !== 'string'))) || !Array.isArray(r.answer_ids) || r.answer_ids.length > 50 || new Set(r.answer_ids).size !== r.answer_ids.length || r.answer_ids.some((x: unknown) => typeof x !== 'string')) fail('INVALID_REQUEST', 'Invalid explicit answer selection')
    if (r.fragment_selection !== undefined && (!Array.isArray(r.fragment_selection) || r.fragment_selection.length !== r.view_ids.length || new Set(r.fragment_selection.map((s: Row) => s?.view_id)).size !== r.view_ids.length || r.fragment_selection.some((s: Row) => !s || Object.keys(s).sort().join(',') !== 'fragment_ids,view_id' || !r.view_ids.includes(s.view_id) || !Array.isArray(s.fragment_ids) || new Set(s.fragment_ids).size !== s.fragment_ids.length || s.fragment_ids.some((id: unknown) => typeof id !== 'string')))) fail('INVALID_REQUEST', 'Fragment selection must cover each explicitly selected View exactly once')
    if (r.expected_revision !== undefined && (!Number.isSafeInteger(r.expected_revision) || this.one('SELECT revision FROM surfaces WHERE task_id=?', r.task_id).revision !== r.expected_revision)) fail('VERSION_CONFLICT', 'Surface changed; reopen the export selection')
    const rows: Row[] = r.view_ids ? r.view_ids.map((view: string) => this.one('SELECT v.*,h.id history_id FROM views v JOIN surfaces s ON s.id=v.surface_id JOIN view_history h ON h.view_id=v.id AND h.view_revision=v.revision WHERE s.task_id=? AND v.id=?', r.task_id, view)) : this.db.prepare('SELECT v.*,h.id history_id FROM views v JOIN surfaces s ON s.id=v.surface_id JOIN view_history h ON h.view_id=v.id AND h.view_revision=v.revision WHERE s.task_id=? ORDER BY v.rowid LIMIT 51').all(r.task_id) as Row[]
    if (!rows.length || rows.length > 50) fail('EXPORT_VIEW_LIMIT', 'Select a task with 1–50 current Views')
    const resources = new Map<string, any>()
    const collect = (history: string, bundleId: string): string[] => {
      return this.collectExportResources(r.task_id, history, bundleId, resources)
    }
    rows.forEach(v => {
      v.resource_ids = collect(v.history_id, v.bundle_resource_id)
      const bundle = this.bundle(v.bundle_resource_id)
      checkPersonalBindings(this.db, r.task_id, bundle)
      const selection = r.fragment_selection?.find((s: Row) => s.view_id === v.id)
      v.fragments = (selection ? selection.fragment_ids.map((id: string) => {
        const fragment = bundle.export.find(f => f.id === id)
        if (!fragment || fragment.category === 'unclassified') fail('EXPORT_SELECTION_INVALID', 'Selected fragment is missing or unclassified')
        if (fragment.category !== 'learning' && (!fragment.personal_binding || !r.answer_ids.includes(fragment.personal_binding.answer_id))) fail('EXPORT_PERSONAL_SELECTION_REQUIRED', 'Explicitly select the matching answer and original question for each personal fragment')
        return fragment
      }) : bundle.export.filter(f => f.category === 'learning')).map((f: Bundle['export'][number]) => ({ id: f.id, category: f.category, ...(f.personal_binding ? { personal_binding: f.personal_binding } : {}) }))
      v.learning_complete = v.fragments.length > 0 && bundle.export.filter(f => f.category === 'learning').every(fragment => v.fragments.some((selected: Row) => selected.id === fragment.id))
    })
    let answerBytes = 0
    for (const answer of r.answer_ids) { answerBytes += this.one('SELECT length(CAST(value_json AS BLOB)) n FROM answers WHERE id=? AND task_id=?', answer, r.task_id).n; if (answerBytes > 8 * 1024 * 1024) fail('EXPORT_ANSWER_SIZE_LIMIT', 'Selected answer values exceed enabled 8 MiB limit; reduce the selection') }
    const selected = r.answer_ids.map((answer: string) => {
      const row = this.one('SELECT a.id,a.value_json,h.id history_id,h.view_id,h.view_revision,h.bundle_resource_id FROM answers a JOIN view_history h ON h.id=a.view_history_id AND h.task_id=a.task_id WHERE a.id=? AND a.task_id=?', answer, r.task_id)
      row.resource_ids = collect(row.history_id, row.bundle_resource_id); return row
    })
    if ([...resources.values()].reduce((bytes, resource) => bytes + resource.byte_length, 0) > 8 * 1024 * 1024) fail('EXPORT_RESOURCE_SIZE_LIMIT', 'Selected immutable resources exceed the enabled 8 MiB source limit; reduce the selection')
    const task = this.task(r.task_id)
    const input: ExportInput = { root: this.root, title: task.title, resources: [...resources.values()], views: rows.map(v => ({ bundle_id: v.bundle_resource_id, resource_ids: v.resource_ids, fragment_ids: v.fragments.map((f: Row) => f.id) })), answers: selected.map((row: Row) => ({ bundle_id: row.bundle_resource_id, resource_ids: row.resource_ids, value: JSON.parse(row.value_json), label: `正式作答 · 原题版本 ${row.view_revision}` })) }
    const composition = freezeExportComposition(this.db, this.epoch, r.task_id, rows.map(view => ({ id: view.id, revision: view.revision, bundle_resource_id: view.bundle_resource_id, learning_complete: view.learning_complete })))
    if (composition) input.composition = composition
    return { rows, selected, resources, input, ...(composition ? { composition } : {}) }
  }
  private exportRequest(r: Row): unknown {
    if (typeof r.task_id !== 'string') fail('INVALID_REQUEST', 'Export requires a task')
    this.task(r.task_id)
    if (r.type === 'export.list' && Object.keys(r).sort().join(',') === 'task_id,type') return this.exports.list(r.task_id)
    if (r.type === 'export.catalog') {
      if (Object.keys(r).sort().join(',') !== 'expected_revision,offset,task_id,type' || !Number.isSafeInteger(r.offset) || r.offset < 0 || !Number.isSafeInteger(r.expected_revision)) fail('INVALID_REQUEST', 'Invalid export directory')
      const surface = this.one('SELECT revision,layout_json FROM surfaces WHERE task_id=?', r.task_id)
      if (surface.revision !== r.expected_revision) fail('VERSION_CONFLICT', 'Surface changed; reopen the export selection')
      const ids: string[] = JSON.parse(surface.layout_json).slots.flatMap((slot: Row) => slot.groups.flatMap((group: Row) => group.views))
      return { items: ids.slice(r.offset, r.offset + 20).map(id => {
        const row = this.one('SELECT v.id,v.revision,v.bundle_resource_id,h.id history_id FROM views v JOIN surfaces s ON s.id=v.surface_id JOIN view_history h ON h.view_id=v.id AND h.view_revision=v.revision WHERE s.task_id=? AND v.id=?', r.task_id, id)
        const bundle = this.bundle(row.bundle_resource_id)
        return { id: row.id, revision: row.revision, history_id: row.history_id, fragments: bundle.export.map(f => ({ id: f.id, category: f.category, ...(f.personal_binding ? { personal_binding: f.personal_binding } : {}), selectable: f.category !== 'unclassified' && (f.category === 'learning' || !!f.personal_binding) })) }
      }), offset: r.offset, total: ids.length, revision: surface.revision }
    }
    if (r.type === 'export.check') {
      if (r.offset !== undefined && (!Number.isSafeInteger(r.offset) || r.offset < 0)) fail('INVALID_REQUEST', 'Invalid export diagnosis offset')
      const { rows, selected, input, composition } = this.resolveExportSelection(r)
      const issues: Row[] = []
      const generated = generateExport(input, issue => {
        const original = issue.answer_index !== undefined, source = original ? selected[issue.answer_index!]! : rows[issue.view_index]!
        issues.push({ ...issue, source: original ? 'original_question' : 'current_view', view_id: original ? source.view_id : source.id, revision: original ? source.view_revision : source.revision, history_id: source.history_id, ...(original ? { answer_id: source.id } : {}) })
      })
      for (const code of exportCompositionIssue(composition)) issues.push({ code, source: 'composition' })
      const offset = r.offset ?? 0
      return { complete: generated.issues.length === 0 && !exportCompositionIssue(composition).length, selection_hash: createHash('sha256').update(json([input, issues, generated.issues, composition])).digest('hex'), issues: issues.slice(offset, offset + 50), issue_count: issues.length, offset, next_offset: offset + 50 < issues.length ? offset + 50 : null, ...(composition ? { selection: exportCompositionSummary(composition) } : {}), notice: 'Read-only check of this exact selection, including frozen original questions. No job or pin was created. Actual export validates again.' }
    }
    if (r.type === 'export.check.start') {
      if (Object.hasOwn(r, 'offset')) fail('INVALID_REQUEST', 'Start does not accept a diagnosis offset')
      if (this.exportChecks.busy()) fail('EXPORT_CHECK_BUSY', 'Cancel the active check and wait for worker exit before starting another')
      const request = JSON.parse(json(r)), resolved = this.resolveExportSelection(request)
      const identity = (value: typeof resolved) => json([value.rows.map(v => [v.id, v.revision, v.history_id, v.fragments]), value.selected.map(v => [v.id, v.history_id, v.view_revision]), value.input, value.composition])
      const source = identity(resolved), captured = captureCheck(resolved.input), fingerprint = captured.fingerprint, epoch = this.epoch
      const current = resolved.rows.map(v => ({ view_id: v.id, revision: v.revision, history_id: v.history_id }))
      const originals = resolved.selected.map(v => ({ view_id: v.view_id, revision: v.view_revision, history_id: v.history_id, answer_id: v.id }))
      return this.exportChecks.start(r.task_id, captured, () => {
        if (this.closed || this.epoch !== epoch) fail('EXPORT_SOURCE_CHANGED', 'Runtime generation changed')
        this.task(request.task_id)
        const next = this.resolveExportSelection(request)
        if (identity(next) !== source || captureCheck(next.input).fingerprint !== fingerprint) fail('EXPORT_SOURCE_CHANGED', 'Selection or verified resource source changed')
      }, result => ({ ...result, complete: result.complete && !exportCompositionIssue(resolved.composition).length, issue_codes: [...result.issue_codes, ...exportCompositionIssue(resolved.composition)], ...(resolved.composition ? { selection: exportCompositionSummary(resolved.composition) } : {}), issues: [...result.issues.map(issue => ({ ...issue, source: issue.answer_index === undefined ? 'current_view' : 'original_question', ...(issue.answer_index === undefined ? current[issue.view_index] : originals[issue.answer_index]) })), ...exportCompositionIssue(resolved.composition).map(code => ({ code, view_index: -1, source: 'composition' }))] }))
    }
    if (r.type === 'export.check.status' || r.type === 'export.check.cancel') {
      if (Object.keys(r).filter(key => key !== 'offset').sort().join(',') !== 'check_id,task_id,type' || typeof r.check_id !== 'string' || (r.offset !== undefined && (r.type !== 'export.check.status' || !Number.isSafeInteger(r.offset) || r.offset < 0))) fail('INVALID_REQUEST', 'Invalid ephemeral check lookup')
      return r.type === 'export.check.cancel' ? this.exportChecks.cancel(r.task_id, r.check_id) : this.exportChecks.status(r.task_id, r.check_id, r.offset ?? 0)
    }
    if (r.type === 'export.prepare') {
      if (Object.hasOwn(r, 'offset')) fail('INVALID_REQUEST', 'Export prepare does not accept a diagnosis offset')
      this.recovery.assertWrite()
      const { rows, resources, input, composition } = this.resolveExportSelection(r)
      const task = this.task(r.task_id), job = this.exports.create(task.id, this.epoch, this.journal.selected(), [...resources.values()], { version: composition ? 2 : 1, title: task.title, views: rows.map(v => ({ view_id: v.id, history_id: v.history_id, view_revision: v.revision, fragments: v.fragments })), answer_ids: r.answer_ids, ...(composition ? { runner: composition } : {}) })
      if (!this.exportRunner) {
        try { const result = generateExport(input), preview = this.exports.preview(job.id, result.html, result.issues); return { ...this.exports.public(job.id), html: preview.html } }
        catch (error) { this.exports.generationFailed(job.id, error instanceof ContractError ? error.code : 'EXPORT_GENERATION_FAILED'); throw error }
      }
      try {
        const reader = { generation: this.exportRunner(input), cancelling: false }
        this.exportReaders.set(job.id, reader)
        void reader.generation.result.then(result => {
          if (!this.closed && !reader.cancelling && this.exports.get(job.id).phase === 'preparing') this.exports.preview(job.id, result.html, result.issues)
        }).catch(error => {
          if (!this.closed && !reader.cancelling) this.exports.generationFailed(job.id, error instanceof ContractError ? error.code : 'EXPORT_GENERATION_FAILED')
        }).finally(() => { if (!reader.cancelling) this.exportReaders.delete(job.id) }).catch(() => {})
        return this.exports.public(job.id)
      } catch (error) { this.exports.generationFailed(job.id, 'EXPORT_GENERATION_FAILED'); throw error }
    }
    if (typeof r.operation_id !== 'string') fail('INVALID_REQUEST', 'Export requires its original operation ID')
    const job = this.exports.get(r.operation_id)
    if (job.task_id !== r.task_id) fail('EXPORT_NOT_FOUND', 'Export is not in this task')
    if (r.type === 'export.status' && Object.keys(r).sort().join(',') === 'operation_id,task_id,type') return this.exports.public(job.id)
    if (r.type === 'export.cancel' && Object.keys(r).sort().join(',') === 'operation_id,task_id,type') { const stopped = this.cancelExport(job.id); return stopped ? stopped.then(() => this.exports.public(job.id)) : this.exports.public(job.id) }
    if (r.type === 'export.preview' && Object.keys(r).sort().join(',') === 'operation_id,task_id,type' && job.phase === 'preview') return { ...this.exports.public(job.id), html: job.html }
    if (r.type === 'export.internal.inspect' && Object.keys(r).sort().join(',') === 'operation_id,task_id,type' && job.phase === 'unknown' && job.destination) return { html: job.html, destination: job.destination }
    if (r.type === 'export.internal.resolve' && Object.keys(r).sort().join(',') === 'operation_id,phase,task_id,type' && ['saved', 'failed'].includes(r.phase)) { this.exports.resolve(job.id, r.phase); return this.exports.public(job.id) }
    if (job.epoch !== this.epoch || job.selected !== this.journal.selected()) fail('EXPORT_SOURCE_INVALID', 'Old export cannot resume after restart or generation change')
    if (r.type === 'export.internal.valid' && Object.keys(r).sort().join(',') === 'operation_id,task_id,type' && job.phase === 'saving') { this.recovery.assertWrite(); return { valid: true } }
    if (r.type === 'export.internal.begin' && Object.keys(r).sort().join(',') === 'operation_id,partial,target,task_id,temporary,type' && typeof r.partial === 'boolean' && typeof r.target === 'string' && typeof r.temporary === 'string') {
      this.recovery.assertWrite()
      for (const resource of job.resources) { this.journal.assertResource(resource); const current = this.one('SELECT * FROM resources WHERE id=?', resource.id); if (json(current) !== json(resource)) fail('EXPORT_RESOURCE_CHANGED', 'Export resource metadata changed') }
      const next = this.exports.beginSave(job.id, r.target, r.temporary, r.partial)
      return { html: next.html, ...this.exports.public(job.id) }
    }
    if (r.type === 'export.internal.finish' && Object.keys(r).sort().join(',') === 'operation_id,phase,reason,task_id,type' && ['saved', 'failed', 'unknown'].includes(r.phase) && (r.reason === null || typeof r.reason === 'string' && /^[A-Z_]+$/.test(r.reason))) {
      this.exports.finish(job.id, r.phase, r.reason); return this.exports.public(job.id)
    }
    if (r.type === 'export.internal.created' && Object.keys(r).sort().join(',') === 'identity,operation_id,task_id,type') { this.exports.created(job.id, r.identity); return this.exports.public(job.id) }
    fail('INVALID_REQUEST', 'Invalid export operation')
  }
  snapshot(taskId: string, viewOffset = 0): Snapshot {
    this.settlePluginCleanup()
    this.chapters().reconcile(taskId)
    const row = this.task(taskId)
    const task: Task = { id: row.id, title: row.title, state: row.state, revision: row.revision }
    const surface = this.one('SELECT * FROM surfaces WHERE task_id=?', taskId)
    const total = this.one('SELECT count(*) n FROM views WHERE surface_id=?', surface.id).n
    const offset = Math.min(viewOffset, Math.max(0, Math.floor((total - 1) / 10) * 10))
    const layout = JSON.parse(surface.layout_json), ordered = layout.slots.flatMap((slot: Row) => slot.groups.flatMap((group: Row) => group.views)) as string[]
    if (new Set(ordered).size !== total || ordered.length !== total) fail('INVALID_LAYOUT', 'Persisted layout does not match current Views')
    const rows = ordered.slice(offset, offset + 10).map(viewId => this.one('SELECT * FROM views WHERE surface_id=? AND id=?', surface.id, viewId))
    const pageIds = new Set(rows.map(v => v.id))
    for (const slot of layout.slots) slot.groups = slot.groups.map((group: Row) => ({ ...group, views: group.views.filter((v: string) => pageIds.has(v)), ...(group.column_weights ? { column_weights: group.column_weights.filter((_: number, index: number) => pageIds.has(group.views[index])) } : {}) })).filter((group: Row) => group.views.length)
    let renderedBytes = 0
    const views = rows.map(v => {
      const bundle = this.bundle(v.bundle_resource_id)
      let checked: ReturnType<typeof checkBundle>, error: { code: string; message: string } | undefined
      try { checked = this.checkedBundle(taskId, bundle, 'v-' + v.id) }
      catch (cause) {
        if (!(cause instanceof ContractError) || cause.code !== 'VIEW_TOP_LAYER_DISABLED') throw cause
        checked = { bundle, html: '', css: '' }
        error = { code: cause.code, message: '此 View 含越界原生界面行为，已阻止呈现。原内容、草稿和历史仍保留。' }
      }
      renderedBytes += Buffer.byteLength(checked.html) + Buffer.byteLength(checked.css) + Buffer.byteLength(v.draft_json) + Buffer.byteLength(json(checked.bundle))
      if (renderedBytes > 16 * 1024 * 1024) fail('SURFACE_PAGE_SIZE_LIMIT', 'Enabled View page exceeds 16 MiB; use fewer or smaller resources')
      const chapters = this.chapters().state
      const manifest = chapters.manifest(taskId, v.id)
      return { id: v.id, revision: v.revision, state_revision: v.state_revision, draft: JSON.parse(v.draft_json), bundle: checked.bundle, presentation: { html: checked.html, css: checked.css, ...(error ? { error } : {}) }, ...(manifest && manifest.view_revision === v.revision ? { chapter_manifest: manifest, chapter_updates: chapters.updates(taskId, v.id) } : {}) }
    })
    return {
      runtime_epoch: this.epoch, task, task_archived: this.taskArchived(taskId), surface: { id: surface.id, revision: surface.revision, layout }, view_page: { offset, limit: 10, total },
      ...(this.features.runner ? { runner: this.features.runner.conversationRouting
        ? { goals: [], next_cursor: null, scope: new RunnerHostStatus(this.db, this.epoch).scope(taskId) }
        : this.runnerGoals({ task_id: taskId, limit: 16 }) } : {}),
      task_data: { items: this.db.prepare('SELECT id,revision FROM task_data WHERE task_id=? ORDER BY rowid DESC LIMIT 200').all(taskId) as { id: string; revision: number }[], total: this.one('SELECT count(*) AS total FROM task_data WHERE task_id=?', taskId).total },
      views,
      approval_total: this.one('SELECT count(*) n FROM approvals p JOIN actions a ON a.id=p.action_id WHERE a.task_id=?', taskId).n,
      record_total: this.one('SELECT count(*) n FROM records WHERE task_id=?', taskId).n,
      approvals: this.approvals(taskId),
      message_requests: this.messageRequests(taskId),
      surface_updates: [...this.surfaceWaiters].filter(([, w]) => w.taskId === taskId).map(([action_id, w]) => ({ action_id, run_id: w.runId, request: { input: { operations: (w.request as Row).input.operations.map((op: Row) => ({ type: op.type, ...(op.view_id ? { view_id: op.view_id } : {}) })) } }, request_truncated: true, reset_requires_confirmation: w.reset, expires_at: w.expires })),
      runs: (this.db.prepare(`SELECT c.id,c.state,c.primary_reason,c.wait_reason,c.budget_json,${runMessage('c')} AS message_id FROM runs c WHERE c.task_id=? ORDER BY c.rowid DESC LIMIT 50`).all(taskId) as Snapshot['runs']).map(run => run.state === 'failed' ? { ...run, primary_reason: runnerFailureReason(this.db, taskId, run.id, run.primary_reason) } : run),
      records: boundedRecent((this.db.prepare("SELECT id,kind,created_at,CASE WHEN length(CAST(payload_json AS BLOB))<=4096 THEN payload_json ELSE json_object('text',substr(json_extract(payload_json,'$.text'),1,600),'truncated',json('true'),'original_event_id',id) END payload_json FROM records WHERE task_id=? ORDER BY sequence DESC LIMIT 200").all(taskId) as Row[]).map(r => ({ id: r.id, kind: r.kind, payload: snapshotValue(r.payload_json, { kind: 'event', id: r.id }), created_at: r.created_at })), 96 * 1024).reverse(),
      answer_total: this.one('SELECT count(*) AS n FROM answers WHERE task_id=?', taskId).n,
      answers: boundedRecent((this.db.prepare("SELECT id,created_at,CASE WHEN length(CAST(raw_json AS BLOB))+length(CAST(value_json AS BLOB))<=4096 THEN raw_json ELSE 'null' END raw_json,CASE WHEN length(CAST(raw_json AS BLOB))+length(CAST(value_json AS BLOB))<=4096 THEN value_json END value_json FROM answers WHERE task_id=? ORDER BY rowid DESC LIMIT 200").all(taskId) as Row[]).map(a => ({ id: a.id, raw: JSON.parse(a.raw_json), value: a.value_json === null ? null : JSON.parse(a.value_json), ...(a.value_json === null ? { truncated: true } : {}), created_at: a.created_at })), 96 * 1024).reverse()
    }
  }
  private messageRequests(task: string): NonNullable<Snapshot['message_requests']> {
    return this.db.prepare("SELECT id,state,json_extract(input_json,'$.code') AS code FROM requests WHERE task_id=? ORDER BY rowid DESC LIMIT 50").all(task) as NonNullable<Snapshot['message_requests']>
  }
  private taskArchived(task: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM task_organization WHERE task_id=? AND archived=1').get(task)
  }
  private subscribe(task: string, viewOffset = 0, after?: Extract<IpcRequest, { type: 'sync.subscribe' }>['after']): unknown {
    this.settlePluginCleanup()
    this.task(task)
    const pageKey = json([task, viewOffset])
    const facts = json([
      this.one('SELECT revision FROM tasks WHERE id=?', task), this.taskArchived(task),
      this.db.prepare('SELECT revision,state_revision FROM views WHERE surface_id IN (SELECT id FROM surfaces WHERE task_id=?) ORDER BY id').all(task),
      this.db.prepare('SELECT state,wait_reason,primary_reason,budget_json FROM runs WHERE task_id=? ORDER BY rowid DESC LIMIT 50').all(task),
      this.messageRequests(task),
      this.approvals(task),
      [...this.surfaceWaiters].filter(([, value]) => value.taskId === task).map(([key]) => key)
      ,this.db.prepare('SELECT update_id,state FROM runner_chapter_updates WHERE task_id=? ORDER BY rowid').all(task)
    ])
    let cached = this.syncFacts.get(pageKey)
    if (!cached || cached.key !== facts) { cached = { key: facts, snapshot: this.snapshot(task, viewOffset) }; this.syncFacts.set(pageKey, cached) }
    if (this.syncFacts.size > 8) for (const key of this.syncFacts.keys()) if (key !== pageKey) { this.syncFacts.delete(key); break }
    return this.sync.subscribe(cached.snapshot, (after?.view_offset ?? 0) === viewOffset ? after : undefined, viewOffset)
  }
  private view(taskId: string, viewId: string, revision: number, stateRevision: number): Row {
    this.task(taskId)
    const v = this.one('SELECT v.* FROM views v JOIN surfaces s ON s.id=v.surface_id WHERE v.id=? AND s.task_id=?', viewId, taskId)
    if (v.revision !== revision || v.state_revision !== stateRevision) fail('VERSION_CONFLICT', 'Content or draft changed; retain local input and reload remote state')
    return v
  }
  private qualify(taskId: string, runId: string): Row {
    this.acceptWork()
    this.journal.assertMaterials(this.db.prepare('SELECT r.id,r.storage_key FROM resources r JOIN task_resources t ON t.resource_id=r.id WHERE t.task_id=?').all(taskId) as Row[])
    this.recovery.assertWrite()
    if (this.closed) fail('SOURCE_INVALID', 'Runtime closed')
    if (this.task(taskId).state !== 'active') fail('SOURCE_INVALID', 'Task is not active')
    const run = this.one('SELECT * FROM runs WHERE id=? AND task_id=?', runId, taskId)
    if (!run.commit_valid || !['running', 'waiting'].includes(run.state) || run.runtime_epoch !== this.epoch) fail('SOURCE_INVALID', 'Run has no commit permission')
    return run
  }
  start(taskId: string, text: string, config: string, attachments: unknown[], queuedRequestId?: string, routed?: RoutedAdmission): string {
    this.acceptWork()
    this.recovery.assertWrite()
    if (!queuedRequestId && this.db.prepare("SELECT 1 FROM requests WHERE task_id=? AND state IN ('queued','confirmation_required') LIMIT 1").get(taskId)) fail('REQUEST_QUEUE_PENDING', 'Resolve or cancel earlier requests before using the legacy start entry')
    if (attachments.length && !queuedRequestId) fail('UNSUPPORTED_INPUT', 'Use the explicit material request entry')
    const boundMaterials = attachments.map((target: any) => this.requestMaterial(taskId, target.id))
    if (!text.trim() || Buffer.byteLength(text) > defaults.data.object_bytes) fail('INVALID_INPUT', 'Text must be nonempty and bounded')
    let main: ModelLease | undefined, approval: ModelLease | undefined, compact: ModelLease | undefined
    if (config !== 'fixture') {
      main = this.models.acquire(config, 'main')
      try { compact = this.models.acquireCompaction(main); if (this.approvalMode === 'assisted') approval = this.models.acquire(this.approvalModel, 'approval') }
      catch (e) { compact?.release(); main.release(); throw e }
    }
    const runId = id(), requestId = queuedRequestId ?? id()
    try { this.db.transaction(() => {
      if (this.task(taskId).state !== 'active') fail('TASK_STOPPED', 'Explicitly resume the task first')
      if (!this.runnerRunAvailable(taskId, requestId)) fail('RUN_BUSY', 'Production admission is currently occupied')
      const conversation = !queuedRequestId && this.features.runner ? captureConversation(this.db, taskId) : undefined
      let userRecord: string | undefined
      if (queuedRequestId) {
        const request = this.one("SELECT state,input_json,config_selection_json FROM requests WHERE id=? AND task_id=?", requestId, taskId)
        const input = routed?.input ?? JSON.parse(request.input_json)
        if (request.state !== 'queued' || input.epoch !== this.epoch) fail('REQUEST_SOURCE_INVALID', 'Request is no longer eligible')
        if (routed && ((main && main.revision !== JSON.parse(request.config_selection_json).revision) || json(this.requestSelection(config)) !== request.config_selection_json)) fail('REQUEST_CONFIGURATION_CHANGED', 'Confirm the model configuration before production')
        userRecord = input.user_record_id
        if (userRecord) {
          const source = this.one("SELECT payload_json FROM records WHERE id=? AND task_id=? AND kind='message.user'", userRecord, taskId)
          const payload = JSON.parse(source.payload_json)
          if (payload.request_id !== requestId || payload.text !== text) fail('REQUEST_SOURCE_INVALID', 'Original conversation input changed')
        }
        this.db.prepare("UPDATE requests SET state='started',input_json=? WHERE id=?").run(json({ ...input, bound_materials: boundMaterials, code: null, ...(routed ? {
          chapter_route: routed.route, ...(this.features.runner?.conversationRouting && ['new', 'delegate'].includes(routed.route.kind) ? { content_plan: true } : {}),
          ...(routed.chapterQuery ? { chapter_query: routed.chapterQuery } : {})
        } : {}) }), requestId)
      } else this.db.prepare("INSERT INTO requests VALUES (?,?,'started',?,?,?)").run(requestId, taskId, json({ id: config, revision: main?.revision ?? 1, approval_id: approval?.id, approval_revision: approval?.revision, approval_mode: this.approvalMode }), json({ text, attachments, ...(conversation ? { conversation } : {}) }), now())
      this.db.prepare("INSERT INTO runs (id,task_id,request_id,state,runtime_epoch,limits_json,budget_json,created_at) VALUES (?,?,?,'running',?,?,?,?)").run(runId, taskId, requestId, this.epoch, json({ ...defaults, run: main?.config.limits ?? {}, output_policy: main?.config.max_output_tokens === undefined ? 'service-default' : 'configured' }), json({ model_requests: 0, tool_requests: 0, tokens: 0, fixture: config === 'fixture' }), now())
      const recordId = userRecord ?? this.record(taskId, 'message.user', { text, run_id: runId, request_id: requestId, ...(queuedRequestId ? { materials: boundMaterials } : {}) })
      if (main && this.features.runner) {
        const event = this.runner().receive({ input_event_id: `request:${requestId}`, task_id: taskId, request_id: requestId, record_id: recordId, kind: 'request', stage: 'received' })
        if (queuedRequestId && this.features.runner.conversationRouting) {
          const work = new RunnerWorkState(this.db, this.epoch)
          const route = work.consume(event.input_event_id, 'routed', () => ({ route: 'direct', kind: 'request', request_id: requestId } as const))
          work.consume(event.input_event_id, 'installed', () => {
            const answerOnly = routed?.route.kind === 'delegate'
            const plan = work.installContentPlan(event, initialDeliveryRequirements(answerOnly ? 'delegate' : 'new', routed?.draft))
            if (!answerOnly) {
              this.runnerArtifacts().installOutline(ruleRouterOutline(plan, this.runnerArtifacts().outline(taskId)))
              this.refreshRunnerScope(taskId)
            }
            this.installRunnerProduction(taskId, requestId, runId, main, boundMaterials, recordId, routed?.draft)
            return { version: 1, input_event_id: event.input_event_id, task_id: taskId, state: 'installed', route, refs: [{ task_id: taskId, kind: 'run', id: runId }], waits: [] }
          })
        } else {
          this.runner().advance(event.input_event_id)
          this.installRunnerProduction(taskId, requestId, runId, main, boundMaterials)
        }
      }
    })()
    } catch (e) { main?.release(); compact?.release(); approval?.release(); throw e }
    if (main) {
      const controller = new AbortController(), budget = new RunBudget(main.config)
      this.accountLease(taskId, runId, main); if (compact) this.accountLease(taskId, runId, compact); if (approval) this.accountLease(taskId, runId, approval)
      this.agents.set(runId, { controller, main, compact, approval, budget, mode: this.approvalMode, ...(this.features.runner ? { managed: true } : {}) })
      if (this.features.runner) {
        if (routed?.draft) this.pumpRunnerWorkers(taskId)
        else {
          const work = new RunnerWorkState(this.db, this.epoch).taskWorks(taskId).find(work => work.run_id === runId)!
          void this.executeRunnerProduction(work.current_attempt_id!).catch(() => {})
        }
      } else void this.agent(taskId, runId, text)
    } else this.timers.set(runId, setTimeout(() => { this.timers.delete(runId); this.fixture(taskId, runId, text) }, 150))
    return runId
  }
  private installRunnerProduction(taskId: string, requestId: string, runId: string, main: ModelLease, materials: Row[], messageId?: string, dispatch?: DispatchWork): void {
    const state = new RunnerWorkState(this.db, this.epoch), goal = state.goal(requestId)
    const query = JSON.parse(this.one('SELECT input_json FROM requests WHERE task_id=? AND id=?', taskId, requestId).input_json).chapter_query as { manifest: ChapterManifest; region_ids: string[] } | undefined
    const chapterDependencies = query ? [...new Map([
      { kind: 'chapter' as const, task_id: taskId, view_id: query.manifest.view_id, revision: query.manifest.shared_revision },
      ...(query.manifest.content_tree ? query.manifest.content_tree.nodes.filter(node => query.region_ids.includes(node.node_id)).map(node => ({ kind: 'chapter' as const, task_id: taskId, view_id: query.manifest.view_id, region_id: node.node_id, revision: node.revision })) : query.manifest.chapters.filter(chapter => query.region_ids.includes(chapter.region_id)).flatMap(chapter => [
        { kind: 'chapter' as const, task_id: taskId, view_id: query.manifest.view_id, region_id: chapter.region_id, revision: chapter.revision }, ...chapter.dependencies
      ]))
    ].map(dependency => [json(dependency), dependency])).values()] : []
    const ledger = new RunnerBudgetLedger(this.db)
    const previous = this.db.prepare("SELECT budget_id FROM runner_budgets WHERE task_id=? AND request_id=? AND purpose='production' ORDER BY rowid LIMIT 1").get(taskId, requestId) as Row | undefined
    const budgetId = previous?.budget_id ?? id()
    if (!previous) ledger.create({ budget_id: budgetId, task_id: taskId, purpose: 'production', request_id: requestId })
    const origin = messageId ? { message_id: messageId } : {}
    state.registerRun({ run_id: runId, task_id: taskId, runtime_epoch: this.epoch, state: 'running', commit_valid: true, budget_id: budgetId, ...origin, purpose: 'production', request_id: requestId, intent_revision: goal.intent_revision })
    if (!requestDelivery(this.db, taskId, requestId, goal.intent_revision)) this.record(taskId, 'runner.delivery.opened', { request_id: requestId, intent_revision: goal.intent_revision, input_event_id: goal.input_event_id, state: 'open' })
    const dependencies = [...(messageId ? [] : [{ kind: 'goal' as const, task_id: taskId, request_id: requestId, intent_revision: goal.intent_revision }]), ...materials.map(resource => ({ kind: 'resource' as const, task_id: taskId, resource_id: resource.id })), ...chapterDependencies]
    const source = { task_id: taskId, run_id: runId, request_id: requestId, intent_revision: goal.intent_revision, dependencies, ...origin }
    if (dispatch) {
      const content = new AssignmentContent(this.db), scope = content.scope(taskId, requestId)
      const works = installableAssignments(dispatch, goal, source, id, binding => this.routedOutputSource(state, taskId, binding), [], checkpoint => { WorkerContext.checkpoint(this.db, taskId, checkpoint, { model_config_id: main.id, model_config_revision: main.revision }) }, (binding, assignment) => content.checkNew(scope, binding, assignment))
      state.installPlan(works)
      const sealer = works.find(work => work.assignment?.final_answer) ?? works.find(work => work.required)!
      this.runnerComposition().designateSource({ task_id: taskId, request_id: requestId, intent_revision: goal.intent_revision, work_id: sealer.work_id, plan_revision: sealer.plan_revision })
      for (const work of works) this.record(taskId, 'runner.plan.installed', { run_id: runId, request_id: requestId, intent_revision: goal.intent_revision, work_id: work.work_id, plan_revision: work.plan_revision, routed: true })
      return
    }
    const workId = id(), attemptId = id()
    const work: LogicalWork = { ...source, work_id: workId, plan_revision: 1, role: 'producer', required: true, requirement_ids: goal.requirements.map(requirement => requirement.requirement_id), state: 'planned', max_attempts: 2, purpose: 'production' }
    state.installPlan([work])
    state.createAttempt({ attempt_id: attemptId, task_id: taskId, run_id: runId, work_id: workId, runtime_epoch: this.epoch, attempt_number: 1, profile_id: 'producer-output-v1', model_config_id: main.id, model_config_revision: main.revision, input_versions: work.dependencies, state: 'registered', dispatch_state: 'not_dispatched', usage_refs: [], ...origin, purpose: 'production', request_id: requestId, intent_revision: goal.intent_revision })
    this.runnerComposition().designateSource({ task_id: taskId, request_id: requestId, intent_revision: goal.intent_revision, work_id: workId, plan_revision: work.plan_revision })
    this.record(taskId, 'runner.plan.installed', { run_id: runId, request_id: requestId, intent_revision: goal.intent_revision, work_id: workId, attempt_id: attemptId, plan_revision: work.plan_revision })
  }
  private runnerGoalText(task: string, request: string, revision: number): string {
    const original = JSON.parse(this.one('SELECT input_json FROM requests WHERE task_id=? AND id=?', task, request).input_json).text
    const changes = (this.db.prepare("SELECT r.payload_json FROM runner_content_plans g JOIN runner_inputs i ON i.input_event_id=g.input_event_id JOIN records r ON r.id=i.record_id AND r.task_id=i.task_id WHERE g.task_id=? AND g.request_id=? AND g.intent_revision<=? AND i.kind='correction' ORDER BY g.intent_revision").all(task, request, revision) as Row[]).map(row => JSON.parse(row.payload_json).text)
    if (typeof original !== 'string' || changes.some(text => typeof text !== 'string')) fail('RUNNER_INPUT_CONFLICT', 'Goal input history requires inspection')
    const text = changes.length ? json({ original_request: original, corrections: changes }) : original
    if (!text.trim() || Buffer.byteLength(text) > defaults.data.object_bytes) fail('INVALID_INPUT', 'Goal input history exceeds the enabled input limit')
    return text
  }
  private runnerConversation(task: string, request: string, revision: number): ConversationHistory {
    const source = this.one(`SELECT r.sequence,r.payload_json,q.input_json AS accepted_input FROM runner_content_plans g
      JOIN runner_inputs i ON i.input_event_id=g.input_event_id JOIN records r ON r.id=i.record_id AND r.task_id=i.task_id
      LEFT JOIN requests q ON q.task_id=r.task_id AND q.id=json_extract(r.payload_json,'$.request_id') WHERE g.task_id=? AND g.request_id=? AND g.intent_revision=?`, task, request, revision)
    const payload = JSON.parse(source.payload_json)
    const input = JSON.parse(this.one('SELECT input_json FROM requests WHERE task_id=? AND id=?', task, request).input_json)
    const accepted = source.accepted_input ? JSON.parse(source.accepted_input) : undefined
    // Old requests have no snapshot. Their own input still fixes the boundary;
    // replay and restart must never pull in later Task or sibling-worker events.
    const binding: ConversationBinding = payload.conversation ?? accepted?.conversation ?? (revision === 1 ? input.conversation : undefined) ?? { version: 1, through_sequence: source.sequence - 1, reply_to_request_id: null }
    return this.loadBoundConversation(task, binding, accepted?.conversation_dependency ?? input.conversation_dependency)
  }
  private boundConversationResult(task: string, dependency?: BoundConversationDependency): ConversationResult | null {
    if (!dependency?.result_id) return null
    return conversationDependencyResult(this.db, task, dependency.message_id, dependency.request_id, dependency.result_id)
      ?? fail('CONVERSATION_DEPENDENCY_UNAVAILABLE', 'The exact preceding result is unavailable')
  }
  private loadBoundConversation(task: string, binding: ConversationBinding, dependency?: BoundConversationDependency): ConversationHistory {
    const history = loadConversation(this.db, task, binding), result = this.boundConversationResult(task, dependency)
    return result ? { ...history, preceding_result: result } : history
  }
  private precedingViewGrants(result?: ConversationResult | null): WorkerGrant[] {
    return result?.views?.length ? [
      { type: 'read', kind: 'view_history', ids: result.views.map(view => view.history.id) },
      { type: 'read', kind: 'resource', ids: result.views.map(view => view.content.id) }
    ] : []
  }
  private runnerCorrectionInputs(task: string, request: string, revision: number): Row[] {
    return this.db.prepare(`SELECT r.id,q.id AS request_id,q.input_json,q.config_selection_json FROM runner_content_plans g
      JOIN runner_inputs i ON i.task_id=g.task_id AND i.input_event_id=g.input_event_id AND i.kind='correction'
      JOIN records r ON r.task_id=i.task_id AND r.id=i.record_id AND r.kind='message.user'
      JOIN requests q ON q.task_id=r.task_id AND q.id=json_extract(r.payload_json,'$.request_id')
      WHERE g.task_id=? AND g.request_id=? AND g.intent_revision<=? ORDER BY g.intent_revision`).all(task, request, revision) as Row[]
  }
  private pumpRunnerGoals(task: string): void {
    if (!this.features.runner || this.closing || this.closed || this.recoveringRunnerInputs.has(task) || this.task(task).state !== 'active') return
    // Dialogue corrections re-enter the persistent message queue after routing.
    if (this.features.runner.conversationRouting) return
    const goals = this.db.prepare(`SELECT h.request_id,h.intent_revision FROM runner_current_content_plans h
      WHERE h.task_id=? AND json_extract(h.payload_json,'$.state')='active'
      AND NOT EXISTS (SELECT 1 FROM runner_content_removals d WHERE d.task_id=h.task_id AND d.request_id=h.request_id AND d.intent_revision=h.intent_revision)
      AND NOT EXISTS (SELECT 1 FROM runner_runs r WHERE r.task_id=h.task_id AND r.request_id=h.request_id AND r.intent_revision=h.intent_revision AND r.purpose='production')
      ORDER BY h.position LIMIT 32`).all(task) as Row[]
    for (const goal of goals) {
      if (this.preparingRunnerGoals.has(goal.request_id) || !this.runnerRunAvailable(task, goal.request_id)) continue
      this.preparingRunnerGoals.add(goal.request_id)
      const epoch = this.epoch
      void this.startRunnerGoal(task, goal.request_id, goal.intent_revision).catch(error => {
        if (!this.closed && this.db.open && this.epoch === epoch) this.record(task, 'runner.goal.waiting', { request_id: goal.request_id, intent_revision: goal.intent_revision, reason: error instanceof ContractError ? error.code : 'RUNNER_PREPARATION_FAILED' })
      }).finally(() => { if (this.epoch === epoch) this.preparingRunnerGoals.delete(goal.request_id) })
    }
  }
  private async startRunnerGoal(task: string, request: string, revision: number, pending?: { id: string; row: Row; materials: Row[] }): Promise<string | null> {
    const epoch = this.epoch
    const row = this.one('SELECT config_selection_json,input_json FROM requests WHERE task_id=? AND id=?', task, request), selection = JSON.parse((pending?.row ?? row).config_selection_json), input = JSON.parse(row.input_json)
    const correctiveInputs = this.runnerCorrectionInputs(task, request, revision)
    const correction = correctiveInputs.at(-1)
    if (pending && correction?.request_id !== pending.id) fail('CONTENT_REQUIREMENT_UNAVAILABLE', 'The queued correction no longer owns this revision')
    const sources: Row[] = [...(input.bound_materials ?? []), ...correctiveInputs.flatMap(row => row.request_id === pending?.id ? pending!.materials : JSON.parse(row.input_json).bound_materials ?? [])]
    const checked = sources.map(source => this.requestMaterial(task, source.id))
    if (json(checked) !== json(sources)) fail('REQUEST_MATERIAL_UNAVAILABLE', 'Original material binding changed')
    const materials = [...new Map(checked.map(material => [material.id, material])).values()]
    this.runnerGoalText(task, request, revision)
    for (const resource of materials) if (resource.byte_length > 262144) {
      const source = this.one('SELECT r.* FROM resources r JOIN task_resources t ON t.resource_id=r.id WHERE t.task_id=? AND r.id=?', task, resource.id)
      await readPluginResource(this.root, source as any, 0, true)
    }
    if (this.epoch !== epoch) return null
    this.acceptWork(); this.recovery.assertWrite()
    const state = new RunnerWorkState(this.db, this.epoch), goal = state.goal(request)
    if (goal.task_id !== task || goal.intent_revision !== revision || goal.state !== 'active') {
      if (pending) fail('CONTENT_REQUIREMENT_UNAVAILABLE', 'The queued correction no longer owns the current revision')
      return null
    }
    if (this.db.prepare('SELECT 1 FROM runner_content_removals WHERE task_id=? AND request_id=? AND intent_revision=?').get(task, request, revision)) return null
    if (!this.runnerRunAvailable(task, request)) return null
    if (pending) {
      const fresh = this.one('SELECT state,input_json,config_selection_json FROM requests WHERE task_id=? AND id=?', task, pending.id)
      if (fresh.state !== 'queued' || fresh.input_json !== pending.row.input_json || fresh.config_selection_json !== pending.row.config_selection_json) return null
      if (json(this.requestSelection(selection.id)) !== pending.row.config_selection_json) fail('REQUEST_CONFIGURATION_CHANGED', 'Confirm the model configuration for the correction')
    }
    const main = this.models.acquire(selection.id, 'main')
    let compact: ModelLease | undefined, approval: ModelLease | undefined
    const runId = id()
    try {
      if (main.revision !== selection.revision) fail('MODEL_CONFIGURATION_CHANGED', 'Corrected goal retains its original model selection')
      compact = this.models.acquireCompaction(main)
      if (selection.approval_mode === 'assisted') {
        approval = this.models.acquire(selection.approval_id, 'approval')
        if (approval.revision !== selection.approval_revision) fail('MODEL_CONFIGURATION_CHANGED', 'Corrected goal retains its original approval selection')
      }
      this.db.transaction(() => {
        if (this.task(task).state !== 'active' || state.goal(request).intent_revision !== revision || !this.runnerRunAvailable(task, request)) fail('RUN_BUSY', 'Goal is no longer eligible for production')
        if (this.db.prepare("SELECT 1 FROM runner_runs WHERE task_id=? AND request_id=? AND intent_revision=? AND purpose='production'").get(task, request, revision)) fail('RUNNER_INPUT_CONFLICT', 'This goal revision already has a production source')
        if (this.one('SELECT config_selection_json FROM requests WHERE id=? AND task_id=?', request, task).config_selection_json !== row.config_selection_json || json(materials.map((source: Row) => this.requestMaterial(task, source.id))) !== json(materials)) fail('REQUEST_SOURCE_INVALID', 'Goal bindings changed during preparation')
        const previous = this.db.prepare("SELECT run_id FROM runner_runs WHERE task_id=? AND request_id=? AND purpose='production' ORDER BY rowid DESC LIMIT 1").get(task, request) as Row | undefined
        this.db.prepare("INSERT INTO runs(id,task_id,request_id,state,runtime_epoch,limits_json,budget_json,created_at) VALUES (?,?,?,'running',?,?,?,?)").run(runId, task, request, this.epoch, json({ ...defaults, run: main.config.limits ?? {} }), json({ model_requests: 0, tool_requests: 0, tokens: 0 }), now())
        this.installRunnerProduction(task, request, runId, main, materials, correction?.id)
        if (correction) {
          const saved = JSON.parse(correction.input_json)
          delete saved.correction_pending
          this.db.prepare("UPDATE requests SET state='started',input_json=? WHERE id=? AND task_id=?").run(json({ ...saved, code: null, correction_run_id: runId, ...(pending ? { bound_materials: pending.materials } : {}) }), correction.request_id, task)
        }
        this.record(task, 'runner.production.started', { run_id: runId, request_id: request, intent_revision: revision, input_event_id: goal.input_event_id, previous_run_id: previous?.run_id ?? null })
      })()
    } catch (error) { main.release(); compact?.release(); approval?.release(); throw error }
    this.agents.set(runId, { controller: new AbortController(), main, compact, approval, budget: new RunBudget(main.config), mode: selection.approval_mode === 'assisted' ? 'assisted' : 'manual', managed: true })
    const work = state.taskWorks(task).find(work => work.run_id === runId)!
    void this.executeRunnerProduction(work.current_attempt_id!).catch(() => {})
    return runId
  }
  recoverRunnerWork(): Promise<void> {
    if (!this.features.runner || this.closing || this.closed || (this.recovery.status() as Row).phase !== 'idle') return Promise.resolve()
    if (this.runnerRecoveryFlight) return this.runnerRecoveryFlight
    const epoch = this.epoch, flight = this.recoverRunnerWorkPass(epoch)
    this.runnerRecoveryFlight = flight
    void flight.finally(() => { if (this.runnerRecoveryFlight === flight) this.runnerRecoveryFlight = undefined }).catch(() => {})
    return flight
  }
  private async recoverRunnerWorkPass(epoch: string): Promise<void> {
    const recovery = new RunnerHostRecovery(this.db, epoch)
    const tasks = this.db.prepare("SELECT DISTINCT t.id FROM tasks t JOIN runner_inputs i ON i.task_id=t.id WHERE t.state='active' ORDER BY t.rowid").all() as Row[]
    for (const { id: task } of tasks) {
      if (this.closed || this.closing || this.epoch !== epoch) return
      this.recoveringRunnerInputs.add(task)
      try {
        let cursor: string | undefined
        do {
          const page = recovery.pendingInputs(task, cursor)
          for (const input of page.items) {
            if (this.task(task).state !== 'active') break
            try { this.advanceRunnerInput(input.input_event_id) }
            catch (error) { this.record(task, 'runner.recovery.blocked', { input_event_id: input.input_event_id, reason: error instanceof ContractError ? error.code : 'RUNNER_INPUT_RECOVERY_FAILED' }) }
          }
          cursor = page.next_cursor ?? undefined
        } while (cursor && this.task(task).state === 'active')
      } finally { this.recoveringRunnerInputs.delete(task) }
      if (this.task(task).state !== 'active') continue
      this.reconcileRunnerDependencies(new RunnerWorkState(this.db, epoch), task)
      const runs = this.db.prepare("SELECT r.run_id FROM runner_runs r JOIN runs c ON c.id=r.run_id WHERE r.task_id=? AND r.purpose='production' AND c.state='interrupted' AND c.runtime_epoch!=? ORDER BY r.rowid").all(task, epoch) as Row[]
      for (const row of runs) {
        if (this.closed || this.closing || this.epoch !== epoch) return
        const state = new RunnerWorkState(this.db, epoch), previous = state.run(row.run_id)
        if (previous.purpose !== 'production' || !this.runnerRunAvailable(task, previous.request_id)) continue
        const blocked = (reason: string): void => {
          if (!this.db.prepare("SELECT 1 FROM records WHERE task_id=? AND kind='runner.goal.waiting' AND json_extract(payload_json,'$.previous_run_id')=? AND json_extract(payload_json,'$.reason')=? LIMIT 1").get(task, previous.run_id, reason)) this.record(task, 'runner.goal.waiting', { request_id: previous.request_id, intent_revision: previous.intent_revision, previous_run_id: previous.run_id, reason })
        }
        const interruptedWorks = state.taskWorks(task).filter(work => work.run_id === previous.run_id)
        const unknownDiagnosis = interruptedWorks.filter(work => work.role === 'diagnostic').some(work => state.attempts(work.work_id).some(attempt =>
          attempt.run_id === previous.run_id && (attempt.state === 'unknown' || attempt.dispatch_state === 'unknown' || attempt.operation_id && recovery.queryOperation(task, attempt.operation_id)?.state === 'unknown')
        ))
        if (unknownDiagnosis) { blocked('RUNNER_OPERATION_UNKNOWN'); continue }
        // Diagnosis opportunities remain historical evidence. Only their original
        // operation can resolve unknown usage; they never resume as content work.
        const works = interruptedWorks.filter(work => work.role !== 'diagnostic' && ['planned', 'queued', 'running', 'waiting'].includes(work.state))
        if (!works.length) continue
        const unavailable = works.map(work => {
          const attempt = work.current_attempt_id ? state.attempt(work.current_attempt_id) : undefined
          if (!attempt) return state.pendingAssignmentRecoveryFailure(work)
          if (state.clarifiedAssignment(work)) return attempt.attempt_number < work.max_attempts ? null : 'RUNNER_ATTEMPTS_EXHAUSTED'
          if (attempt.state === 'unknown' || attempt.dispatch_state !== 'not_dispatched') return 'RUNNER_OPERATION_UNKNOWN'
          if (!this.recoverableProductionProfile(work, attempt)) return 'RUNNER_RECOVERY_PROFILE_UNAVAILABLE'
          if (attempt.attempt_number >= work.max_attempts) return 'RUNNER_ATTEMPTS_EXHAUSTED'
          return attempt.state !== 'revoked' ? 'RUNNER_RECOVERY_INELIGIBLE' : null
        }).find(reason => reason !== null)
        if (unavailable) { blocked(unavailable); continue }
        try { await this.resumeRunnerProduction(task, previous.run_id, works, epoch) }
        catch (error) {
          if (this.epoch !== epoch || this.closed) return
          blocked(error instanceof ContractError ? error.code : 'RUNNER_RECOVERY_FAILED')
        }
      }
      const batches = this.db.prepare(`SELECT b.batch_id,b.payload_json FROM runner_batches b JOIN runs c ON c.id=json_extract(b.payload_json,'$.run_id') WHERE b.task_id=? AND c.state='interrupted' AND c.runtime_epoch!=?
        AND NOT EXISTS (SELECT 1 FROM runner_batches next WHERE next.task_id=b.task_id AND json_extract(next.payload_json,'$.previous_batch_id')=b.batch_id)
        AND NOT EXISTS (SELECT 1 FROM records f WHERE f.task_id=b.task_id AND f.kind='runner.composition.feedback' AND json_extract(f.payload_json,'$.run_id')=c.id) ORDER BY b.rowid`).all(task, epoch) as Row[]
      for (const row of batches) {
        const batch = JSON.parse(row.payload_json)
        void this.executeAutomaticComposition(task, batch.trigger_request_id, row.batch_id).catch(error => {
          if (!this.closed && this.epoch === epoch) this.record(task, 'runner.recovery.blocked', { batch_id: row.batch_id, operation_id: batch.operation_id, reason: error instanceof ContractError ? error.code : 'COMPOSITION_RECOVERY_FAILED' })
        })
      }
      this.resumeContentRemainders(task)
      this.pumpRunnerWorkers(task)
      this.pumpRunnerGoals(task)
      this.settleRunnerDeliveries(task)
    }
  }
  private async resumeRunnerProduction(task: string, previousRunId: string, works: LogicalWork[], epoch: string): Promise<void> {
    const state = new RunnerWorkState(this.db, epoch), previous = state.run(previousRunId)
    if (previous.purpose !== 'production') fail('RUNNER_RECOVERY_INELIGIBLE', 'Only undispatched production can resume')
    const request = previous.request_id, row = this.one('SELECT input_json,config_selection_json FROM requests WHERE task_id=? AND id=?', task, request)
    const input = JSON.parse(row.input_json), corrections = this.runnerCorrectionInputs(task, request, previous.intent_revision)
    const correction = corrections.find(item => item.id === previous.message_id)
    const sourceRequest = correction?.request_id ?? request, selectionRow = correction ?? row
    const selection = JSON.parse(selectionRow.config_selection_json)
    const sources: Row[] = [...(input.bound_materials ?? []), ...corrections.flatMap(item => JSON.parse(item.input_json).bound_materials ?? [])]
    const checked = sources.map(source => this.requestMaterial(task, source.id))
    if (json(checked) !== json(sources)) fail('REQUEST_MATERIAL_UNAVAILABLE', 'Recovery retains exact original materials')
    const materials = [...new Map(checked.map(material => [material.id, material])).values()]
    for (const resource of materials) if (resource.byte_length > defaults.resource.inline_bytes) {
      const source = this.one('SELECT r.* FROM resources r JOIN task_resources t ON t.resource_id=r.id WHERE t.task_id=? AND r.id=?', task, resource.id)
      await readPluginResource(this.root, source as any, 0, true)
    }
    if (this.epoch !== epoch) return
    this.acceptWork(); this.recovery.assertWrite()
    const main = this.models.acquire(selection.id, 'main')
    let compact: ModelLease | undefined, approval: ModelLease | undefined
    const runId = id()
    try {
      if (main.revision !== selection.revision) fail('MODEL_CONFIGURATION_CHANGED', 'Recovery requires the original model revision')
      compact = this.models.acquireCompaction(main)
      if (selection.approval_mode === 'assisted') {
        approval = this.models.acquire(selection.approval_id, 'approval')
        if (approval.revision !== selection.approval_revision) fail('MODEL_CONFIGURATION_CHANGED', 'Recovery requires the original approval revision')
      }
      const waits = new Set<string>()
      const attempts: ExecutionAttempt[] = works.flatMap(work => {
        if (!work.current_attempt_id) return []
        const original = state.attempt(work.current_attempt_id)
        if (original.model_config_id !== main.id || original.model_config_revision !== main.revision) fail('MODEL_CONFIGURATION_CHANGED', 'Recovered attempts retain their model binding')
        if (state.clarifiedAssignment(work)) { waits.add(work.work_id); return [] }
        state.checkHandoffs(work, original.attempt_id)
        const { result_ref: _result, operation_id: _operation, ...binding } = original
        return [{ ...binding, attempt_id: id(), previous_attempt_id: original.attempt_id, run_id: runId, runtime_epoch: epoch, attempt_number: original.attempt_number + 1, state: 'registered', dispatch_state: 'not_dispatched', usage_refs: [] }]
      })
      const repairs = new RunnerRepairState(this.db, state, this.runnerArtifacts(), this.runnerComposition())
      const repairTargets = new Map<string, { repair: PendingRepair; target: ReturnType<RuntimeStore['repairTarget']> }>()
      this.db.transaction(() => {
        for (const work of works) {
          const binding = artifactRepair(this.db, task, work.work_id)
          const repairId = binding?.request_record_id ?? repairRequestId(this.db, task, work.work_id)
          if (!repairId) continue
          const repair = repairs.request(task, repairId)
          if (!repairs.current(task, repair) || binding && binding.repair_run_id !== previousRunId) fail('REPAIR_OBSOLETE', 'Resumed feedback must still reference the current problem')
          const target = this.repairTarget(state, task, repair)
          repairTargets.set(work.work_id, { repair, target })
          if (binding) this.record(task, 'runner.repair.rebound', { ...binding, repair_run_id: runId, previous_run_id: previousRunId })
        }
        new RunnerHostRecovery(this.db, epoch).resume({ run: { ...previous, run_id: runId, previous_run_id: previous.run_id, runtime_epoch: epoch, state: 'running', commit_valid: true }, attempts, planned_work_ids: works.filter(work => !work.current_attempt_id).map(work => work.work_id), waiting_work_ids: [...waits] }, {
          recheck: () => {
            this.acceptWork(); this.recovery.assertWrite()
            if (!this.runnerRunAvailable(task, request)) fail('RUN_BUSY', 'Recovery awaits production admission')
            const current = this.one('SELECT input_json,config_selection_json FROM requests WHERE task_id=? AND id=?', task, sourceRequest)
            if (current.config_selection_json !== selectionRow.config_selection_json || current.input_json !== selectionRow.input_json || json(materials.map(source => this.requestMaterial(task, source.id))) !== json(materials)) fail('REQUEST_SOURCE_INVALID', 'Recovery bindings changed during preparation')
          },
          installRun: () => { this.db.prepare("INSERT INTO runs(id,task_id,request_id,state,runtime_epoch,limits_json,budget_json,created_at) VALUES (?,?,?,'running',?,?,?,?)").run(runId, task, request, epoch, json({ ...defaults, run: main.config.limits ?? {} }), json({ model_requests: 0, tool_requests: 0, tokens: 0 }), now()) }
        })
        const source = this.runnerComposition().source(task, request, previous.intent_revision)
        if (source && works.some(work => work.work_id === source.work_id)) this.runnerComposition().designateSource({ ...source, plan_revision: state.work(source.work_id).plan_revision }, { work_id: source.work_id, plan_revision: source.plan_revision })
        if (correction) this.db.prepare("UPDATE requests SET input_json=json_set(input_json,'$.correction_run_id',?) WHERE task_id=? AND id=?").run(runId, task, sourceRequest)
        this.record(task, 'runner.production.resumed', { run_id: runId, previous_run_id: previous.run_id, request_id: request, intent_revision: previous.intent_revision, work_ids: works.map(work => work.work_id), attempt_ids: attempts.map(attempt => attempt.attempt_id), budget_id: previous.budget_id })
        for (const attempt of attempts) this.installAssignmentHandoffs(state, state.work(attempt.work_id), attempt)
      })()
      this.agents.set(runId, { controller: new AbortController(), main, compact, approval, budget: new RunBudget(main.config), mode: selection.approval_mode === 'assisted' ? 'assisted' : 'manual', managed: true })
      if (waits.size) this.aggregateWorkerRun(task, runId)
      for (const attempt of attempts) {
        const resumed = repairTargets.get(attempt.work_id)
        const execution = attempt.profile_id === 'work-router-v1' && resumed
          ? this.executeRepairRouter(state, task, repairs, resumed.repair, state.work(attempt.work_id) as AssignedWork, attempt, createWorkRouterProfile('feedback'), resumed.target.index, resumed.target.requirements)
          : this.executeRunnerProduction(attempt.attempt_id)
        void execution.catch(() => {})
      }
    } catch (error) { main.release(); compact?.release(); approval?.release(); throw error }
  }
  private contentToolGrants(task: string, conversation: ConversationHistory): WorkerGrant[] {
    // Queries enforce Task ownership; request materials describe inputs, not the tool access boundary.
    const capabilities = this.pluginDirectory.discovery(task).map(capability => capability.id as string)
    return [
      { type: 'list', kind: 'content_tree' }, { type: 'read', kind: 'content_tree' }, { type: 'read', kind: 'content_node' },
      { type: 'list', kind: 'resource' }, { type: 'read', kind: 'resource' },
      { type: 'read', kind: 'event', ids: [...new Set([...conversation.refs.map(ref => ref.id), ...conversation.messages.map(item => item.source.id), ...(conversation.preceding_result ? [conversation.preceding_result.id] : [])])] },
      ...this.precedingViewGrants(conversation.preceding_result),
      { type: 'list', kind: 'task_data' }, { type: 'read', kind: 'task_data' },
      { type: 'list', kind: 'plugin' }, { type: 'read', kind: 'plugin' },
      { type: 'list', kind: 'capability' }, { type: 'read', kind: 'capability', ids: capabilities },
      ...capabilities.map(capability => ({ type: 'call' as const, capability }))
    ]
  }
  private orchestrationSource(state: RunnerWorkState, task: string, binding: RouteWorkRunnerOutputBinding): Extract<LogicalWork, { purpose: 'production' }> {
    if (!this.db.prepare('SELECT 1 FROM runner_work WHERE task_id=? AND work_id=?').get(task, binding.work_id)) fail('RUNNER_DEPENDENCY_INVALID', 'Output source is not available in this Task')
    const work = state.work(binding.work_id)
    if (work.purpose !== 'production' || work.plan_revision !== binding.plan_revision || !work.assignment?.outputs.some(output => output.output_key === binding.output_key)) fail('RUNNER_DEPENDENCY_INVALID', 'Output source no longer matches the selected plan')
    return work
  }
  private routedOutputSource(state: RunnerWorkState, task: string, binding: RouteWorkRunnerOutputBinding): AssignedWork {
    const work = this.orchestrationSource(state, task, binding), exact = bindOutput(task, work, binding)
    if (work.state === 'succeeded') this.assignedOutput(work, exact)
    else {
      const run = state.run(work.run_id), goal = state.goal(work.request_id)
      if (!run.commit_valid || run.runtime_epoch !== this.epoch || goal.state !== 'active' || goal.intent_revision !== work.intent_revision) fail('RUNNER_DEPENDENCY_INVALID', 'The selected work can no longer deliver its output')
    }
    return work
  }
  private routingRevision(task: string, run: string): number {
    return (this.db.prepare(`SELECT COALESCE(MAX(json_extract(payload_json,'$.revision')),1) AS revision FROM records
      WHERE task_id=? AND kind='runner.plan.revised' AND json_extract(payload_json,'$.run_id')=?`).get(task, run) as { revision: number }).revision
  }
  private *catalogOutputs(task: string): Iterable<CatalogOutput> {
    const state = new RunnerWorkState(this.db, this.epoch)
    const candidates = this.db.prepare(`SELECT work_id FROM runner_work WHERE task_id=? AND state IN ('planned','queued','running','waiting','succeeded')
      AND json_type(payload_json,'$.assignment')='object' ORDER BY work_id`).all(task) as { work_id: string }[]
    for (const { work_id } of candidates) {
      const work = state.work(work_id)
      if (work.purpose !== 'production' || !work.assignment) continue
      const source = { work_id, request_id: work.request_id }
      if (work.state !== 'succeeded') {
        const run = state.run(work.run_id), goal = state.goal(work.request_id)
        if (!run.commit_valid || run.runtime_epoch !== this.epoch || goal.state !== 'active' || goal.intent_revision !== work.intent_revision) continue
      }
      for (const output of work.assignment.outputs) {
        const reference = { work_id, plan_revision: work.plan_revision, output_key: output.output_key }
        if (work.state !== 'succeeded') { yield { kind: 'output', name: output.output_key, status: 'expected', reference, source }; continue }
        try {
          const exact = this.assignedOutput(work, reference)
          const publication = exact.kind === 'artifact'
            ? this.db.prepare(`SELECT m.view_id,m.view_revision FROM runner_view_mappings m JOIN views v ON v.id=m.view_id AND v.revision=m.view_revision
                WHERE m.task_id=? AND m.artifact_id=? AND m.artifact_revision=? LIMIT 1`).get(task, exact.artifact_id, exact.artifact_revision) as object | undefined
            : this.db.prepare(`SELECT id AS message_id FROM records WHERE task_id=? AND kind='runner.answer' AND json_extract(payload_json,'$.purpose')='final_answer'
                AND json_extract(payload_json,'$.result_ref.id')=? LIMIT 1`).get(task, exact.record_id) as object | undefined
          yield { kind: 'output', name: output.output_key, status: publication ? 'published' : 'accepted', reference: { ...reference, result_revision: exact.result_revision }, source: { ...source, ...publication } }
        } catch (error) {
          if (!(error instanceof ContractError) || !['RUNNER_DEPENDENCY_INVALID', 'RUNNER_OUTPUT_UNAVAILABLE'].includes(error.code)) throw error
        }
      }
    }
  }
  private routingWorkTable(state: RunnerWorkState, task: string, model: Pick<ExecutionAttempt, 'model_config_id' | 'model_config_revision'>, run?: string) {
    const rows = this.db.prepare(`SELECT work_id FROM runner_work WHERE task_id=? AND json_type(payload_json,'$.assignment')='object'
      ORDER BY (run_id IS ?) DESC,rowid DESC LIMIT 16`).all(task, run ?? null) as { work_id: string }[]
    let remainingBytes = 8192
    return rows.map(({ work_id }) => state.work(work_id)).flatMap(work => {
      if (work.purpose !== 'production' || !work.assignment) return []
      const outputs = work.assignment.outputs.flatMap(output => {
        const reference = { work_id: work.work_id, plan_revision: work.plan_revision, output_key: output.output_key }
        try {
          const source = this.routedOutputSource(state, task, reference)
          return [{ ...output, ...reference, ...(source.state === 'succeeded' ? { result_revision: source.result_revision } : {}) }]
        } catch (error) {
          if (error instanceof ContractError) return []
          throw error
        }
      })
      const attempt = work.current_attempt_id ? state.attempt(work.current_attempt_id) : state.attempts(work.work_id).at(-1)
      const checkpoints = attempt ? new WorkerContext(this.db, this.workerOwner({ task_id: task, runtime_epoch: attempt.runtime_epoch, work, attempt, run: state.run(work.run_id) })).checkpoints(model) : []
      const entry = { work_id: work.work_id, request_id: work.request_id, plan_revision: work.plan_revision, state: work.state,
        required: work.required, instructions: work.assignment.instructions.slice(0, 160), outputs, checkpoints }
      const bytes = Buffer.byteLength(json(entry)) + 1
      if (bytes > remainingBytes) return []
      remainingBytes -= bytes
      return [entry]
    })
  }
  private applyWorkRouting(state: RunnerWorkState, owner: Extract<ExecutionScope, { purpose: 'production' }>, origin: AssignedWork, decision: RouteWork): unknown {
    const task = owner.task_id, runId = owner.run_id, goal = state.goal(owner.request_id)
    if (decision.base_revision !== this.routingRevision(task, runId) || goal.intent_revision !== owner.intent_revision) fail('RUNNER_PLAN_CONFLICT', 'This routing context is no longer current')
    const works = state.taskWorks(task).filter((work): work is AssignedWork => work.purpose === 'production' && work.run_id === runId && !!work.assignment)
    const lookup = (binding: RouteWorkRunnerOutputBinding) => this.routedOutputSource(state, task, binding)
    const model = state.attempt(owner.attempt_id)
    const checkpoint = (id: string) => { WorkerContext.checkpoint(this.db, task, id, model) }
    const content = new AssignmentContent(this.db), scope = content.scope(task, owner.request_id)
    const checkContent: Parameters<typeof assignmentRevisions>[4] = (binding, assignment) => content.checkNew(scope, binding, assignment)
    const installed = decision.action === 'dispatch'
      ? state.installPlan(installableAssignments(decision, goal, {
          task_id: task, run_id: runId, request_id: owner.request_id, intent_revision: owner.intent_revision,
          dependencies: origin.dependencies, ...(owner.message_id ? { message_id: owner.message_id } : {})
        }, id, lookup, works, checkpoint, checkContent))
      : state.installAssignmentRevisions(assignmentRevisions(decision, works, lookup, checkpoint, checkContent))
    const inventorySource = this.runnerComposition().source(task, goal.request_id, goal.intent_revision)
    const revisedSource = installed.find(work => work.work_id === inventorySource?.work_id)
    if (inventorySource && revisedSource) this.runnerComposition().designateSource({ ...inventorySource, plan_revision: revisedSource.plan_revision }, inventorySource)
    const revision = decision.base_revision + 1
    const installedRefs = installed.map((work, index) => ({ work_id: work.work_id, plan_revision: work.plan_revision, ...(decision.action === 'dispatch' ? { assignment_key: decision.assignments[index]!.assignment_key } : {}) }))
    this.record(task, 'runner.plan.revised', { owner, run_id: runId, request_id: goal.request_id, revision, works: installedRefs })
    return { revision, works: installedRefs }
  }
  private reportAssignedInput(owner: Extract<ExecutionScope, { purpose: 'production' }>, work: AssignedWork, report: ReportMissingInput): string {
    const task = owner.task_id
    for (const reference of report.references ?? []) this.runnerArtifacts().checkProvenance(task, reference)
    const payload: MissingInputEvent = { run_id: owner.run_id, request_id: owner.request_id, work_id: work.work_id, attempt_id: owner.attempt_id, plan_revision: work.plan_revision, report }
    const previous = this.db.prepare(`SELECT id FROM records WHERE task_id=? AND kind='runner.input.reported' AND payload_json=? ORDER BY sequence LIMIT 1`).get(task, json(payload)) as { id: string } | undefined
    return previous?.id ?? this.record(task, 'runner.input.reported', payload)
  }
  private pendingWorkerInputs(task: string, through: number): PendingWorkerInput[] {
    return this.db.prepare(`SELECT q.id,substr(json_extract(q.payload_json,'$.text'),1,250) AS question,
      r.request_id,r.id AS run_id,w.work_id,a.attempt_id,w.plan_revision AS previous_plan_revision
      FROM records q JOIN records e ON e.id=json_extract(q.payload_json,'$.report_id') AND e.task_id=q.task_id AND e.kind='runner.input.reported'
      JOIN runner_work w ON w.work_id=json_extract(e.payload_json,'$.work_id') AND w.task_id=q.task_id AND w.state='waiting' AND w.plan_revision=json_extract(e.payload_json,'$.plan_revision')
      JOIN runner_attempts a ON a.attempt_id=json_extract(e.payload_json,'$.attempt_id') AND a.task_id=q.task_id AND a.work_id=w.work_id AND a.state='revoked'
      JOIN runs r ON r.id=w.run_id AND r.task_id=q.task_id AND r.runtime_epoch=? AND r.commit_valid=1
      WHERE q.task_id=? AND q.kind='runner.input.clarification' AND q.sequence<=? AND a.attempt_id=json_extract(w.payload_json,'$.current_attempt_id')
      AND a.run_id=json_extract(q.payload_json,'$.run_id')
      AND NOT EXISTS (SELECT 1 FROM records b WHERE b.task_id=q.task_id AND b.kind='runner.input.bound' AND json_extract(b.payload_json,'$.clarification_id')=q.id)
      ORDER BY q.sequence DESC LIMIT 16`).all(this.epoch, task, through) as PendingWorkerInput[]
  }
  private bindAssignmentReply(task: string, row: Row, input: Row, target: PendingWorkerInput, checkpointId: string | undefined, materials: Row[]): void {
    if (!this.pendingWorkerInputs(task, input.conversation.through_sequence).some(item => isDeepStrictEqual(item, target))) fail('CONVERSATION_REFERENCE_INVALID', 'Worker clarification is no longer pending')
    const state = new RunnerWorkState(this.db, this.epoch), work = state.work(target.work_id), attempt = state.attempt(target.attempt_id)
    if (work.purpose !== 'production' || !work.assignment || work.update_id || work.task_id !== task || target.request_id === row.id) fail('RUNNER_OWNERSHIP_INVALID', 'Reply does not target an eligible assignment')
    this.qualify(task, target.run_id)
    const selection = JSON.parse(row.config_selection_json)
    const original = this.one('SELECT config_selection_json FROM requests WHERE task_id=? AND id=?', task, target.request_id)
    if (attempt.model_config_id !== selection.id || attempt.model_config_revision !== selection.revision || row.config_selection_json !== original.config_selection_json) fail('REQUEST_CONFIGURATION_CHANGED', 'Confirm the original Worker configuration before supplying new input')
    if (!this.db.prepare("SELECT 1 FROM records WHERE task_id=? AND id=? AND kind='message.user' AND json_extract(payload_json,'$.request_id')=?").get(task, input.user_record_id, row.id)) fail('CONVERSATION_REFERENCE_INVALID', 'Supplement must use the saved user reply')
    if (checkpointId) WorkerContext.checkpoint(this.db, task, checkpointId, attempt)
    const { id: clarification_id, question: _question, ...origin } = target
    const resource_ids = materials.map(material => material.id as string)
    const supplement: AssignmentSupplement = { ...origin, clarification_id, source_request_id: row.id, message_id: input.user_record_id, resource_ids }
    const supplementId = this.record(task, 'runner.input.bound', supplement)
    const { current_attempt_id: _attempt, root_cause: _cause, result_revision: _result, ...source } = work
    const dependencies = [...work.dependencies]
    for (const resource_id of resource_ids) if (!dependencies.some(input => input.kind === 'resource' && input.resource_id === resource_id)) dependencies.push({ kind: 'resource', task_id: task, resource_id })
    const revised = { ...source, state: 'planned' as const, dependencies, plan_revision: work.plan_revision + 1,
      assignment: { ...work.assignment, ...(checkpointId ? { checkpoint_id: checkpointId } : {}), supplement_ids: [...work.assignment.supplement_ids ?? [], supplementId] } }
    const works = state.taskWorks(task).filter((work): work is AssignedWork => work.purpose === 'production' && work.run_id === target.run_id && !!work.assignment)
    const installed = state.installAssignmentRevisions(propagateAssignmentRevisions([revised], works), supplementId)
    this.record(task, 'runner.plan.revised', { run_id: work.run_id, request_id: work.request_id, revision: this.routingRevision(task, work.run_id) + 1, supplement_id: supplementId, works: installed.map(item => ({ work_id: item.work_id, plan_revision: item.plan_revision })) })
    const inventorySource = this.runnerComposition().source(task, work.request_id, work.intent_revision), revisedSource = installed.find(item => item.work_id === inventorySource?.work_id)
    if (inventorySource && revisedSource) this.runnerComposition().designateSource({ ...inventorySource, plan_revision: revisedSource.plan_revision }, inventorySource)
  }
  private queueWorkRouting(state: RunnerWorkState, task: string): void {
    const rows = this.db.prepare(`SELECT e.id,e.payload_json FROM records e JOIN runs r ON r.task_id=e.task_id AND r.id=json_extract(e.payload_json,'$.run_id')
      WHERE e.task_id=? AND e.kind='runner.input.reported' AND r.commit_valid=1 AND r.runtime_epoch=?
      AND NOT EXISTS (SELECT 1 FROM records c WHERE c.task_id=e.task_id AND c.kind='runner.input.routed' AND json_extract(c.payload_json,'$.report_id')=e.id)
      AND (json_extract(e.payload_json,'$.report.wait')=0 OR EXISTS (SELECT 1 FROM records w WHERE w.task_id=e.task_id AND w.kind='runner.assignment.waiting' AND json_extract(w.payload_json,'$.report_id')=e.id)) ORDER BY e.sequence`).all(task, this.epoch) as { id: string; payload_json: string }[]
    for (const row of rows) {
      const source = JSON.parse(row.payload_json) as MissingInputEvent
      const origin = state.work(source.work_id), agent = this.agents.get(source.run_id)
      if (!agent?.managed || origin.purpose !== 'production' || origin.plan_revision !== source.plan_revision || origin.current_attempt_id !== source.attempt_id || !['running', 'waiting'].includes(origin.state)) continue
      const profile = createWorkRouterProfile()
      const attempt = this.db.transaction(() => {
        const work: AssignedWork = { task_id: task, request_id: origin.request_id, run_id: origin.run_id, intent_revision: origin.intent_revision,
          ...(origin.message_id ? { message_id: origin.message_id } : {}), work_id: id(), purpose: 'production', role: 'router', plan_revision: 1,
          state: 'planned', required: false, requirement_ids: [], dependencies: origin.dependencies.filter(dependency => dependency.kind !== 'work'), max_attempts: 1 }
        state.installPlan([work])
        const attempt = state.createAttempt({ task_id: task, run_id: work.run_id, work_id: work.work_id, attempt_id: id(), runtime_epoch: this.epoch,
          purpose: 'production', request_id: work.request_id, intent_revision: work.intent_revision, ...(work.message_id ? { message_id: work.message_id } : {}),
          attempt_number: 1, profile_id: profile.id, model_config_id: agent.main.id, model_config_revision: agent.main.revision,
          input_versions: work.dependencies, state: 'registered', dispatch_state: 'not_dispatched', usage_refs: [] })
        this.record(task, 'runner.input.routed', { report_id: row.id, request_id: work.request_id, run_id: work.run_id, work_id: work.work_id, attempt_id: attempt.attempt_id })
        return attempt
      }).immediate()
      const revision = () => this.routingRevision(task, source.run_id)
      const catalog = new RoutingInputCatalog(this.db, new AssignmentContent(this.db).scope(task, origin.request_id), () => this.catalogOutputs(task))
      const stillWaiting = () => {
        const current = state.work(origin.work_id)
        return source.report.wait && current.state === 'waiting' && current.plan_revision === source.plan_revision && current.current_attempt_id === source.attempt_id ? current : undefined
      }
      let affected: LogicalWork[] = []
      void this.executeWorker(attempt.attempt_id, profile, {
        text: this.runnerGoalText(task, origin.request_id, origin.intent_revision),
        bound: { base_revision: revision(), report: source, work_table: this.routingWorkTable(state, task, attempt, source.run_id) },
        orchestration: {
          get revision() { return revision() },
          route: (decision, owner) => this.applyWorkRouting(state, owner, origin, decision),
          catalog: query => catalog.page(query),
          report: () => fail('WORKER_CAPABILITY_DENIED', 'Router cannot report on behalf of a Worker')
        }
      }, (result, owner) => {
        this.record(task, 'runner.input.resolved', { report_id: row.id, owner, request_id: origin.request_id, run_id: origin.run_id, result })
        const current = stillWaiting()
        if (!current) return
        if (result.kind === 'blocked') affected = state.revokeWork(current.work_id, { kind: 'failure', work_id: current.work_id, attempt_id: source.attempt_id })
        if (result.kind === 'clarification') {
          const attempt = state.attempt(source.attempt_id), sourceOwner = this.workerOwner({ task_id: task, runtime_epoch: this.epoch, work: current, run: state.run(origin.run_id), attempt })
          this.record(task, 'runner.input.clarification', { owner, report_id: row.id, request_id: origin.request_id, run_id: origin.run_id, reply_to: origin.message_id, text: result.question })
          this.record(task, 'worker.state', { owner: sourceOwner, run_id: origin.run_id, state: 'waiting', reason: 'input_required' })
        }
      }, undefined, undefined, result => {
        const current = stillWaiting()
        if (result.kind === 'clarification' && !current) return {
          code: 'RUNNER_PLAN_CONFLICT', path: 'kind', value: result.kind, message: 'No assignment is waiting for a user reply. Return updated if a decision was installed, or blocked.'
        }
        if (!current || result.kind === 'blocked') return null
        if (state.attempt(source.attempt_id).attempt_number >= current.max_attempts) return {
          code: 'RUNNER_ATTEMPTS_EXHAUSTED', path: 'kind', value: result.kind, message: 'The waiting assignment has no attempts left. A user reply cannot resume it. Return blocked.'
        }
        return result.kind === 'updated' ? {
          code: 'RUNNER_PLAN_CONFLICT', path: 'kind', value: result.kind,
          message: 'The reporting assignment is still waiting. Bind or revise that assignment, ask for clarification, or return blocked.'
        } : null
      }).then(() => this.settleDependentRuns(task, affected, origin.run_id), error => {
        if (this.closed || this.closing || !this.db.open || !state.run(origin.run_id).commit_valid) return
        const router = state.attempt(attempt.attempt_id), current = stillWaiting()
        if (!current || router.state === 'unknown' || router.dispatch_state === 'unknown') return
        const code = error instanceof ContractError || error instanceof ModelError ? error.code : 'MODEL_EXECUTION_FAILED'
        const affected = this.db.transaction(() => {
          this.record(task, 'runner.input.blocked', { report_id: row.id, request_id: origin.request_id, run_id: origin.run_id, work_id: current.work_id, routing_attempt_id: router.attempt_id, code })
          return state.revokeWork(current.work_id, { kind: 'failure', work_id: router.work_id, attempt_id: router.attempt_id, reason: code })
        }).immediate()
        this.settleDependentRuns(task, affected, origin.run_id)
        this.aggregateWorkerRun(task, origin.run_id)
      })
    }
  }
  private assignedOutput(work: Extract<LogicalWork, { purpose: 'production' }>, binding: RouteWorkRunnerOutputBinding) {
    const revision = work.result_revision
    if (work.state !== 'succeeded' || revision === undefined || binding.result_revision !== undefined && binding.result_revision !== revision) fail('RUNNER_DEPENDENCY_INVALID', 'Output source has no matching successful result')
    const output = (() => {
      try { return this.runnerComposition().checkOutput(work.task_id, work.work_id, work.plan_revision, revision) }
      catch (error) {
        if (!(error instanceof ContractError) || !['RUNNER_OWNERSHIP_INVALID', 'RUNNER_DEPENDENCY_INVALID', 'RUNNER_OUTPUT_INCOMPLETE', 'RUNNER_NOT_FOUND'].includes(error.code)) throw error
        fail('RUNNER_DEPENDENCY_INVALID', 'The assigned output is no longer current')
      }
    })()
    if (!output) fail('RUNNER_OUTPUT_UNAVAILABLE', 'The assigned output was not accepted')
    const exact = { ...binding, result_revision: revision }
    if (work.assignment?.outputs.find(item => item.output_key === binding.output_key)?.kind === 'answer') {
      if (!this.db.prepare("SELECT 1 FROM records WHERE task_id=? AND id=? AND kind='worker.result' AND json_type(payload_json,'$.value.answer')='text'").get(work.task_id, output.result_ref.id)) fail('RUNNER_OUTPUT_UNAVAILABLE', 'The assigned answer was not delivered')
      return { ...exact, kind: 'answer' as const, record_id: output.result_ref.id }
    }
    const slot = this.db.prepare('SELECT artifact_id FROM runner_artifact_slots WHERE task_id=? AND work_id=? AND output_key=?').get(work.task_id, work.work_id, binding.output_key) as { artifact_id: string } | undefined
    const artifact = output.artifacts.find(item => item.artifact_id === (slot?.artifact_id ?? artifactRepair(this.db, work.task_id, work.work_id)?.previous.artifact_id))
    const current = artifact ? this.runnerArtifacts().owner(work.task_id, artifact.artifact_id) : null
    const index = artifact && current?.current_revision === artifact.artifact_revision ? this.runnerArtifacts().artifact(work.task_id, artifact.artifact_id, artifact.artifact_revision) : null
    if (!index) fail('RUNNER_OUTPUT_UNAVAILABLE', 'The assigned artifact is not an accepted current version')
    return { ...exact, kind: 'artifact' as const, artifact_id: index.artifact_id, artifact_revision: index.artifact_revision, bundle_resource_id: index.bundle_resource_id }
  }
  private boundAssignmentOutputs(state: RunnerWorkState, work: Extract<LogicalWork, { purpose: 'production' }>) {
    return (work.assignment?.inputs ?? []).filter(binding => 'work_id' in binding).map(binding => {
      const dependency = work.dependencies.find(item => item.kind === 'work' && item.work_id === binding.work_id)
      if (dependency?.kind !== 'work' || dependency.task_id !== work.task_id) fail('RUNNER_DEPENDENCY_INVALID', 'Assignment input is not authorized by its exact dependency')
      try { return this.assignedOutput(this.orchestrationSource(state, work.task_id, binding), binding) }
      catch (error) {
        if (!(error instanceof ContractError)) throw error
        fail(error.code, `Output ${binding.work_id}/${binding.output_key}: ${error.message}`)
      }
    })
  }
  private publishDeliveryAnswer(state: RunnerWorkState, inventory: NonNullable<ReturnType<RunnerCompositionState['inventory']>>): void {
    const goal = state.goal(inventory.request_id)
    if (goal.intent_revision !== inventory.intent_revision || unresolvedDeliveryRequirements(this.db, inventory).length) return
    const output = inventory.required_works.find(output => {
      const work = state.work(output.work_id)
      return work.purpose === 'production' && (work.assignment?.final_answer || this.features.runner?.conversationRouting && !work.assignment && output.artifacts.length > 0)
    })
    if (!output) return
    try {
      if (!this.runnerComposition().checkOutput(inventory.task_id, output.work_id, output.plan_revision, output.result_revision)) return
    } catch (error) { if (error instanceof ContractError) return; throw error }
    const work = state.work(output.work_id), attempt = state.attempt(output.attempt_id), run = state.run(output.run_id)
    const owner = this.workerOwner({ task_id: inventory.task_id, runtime_epoch: run.runtime_epoch, work, attempt, run, goal })
    const { text } = this.one("SELECT json_extract(payload_json,'$.value.answer') AS text FROM records WHERE task_id=? AND id=?", inventory.task_id, output.result_ref.id) as { text: string | null }
    if (text !== null) this.recordRunnerAnswer(inventory.task_id, { owner, purpose: 'final_answer', text, request_id: goal.request_id, input_event_id: goal.input_event_id, run_id: run.run_id, intent_revision: goal.intent_revision, result_ref: output.result_ref })
  }
  private publishCompositionAnswers(state: RunnerWorkState, task: string): void {
    const composition = this.runnerComposition(), scope = composition.scope(task)
    if (!scope?.targets.some(target => target.contribution_inventory)) return
    const ready = this.runnerHostComposition().completeness(task)
    for (const target of scope.targets) {
      const reference = target.contribution_inventory
      if (!reference || ready.unresolved.some(item => item.request_id === target.request_id && item.intent_revision === target.intent_revision)) continue
      const inventory = composition.checkInventory(task, target.request_id, target.intent_revision, reference.inventory_revision)
      if (composition.currentArtifacts(inventory).every(index => ready.contributions.some(entry => entry.artifact_id === index.artifact_id && entry.artifact_revision === index.artifact_revision))) this.publishDeliveryAnswer(state, inventory)
    }
  }
  private settleRunnerDeliveries(task: string, unavailableTrigger?: string): void {
    if (!this.features.runner || this.closed || this.closing) return
    const state = new RunnerWorkState(this.db, this.epoch), composition = this.runnerComposition()
    const pending = new RunnerRepairState(this.db, state, this.runnerArtifacts(), composition).pending(task)
    const goals = state.contentPlans(task)
    if (!goals.some(goal => requestDelivery(this.db, task, goal.request_id, goal.intent_revision)?.state === 'open')) return
    if (!composition.scope(task) && goals.some(goal => goal.requirements.some(requirement => requirement.kind !== 'answer'))) this.refreshRunnerScope(task)
    const scope = composition.scope(task), host = this.runnerHostComposition()
    const ready = scope ? host.completeness(task) : undefined
    const active = this.task(task).state === 'active', modelFeedback = this.features.runner.collator === 'model' && active
    const rebuildId = this.runnerCompositionWaiting.get(task)?.previousBatchId
    const rebuild = rebuildId ? composition.batch(task, rebuildId) : null
    const settling = [...this.runnerCompositionPublishing.values()].filter(batch => batch.task_id === task)
    if (rebuild) settling.push(rebuild)
    let feedback: ContentPlan | undefined, continuation: string | undefined
    this.db.transaction(() => {
      for (const goal of goals) {
        const { request_id, intent_revision, input_event_id } = goal
        if (requestDelivery(this.db, task, request_id, intent_revision)?.state !== 'open' || deliveryHasUnsettledExecution(this.db, task, request_id, intent_revision) || pending.some(repair => repair.request_id === request_id && repair.intent_revision === intent_revision)) continue
        if (settling.some(batch => batch.targets.some(target => target.request_id === request_id && target.intent_revision === intent_revision))) continue
        const works = state.taskWorks(task).filter((work): work is AssignedWork => work.purpose === 'production' && !work.update_id && work.request_id === request_id && work.intent_revision === intent_revision)
        if (!works.length) continue
        const content = goal.requirements.some(requirement => requirement.kind !== 'answer')
        const planned = composition.inventory(task, request_id, intent_revision)
        let inventory: typeof planned = null
        if (planned) try { inventory = composition.checkInventory(task, request_id, intent_revision, planned.inventory_revision) }
        catch (error) { if (!(error instanceof ContractError)) throw error }
        const missing = new Set((inventory ? unresolvedDeliveryRequirements(this.db, inventory) : goal.requirements.filter(requirement => requirement.required)).map(item => item.requirement_id))
        if (content) for (const item of ready?.unresolved ?? []) if (item.request_id === request_id && item.intent_revision === intent_revision) missing.add(item.requirement_id)
        const fragments = this.db.prepare(`SELECT artifact_id,current_revision FROM runner_artifact_owners o JOIN runner_artifacts a USING(task_id,artifact_id)
          WHERE o.task_id=? AND a.artifact_revision=o.current_revision AND json_extract(a.payload_json,'$.request_id')=? AND json_extract(a.payload_json,'$.intent_revision')=?`).all(task, request_id, intent_revision) as { artifact_id: string; current_revision: number }[]
        const unattempted = active && request_id !== unavailableTrigger && fragments.some(fragment => {
          const index = this.runnerArtifacts().artifact(task, fragment.artifact_id, fragment.current_revision)
          return index && host.unattemptedFragment(index)
        })
        if (unattempted) { continuation ??= request_id; continue }
        if (inventory && scope && modelFeedback && host.missingRequirements(scope, [goal]).length && !this.missingFeedbackAttempted(goal)) {
          feedback ??= goal
          continue
        }
        if (content && inventory && !ready?.targets.some(target => target.request_id === request_id && target.intent_revision === intent_revision)) {
          for (const requirement of goal.requirements.filter(item => item.required && item.kind !== 'answer')) missing.add(requirement.requirement_id)
        }
        if (!missing.size && inventory) this.publishDeliveryAnswer(state, inventory)
        const answer = this.db.prepare(`SELECT 1 FROM records WHERE task_id=? AND kind='runner.answer' AND json_extract(payload_json,'$.request_id')=?
          AND json_extract(payload_json,'$.intent_revision')=? AND json_extract(payload_json,'$.input_event_id')=?`).get(task, request_id, intent_revision, input_event_id)
        if (!answer) for (const requirement of goal.requirements.filter(item => item.required && item.kind === 'answer')) missing.add(requirement.requirement_id)
        this.record(task, 'runner.delivery.settled', { request_id, intent_revision, input_event_id, state: missing.size ? 'incomplete' : 'complete', missing_requirement_ids: [...missing] })
      }
    }).immediate()
    if (continuation && !this.runnerCompositionMerges.has(task) && !this.runnerCompositionWaiting.has(task)) this.scheduleRunnerComposition(task, continuation)
    if (feedback) this.executeMissingCompositionFeedback(feedback)
  }
  private missingFeedbackAttempted(goal: ContentPlan): boolean {
    const { task_id, request_id, intent_revision } = goal
    return !!this.db.prepare(`SELECT 1 FROM runner_batches b,json_each(b.payload_json,'$.targets') t WHERE b.task_id=@task_id
      AND json_array_length(b.payload_json,'$.indexes')=0 AND json_extract(t.value,'$.request_id')=@request_id AND json_extract(t.value,'$.intent_revision')=@intent_revision
      UNION ALL SELECT 1 FROM records WHERE task_id=@task_id AND kind='runner.composition.feedback_blocked'
      AND json_extract(payload_json,'$.request_id')=@request_id AND json_extract(payload_json,'$.intent_revision')=@intent_revision LIMIT 1`).get({ task_id, request_id, intent_revision })
  }
  private executeMissingCompositionFeedback(goal: ContentPlan): void {
    const { task_id: task, request_id: request, intent_revision } = goal
    let prepared: PreparedRunnerComposition
    try { prepared = this.prepareRunnerComposition(task, request, { feedback_only: true }) }
    catch (error) {
      if (error instanceof ContractError && error.code === 'RUN_BUSY') return
      this.record(task, 'runner.composition.feedback_blocked', { request_id: request, intent_revision, code: error instanceof ContractError ? error.code : 'COMPOSITION_PREPARATION_FAILED' })
      queueMicrotask(() => this.settleRunnerDeliveries(task))
      return
    }
    void this.executePreparedComposition(task, request, prepared).catch(() => {})
  }
  private queueAssignedWork(state: RunnerWorkState, task: string): void {
    const settle = new Set<string>(), affected: LogicalWork[] = []
    for (const work of state.taskWorks(task)) {
      if (work.purpose !== 'production' || !work.assignment || work.state !== 'planned' || work.current_attempt_id) continue
      const agent = this.agents.get(work.run_id), run = state.run(work.run_id)
      if (!agent?.managed || !run.commit_valid) continue
      if (work.dependencies.some(dependency => dependency.kind === 'work' && state.work(dependency.work_id).state !== 'succeeded')) continue
      try {
        const attempt = this.db.transaction(() => {
          const previous = state.attempts(work.work_id).at(-1)
          const current = state.pinAssignmentOutputs(work.work_id, this.boundAssignmentOutputs(state, work))
          const contentInputs = boundContentInputs(current)
          const attempt = state.createAttempt({ attempt_id: id(), task_id: task, work_id: work.work_id, run_id: work.run_id, runtime_epoch: this.epoch,
            attempt_number: (previous?.attempt_number ?? 0) + 1, ...(previous ? { previous_attempt_id: previous.attempt_id } : {}), profile_id: 'producer-output-v1', model_config_id: agent.main.id, model_config_revision: agent.main.revision, input_versions: current.dependencies,
            state: 'registered', dispatch_state: 'not_dispatched', usage_refs: [], purpose: 'production', request_id: work.request_id, intent_revision: work.intent_revision,
            ...(contentInputs.length ? { content_inputs: contentInputs } : {}), ...(work.message_id ? { message_id: work.message_id } : {}) })
          this.installAssignmentHandoffs(state, current, attempt)
          return attempt
        }).immediate()
        void this.executeRunnerProduction(attempt.attempt_id).catch(() => {})
      } catch (error) {
        if (!(error instanceof ContractError) || !['RUNNER_OUTPUT_UNAVAILABLE', 'RUNNER_DEPENDENCY_INVALID', 'RUNNER_ATTEMPT_CONFLICT'].includes(error.code)) throw error
        affected.push(...state.revokeWork(work.work_id, { kind: 'failure', work_id: work.work_id }))
        this.record(task, 'runner.assignment.blocked', { run_id: work.run_id, request_id: work.request_id, work_id: work.work_id, code: error.code, reason: error.message })
        settle.add(work.run_id)
      }
    }
    this.settleDependentRuns(task, affected)
    for (const runId of settle) this.aggregateWorkerRun(task, runId)
  }
  private installAssignmentHandoffs(state: RunnerWorkState, work: LogicalWork, attempt: ExecutionAttempt): void {
    if (work.purpose !== 'production' || !work.assignment?.inputs.length) return
    for (const output of this.boundAssignmentOutputs(state, work)) this.record(work.task_id, 'runner.output.handoff', {
      work_id: output.work_id, plan_revision: output.plan_revision, result_revision: output.result_revision, output_key: output.output_key,
      ...(output.kind === 'artifact' ? { artifact_id: output.artifact_id, artifact_revision: output.artifact_revision } : {}),
      consumer_work_id: work.work_id, consumer_attempt_id: attempt.attempt_id, request_id: work.request_id, run_id: work.run_id
    })
  }
  private repairTarget(state: RunnerWorkState, task: string, repair: PendingRepair) {
    const { issue, request_id, intent_revision } = repair, artifacts = this.runnerArtifacts(), direct = repair.recipient.kind === 'worker'
    const index = issue.kind === 'missing_requirement' ? null : artifacts.artifact(task, issue.artifact.artifact_id, issue.artifact.artifact_revision)
    const composition = this.runnerComposition(), designated = !index ? composition.source(task, request_id, intent_revision) : null
    const sourceId = index?.work_id ?? designated?.work_id
    if (!sourceId || issue.kind !== 'missing_requirement' && !index || direct && !index) fail('REPAIR_SOURCE_INELIGIBLE', 'The feedback source is unavailable')
    const source = state.work(sourceId), originalId = index?.attempt_id ?? source.current_attempt_id
    if (!originalId) fail('REPAIR_SOURCE_INELIGIBLE', 'The feedback source has no eligible attempt')
    const original = state.attempt(originalId), previous = state.run(original.run_id)
    if (source.purpose !== 'production' || previous.purpose !== 'production' || direct && source.role !== 'producer' || source.update_id || original.state !== 'succeeded') fail('REPAIR_SOURCE_INELIGIBLE', 'Feedback requires an eligible settled production source')
    if (previous.state !== 'completed' && !(previous.state === 'interrupted' && designated?.plan_revision === source.plan_revision && source.result_revision !== undefined &&
      composition.checkOutput(task, source.work_id, source.plan_revision, source.result_revision)?.attempt_id === originalId)) fail('REPAIR_SOURCE_INELIGIBLE', 'Feedback requires an eligible settled production source')
    if (this.db.prepare(`SELECT 1 FROM actions a JOIN approvals p ON p.action_id=a.id WHERE a.task_id=? AND p.decision='deny'
      AND json_extract(a.source_json,'$.owner.attempt_id')=?`).get(task, original.attempt_id)) fail('APPROVAL_DENIED', 'Feedback cannot bypass an original denial')
    const requirements = index ? artifacts.candidate(task, this.one('SELECT candidate_id FROM runner_artifacts WHERE task_id=? AND artifact_id=? AND artifact_revision=?', task, index.artifact_id, index.artifact_revision).candidate_id)!.candidate.requirement_ids : []
    return { source, original, previous, index, requirements }
  }
  private queueRepairs(state: RunnerWorkState, task: string): void {
    if (!this.features.runner || this.closed || this.closing || this.task(task).state !== 'active') return
    const artifacts = this.runnerArtifacts(), repairs = new RunnerRepairState(this.db, state, artifacts, this.runnerComposition())
    for (const repair of repairs.pending(task)) {
      const { request_record_id, problem_key, request_id, intent_revision, issue } = repair
      const blocked = (code: string) => this.record(task, 'runner.repair.blocked', { request_record_id, problem_key, request_id, intent_revision, code })
      if (!repairs.current(task, repair)) { blocked('REPAIR_OBSOLETE'); continue }
      if (!this.runnerRunAvailable(task, request_id)) continue
      const direct = repair.recipient.kind === 'worker'
      if (direct && this.db.prepare(`SELECT 1 FROM records WHERE task_id=? AND kind='runner.repair.started'
        AND json_extract(payload_json,'$.problem_key')=? AND json_type(payload_json,'$.previous')='object'`).get(task, problem_key)) { blocked('REPAIR_NO_PROGRESS'); continue }
      const selection = JSON.parse(this.one('SELECT config_selection_json FROM requests WHERE task_id=? AND id=?', task, request_id).config_selection_json)
      let main: ModelLease | undefined, compact: ModelLease | undefined, approval: ModelLease | undefined
      try {
        const { source, original, previous, index, requirements } = this.repairTarget(state, task, repair)
        this.recovery.assertWrite()
        main = this.models.acquire(selection.id, 'main')
        if (main.id !== original.model_config_id || main.revision !== original.model_config_revision || main.revision !== selection.revision) fail('MODEL_CONFIGURATION_CHANGED', 'Repair retains the original Worker configuration')
        compact = this.models.acquireCompaction(main)
        if (selection.approval_mode === 'assisted') {
          approval = this.models.acquire(selection.approval_id, 'approval')
          if (approval.revision !== selection.approval_revision) fail('MODEL_CONFIGURATION_CHANGED', 'Repair retains the original approval configuration')
        }
        const model = main, runId = id(), workId = id(), attemptId = id()
        const profile = direct ? undefined : createWorkRouterProfile('feedback')
        const { work, attempt } = this.db.transaction(() => {
          if (!repairs.current(task, repair) || !this.runnerRunAvailable(task, request_id)) fail('REPAIR_OBSOLETE', 'Repair eligibility changed before admission')
          this.db.prepare("INSERT INTO runs(id,task_id,request_id,state,runtime_epoch,limits_json,budget_json,created_at) VALUES (?,?,?,'running',?,?,?,?)").run(runId, task, request_id, this.epoch, json({ ...defaults, run: model.config.limits ?? {} }), json({ model_requests: 0, tool_requests: 0, tokens: 0 }), now())
          state.registerRun({ ...previous, run_id: runId, previous_run_id: previous.run_id, runtime_epoch: this.epoch, state: 'running', commit_valid: true })
          const dependencies: LogicalWork['dependencies'] = [...source.dependencies, ...(index ? [{ kind: 'resource' as const, task_id: task, resource_id: index.bundle_resource_id }] : [])]
          const unique = [...new Map(dependencies.map(input => [json(input), input])).values()]
          const origin = { purpose: 'production' as const, task_id: task, request_id, intent_revision, run_id: runId, work_id: workId, ...(source.message_id ? { message_id: source.message_id } : {}) }
          const work: AssignedWork = { ...origin, role: direct ? 'producer' : 'router', plan_revision: 1, required: true, requirement_ids: direct ? requirements : [], dependencies: unique, state: 'planned', max_attempts: 2,
            ...(direct ? { assignment: { instructions: 'Address the bound structural issue within the exact artifact replacement scope.', inputs: [], outputs: [{ output_key: 'replacement', kind: 'artifact', exposure: 'publish' }] } } : {}) }
          state.installPlan([work])
          const attempt = state.createAttempt({ ...origin, attempt_id: attemptId, runtime_epoch: this.epoch, attempt_number: 1, profile_id: profile?.id ?? 'producer-output-v1', model_config_id: model.id, model_config_revision: model.revision, input_versions: unique, state: 'registered', dispatch_state: 'not_dispatched', usage_refs: [] })
          if (direct && index && issue.kind !== 'missing_requirement') {
            const binding: ArtifactRepair = { request_record_id, problem_key, request_id, intent_revision, issue, previous: index, repair_run_id: runId, repair_work_id: workId }
            this.record(task, 'runner.repair.started', binding)
          } else this.record(task, 'runner.repair.routed', { request_record_id, problem_key, request_id, intent_revision, run_id: runId, work_id: workId, attempt_id: attemptId })
          return { work, attempt }
        }).immediate()
        this.agents.set(runId, { controller: new AbortController(), main, compact, approval, budget: new RunBudget(main.config), mode: selection.approval_mode === 'assisted' ? 'assisted' : 'manual', managed: true })
        const execution = profile ? this.executeRepairRouter(state, task, repairs, repair, work, attempt, profile, index, requirements) : this.executeRunnerProduction(attemptId)
        void execution.catch(error => {
          if (this.closed || this.closing || !this.db.open) return
          if (error instanceof ContractError && error.code === 'RUNNER_WAITING_INPUT') return
          if (profile && installedRepairDispatch(this.db, task, attemptId)) return
          const run = state.run(runId)
          if (run.commit_valid && state.attempt(attemptId).state !== 'unknown') this.finish(task, runId, 'failed', error instanceof ContractError ? error.code : 'REPAIR_EXECUTION_FAILED')
        })
      } catch (error) {
        main?.release(); compact?.release(); approval?.release()
        if (!(error instanceof ContractError)) throw error
        blocked(error.code)
      }
    }
  }
  private executeRepairRouter(state: RunnerWorkState, task: string, repairs: RunnerRepairState, repair: PendingRepair, work: AssignedWork, attempt: ExecutionAttempt, profile: ReturnType<typeof createWorkRouterProfile>, index: ReturnType<RunnerArtifactState['artifact']>, requirements: string[]) {
    const { issue, request_record_id, request_id, intent_revision, problem_key } = repair, runId = work.run_id
    const revision = () => this.routingRevision(task, runId)
    const installedPlan = () => !!this.db.prepare("SELECT 1 FROM records WHERE task_id=? AND kind='runner.repair.plan' AND json_extract(payload_json,'$.request_record_id')=?").get(task, request_record_id)
    const content = new AssignmentContent(this.db), scope = content.scope(task, request_id)
    const catalog = new RoutingInputCatalog(this.db, scope, () => this.catalogOutputs(task))
    return this.executeWorker(attempt.attempt_id, profile, {
      text: this.runnerGoalText(task, request_id, intent_revision),
      bound: { base_revision: revision(), feedback: { issue, request_record_id }, work_table: this.routingWorkTable(state, task, attempt, runId) },
      orchestration: {
        get revision() { return revision() },
        catalog: query => catalog.page(query),
        route: (decision, owner) => {
          if (!repairs.current(task, repair)) fail('REPAIR_OBSOLETE', 'Feedback no longer refers to a current problem')
          if (decision.action !== 'dispatch' || decision.final_answer !== undefined || installedPlan()) fail('RUNNER_PLAN_CONFLICT', 'Feedback installs one scoped dispatch without changing the original final answer source')
          const requirementId = issue.kind === 'missing_requirement' ? issue.requirement.requirement_id : undefined
          const allowed = requirementId ? [requirementId] : requirements
          if (decision.assignments.some(assignment => assignment.requirement_ids.some(requirement => !allowed.includes(requirement)))) fail('REPAIR_SCOPE_INVALID', 'Feedback cannot add unrelated requirement work')
          if (index && (decision.assignments.length !== 1 || decision.assignments[0]!.outputs.length !== 1 || decision.assignments[0]!.outputs[0]!.exposure !== 'publish')) fail('REPAIR_SCOPE_INVALID', 'An exact artifact replacement uses one publishing assignment')
          const covering = decision.assignments.findIndex(assignment => assignment.required && allowed.every(requirement => assignment.requirement_ids.includes(requirement)) && assignment.outputs.some(output => output.exposure === 'publish'))
          if (covering < 0) fail('REPAIR_SCOPE_INVALID', 'A repair must preserve its required publication coverage')
          const signature = canonical(decision.assignments.map(assignment => ({ instructions: assignment.instructions.trim().replace(/\s+/g, ' '), requirements: assignment.requirement_ids, inputs: assignment.inputs?.map(input => 'assignment_key' in input ? input.output_key : 'work_id' in input ? [input.work_id, input.output_key] : input), outputs: assignment.outputs.map(output => [output.kind, output.exposure]) })))
          if (this.db.prepare(`SELECT 1 FROM records WHERE task_id=? AND kind='runner.repair.plan' AND json_extract(payload_json,'$.problem_key')=? AND json_extract(payload_json,'$.signature')=?`).get(task, problem_key, signature)) fail('REPAIR_NO_PROGRESS', 'This problem already received the same repair plan')
          const goal = state.goal(request_id), oldSource = this.runnerComposition().source(task, request_id, intent_revision)
          const existing = state.taskWorks(task).filter((item): item is AssignedWork => item.purpose === 'production' && item.request_id === request_id && item.intent_revision === intent_revision && item.state === 'succeeded')
          const planned = installableAssignments(decision, goal, work, id, binding => {
            const selected = this.routedOutputSource(state, task, binding)
            if (index && selected.state === 'succeeded') {
              const output = this.assignedOutput(selected, binding)
              if (output.kind === 'artifact' && output.artifact_id === index.artifact_id) fail('REPAIR_SCOPE_INVALID', 'The replacement baseline is already bound; it cannot be its own live output dependency')
            }
            return selected
          }, existing, checkpoint => { WorkerContext.checkpoint(this.db, task, checkpoint, attempt) }, (binding, assignment) => content.checkNew(scope, binding, assignment))
          const installed = state.installPlan(planned)
          if (index && issue.kind !== 'missing_requirement') {
            const binding: ArtifactRepair = { request_record_id, problem_key, request_id, intent_revision, issue, previous: index, repair_run_id: runId, repair_work_id: installed[0]!.work_id }
            this.record(task, 'runner.repair.started', binding)
          } else {
            const sealer = installed[covering]!
            this.runnerComposition().designateSource({ task_id: task, request_id, intent_revision, work_id: sealer.work_id, plan_revision: sealer.plan_revision }, oldSource)
          }
          this.record(task, 'runner.repair.plan', { request_record_id, problem_key, request_id, intent_revision, run_id: runId, owner, requirement_id: requirementId ?? null, signature, work_ids: installed.map(item => item.work_id) })
          const nextRevision = decision.base_revision + 1
          this.record(task, 'runner.plan.revised', { owner, run_id: runId, request_id, revision: nextRevision, works: installed.map(item => ({ work_id: item.work_id, plan_revision: item.plan_revision })) })
          return { revision: nextRevision, works: installed.map(item => ({ work_id: item.work_id, plan_revision: item.plan_revision })) }
        },
        report: () => fail('WORKER_CAPABILITY_DENIED', 'Router cannot report on behalf of an assigned Worker')
      }
    }, (result, owner) => this.record(task, 'runner.repair.response', { request_record_id, problem_key, request_id, intent_revision, run_id: runId, owner, kind: result.kind }), undefined, undefined, result => {
      const installed = installedPlan()
      if (result.kind === (installed ? 'updated' : 'blocked')) return null
      return {
        code: 'RUNNER_PLAN_CONFLICT', path: 'kind', value: result.kind,
        message: installed ? 'A repair plan was installed. Return updated without dispatching again.' : 'No repair plan was installed. Install a scoped repair before returning updated, or return blocked.'
      }
    })
  }
  async executeRunnerProduction(attemptId: string): Promise<ProducerResult> {
    const state = new RunnerWorkState(this.db, this.epoch), qualified = state.qualify(attemptId, 'dispatch'), { work, goal } = qualified
    if (!goal || work.purpose !== 'production' || !['producer', 'lightweight', 'integrator'].includes(work.role)) fail('RUNNER_OWNERSHIP_INVALID', 'Content execution requires current production work')
    const owner = this.workerOwner(qualified), sections = this.runnerArtifacts().outline(work.task_id)?.sections.filter(section => section.request_id === work.request_id && section.intent_revision === work.intent_revision) ?? []
    const integration = work.role === 'integrator' ? this.runnerComposition().integrationInputs(attemptId) : undefined
    const repair = artifactRepair(this.db, work.task_id, work.work_id)
    const resources = integration?.resources ?? work.dependencies.flatMap(dependency => dependency.kind === 'resource' ? [dependency.resource_id] : dependency.kind === 'artifact' ? [this.runnerArtifacts().artifact(work.task_id, dependency.artifact_id, dependency.artifact_revision)?.bundle_resource_id].filter((value): value is string => !!value) : [])
    const conversation = this.runnerConversation(work.task_id, work.request_id, work.intent_revision)
    const conversationResources = repair ? [] : conversation.resource_ids.filter(resource => this.db.prepare('SELECT 1 FROM task_resources WHERE task_id=? AND resource_id=?').get(work.task_id, resource))
    const materialIds = [...new Set([...resources, ...conversationResources])]
    const outputs = this.boundAssignmentOutputs(state, work)
    const boundInputs = this.boundContentReader.entries(new AssignmentContent(this.db), work, attemptId)
    const materials = [...new Set([...materialIds, ...outputs.flatMap(output => output.kind === 'artifact' ? [output.bundle_resource_id] : [])])].map(resource => ({ ...this.one('SELECT r.id,r.display_name,r.byte_length,r.media_type FROM resources r JOIN task_resources t ON t.resource_id=r.id WHERE t.task_id=? AND r.id=?', work.task_id, resource), provenance_ref: { task_id: work.task_id, kind: 'resource' as const, id: resource } }))
    const host = new RunnerHostProduction(this.db, this.epoch)
    const grants: WorkerGrant[] = repair ? [{ type: 'read', kind: 'resource', ids: materials.map(material => material.provenance_ref.id) }] : this.contentToolGrants(work.task_id, conversation)
    if (outputs.some(output => output.kind === 'answer')) grants.push({ type: 'call', capability: READ_WORK_OUTPUT })
    if (boundInputs.length) grants.push({ type: 'call', capability: READ_BOUND_INPUT })
    if (work.assignment) grants.push({ type: 'call', capability: REPORT_MISSING_INPUT })
    const profile = createProducerProfile({ owner, work, goal, sections, grants, repair: !!repair, normalize: (draft, response) => host.normalize(draft, owner, response) })
    const loadArtifact = (resourceId: string) => loadBundleSource(this.db, this.root, work.task_id, { type: 'resource', resource: { kind: 'resource', id: resourceId } }, row => this.journal.assertResource(row)).bundle
    const preflight = (value: ProducerResult): WorkerResultIssue | null => {
      const issue = host.preflight(value, owner, materials.map(material => material.provenance_ref))
      if (issue) return issue
      for (const [index, candidate] of value.artifacts.entries()) {
        try { checkPersonalBindings(this.db, work.task_id, loadArtifact(candidate.bundle_resource_id), true) }
        catch (error) {
          if (!(error instanceof ContractError)) throw error
          // Other failures retain their existing acceptance outcome.
          if (error.code !== 'PERSONAL_BINDING_REQUIRED' && error.code !== 'PERSONAL_BINDING_INVALID') continue
          return { code: error.code, path: `artifacts[${index}].bundle_resource_id`, value: candidate.bundle_resource_id, message: `${error.message} Create a corrected bundle resource and return its new ID.` }
        }
      }
      return null
    }
    let result: ProducerResult
    const text = this.runnerGoalText(work.task_id, work.request_id, work.intent_revision)
    const chapterQuery = JSON.parse(this.one('SELECT input_json FROM requests WHERE task_id=? AND id=?', work.task_id, work.request_id).input_json).chapter_query as { manifest: ChapterManifest; region_ids: string[] } | undefined
    const workOutputs = outputs.map(output => {
      if (output.kind === 'artifact') return output
      const { record_id: _record, ...navigation } = output
      return navigation
    })
    const supplementalInputs = (work.assignment?.supplement_ids ?? []).map(supplementId => {
      const reply = state.assignmentSupplement(work.task_id, supplementId)
      if (reply.work_id !== work.work_id || reply.request_id !== work.request_id || reply.previous_plan_revision >= work.plan_revision || reply.resource_ids.some(id => !qualified.attempt.input_versions.some(input => input.kind === 'resource' && input.resource_id === id))) fail('RUNNER_OWNERSHIP_INVALID', 'Supplement no longer matches this Worker assignment')
      const message = this.one("SELECT json_extract(payload_json,'$.text') AS text FROM records WHERE task_id=? AND id=? AND kind='message.user' AND json_extract(payload_json,'$.request_id')=?", work.task_id, reply.message_id, reply.source_request_id)
      return { message_id: reply.message_id, clarification_id: reply.clarification_id, text: message.text as string, resource_ids: reply.resource_ids }
    })
    let checkpoint: WorkerInput['checkpoint']
    if (work.assignment?.checkpoint_id) {
      try {
        checkpoint = WorkerContext.checkpoint(this.db, work.task_id, work.assignment.checkpoint_id, qualified.attempt, {
          dependencies: qualified.attempt.input_versions, resources: materials.map(material => material.provenance_ref.id), outputs, authorize: profile.authorize
        })
      } catch (error) {
        if (!(error instanceof ContractError) || error.code !== 'RUNNER_CHECKPOINT_UNAVAILABLE') throw error
      }
    }
    let waitReport: string | undefined
    const input: WorkerInput = { text: integration ? `${text}\nBound integration sources (data): ${json(integration)}` : text, conversation: repair ? undefined : conversation, checkpoint, bound: { materials, ...(boundInputs.length ? { bound_inputs: boundInputs } : {}), ...(repair ? { repair: { instruction: 'Correct only the referenced artifact, use its exact base revision, preserve its coverage, and return no answer.', issue: repair.issue, previous: repair.previous } } : {}), ...(supplementalInputs.length ? { supplemental_inputs: supplementalInputs } : {}), ...(workOutputs.length ? { work_outputs: workOutputs } : {}), ...(chapterQuery ? chapterQuery.manifest.content_tree ? { content_query: { view_id: chapterQuery.manifest.view_id, node_ids: chapterQuery.region_ids } } : { chapter_context: chapterContext(this.bundle(chapterQuery.manifest.bundle_resource_id), chapterQuery.manifest, chapterQuery.region_ids), chapter_manifest: chapterQuery.manifest, region_ids: chapterQuery.region_ids } : {}) },
      ...(work.assignment ? {
        waitReport: () => waitReport,
        orchestration: {
          revision: work.plan_revision,
          route: () => fail('WORKER_CAPABILITY_DENIED', 'An assigned Worker cannot route work'),
          report: (report, owner) => {
            const reportId = this.reportAssignedInput(owner, work, report)
            if (report.wait) waitReport = reportId
            return { report_id: reportId, waiting: report.wait }
          }
        }
      } : {})
    }
    try { result = await this.executeWorker(attemptId, profile, input, (result, source) => {
      this.checkContentReads(work.task_id, source)
      const accepted = host.accept(result, source, resourceId => {
        const bundle = loadArtifact(resourceId)
        validateProducerBundle(bundle); checkPersonalBindings(this.db, work.task_id, bundle, true); this.checkedBundle(work.task_id, bundle, source.attempt_id)
      })
      if (repair) this.record(work.task_id, 'runner.repair.applied', { ...repair, owner: source, artifact_revision: accepted.indexes[0]!.artifact_revision })
      if (result.answer !== null && !work.assignment && !repair && (!this.features.runner?.conversationRouting || goal.requirements.every(requirement => requirement.kind === 'answer'))) this.recordRunnerAnswer(work.task_id, { owner: source, purpose: 'final_answer', text: result.answer, request_id: work.request_id, input_event_id: goal.input_event_id, run_id: work.run_id, intent_revision: work.intent_revision, result_ref: accepted.output.result_ref })
      this.record(work.task_id, 'runner.output.accepted', { owner: source, run_id: work.run_id, plan_revision: work.plan_revision, result_revision: accepted.output.result_revision, requirement_ids: accepted.output.requirement_ids, artifacts: accepted.output.artifacts, inventory_revision: accepted.inventory?.inventory_revision ?? null })
      if (sections.length || !work.assignment) this.refreshRunnerScope(work.task_id)
      if (work.assignment && accepted.inventory && !repair) {
        if (goal.requirements.every(requirement => requirement.kind === 'answer')) this.publishDeliveryAnswer(state, accepted.inventory)
        else this.publishCompositionAnswers(state, work.task_id)
      }
    }, undefined, undefined, preflight) } catch (error) {
      if (!this.closed && this.db.open) host.retainFailure(error)
      throw error
    }
    if (result.artifacts.length || work.assignment && sections.length) this.scheduleRunnerComposition(work.task_id, work.request_id)
    return result
  }
  private scheduleRunnerComposition(task: string, trigger: string): void {
    if (!this.features.runner || this.closing || this.closed || this.task(task).state !== 'active') return
    const at = Date.now(), previous = this.runnerCompositionMerges.get(task), first = previous?.first ?? at
    if (previous) clearTimeout(previous.timer)
    const firstPublication = !this.db.prepare('SELECT 1 FROM runner_view_mappings WHERE task_id=? LIMIT 1').get(task)
    const readyAt = compositionReadyAt(first, at, firstPublication)
    const timer = setTimeout(() => {
      this.runnerCompositionMerges.delete(task)
      void this.executeAutomaticComposition(task, trigger).catch(error => {
        if (!this.closed && this.db.open) this.record(task, 'runner.composition.blocked', { trigger_request_id: trigger, code: error instanceof ContractError ? error.code : 'COMPOSITION_EXECUTION_FAILED' })
      })
    }, Math.max(0, readyAt - at))
    timer.unref?.()
    this.runnerCompositionMerges.set(task, { first, latest: at, trigger, timer })
  }
  private async executeAutomaticComposition(task: string, trigger: string, previousBatchId?: string): Promise<void> {
    if (this.closing || this.closed || this.task(task).state !== 'active') return
    let prepared: PreparedRunnerComposition
    try { prepared = this.prepareRunnerComposition(task, trigger, previousBatchId ? { previous_batch_id: previousBatchId } : { unattempted_only: true }) }
    catch (error) {
      if (error instanceof ContractError && error.code === 'RUN_BUSY') {
        const waiting = this.runnerCompositionWaiting.get(task)
        if (!waiting?.previousBatchId) this.runnerCompositionWaiting.set(task, { trigger, ...(previousBatchId ? { previousBatchId } : {}) })
        return
      }
      if (!previousBatchId) this.settleRunnerDeliveries(task, trigger)
      if (error instanceof ContractError && error.code === 'COMPOSITION_NOT_READY') return
      throw error
    }
    await this.executePreparedComposition(task, trigger, prepared)
  }
  private async executePreparedComposition(task: string, trigger: string, prepared: PreparedRunnerComposition): Promise<void> {
    let outcome: import('./runner/collator').CollatorResult
    try {
      outcome = this.features.runner?.collator === 'model'
        ? await this.executeWorker(prepared.attempt_id, prepared.collator.profile, undefined, (value, owner) => {
          if (!('kind' in value)) return
          if (owner.purpose !== 'composition') fail('RUNNER_OWNERSHIP_INVALID', 'Feedback requires a composition owner')
          const state = new RunnerWorkState(this.db, this.epoch)
          new RunnerRepairState(this.db, state, this.runnerArtifacts(), this.runnerComposition()).install(prepared.collator.feedback(value), owner, this.record.bind(this))
          this.runnerHostComposition().setBatchState(task, prepared.batch.batch_id, 'failed')
        }, prepared.collator, undefined, value => !prepared.batch.indexes.length && !('kind' in value) ? {
          code: 'INVALID_COLLATOR_FEEDBACK', path: 'kind', value: null, message: 'This batch has no publishable indexes. Report the listed structural evidence as feedback.'
        } : null)
        : prepared.collator.rulePlan()
    } catch (error) {
      if (!this.closed && this.db.open) {
        const state = new RunnerWorkState(this.db, this.epoch), run = state.run(prepared.run_id), attempt = state.attempt(prepared.attempt_id)
        if (!this.closing && this.runnerComposition().batch(task, prepared.batch.batch_id)?.state === 'preparing' &&
          attempt.state !== 'unknown' && attempt.dispatch_state !== 'unknown' && run.state !== 'interrupted') {
          this.runnerHostComposition().setBatchState(task, prepared.batch.batch_id, run.state === 'cancelled' || attempt.state === 'cancelled' ? 'cancelled' : 'failed')
        }
        this.finish(task, prepared.run_id, 'failed', error instanceof ContractError || error instanceof ModelError ? error.code : 'COLLATOR_FAILED')
        this.settleRunnerDeliveries(task)
      }
      throw error
    }
    if ('kind' in outcome) {
      this.finish(task, prepared.run_id, 'failed', 'COLLATOR_FEEDBACK_PENDING')
      this.scheduleRunnerComposition(task, trigger)
      return
    }
    const epoch = this.epoch, batchId = prepared.batch.batch_id
    this.runnerCompositionPublishing.set(batchId, prepared.batch)
    try {
      const result = await this.publishRunnerComposition(task, batchId, outcome)
      if (result.state === 'published') {
        this.refreshRunnerScope(task)
        this.scheduleRunnerComposition(task, trigger)
      } else if (result.state === 'failure' && ['VERSION_CONFLICT', 'RESOURCE_CHANGED'].includes(result.code ?? '')) {
        await this.executeAutomaticComposition(task, trigger, batchId)
      }
    } finally {
      this.runnerCompositionPublishing.delete(batchId)
      if (this.epoch === epoch) this.settleRunnerDeliveries(task)
    }
  }
  private accountLease(taskId: string, runId: string, lease: ModelLease): void {
    const owner = captureExecutionScope(lease.owner, taskId)
    if (owner && owner.run_id !== runId) fail('RUNNER_OWNERSHIP_INVALID', 'Model lease belongs to another Run')
    const valid = () => { this.qualify(taskId, runId); if (owner) this.qualifyWorker(owner.attempt_id) }
    const run = this.db.prepare('SELECT budget_id FROM runner_runs WHERE run_id=? AND task_id=?').get(runId, taskId) as Row | undefined
    const accounting = run ? new RunnerBudgetAccounting(new RunnerBudgetLedger(this.db), { task_id: taskId, budget_id: run.budget_id, ...(owner ? { attempt_id: owner.attempt_id } : {}) }) : undefined
    lease.evidence = (event: RequestEvidence) => {
      valid()
      assertContract('request_evidence', event)
      if (owner && json(event.owner) !== json(owner)) fail('RUNNER_OWNERSHIP_INVALID', 'Model evidence belongs to another attempt')
      if (Buffer.byteLength(json({ ...event, run_id: runId })) > 1048576) throw new ModelError('CONTEXT_RECORD_LIMIT')
      return this.db.transaction(() => this.record(taskId, 'model.request.evidence', { ...event, run_id: runId }))()
    }
    lease.accounting = (event: RequestAccounting) => {
      if (this.closed || !this.db.open) throw new ModelError('ACCOUNTING_UNAVAILABLE')
      assertContract('request_accounting', event)
      this.one('SELECT state FROM runs WHERE id=? AND task_id=?', runId, taskId)
      if (['reserved', 'dispatched'].includes(event.phase)) valid()
      if (event.phase === 'reserved' && owner) this.workers.get(owner.attempt_id)?.diagnostic?.reserve()
      let accountingError: unknown
      try { accounting?.model(event) } catch (error) { accountingError = error }
      this.db.transaction(() => {
        // Late accounting is factual only: it never resumes a terminal Run.
        this.record(taskId, 'model.request.accounting', { ...event, run_id: runId, ...(owner ? { owner } : {}) })
      })()
      if (owner && ['completed', 'failed'].includes(event.phase)) this.aggregateWorkerRun(taskId, runId)
      if (accountingError) throw accountingError
    }
  }
  private qualifyWorker(attemptId: string): QualifiedAttempt {
    const value = new RunnerWorkState(this.db, this.epoch).qualify(attemptId)
    this.qualify(value.task_id, value.run.run_id)
    const worker = this.workers.get(attemptId)
    if (!worker || worker.controller.signal.aborted || !['dispatched', 'running', 'waiting'].includes(value.attempt.state) || value.attempt.profile_id !== worker.profile.id || value.work.role !== worker.profile.role) fail('RUNNER_OWNERSHIP_INVALID', 'Worker attempt is no longer executable')
    if (worker.diagnostic) {
      const source = worker.diagnostic.source, subject = new RunnerWorkState(this.db, this.epoch).work(source.work_id)
      if (!this.features.runner || this.features.runner.diagnostics === false || subject.purpose !== 'production' || subject.task_id !== source.task_id || subject.request_id !== source.request_id || subject.intent_revision !== source.intent_revision || subject.plan_revision !== source.plan_revision || subject.run_id !== value.run.run_id || !['running', 'waiting', 'failed'].includes(subject.state)) fail('RUNNER_OWNERSHIP_INVALID', 'Diagnosis source or capability is no longer current')
    }
    return value
  }
  private workerOwner(value: QualifiedAttempt): ExecutionScope {
    const common = { task_id: value.task_id, run_id: value.run.run_id, work_id: value.work.work_id, attempt_id: value.attempt.attempt_id, role: value.work.role }
    return value.run.purpose === 'production'
      ? { ...common, purpose: 'production', request_id: value.run.request_id, intent_revision: value.run.intent_revision, ...(value.run.message_id ? { message_id: value.run.message_id } : {}), ...(value.run.update_id ? { update_id: value.run.update_id } : {}) }
      : { ...common, purpose: 'composition', batch_id: value.run.batch_id, composition_version: value.run.composition_version, trigger_request_id: value.run.trigger_request_id }
  }
  // The Run owns configuration leases and the cumulative budget. Each attempt
  // gets its own messages, cancellation source, read cursors and evidence owner.
  async executeWorker<Result>(attemptId: string, profile: WorkerProfile<Result>, input?: WorkerInput, installResult?: (result: Result, owner: ExecutionScope) => void, collator?: Collator, diagnostic?: RunnerDiagnostic, validateResult?: WorkerExecution<Result>['validateResult']): Promise<Result> {
    const state = new RunnerWorkState(this.db, this.epoch), attempt = state.attempt(attemptId), work = state.work(attempt.work_id)
    if (this.pendingWorkers.has(attemptId) || this.workers.has(attemptId) || profile.id !== attempt.profile_id || profile.role !== work.role || !['registered', 'queued'].includes(attempt.state)) fail('RUNNER_OWNERSHIP_INVALID', 'Worker attempt cannot enter the dispatch queue')
    state.updateAttempt({ ...attempt, state: 'queued' })
    return new Promise<Result>((resolve, reject) => {
      this.pendingWorkers.set(attemptId, { task: work.task_id, work: admissionWork(work), reject, start: () => {
        void this.executeAdmittedWorker(attemptId, profile, input, installResult, collator, diagnostic, validateResult).then(resolve, reject).finally(() => this.pumpRunnerWorkers(work.task_id))
      } })
      this.pumpRunnerWorkers(work.task_id)
    })
  }
  private activeRunnerWorks(task: string): RunnerAdmissionWork[] {
    const state = new RunnerWorkState(this.db, this.epoch)
    return state.taskWorks(task).filter(work => {
      // A content publisher is a host child of the admitted producer. Its
      // durable work record tracks delivery without reserving another slot.
      if (work.purpose === 'production' && work.update_id && work.role === 'lightweight' && this.chapters().state.update(task, work.update_id)?.scope_revision !== undefined) return false
      return this.workers.has(work.current_attempt_id ?? '') || state.attempts(work.work_id).some(attempt =>
      ['dispatched', 'running', 'waiting', 'unknown'].includes(attempt.state)
      ) || !!this.db.prepare("SELECT 1 FROM calls WHERE run_id=? AND json_extract(limits_json,'$.owner.work_id')=? AND (state!='ended' OR execution='unknown') LIMIT 1").get(work.run_id, work.work_id) || this.runnerCleanupPending(work.run_id)
    }).map(admissionWork)
  }
  private pumpRunnerWorkers(task: string): void {
    if (this.pumpingWorkers.has(task) || this.recoveringRunnerInputs.has(task) || this.closed || !this.db.open) return
    this.pumpingWorkers.add(task)
    try {
      const state = new RunnerWorkState(this.db, this.epoch)
      this.reconcileRunnerDependencies(state, task)
      this.queueRepairs(state, task)
      this.queueWorkRouting(state, task)
      this.queueAssignedWork(state, task)
      for (;;) {
        const candidates = [...this.pendingWorkers].filter(([, pending]) => pending.task === task).map(([attempt_id, pending]) => ({ ...pending.work, attempt_id }))
        const ready = new Set<string>()
        for (const candidate of candidates) {
          try { state.qualify(candidate.attempt_id, 'dispatch'); ready.add(candidate.attempt_id) }
          catch (error) {
            if (error instanceof ContractError && error.code === 'RUNNER_DEPENDENCY_INVALID') continue
            const pending = this.pendingWorkers.get(candidate.attempt_id)
            this.pendingWorkers.delete(candidate.attempt_id); pending?.reject(error)
          }
        }
        const next = this.runnerAdmission.next(task, candidates.filter(candidate => this.pendingWorkers.has(candidate.attempt_id)), this.activeRunnerWorks(task), candidate => ready.has(candidate.attempt_id))
        if (!next) break
        const pending = this.pendingWorkers.get(next.attempt_id)!
        this.pendingWorkers.delete(next.attempt_id)
        pending.start()
      }
    } catch (error) {
      for (const [attemptId, pending] of this.pendingWorkers) if (pending.task === task) {
        this.pendingWorkers.delete(attemptId); pending.reject(error)
      }
    } finally {
      this.pumpingWorkers.delete(task)
      const waiting = this.runnerCompositionWaiting.get(task)
      const previous = waiting?.previousBatchId ? this.runnerComposition().batch(task, waiting.previousBatchId) : null
      const settling = previous && !['completed', 'failed', 'cancelled', 'interrupted'].includes(new RunnerWorkState(this.db, this.epoch).run(previous.run_id).state)
      if (waiting && !settling && !this.closing && this.task(task).state === 'active' && Number((this.db.prepare("SELECT COUNT(*) n FROM runner_runs r JOIN runs c ON c.id=r.run_id WHERE r.task_id=? AND r.purpose='composition' AND c.state IN ('running','waiting')").get(task) as Row).n) < RUNNER_LIMITS.admission.composition_batches_per_task) {
        this.runnerCompositionWaiting.delete(task)
        void this.executeAutomaticComposition(task, waiting.trigger, waiting.previousBatchId).catch(error => {
          if (!this.closed && this.db.open) this.record(task, 'runner.composition.blocked', { trigger_request_id: waiting.trigger, code: error instanceof ContractError ? error.code : 'COMPOSITION_EXECUTION_FAILED' })
        }).finally(() => this.settleRunnerDeliveries(task))
      }
    }
  }
  private async executeAdmittedWorker<Result>(attemptId: string, profile: WorkerProfile<Result>, input?: WorkerInput, installResult?: (result: Result, owner: ExecutionScope) => void, collator?: Collator, diagnostic?: RunnerDiagnostic, validateResult?: WorkerExecution<Result>['validateResult']): Promise<Result> {
    const state = new RunnerWorkState(this.db, this.epoch), qualified = state.qualify(attemptId, 'dispatch')
    const { attempt, work, run } = qualified, taskId = qualified.task_id, runId = run.run_id
    this.qualify(taskId, runId)
    if (profile.id !== attempt.profile_id || profile.role !== work.role || this.workers.has(attemptId)) fail('RUNNER_OWNERSHIP_INVALID', 'Worker profile does not match its registered attempt')
    if (profile.role === 'collator' ? !collator || collator.profile !== profile : collator !== undefined) fail('INVALID_COLLATOR_CONTEXT', 'Collator execution requires its dedicated metadata context')
    if (profile.role === 'diagnostic' ? !diagnostic || diagnostic.profile !== profile || !this.features.runner || this.features.runner.diagnostics === false : diagnostic !== undefined) fail('INVALID_DIAGNOSTIC_CONTEXT', 'Diagnosis execution requires its dedicated metadata context and capability')
    let agent = this.agents.get(runId)
    if (agent && !agent.managed) fail('RUNNER_EXECUTION_CONFLICT', 'Run already has a legacy execution loop')
    if (!agent) {
      const main = this.models.acquire(attempt.model_config_id, 'main')
      let compact: ModelLease | undefined, approval: ModelLease | undefined
      try {
        compact = this.models.acquireCompaction(main)
        if (this.approvalMode === 'assisted') approval = this.models.acquire(this.approvalModel, 'approval')
        if (main.revision !== attempt.model_config_revision) fail('MODEL_CONFIGURATION_CHANGED', 'Worker configuration changed before dispatch')
        agent = { controller: new AbortController(), main, compact, approval, budget: new RunBudget(main.config), mode: this.approvalMode, managed: true }
        this.agents.set(runId, agent)
      } catch (error) { main.release(); compact?.release(); approval?.release(); throw error }
    }
    if (agent.main.id !== attempt.model_config_id || agent.main.revision !== attempt.model_config_revision) fail('MODEL_CONFIGURATION_CHANGED', 'Worker does not match the Run configuration lease')
    const owner = this.workerOwner(qualified), controller = new AbortController()
    const cancel = () => controller.abort()
    agent.controller.signal.addEventListener('abort', cancel, { once: true })
    if (agent.controller.signal.aborted) cancel()
    const clone = (lease: ModelLease): ModelLease => ({ ...lease, owner: { ...owner }, release() {} })
    const worker: WorkerAgent = { owner, controller, main: clone(agent.main), ...(agent.compact ? { compact: clone(agent.compact) } : {}), ...(agent.approval ? { approval: clone(agent.approval) } : {}), budget: agent.budget.forAttempt(), mode: agent.mode, context: new WorkerContext(this.db, owner), profile, ...(collator ? { collator } : {}), ...(diagnostic ? { diagnostic } : {}), orchestration: input?.orchestration, state: 'running' }
    this.workers.set(attemptId, worker)
    let result!: Result, accepted = false
    try {
      this.accountLease(taskId, runId, worker.main)
      if (worker.compact) this.accountLease(taskId, runId, worker.compact)
      if (worker.approval) this.accountLease(taskId, runId, worker.approval)
      let conversation = collator || diagnostic ? undefined : input?.conversation
      const body = collator || diagnostic ? { metadata: (collator ?? diagnostic!).initial() } : (() => {
        const text = input?.text ?? (run.purpose === 'production' ? this.runnerGoalText(taskId, run.request_id, run.intent_revision) : JSON.parse(this.one('SELECT input_json FROM requests WHERE id=? AND task_id=?', run.trigger_request_id, taskId).input_json).text)
        if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > defaults.data.object_bytes) fail('INVALID_INPUT', 'Worker input must be nonempty and bounded')
        const materials = worker.context.navigation(attempt.input_versions)
        const bound = { ...(input?.bound === undefined ? {} : { bound: input.bound }), ...(conversation?.preceding_result ? { preceding_result: conversation.preceding_result } : {}) }
        if (Buffer.byteLength(json(bound)) > defaults.transport.rpc_message_bytes) fail('INPUT_TOO_LARGE', 'Bound worker input exceeds transport capacity')
        const navigation = (history?: ConversationHistory) => history ? { conversation_history: { refs: history.refs, truncated: history.truncated, notice: history.preceding_result
          ? 'Read earlier replies by exact event ID. For preceding_result, use views[].content for the exact published body and views[].history for version metadata. Read its event if text is null.'
          : 'Earlier messages belong to this Task conversation. Use the read event tool with these exact IDs for complete originals when needed.' } } : {}
        if (conversation) conversation = fitConversation(conversation, history => !worker.budget.plan([
          { role: 'system', content: profile.system }, ...history.messages.map(item => item.message),
          { role: 'user', content: JSON.stringify({ request: text, request_materials: materials, ...bound, ...navigation(history) }) }
        ], profile.tools).needsCompaction)
        return { text, materials, ...bound, ...navigation(conversation) }
      })()
      this.db.transaction(() => {
        state.qualify(attemptId, 'dispatch')
        state.updateAttempt({ ...attempt, operation_id: attempt.operation_id ?? id(), state: 'dispatched', dispatch_state: 'dispatched' })
        if (!collator && !diagnostic) for (const message of conversation?.messages ?? []) {
          this.record(taskId, 'worker.conversation', { message: message.message, conversation_source: message.source, run_id: runId, owner })
        }
        this.record(taskId, 'worker.input', { ...body, run_id: runId, owner, plan_revision: work.plan_revision,
          ...(work.purpose === 'production' && work.assignment && !input?.checkpoint ? { checkpoint_source: true } : {}) })
        if (input?.checkpoint && !worker.budget.plan([{ role: 'system', content: profile.system }, ...input.checkpoint.messages, ...worker.context.load({ role: 'system', content: profile.system }).slice(1)], profile.tools).needsCompaction) {
          worker.prefix = input.checkpoint.messages
          this.record(taskId, 'runner.checkpoint.reused', { owner, run_id: runId, request_id: owner.purpose === 'production' ? owner.request_id : undefined, checkpoint_id: input.checkpoint.checkpoint_id })
        }
      })()
      await runAgent(this.models, worker.main, taskId, [], {
        context: (messages, recovery) => this.prepareWorkerContext(worker, messages, recovery),
        valid: () => { this.qualifyWorker(attemptId) },
        state: (value, reason) => this.workerState(worker, value, reason),
        budget: value => { this.qualifyWorker(attemptId); this.db.prepare('UPDATE runs SET budget_json=? WHERE id=?').run(json(value), runId) },
        record: (kind, payload) => {
          this.qualifyWorker(attemptId)
          if (diagnostic && ['message.assistant', 'message.assistant.partial'].includes(kind)) return
          const body = { ...payload, run_id: runId, owner, model_config_id: worker.main.id }
          this.db.transaction(() => {
            const recordId = this.record(taskId, kind, body)
            if (payload.message) recordedMessage({ id: recordId, sequence: this.task(taskId).next_sequence - 1, kind, payload: body })
          })()
        },
        toolsSettled: () => { this.observeRunnerGoal(owner, true); if (worker.orchestration) this.pumpRunnerWorkers(taskId) },
        ...(input?.waitReport ? { yieldAfterTools: () => input.waitReport!() !== undefined } : {}),
        tool: (request, signal) => this.workerTool(attemptId, request, signal)
      }, controller.signal, worker.budget, {
        profile,
        ...(validateResult ? { validateResult } : {}),
        onResult: value => {
          this.db.transaction(() => {
            this.qualifyWorker(attemptId)
            let serialized: string | undefined
            try { serialized = json(value) } catch { fail('INVALID_WORKER_RESULT', 'Worker result is not finite JSON') }
            if (!serialized || Buffer.byteLength(serialized) > 1048576) fail('INVALID_WORKER_RESULT', 'Worker result exceeds its record limit')
            this.record(taskId, 'worker.result', { value: JSON.parse(serialized), run_id: runId, owner })
            result = value; accepted = true
          })()
        }
      })
      const wait = input?.waitReport?.()
      if (wait) {
        state.suspendAssignment(attemptId, wait, current => {
          this.record(taskId, 'runner.assignment.waiting', { request_id: run.purpose === 'production' ? run.request_id : undefined, run_id: runId, work_id: work.work_id, attempt_id: attemptId, plan_revision: current.plan_revision, report_id: wait })
          this.record(taskId, 'worker.state', { run_id: runId, owner, state: 'waiting', reason: 'missing_input' })
        })
        fail('RUNNER_WAITING_INPUT', 'Assignment is waiting for a missing input')
      }
      this.db.transaction(() => {
        this.qualifyWorker(attemptId)
        if (!accepted) fail('INVALID_WORKER_RESULT', 'Worker completed without an accepted result')
        const resultRecord = this.one("SELECT id FROM records WHERE task_id=? AND kind='worker.result' AND json_extract(payload_json,'$.owner.attempt_id')=? ORDER BY sequence DESC LIMIT 1", taskId, attemptId)
        state.updateAttempt({ ...state.attempt(attemptId), state: 'succeeded', result_ref: { task_id: taskId, kind: 'record', id: resultRecord.id } })
        const installed = installResult?.(result, { ...owner }) as unknown
        if (installed && typeof (installed as { then?: unknown }).then === 'function') {
          void Promise.resolve(installed).catch(() => {})
          fail('INVALID_WORKER_RESULT', 'Worker result installation must be synchronous')
        }
        this.record(taskId, 'worker.ended', { state: 'succeeded', run_id: runId, owner })
      })()
      return result
    } catch (error) {
      if (!this.closed && this.db.open) this.db.transaction(() => {
        const current = state.attempt(attemptId)
        let code = error instanceof ContractError || error instanceof ModelError ? error.code : 'MODEL_EXECUTION_FAILED'
        if (code === 'RUNNER_OWNERSHIP_INVALID' && owner.purpose === 'production' && owner.update_id) {
          const update = this.chapters().state.update(taskId, owner.update_id)
          if (update?.state === 'failed' && update.reason) code = update.reason
        }
        if (['dispatched', 'running', 'waiting'].includes(current.state)) state.updateAttempt({ ...current, state: controller.signal.aborted ? 'cancelled' : 'failed' })
        this.record(taskId, 'worker.ended', { state: state.attempt(attemptId).state, code, run_id: runId, owner })
      })()
      throw error
    } finally {
      agent.controller.signal.removeEventListener('abort', cancel)
      this.workers.delete(attemptId)
      if (!this.closed) this.aggregateWorkerRun(taskId, runId)
    }
  }
  private workerState(worker: WorkerAgent, state: 'running' | 'waiting', reason?: string): void {
    const { owner } = worker, qualified = this.qualifyWorker(owner.attempt_id)
    this.db.transaction(() => {
      new RunnerWorkState(this.db, this.epoch).updateAttempt({ ...qualified.attempt, state })
      this.record(owner.task_id, 'worker.state', { run_id: owner.run_id, owner, state, ...(reason ? { reason } : {}) })
    })()
    worker.state = state; worker.reason = reason
    this.aggregateWorkerRun(owner.task_id, owner.run_id)
    if (state === 'waiting' && ['approval', 'input', 'input_required', 'user_input'].includes(reason ?? '')) this.observeRunnerGoal(owner, true)
  }
  private async prepareWorkerContext(worker: WorkerAgent, live: ChatMessage[], recovery?: import('./model/agent').ContextRecovery): Promise<ChatMessage[]> {
    const { owner, context } = worker
    this.qualifyWorker(owner.attempt_id)
    if (worker.collator) return worker.collator.context(live, recovery)
    if (worker.diagnostic) return worker.diagnostic.context(live, recovery)
    this.observeRunnerGoal(worker.owner)
    const old = context.summary()
    const messages = worker.messages ? live : [live[0]!, ...worker.prefix ?? [], ...context.load(live[0]!).slice(1)]
    annotateReads(messages); worker.messages = messages
    if (!recovery && !worker.budget.plan(messages, worker.profile.tools).needsCompaction) return messages
    if (worker.prefix) {
      const prefix = new Set(worker.prefix)
      worker.prefix = undefined
      return this.prepareWorkerContext(worker, messages.filter(message => !prefix.has(message)))
    }
    if (!recovery && !context.hasFresh(old?.through_sequence ?? 0)) {
      if (!worker.budget.fits(messages, worker.profile.tools)) throw worker.budget.rejection(messages, worker.profile.tools, 'protected-input', 'CONTEXT_MINIMUM_TOO_LARGE')
      return messages
    }
    const through = context.sequence()
    const updated = await compactContext(this.models, worker.compact ?? worker.main, owner.task_id, worker.budget, worker.controller.signal, messages, through, worker.profile.tools, {
      valid: () => { this.qualifyWorker(owner.attempt_id) },
      state: reason => this.workerState(worker, 'waiting', reason),
      budget: () => { this.db.prepare('UPDATE runs SET budget_json=? WHERE id=?').run(json(worker.budget.state), owner.run_id) },
      install: value => {
        this.qualifyWorker(owner.attempt_id)
        context.installSummary(value)
      }
    }, recovery)
    worker.messages = updated
    this.workerState(worker, 'running')
    return updated
  }
  private observeRunnerGoal(owner: ExecutionScope, force = false): void {
    if (owner.purpose !== 'production' || owner.role === 'diagnostic' || this.closing || this.closed || !this.db.open) return
    const key = `${owner.request_id}:${owner.intent_revision}`, at = Date.now(), previous = this.runnerProgressObservedAt.get(key) ?? 0
    if (!force && at - previous < 1000) return
    this.runnerProgressObservedAt.set(key, at)
    try {
      const allowed = !!this.features.runner && this.features.runner.diagnostics !== false
      const observed = new RunnerHostProgress(this.db, this.epoch).observe(owner.task_id, owner.request_id, { capability_allowed: allowed })
      for (const diagnosis of observed.diagnoses) if (diagnosis.model_diagnosis === 'eligible') this.executeRunnerDiagnosis(diagnosis)
    }
    catch (error) { this.record(owner.task_id, 'runner.progress.blocked', { request_id: owner.request_id, intent_revision: owner.intent_revision, reason: error instanceof ContractError ? error.code : 'PROGRESS_FACTS_UNAVAILABLE' }) }
  }
  private executeRunnerDiagnosis(source: ProgressDiagnosis): void {
    const state = new RunnerWorkState(this.db, this.epoch), subject = state.work(source.work_id)
    if (subject.purpose !== 'production' || subject.task_id !== source.task_id || subject.request_id !== source.request_id || subject.intent_revision !== source.intent_revision || subject.plan_revision !== source.plan_revision || !subject.current_attempt_id) fail('RUNNER_OWNERSHIP_INVALID', 'Diagnosis requires the observed current production work')
    const original = state.attempt(subject.current_attempt_id), run = state.run(subject.run_id), diagnostic = createRunnerDiagnostic(source)
    const workId = id(), attemptId = id(), dependencies = subject.message_id ? [] : [{ kind: 'goal' as const, task_id: source.task_id, request_id: source.request_id, intent_revision: source.intent_revision }]
    const binding = { request_id: source.request_id, intent_revision: source.intent_revision, work_id: source.work_id, plan_revision: source.plan_revision, through_sequence: source.through_sequence }
    this.db.transaction(() => {
      const scope = { purpose: 'production' as const, request_id: source.request_id, intent_revision: source.intent_revision, ...(subject.message_id ? { message_id: subject.message_id } : {}), ...(subject.update_id ? { update_id: subject.update_id } : {}) }
      state.installPlan([{ work_id: workId, task_id: source.task_id, run_id: run.run_id, plan_revision: 1, role: 'diagnostic', required: false, requirement_ids: [], dependencies, state: 'planned', max_attempts: 1, ...scope }])
      state.createAttempt({ attempt_id: attemptId, work_id: workId, task_id: source.task_id, run_id: run.run_id, runtime_epoch: this.epoch, attempt_number: 1, profile_id: diagnostic.profile.id, model_config_id: original.model_config_id, model_config_revision: original.model_config_revision, input_versions: dependencies, state: 'registered', dispatch_state: 'not_dispatched', usage_refs: [], ...scope })
      this.record(source.task_id, 'runner.progress.diagnostic.queued', { subject: binding, run_id: run.run_id, work_id: workId, attempt_id: attemptId, automatic_replay: false, execution_permission: false, recovery_permission: false })
    })()
    void this.executeWorker(attemptId, diagnostic.profile, undefined, (result, owner) => {
      this.record(source.task_id, 'runner.progress.diagnostic.result', { subject: binding, run_id: run.run_id, owner, result })
    }, undefined, diagnostic).catch(error => {
      if (!this.closing && !this.closed && this.db.open) {
        if (state.attempt(attemptId).dispatch_state === 'not_dispatched') state.revokeWork(workId)
        this.record(source.task_id, 'runner.progress.diagnostic.ended', { subject: binding, run_id: run.run_id, work_id: workId, attempt_id: attemptId, code: error instanceof ContractError || error instanceof ModelError ? error.code : 'DIAGNOSIS_FAILED', automatic_replay: false, execution_permission: false, recovery_permission: false })
        this.aggregateWorkerRun(source.task_id, run.run_id)
      }
    })
  }
  private aggregateWorkerRun(taskId: string, runId: string): void {
    if (this.closed || !this.db.open || !this.db.prepare('SELECT 1 FROM runner_runs WHERE run_id=?').get(runId)) return
    const state = new RunnerWorkState(this.db, this.epoch)
    this.reconcileRunnerDependencies(state, taskId, runId)
    const run = state.run(runId), works = state.taskWorks(taskId).filter(work => work.run_id === runId)
    const attempts = works.flatMap(work => state.attempts(work.work_id)), states: WorkRunState[] = []
    for (const work of works) {
      if (!work.current_attempt_id) continue
      const row = this.db.prepare("SELECT payload_json FROM records WHERE task_id=? AND kind='worker.state' AND json_extract(payload_json,'$.owner.attempt_id')=? ORDER BY sequence DESC LIMIT 1").get(taskId, work.current_attempt_id) as Row | undefined
      if (row) {
        const value = JSON.parse(row.payload_json)
        states.push({ work_id: work.work_id, attempt_id: work.current_attempt_id, state: value.state, ...(value.reason ? { reason: value.reason } : {}) })
      }
    }
    const cancelled = this.db.prepare("SELECT payload_json FROM records WHERE task_id=? AND kind='runner.cancelled' AND json_extract(payload_json,'$.run_id')=? ORDER BY sequence DESC LIMIT 1").get(taskId, runId) as Row | undefined
    const cancellation = cancelled ? JSON.parse(cancelled.payload_json).scope === 'task' ? 'task' as const : 'run' as const : undefined
    const outcomeWorks = works.map(work => work.role === 'router' && work.state === 'failed' && work.current_attempt_id && installedRepairDispatch(this.db, taskId, work.current_attempt_id) ? { ...work, required: false } : work)
    const proposed = aggregateRunOutcome({ run, works: outcomeWorks, attempts, states, ...(cancellation ? { cancellation } : {}) })
    const terminal = this.one('SELECT intended_terminal,primary_reason FROM runs WHERE id=?', runId)
    const interrupted = terminal.intended_terminal === 'interrupted'
    const outcome = interrupted && proposed.phase !== 'terminal' ? {
      phase: 'closing' as const, outcome: 'interrupted' as const,
      cancel_work_ids: works.filter(work => ['planned', 'queued', 'running', 'waiting'].includes(work.state) && !(terminal.primary_reason === 'host_shutdown' && this.preservedShutdownWork(work))).map(work => work.work_id),
      unknown_attempt_ids: attempts.filter(attempt => attempt.state === 'unknown' || attempt.dispatch_state === 'unknown').map(attempt => attempt.attempt_id)
    } : proposed
    if (outcome.phase === 'terminal') return
    if (outcome.phase === 'active') {
      this.db.prepare('UPDATE runs SET state=?,wait_reason=? WHERE id=? AND commit_valid=1').run(outcome.state, outcome.state === 'waiting' ? outcome.waits[0]?.reason ?? 'work_waiting' : null, runId)
      return
    }
    state.closeRun(runId)
    const affected = outcome.cancel_work_ids.flatMap(workId => state.revokeWork(workId))
    const cancelledAttempts = attempts.filter(attempt => outcome.cancel_work_ids.includes(attempt.work_id)).map(attempt => attempt.attempt_id)
    if (cancelledAttempts.length) this.revokeRunActions(runId, cancelledAttempts)
    for (const [attemptId, worker] of this.workers) if (worker.owner.run_id === runId && outcome.cancel_work_ids.includes(worker.owner.work_id)) {
      this.pluginCalls.cancelAttempt(attemptId); this.monty.cancelAttempt(attemptId); worker.controller.abort()
    }
    this.settleDependentRuns(taskId, affected, runId)
    if (!outcome.outcome) { this.pumpRunnerWorkers(taskId); return }
    // Missing token usage remains an accounting fact after the request ends.
    // Only execution ownership and unconfirmed effects keep a Run closing.
    const unresolved = this.workersForRun(runId) || this.pluginCalls.busyRun(runId) || this.runnerCleanupPending(runId) || this.monty.busyRun(runId) || outcome.unknown_attempt_ids.length > 0 || !!this.db.prepare("SELECT 1 FROM calls WHERE run_id=? AND (state!='ended' OR execution='unknown') LIMIT 1").get(runId)
    const dependencyInvalid = works.some(work => work.required && work.state === 'invalidated' && work.purpose === 'production' && work.assignment)
    const reason = (outcome.outcome === 'failed' ? runnerFailureReason(this.db, taskId, runId, terminal.primary_reason) ?? (dependencyInvalid ? 'RUNNER_DEPENDENCY_INVALID' : null) : terminal.primary_reason) ?? (cancellation ? 'user_cancelled' : 'required_work_settled')
    this.db.prepare("UPDATE runs SET state='waiting',wait_reason=?,intended_terminal=?,primary_reason=CASE WHEN primary_reason IS NULL OR primary_reason='required_work_settled' THEN ? ELSE primary_reason END WHERE id=? AND state IN ('running','waiting')").run(unresolved ? 'ending_cleanup' : 'runner_closing', outcome.outcome, reason, runId)
    if (unresolved) { this.pumpRunnerWorkers(taskId); return }
    const agent = this.agents.get(runId)
    if (agent?.managed) {
      agent.main.release(); agent.compact?.release(); agent.approval?.release(); this.agents.delete(runId)
    }
    this.finish(taskId, runId, outcome.outcome, reason, true)
    this.pumpRunnerWorkers(taskId)
  }
  private reconcileRunnerDependencies(state: RunnerWorkState, task: string, currentRun?: string): void {
    this.settleDependentRuns(task, state.reconcileDependencies(task), currentRun)
  }
  private settleDependentRuns(task: string, affected: LogicalWork[], currentRun?: string): void {
    if (this.closed || !this.db.open) return
    const runs = new Set<string>()
    for (const work of affected) {
      if (work.purpose !== 'production' || !work.assignment || !['invalidated', 'dependency_failed', 'dependency_cancelled'].includes(work.state)) continue
      if (work.run_id !== currentRun) runs.add(work.run_id)
      if (!work.current_attempt_id) continue
      this.revokeRunActions(work.run_id, [work.current_attempt_id])
      this.pluginCalls.cancelAttempt(work.current_attempt_id); this.monty.cancelAttempt(work.current_attempt_id)
      this.workers.get(work.current_attempt_id)?.controller.abort()
    }
    for (const run of runs) this.aggregateWorkerRun(task, run)
  }
  private workersForRun(runId: string): boolean { return [...this.workers.values()].some(worker => worker.owner.run_id === runId) }
  private runnerCleanupPending(runId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM cleanup_jobs j
      WHERE j.necessary=1 AND j.state!='done' AND (
        (j.owner_kind='call' AND EXISTS (SELECT 1 FROM calls c WHERE c.id=j.owner_id AND c.run_id=@run)) OR
        (j.owner_kind='action' AND EXISTS (SELECT 1 FROM actions a WHERE a.id=j.owner_id AND (a.run_id=@run OR json_extract(a.source_json,'$.owner.run_id')=@run))) OR
        (j.owner_kind='staging' AND EXISTS (SELECT 1 FROM staging s JOIN actions a ON a.id=s.owner_id WHERE s.id=j.owner_id AND s.owner_kind='action' AND (a.run_id=@run OR json_extract(a.source_json,'$.owner.run_id')=@run))) OR
        (j.owner_kind='plugin_instance' AND EXISTS (SELECT 1 FROM json_each(j.detail_json,'$.call_ids') affected JOIN calls c ON c.id=affected.value WHERE c.run_id=@run)) OR
        (j.owner_kind NOT IN ('call','action','staging','plugin_instance') AND j.task_id=(SELECT task_id FROM runs WHERE id=@run))
      ) LIMIT 1`).get({ run: runId })
  }
  private runnerArtifacts(): RunnerArtifactState { return this.runnerArtifactState ??= new RunnerArtifactState(this.db, new RunnerWorkState(this.db, this.epoch)) }
  private contentTreeQuery(task: string, request: Extract<ModelRequest, { type: 'read' | 'list' }>, source: string, bodyAllowed = true): unknown {
    const queries = new ContentTreeQueries(new ContentTreeState(this.db), () => this.publishedChapterManifests(task), resource => this.bundle(resource), (dependency, reference) => {
      const worker = this.workers.get(source)
      if (worker) {
        if (reference) {
          const saved = this.contentReads(task, worker.owner).find(read => read.read_ref === reference)
          if (!saved || saved.view_id !== dependency.view_id || saved.node_id !== dependency.node_id || saved.revision !== dependency.revision || saved.position_revision !== dependency.position_revision) fail('CONTENT_READ_INVALID', 'A content page must retain its exact original reading evidence')
          return reference
        }
        return this.record(task, 'content.node.read', { owner: worker.owner, ...dependency })
      }
    })
    return queries.query(task, source, request, bodyAllowed)
  }
  private contentReads(task: string, owner: ExecutionScope): Row[] {
    return (this.db.prepare("SELECT id,payload_json FROM records WHERE task_id=? AND kind='content.node.read' AND json_extract(payload_json,'$.owner.attempt_id')=? ORDER BY sequence").all(task, owner.attempt_id) as Row[]).map(row => ({ ...JSON.parse(row.payload_json), read_ref: row.id }))
  }
  private checkContentReads(task: string, owner: ExecutionScope, references?: readonly string[]): void {
    const reads = this.contentReads(task, owner)
    if (references?.some(reference => !reads.some(read => read.read_ref === reference))) fail('CONTENT_READ_INVALID', 'Effective reads must belong to this content worker')
    for (const read of references ? reads.filter(read => references.includes(read.read_ref)) : reads) {
      const node = this.chapters().state.manifest(task, read.view_id)?.content_tree?.nodes.find(node => node.node_id === read.node_id)
      if (!node || node.revision !== read.revision || node.position_revision !== read.position_revision) fail('CONTENT_DEPENDENCY_STALE', 'A content node read by this worker changed')
    }
  }
  private contentReadRefs(task: string, owner: ExecutionScope, update: ChapterUpdate, operations: readonly (ContentOperation | import('../shared/contracts.generated').ContentOperationPlan)[], references?: string[]): string[] {
    const tree = this.chapters().state.manifest(task, update.view_id)?.content_tree ?? fail('CONTENT_TREE_REQUIRED', 'Read the current content tree before submitting')
    const history = this.contentReads(task, owner).filter(read => read.view_id === update.view_id).reverse()
    const targets = [...new Set(operations.flatMap(operation => 'node_ids' in operation ? operation.node_ids : [operation.parent_id]))]
    const covers = (read: Row, target: string): boolean => {
      const node = tree.nodes.find(node => node.node_id === target), ancestor = tree.nodes.find(node => node.node_id === read.node_id)
      return !!node && !!ancestor && ancestor.span.start <= node.span.start && ancestor.span.end >= node.span.end
    }
    const selected = references ?? [...new Set(targets.flatMap(target => {
      const read = history.find(read => covers(read, target))
      return read ? [read.read_ref as string] : []
    }))]
    if (targets.some(target => !history.some(read => selected.includes(read.read_ref) && covers(read, target)))) fail('CONTENT_BASELINE_REQUIRED', 'Read each affected node or its containing subtree before submitting')
    this.checkContentReads(task, owner, selected)
    return selected
  }
  private submittedContentProposal(task: string, owner: ExecutionScope): ChapterProposal | null {
    if (owner.purpose !== 'production' || !owner.update_id) return null
    const chapters = this.chapters().state, update = chapters.update(task, owner.update_id)
    const publication = update?.publication_operation_id ? chapters.publication(task, update.publication_operation_id) : null
    if (update?.state !== 'succeeded' || publication?.operation.state !== 'published' || !update.proposal_id) return null
    const proposal = chapters.proposal(task, update.proposal_id)
    return proposal?.source.attempt_id === owner.attempt_id && proposal.scope_revision === update.scope_revision ? proposal : null
  }
  private async submitContentOperations(task: string, owner: ExecutionScope, raw: unknown, signal: AbortSignal, valid: () => void): Promise<unknown> {
    valid()
    const chapters = this.chapters().state
    const original = owner.purpose === 'production' && owner.update_id ? chapters.assertLive(task, owner.update_id) : fail('WORKER_CAPABILITY_DENIED', 'Content operations require bound content work')
    const querying = !!raw && typeof raw === 'object' && !Array.isArray(raw) && (raw as Row).action === 'query'
    try {
      const input = parseContentRequest(raw)
      if (input.action === 'query') {
        const publication = chapters.publication(task, input.operation_id)
        if (!publication || publication.operation.update_id !== original.update_id) fail('WORKER_CAPABILITY_DENIED', 'Query only a publication belonging to this update')
        return this.contentPublicationResult(task, original.update_id, publication.operation.operation_id)
      }
      const read_refs = this.contentReadRefs(task, owner, original, input.operations, input.read_refs)
      const plans = input.operations.map(operation => 'html' in operation ? (({ html: _html, ...plan }) => plan)(operation) : operation)
      const update = original.scope_revision === undefined ? chapters.assertCurrent(task, original.update_id) : chapters.reviseScope(task, original.update_id, { operations: plans, source: owner, read_refs })
      this.record(task, 'chapter.update.stage', { update_id: update.update_id, scope_revision: update.scope_revision, state: update.state, region_ids: update.region_ids })
      for (const old of update.previous_update_ids) this.cancelChapterExecution(task, old)
      this.continueContentRemainders(update)
      const inherited_requirements = this.inheritedContentRequirements(update)
      if (input.action === 'register') return { execution: 'success', delivery: 'delivered', data: { update_id: update.update_id, scope_revision: update.scope_revision, state: 'registered', region_ids: update.region_ids, read_refs, inherited_requirements } }
      const operations = input.operations
      assertContentAuthority(update, operations)
      const latest = chapters.manifest(task, update.view_id)!
      const assembled = assembleContentUpdate({ bundle: this.bundle(latest.bundle_resource_id), manifest: latest }, update, operations)
      validateProducerBundle(assembled.bundle); this.checkedBundle(task, assembled.bundle, owner.attempt_id)
      const resourceInput = { type: 'resource.create' as const, display_name: 'Content candidate', content: { type: 'json' as const, value: JSON.parse(json(assembled.bundle)) } }, actionId = id()
      this.db.prepare("INSERT INTO actions(id,task_id,run_id,kind,state,source_json,request_json,commit_valid,created_at) VALUES (?,?,?,'mutation','registered',?,?,1,?)").run(actionId, task, owner.run_id, json({ type: 'worker', owner }), json(resourceInput), now())
      const context: ExecutionActionContext = { id: actionId, owner, signal, valid, authorize: request => { if (json(request) !== json({ type: 'write', input: resourceInput })) fail('WORKER_CAPABILITY_DENIED', 'Only the exact compiled content candidate is authorized') } }
      const created = this.resourceCreate(task, owner.run_id, resourceInput, context) as { data: { id: string } }
      const proposal = validateRunnerContract('runner_chapter_proposal', { task_id: task, update_id: update.update_id, intent_revision: update.intent_revision, proposal_id: id(), source: owner, bundle_resource_id: created.data.id, replacements: [], dependencies: update.dependencies, tree_operations: operations, ...(update.scope_revision !== undefined ? { scope_revision: update.scope_revision, read_refs } : {}) })
      this.db.transaction(() => {
        valid(); chapters.recordProposal(proposal)
        this.record(task, 'content.operations.submitted', proposal)
        this.record(task, 'chapter.proposal.accepted', { update_id: update.update_id, scope_revision: update.scope_revision, proposal_id: proposal.proposal_id, owner })
      })()
      const state = new RunnerWorkState(this.db, this.epoch), publisher = state.taskWorks(task).find(work => work.run_id === owner.run_id && work.role === 'lightweight')!
      await this.publishChapterUpdate(task, update.update_id, publisher.current_attempt_id!, owner)
      const current = chapters.update(task, update.update_id)!
      if (current.state === 'unknown') await this.waitContentPublication(task, current.update_id, current.publication_operation_id!, owner, signal)
      return this.contentPublicationResult(task, update.update_id, current.publication_operation_id!)
    } catch (error) {
      if (querying) throw error
      const current = chapters.update(task, original.update_id)!, code = error instanceof ContractError ? error.code : 'CONTENT_OPERATION_FAILED'
      const publication = current.publication_operation_id ? chapters.publication(task, current.publication_operation_id) : null
      const denied = (publication?.result as Row | null)?.denied === true
      const knownIneffective = !publication || publication.operation.operation_id === original.publication_operation_id || publication.operation.state === 'failure'
      const correctable = error instanceof ContractError && knownIneffective && !denied && !signal.aborted && !chapterTerminal.has(current.state) && current.state !== 'unknown' && isCorrectableContentError(code)
      if (!correctable) {
        if (knownIneffective && !chapterTerminal.has(current.state) && current.state !== 'unknown') chapters.stage(task, current.update_id, signal.aborted ? 'cancelled' : 'failed', { reason: code })
        throw error
      }
      if (current.scope_revision !== undefined) chapters.releaseScope(task, current.update_id, code)
      else chapters.stage(task, current.update_id, 'generating', { reason: code })
      this.record(task, 'content.operations.rejected', { update_id: current.update_id, scope_revision: current.scope_revision, operation_id: current.publication_operation_id, code, correctable: true })
      return { execution: 'not_executed', delivery: 'delivered', error: { code, message: error.message, correctable: true }, data: { update_id: current.update_id, scope_revision: current.scope_revision, proposal_id: current.proposal_id, operation_id: current.publication_operation_id, state: 'correction_required', read: { kind: 'content_tree', id: current.view_id } } }
    }
  }
  private contentPublicationResult(task: string, updateId: string, operationId: string): unknown {
    const publication = this.chapters().state.publication(task, operationId) ?? fail('RUNNER_NOT_FOUND', 'Content publication is unavailable')
    const { operation, result } = publication
    return { execution: operation.state === 'published' ? 'success' : operation.state === 'unknown' ? 'unknown' : 'not_executed', delivery: 'delivered', data: { update_id: updateId, scope_revision: operation.scope_revision, proposal_id: operation.proposal_id, operation_id: operationId, action_id: operation.action_id, state: operation.state, result } }
  }
  private async waitContentPublication(task: string, updateId: string, operationId: string, owner: ExecutionScope, signal: AbortSignal): Promise<void> {
    const worker = this.workers.get(owner.attempt_id)!
    this.workerState(worker, 'waiting', 'content_publication_unknown')
    for (;;) {
      if (signal.aborted || worker.controller.signal.aborted) fail('SOURCE_INVALID', 'Content publication reconciliation was cancelled')
      this.qualifyWorker(owner.attempt_id)
      this.chapters().reconcile(task)
      const publication = this.chapters().state.publication(task, operationId)
      if (!publication || publication.operation.update_id !== updateId) fail('RUNNER_OWNERSHIP_INVALID', 'The original publication is unavailable')
      if (publication.operation.state !== 'unknown') {
        this.workerState(worker, 'running')
        if (publication.operation.state !== 'published') {
          const result = publication.result as Row | null
          fail(result?.code ?? 'CHAPTER_PUBLICATION_FAILED', result?.message ?? 'The original publication was confirmed ineffective')
        }
        return
      }
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
        const timer = setTimeout(done, 250)
        signal.addEventListener('abort', done, { once: true })
      })
    }
  }
  private chapters(): ChapterHost { return new ChapterHost(this.db, this.epoch, resource => this.bundle(resource), (task, kind, payload) => this.record(task, kind, payload)) }
  startChapterUpdate(input: Extract<IpcRequest, { type: 'chapter.update' }>, received?: { record_id: string; conversation: unknown; material_resource_ids: string[]; inherited_requirements?: Row[]; content_authority?: { region_ids: string[] }; conversation_dependency?: BoundConversationDependency }): ChapterUpdate {
    this.acceptWork(); this.recovery.assertWrite(); this.task(input.task_id)
    let clarified: { request_id: string; input: Row; row: Row } | undefined
    if (input.source_request_id) {
      const row = this.one('SELECT * FROM requests WHERE task_id=? AND id=?', input.task_id, input.source_request_id), original = JSON.parse(row.input_json), selection = JSON.parse(row.config_selection_json)
      if (original.binding_version !== 1 || !(row.state === 'confirmation_required' && original.code === 'CHAPTER_SCOPE_REQUIRED' || row.state === 'started' && original.chapter_update_id === input.update_id)) fail('REQUEST_NOT_CONFIRMABLE', 'Select chapters for the original request awaiting scope clarification')
      const originalMaterialIds = (this.requests.handle({ type: 'request.status', task_id: input.task_id, request_id: input.source_request_id }).materials as Row[]).map(material => {
        if (material.state !== 'success') fail('REQUEST_MATERIALS_INCOMPLETE', 'Original materials must remain available')
        return material.id as string
      })
      const materialIds = [...new Set([...originalMaterialIds, ...(received?.material_resource_ids ?? [])])]
      for (const resourceId of materialIds) this.requestMaterial(input.task_id, resourceId)
      const clarification = received && this.features.runner?.conversationRouting ? this.one("SELECT payload_json FROM records WHERE id=? AND task_id=? AND kind='message.user'", received.record_id, input.task_id) : null
      if (clarification && JSON.parse(clarification.payload_json).text !== input.text) fail('REQUEST_SOURCE_INVALID', 'Clarification must retain its exact accepted user input')
      const text = clarification ? `${original.text}\n\nUser clarification:\n${input.text}` : original.text
      if (Buffer.byteLength(text) > defaults.data.object_bytes) fail('INVALID_INPUT', 'Original request and its clarification exceed the input limit')
      input = { ...input, text, model_config_id: selection.id }
      received = { record_id: original.user_record_id, conversation: original.conversation, material_resource_ids: materialIds, conversation_dependency: original.conversation_dependency }
      clarified = { request_id: input.source_request_id!, input: original, row }
      if (json(this.requestSelection(selection.id)) !== json(selection)) fail('REQUEST_CONFIGURATION_CHANGED', 'Confirm the changed model selection before selecting chapters')
    }
    const host = this.chapters(), saved = host.state.update(input.task_id, input.update_id)
    if (saved) return host.start(input)
    const main = this.models.acquire(input.model_config_id, 'main')
    let compact: ModelLease | undefined, approval: ModelLease | undefined, update!: ChapterUpdate, producer!: ExecutionAttempt
    try {
      compact = this.models.acquireCompaction(main)
      if (this.approvalMode === 'assisted') approval = this.models.acquire(this.approvalModel, 'approval')
      this.db.transaction(() => {
        if (this.task(input.task_id).state !== 'active') fail('TASK_STOPPED', 'Explicitly resume the task first')
        update = host.start(input, received)
        const state = new RunnerWorkState(this.db, this.epoch), runId = id()
        const common = { task_id: update.task_id, run_id: runId, purpose: 'production' as const, request_id: update.request_id, intent_revision: update.intent_revision, update_id: update.update_id, ...(this.features.runner?.conversationRouting ? { message_id: received?.record_id ?? update.record_id } : {}) }
        const ledger = new RunnerBudgetLedger(this.db)
        const existing = this.db.prepare("SELECT budget_id FROM runner_budgets WHERE task_id=? AND request_id=? AND purpose='production' ORDER BY rowid LIMIT 1").get(update.task_id, update.request_id) as Row | undefined
        const budgetId = existing?.budget_id ?? id()
        if (!existing) ledger.create({ budget_id: budgetId, task_id: update.task_id, purpose: 'production', request_id: update.request_id })
        this.db.prepare("INSERT INTO runs(id,task_id,request_id,chapter_update_id,state,runtime_epoch,limits_json,budget_json,created_at) VALUES (?,?,?,?,'running',?,?,?,?)").run(runId, update.task_id, update.request_id, update.update_id, this.epoch, json({ ...defaults, run: main.config.limits ?? {} }), json({ model_requests: 0, tool_requests: 0, tokens: 0 }), now())
        state.registerRun({ ...common, runtime_epoch: this.epoch, state: 'running', commit_valid: true, budget_id: budgetId })
        const originalArtifact = update.base_manifest.artifact_id ? this.runnerArtifacts().artifact(update.task_id, update.base_manifest.artifact_id, update.base_manifest.artifact_revision) ?? fail('RUNNER_OWNERSHIP_INVALID', 'Chapter baseline artifact is unavailable') : null
        const inheritedMaterials = originalArtifact ? this.runnerArtifacts().chapterMaterialDependencies(originalArtifact).map(dependency => dependency.resource_id) : []
        const materialIds = [...new Set([...(received?.material_resource_ids ?? []), ...inheritedMaterials])]
        host.state.protect(update.task_id, 'input_materials', update.update_id, materialIds)
        const dependencies = [...(common.message_id ? [] : [{ kind: 'goal' as const, task_id: update.task_id, request_id: update.request_id, intent_revision: update.intent_revision }]), ...(update.scope_revision === undefined ? update.dependencies : []), ...materialIds.map(resource_id => ({ kind: 'resource' as const, task_id: update.task_id, resource_id }))]
        const works: LogicalWork[] = ['producer', 'lightweight'].map(role => ({ ...common, work_id: id(), plan_revision: 1, role: role as 'producer' | 'lightweight', required: true, requirement_ids: [], dependencies, state: 'planned', max_attempts: 1 }))
        state.installPlan(works)
        for (const work of works) {
          const attempt: ExecutionAttempt = { ...common, work_id: work.work_id, attempt_id: id(), runtime_epoch: this.epoch, attempt_number: 1, profile_id: work.role === 'producer' ? 'chapter-producer-v1' : 'chapter-host-publisher-v1', model_config_id: main.id, model_config_revision: main.revision, input_versions: dependencies, state: 'registered', dispatch_state: 'not_dispatched', usage_refs: [] }
          state.createAttempt(attempt)
          if (work.role === 'producer') producer = attempt
        }
        update = host.state.stage(update.task_id, update.update_id, 'queued', { source: this.workerOwner(state.qualify(producer.attempt_id, 'dispatch')) })
        if (clarified) {
          const current = this.one('SELECT state,input_json,config_selection_json FROM requests WHERE task_id=? AND id=?', input.task_id, clarified.request_id)
          if (current.state !== 'confirmation_required' || current.input_json !== clarified.row.input_json || current.config_selection_json !== clarified.row.config_selection_json) fail('REQUEST_SOURCE_INVALID', 'Original scope clarification changed before installation')
          this.db.prepare("UPDATE requests SET state='started',input_json=? WHERE task_id=? AND id=?").run(json({ ...clarified.input, chapter_update_id: update.update_id, chapter_run_id: producer.run_id, chapter_route: { kind: 'update', view_id: input.view_id, region_ids: input.region_ids }, code: null }), input.task_id, clarified.request_id)
        }
      })()
      this.agents.set(producer.run_id, { controller: new AbortController(), main, compact, approval, budget: new RunBudget(main.config), mode: this.approvalMode, managed: true })
      for (const old of update.previous_update_ids) this.cancelChapterExecution(update.task_id, old)
      this.continueContentRemainders(update)
      const flight = this.executeChapterUpdate(update.task_id, update.update_id, producer.attempt_id)
      this.chapterFlights.set(update.update_id, flight)
      void flight.finally(() => this.chapterFlights.delete(update.update_id)).catch(() => {})
      return host.state.update(update.task_id, update.update_id)!
    } catch (error) { main.release(); compact?.release(); approval?.release(); throw error }
  }
  private continueContentRemainders(update: ChapterUpdate): void {
    if (!update.base_manifest.content_tree) return
    this.resumeContentRemainders(update.task_id)
  }
  private resumeContentRemainders(task: string): void {
    if (this.closed || this.closing || this.continuingContentRemainders.has(task) || this.task(task).state !== 'active') return
    this.continuingContentRemainders.add(task)
    try {
      const host = this.chapters()
      host.reconcile(task)
      const rows = this.db.prepare('SELECT update_id,previous_update_id,payload_json FROM runner_content_intent_relations WHERE task_id=? ORDER BY rowid').all(task) as Row[]
      const updates = this.db.prepare('SELECT rowid AS ordinal,update_id FROM runner_chapter_updates WHERE task_id=? ORDER BY rowid').all(task) as Row[]
      const origins = new Map<string, string>()
      for (const row of rows) {
        const relation = JSON.parse(row.payload_json)
        for (const continuation of [relation.continuation_update_id, ...(relation.previous_continuation_update_ids ?? [])]) if (continuation) origins.set(continuation, row.previous_update_id)
      }
      const ordinal = (updateId: string): number => {
        const seen = new Set<string>()
        while (origins.has(updateId) && !seen.has(updateId)) { seen.add(updateId); updateId = origins.get(updateId)! }
        return updates.find(row => row.update_id === updateId)?.ordinal ?? 0
      }
      const unresolved = (update: ChapterUpdate): boolean => update.state === 'unknown' || !!(update.publication_operation_id && ['dispatched', 'unknown'].includes(host.state.publication(task, update.publication_operation_id)?.operation.state ?? ''))
      for (const row of rows) {
        let relation: Row = JSON.parse(row.payload_json)
        if (!relation.retained_node_ids.length || ['failed', 'completed', 'settled', 'superseded'].includes(relation.continuation_state)) continue
        const save = (fields: Row): void => {
          relation = { ...relation, ...fields }
          this.db.prepare('UPDATE runner_content_intent_relations SET payload_json=? WHERE task_id=? AND update_id=? AND previous_update_id=?').run(json(relation), task, row.update_id, row.previous_update_id)
        }
        const previous = host.state.update(task, row.previous_update_id), takeover = host.state.update(task, row.update_id)
        if (!previous || !takeover) continue
        let continuationId: string | undefined = relation.continuation_update_id
        const existing = continuationId ? host.state.update(task, continuationId) : null
        if (existing) {
          if (unresolved(existing)) continue
          if (existing.state === 'succeeded') { save({ continuation_state: 'completed' }); continue }
          if (existing.state !== 'interrupted') {
            if (chapterTerminal.has(existing.state)) save({ continuation_state: 'settled' })
            continue
          }
          // A lost execution gets a new identity only after its original operation is known.
          if (!existing.source || new RunnerWorkState(this.db, this.epoch).run(existing.source.run_id).runtime_epoch === this.epoch) { save({ continuation_state: 'settled' }); continue }
        }
        try {
          const manifest = host.state.manifest(task, takeover.view_id)!
          if (manifest.request_id !== previous.request_id || manifest.intent_revision !== previous.intent_revision) fail('RUNNER_OWNERSHIP_INVALID', 'Continuation must retain its original request authority')
          let remainder: ChapterUpdate = { ...previous, base_manifest: takeover.base_manifest, region_ids: relation.retained_node_ids, tree_operations: relation.retained_tree_operations }
          // Preserve intent order across crashes and deferred dispatch, including completed later requests.
          for (const laterRow of updates) {
            if (ordinal(laterRow.update_id) <= ordinal(takeover.update_id) || origins.get(laterRow.update_id) === previous.update_id) continue
            const later = host.state.update(task, laterRow.update_id)!
            if (later.view_id !== previous.view_id) continue
            const retained = reconcileRetainedContentScope(remainder, later)
            remainder = { ...remainder, region_ids: retained.retained_node_ids, tree_operations: retained.retained_tree_operations }
            if (!remainder.region_ids.length) break
          }
          if (!remainder.region_ids.length) { save({ continuation_state: 'superseded' }); continue }
          const rebased: ChapterUpdate = { ...remainder, base_manifest: manifest }
          // Validates original node and location identities against the current tree.
          updateContentScope(rebased)
          const blocked = host.state.updates(task, takeover.view_id).some(active => active.update_id !== continuationId && (!chapterTerminal.has(active.state) || unresolved(active)) && contentUpdatesOverlap(rebased, active))
          if (blocked || unresolved(takeover)) { save({ continuation_state: 'deferred' }); continue }
          if (existing) {
            save({ previous_continuation_update_ids: [...(relation.previous_continuation_update_ids ?? []), continuationId] })
            continuationId = undefined
          }
          continuationId ??= id()
          save({ continuation_update_id: continuationId, continuation_state: 'starting' })
          const original = JSON.parse(this.one('SELECT payload_json FROM records WHERE task_id=? AND id=?', task, previous.record_id).payload_json)
          const view = this.one('SELECT revision,state_revision FROM views WHERE id=?', takeover.view_id)
          const continuation = this.startChapterUpdate({ type: 'chapter.update', task_id: task, input_event_id: `content-continuation:${continuationId}`, update_id: continuationId, view_id: takeover.view_id, view_revision: view.revision, state_revision: view.state_revision, region_ids: remainder.region_ids, text: previous.text, model_config_id: previous.model_config_id ?? takeover.model_config_id!, ...(remainder.tree_operations?.length ? { tree_operations: remainder.tree_operations } : {}) }, { record_id: original.source_record_id ?? previous.record_id, conversation: original.conversation, material_resource_ids: original.material_resource_ids ?? [], inherited_requirements: this.inheritedContentRequirements(previous) })
          save({ continuation_state: 'started' })
          this.record(task, 'content.intent.continued', { update_id: continuationId, previous_update_id: previous.update_id, takeover_update_id: takeover.update_id, source_record_id: previous.record_id, region_ids: continuation.region_ids, request_id: previous.request_id })
        } catch (error) {
          const code = error instanceof ContractError ? error.code : 'CONTENT_CONTINUATION_FAILED'
          const waiting = ['MODEL_NOT_CONFIGURED', 'MODEL_NOT_VALIDATED', 'CREDENTIAL_REQUIRED', 'CONFIGURATION_BUSY', 'COMPACTION_CONFIGURATION_CHANGED'].includes(code)
          const changed = relation.continuation_state !== (waiting ? 'deferred' : 'failed') || relation.code !== code
          save({ continuation_state: waiting ? 'deferred' : 'failed', code })
          if (changed) this.record(task, waiting ? 'content.intent.continuation.waiting' : 'content.intent.continuation.failed', { update_id: continuationId, previous_update_id: previous.update_id, takeover_update_id: takeover.update_id, code })
        }
      }
    } finally { this.continuingContentRemainders.delete(task) }
  }
  private inheritedContentRequirements(update: ChapterUpdate): Row[] {
    const seen = new Set<string>(), requirements: Row[] = []
    const visit = (current: ChapterUpdate): void => {
      const accepted = JSON.parse(this.one('SELECT payload_json FROM records WHERE task_id=? AND id=?', update.task_id, current.record_id).payload_json)
      requirements.push(...(accepted.inherited_requirements ?? []))
      for (const previousId of current.previous_update_ids) {
        if (seen.has(previousId)) continue
        seen.add(previousId)
        const previous = this.chapters().state.update(update.task_id, previousId)
        if (!previous) fail('RUNNER_OWNERSHIP_INVALID', 'Inherited content requirements lost their original input')
        visit(previous)
        const original = JSON.parse(this.one('SELECT payload_json FROM records WHERE task_id=? AND id=?', update.task_id, previous.record_id).payload_json)
        const scope = updateContentScope(previous)
        requirements.push({ source_record_id: original.source_record_id ?? previous.record_id, request_id: previous.request_id, intent_revision: previous.intent_revision, node_ids: scope.node_ids, gaps: scope.gaps, text: previous.text, effect: 'retain_unless_superseded', superseding_record_id: current.record_id })
      }
    }
    visit(update)
    const tree = update.base_manifest.content_tree!, scope = updateContentScope(update)
    const within = (id: string, parent: string): boolean => {
      let node = tree.nodes.find(node => node.node_id === id)
      while (node) { if (node.node_id === parent) return true; node = tree.nodes.find(item => item.node_id === node!.parent_id) }
      return false
    }
    const projected: Row[] = requirements.flatMap((requirement): Row[] => {
      const nodeIds = new Set<string>()
      for (const original of requirement.node_ids ?? []) for (const target of scope.node_ids) {
        if (within(original, target)) nodeIds.add(original)
        else if (within(target, original)) nodeIds.add(target)
      }
      const gaps = (requirement.gaps ?? []).filter((gap: Row) => scope.node_ids.some(node => within(gap.parent_id, node)) || scope.gaps.some(current => current.parent_id === gap.parent_id && current.before_id === gap.before_id && current.after_id === gap.after_id))
      return nodeIds.size || gaps.length ? [{ ...requirement, node_ids: [...nodeIds], gaps }] : []
    })
    const merged = new Map<string, Row>()
    for (const requirement of projected) {
      const previous = merged.get(requirement.source_record_id)
      merged.set(requirement.source_record_id, { ...requirement, node_ids: [...new Set([...(previous?.node_ids ?? []), ...requirement.node_ids])], gaps: [...new Map([...(previous?.gaps ?? []), ...requirement.gaps].map(gap => [json(gap), gap])).values()] })
    }
    return [...merged.values()]
  }
  private cancelChapterExecution(task: string, updateId: string): void {
    const state = new RunnerWorkState(this.db, this.epoch)
    const runs = this.db.prepare('SELECT run_id FROM runner_runs WHERE task_id=? AND json_extract(payload_json,\'$.update_id\')=?').all(task, updateId) as Row[]
    for (const run of runs) {
      this.record(task, 'runner.cancelled', { run_id: run.run_id, scope: 'run', reason: 'chapter_update_cancelled' })
      state.revokeRun(run.run_id)
      this.agents.get(run.run_id)?.controller.abort()
      this.revokeRunActions(run.run_id)
      this.aggregateWorkerRun(task, run.run_id)
    }
  }
  private async executeChapterUpdate(task: string, updateId: string, producerId: string): Promise<void> {
    const host = this.chapters(), state = new RunnerWorkState(this.db, this.epoch)
    const initial = host.state.assertLive(task, updateId), runId = state.attempt(producerId).run_id
    try {
      const owner = this.workerOwner(state.qualify(producerId, 'dispatch'))
      const treePath = !!initial.base_manifest.content_tree
      const context = treePath ? null : chapterInput(this.bundle(initial.base_manifest.bundle_resource_id), initial.base_manifest, initial.region_ids, initial.dependencies)
      const template = treePath ? null : chapterCandidateTemplate(this.bundle(initial.base_manifest.bundle_resource_id), initial.base_manifest, initial.region_ids, initial.dependencies)
      const checkCandidate = (proposal: ChapterProposal, source: ExecutionScope): void => {
        state.qualify(producerId)
        const resource = this.db.prepare("SELECT a.source_json FROM actions a WHERE a.task_id=? AND a.result='success' AND json_extract(a.result_json,'$.data.id')=?").get(task, proposal.bundle_resource_id) as Row | undefined
        if (!resource || json(captureExecutionScope(JSON.parse(resource.source_json).owner)) !== json(source)) fail('RUNNER_OWNERSHIP_INVALID', 'Chapter proposal requires a resource created by its exact producer')
        const bundle = loadBundleSource(this.db, this.root, task, { type: 'resource', resource: { kind: 'resource', id: proposal.bundle_resource_id } }, row => this.journal.assertResource(row)).bundle
        validateProducerBundle(bundle); this.checkedBundle(task, bundle, source.attempt_id)
        const latest = host.state.manifest(task, initial.view_id)!
        if (proposal.tree_operations) {
          this.checkContentReads(task, source, proposal.read_refs)
          assembleContentUpdate({ bundle: this.bundle(latest.bundle_resource_id), manifest: latest }, host.state.assertCurrent(task, updateId, proposal.scope_revision), proposal.tree_operations)
        } else {
          validateChapterCandidate(bundle, proposal.replacements.flatMap(group => group.chapters))
          assembleChapterUpdate({ latest: { bundle: this.bundle(latest.bundle_resource_id), manifest: latest }, baseline: initial.base_manifest, candidate: bundle, replacements: proposal.replacements, dependencies: proposal.dependencies })
        }
      }
      const accepted = this.one('SELECT payload_json FROM records WHERE task_id=? AND id=?', task, initial.record_id)
      const binding = JSON.parse(accepted.payload_json)
      const conversation = this.loadBoundConversation(task, binding.conversation, binding.conversation_dependency)
      const profile = treePath
        ? createContentProfile(initial, owner, this.contentToolGrants(task, conversation), () => this.submittedContentProposal(task, owner))
        : createChapterProfile(initial, owner, this.contentToolGrants(task, conversation), proposal => checkCandidate(proposal, owner), template!.chapters)
      host.state.stage(task, updateId, 'generating'); this.record(task, 'chapter.update.stage', { update_id: updateId, state: 'generating' })
      const inherited = treePath ? this.inheritedContentRequirements(initial) : []
      if (inherited.length) this.record(task, 'content.intent.reconciled', { update_id: updateId, source_record_id: initial.record_id, requirements: inherited })
      await this.executeWorker(producerId, profile, { text: initial.text, bound: treePath ? { inherited_requirements: inherited } : { chapter_context: context!.bundle, chapter_fragments: context!.chapters, chapter_template: template!.bundle }, conversation }, (proposal, source) => {
        if (treePath) {
          if (this.submittedContentProposal(task, source)?.proposal_id !== proposal.proposal_id) fail('RUNNER_OUTPUT_INCOMPLETE', 'Content work requires its exact successful publication')
          return
        }
        checkCandidate(proposal, source)
        host.state.recordProposal(proposal)
        this.record(task, 'chapter.proposal.accepted', { update_id: updateId, proposal_id: proposal.proposal_id, owner: source })
      })
      if (treePath) return
      const publisher = state.taskWorks(task).find(work => work.run_id === runId && work.role === 'lightweight')!
      await new Promise<void>((resolve, reject) => {
        const attemptId = publisher.current_attempt_id!
        state.updateAttempt({ ...state.attempt(attemptId), state: 'queued' })
        this.pendingWorkers.set(attemptId, { task, work: admissionWork(publisher), reject, start: () => { void this.publishChapterUpdate(task, updateId, attemptId).then(resolve, reject).finally(() => this.pumpRunnerWorkers(task)) } })
        this.pumpRunnerWorkers(task)
      })
    } catch (error) {
      if (!this.closed && this.db.open) {
        const current = host.state.update(task, updateId)!
        if (!chapterTerminal.has(current.state) && current.state !== 'unknown') host.state.stage(task, updateId, this.agents.get(runId)?.controller.signal.aborted ? 'cancelled' : 'failed', { reason: error instanceof ContractError || error instanceof ModelError ? error.code : 'CHAPTER_EXECUTION_FAILED' })
        const publisher = state.taskWorks(task).find(work => work.run_id === runId && work.role === 'lightweight')
        if (publisher && !['succeeded', 'failed', 'cancelled', 'invalidated'].includes(publisher.state)) state.revokeWork(publisher.work_id, { kind: 'failure', work_id: publisher.work_id })
        this.record(task, 'chapter.update.ended', { update_id: updateId, state: host.state.update(task, updateId)!.state, reason: host.state.update(task, updateId)!.reason })
      }
    } finally {
      if (!this.closed && this.db.open) { this.aggregateWorkerRun(task, runId); this.resumeContentRemainders(task) }
    }
  }
  private async publishChapterUpdate(task: string, updateId: string, attemptId: string, parent?: ExecutionScope): Promise<void> {
    const host = this.chapters(), chapters = host.state, state = new RunnerWorkState(this.db, this.epoch)
    const attempt = state.attempt(attemptId), qualified = state.qualify(attemptId, attempt.dispatch_state === 'not_dispatched' ? 'dispatch' : 'commit'), owner = this.workerOwner(qualified), runId = owner.run_id
    const scopeRevision = chapters.update(task, updateId)?.scope_revision
    const agent = this.agents.get(runId) ?? fail('RUNNER_OWNERSHIP_INVALID', 'Chapter publication lease is unavailable')
    const signal = agent.controller.signal
    const valid = () => {
      if (signal.aborted) fail('SOURCE_INVALID', 'Chapter update was cancelled')
      if (parent) this.qualifyWorker(parent.attempt_id)
      chapters.assertCurrent(task, updateId, scopeRevision); state.qualify(attemptId); this.qualify(task, runId)
    }
    if (qualified.attempt.dispatch_state === 'not_dispatched') state.updateAttempt({ ...qualified.attempt, state: 'dispatched', dispatch_state: 'dispatched', operation_id: id() })
    state.updateAttempt({ ...state.attempt(attemptId), state: 'running' })
    let previousOperation = chapters.update(task, updateId)?.publication_operation_id
    try {
      for (;;) {
        valid()
        const update = chapters.assertCurrent(task, updateId), proposal = chapters.proposal(task, update.proposal_id!)!
        const latest = chapters.manifest(task, update.view_id)!
        const view = this.one('SELECT v.* FROM views v JOIN surfaces s ON s.id=v.surface_id WHERE s.task_id=? AND v.id=?', task, update.view_id)
        if (view.revision !== latest.view_revision || view.bundle_resource_id !== latest.bundle_resource_id) fail('CHAPTER_BASELINE_CONFLICT', 'Published content changed outside the current chapter mapping')
        const candidate = loadBundleSource(this.db, this.root, task, { type: 'resource', resource: { kind: 'resource', id: proposal.bundle_resource_id } }, row => this.journal.assertResource(row)).bundle
        const dependencyManifests = proposal.dependencies.flatMap(dependency => { const manifest = chapters.manifest(task, dependency.view_id); return manifest ? [manifest] : [] })
        if (proposal.tree_operations) this.checkContentReads(task, proposal.source, proposal.read_refs)
        const assembled = proposal.tree_operations
          ? assembleContentUpdate({ bundle: this.bundle(latest.bundle_resource_id), manifest: latest }, update, proposal.tree_operations)
          : assembleChapterUpdate({ latest: { bundle: this.bundle(latest.bundle_resource_id), manifest: latest }, baseline: update.base_manifest, candidate, replacements: proposal.replacements, dependencies: proposal.dependencies, dependency_manifests: dependencyManifests })
        if (assembled.invalid_kept_region_ids.length) fail('CHAPTER_DEPENDENCY_CONFLICT', 'Dependent chapters require an explicit wider update scope')
        validateProducerBundle(assembled.bundle); this.checkedBundle(task, assembled.bundle, attemptId)
        const resourceAction = id(), resourceInput = { type: 'resource.create' as const, display_name: 'Chapter assembly', content: { type: 'json' as const, value: JSON.parse(json(assembled.bundle)) } }
        this.db.prepare("INSERT INTO actions(id,task_id,run_id,kind,state,source_json,request_json,commit_valid,created_at) VALUES (?,?,?,'mutation','registered',?,?,1,?)").run(resourceAction, task, runId, json({ type: 'host_chapter', owner }), json(resourceInput), now())
        const resourceContext: ExecutionActionContext = { id: resourceAction, owner, signal, valid, authorize: request => { if (json(request) !== json({ type: 'write', input: resourceInput })) fail('WORKER_CAPABILITY_DENIED', 'Only the exact assembled resource is authorized') } }
        const created = this.resourceCreate(task, runId, resourceInput, resourceContext) as { data: { id: string } }
        const surface = this.one('SELECT * FROM surfaces WHERE task_id=?', task), operationId = id(), actionId = id()
        const request: SurfaceWrite = { type: 'write', input: { type: 'surface.update', surface_id: surface.id, expected_revision: surface.revision, operations: [{ type: 'view.replace', view_id: view.id, expected_view_revision: view.revision, bundle: { type: 'resource', resource: { kind: 'resource', id: created.data.id } }, state_transition: { type: 'preserve', expected_state_revision: view.state_revision, compatibility_version: assembled.bundle.state.compatibility_version } }] } }
        const approvalOperations = [...new Set((proposal.tree_operations ?? []).flatMap(op => op.type === 'delete' ? ['content.delete' as const] : op.type === 'move' ? ['content.move' as const] : []))]
        const operation: ChapterPublication = { task_id: task, operation_id: operationId, update_id: updateId, proposal_id: proposal.proposal_id, ...(proposal.scope_revision !== undefined ? { scope_revision: proposal.scope_revision } : {}), base_manifest_revision: latest.manifest_revision, assembled_bundle_resource_id: created.data.id, view_id: view.id, expected_view_revision: view.revision, expected_state_revision: view.state_revision, request, source_bundle_resource_ids: [latest.bundle_resource_id, proposal.bundle_resource_id], ...(previousOperation ? { previous_operation_id: previousOperation } : {}), action_id: actionId, state: 'registered' }
        this.db.transaction(() => {
          valid(); chapters.registerPublication(operation)
          this.db.prepare("INSERT INTO actions(id,task_id,run_id,kind,state,source_json,request_json,commit_valid,created_at) VALUES (?,?,?,'mutation','registered',?,?,1,?)").run(actionId, task, runId, json({ type: 'host_chapter', owner, update_id: updateId, operation_id: operationId, ...(approvalOperations.length ? { approval_operations: approvalOperations } : {}) }), json(request.input), now())
          chapters.publicationStage(task, operationId, 'prepared')
          chapters.stage(task, updateId, 'publishing', { action_id: actionId })
          this.record(task, 'chapter.publication.prepared', { update_id: updateId, scope_revision: proposal.scope_revision, proposal_id: proposal.proposal_id, operation_id: operationId, action_id: actionId, previous_operation_id: previousOperation, ...(parent ? { parent } : {}) })
        })()
        const context: ExecutionActionContext = { id: actionId, owner, signal, valid, hostPublication: true, authorize: raw => { if (json(raw) !== json(request)) fail('WORKER_CAPABILITY_DENIED', 'Chapter publisher can execute only its exact compiled action') } }
        let installedResource: string | undefined
        const hooks: CompositionPublicationHooks = {
          approvalOperations,
          check: () => { valid(); if (proposal.tree_operations) this.checkContentReads(task, proposal.source, proposal.read_refs); if (chapters.manifest(task, view.id)?.manifest_revision !== latest.manifest_revision) fail('VERSION_CONFLICT', 'Chapter publication requires reassembly on the latest content') },
          prepared: prepared => { installedResource = prepared.find(item => item.viewId === view.id)?.resourceId },
          committed: (recordId, surfaceRevision) => {
            if (!installedResource) fail('CHAPTER_CONFLICT', 'Chapter publication has no installed resource')
            const artifact = latest.artifact_id ? this.db.prepare('SELECT candidate_id FROM runner_artifacts WHERE task_id=? AND artifact_id=? AND artifact_revision=?').get(task, latest.artifact_id, latest.artifact_revision) as Row | undefined : undefined
            const requirements = latest.artifact_id ? (artifact && this.runnerArtifacts().candidate(task, artifact.candidate_id)?.candidate.requirement_ids) ?? fail('RUNNER_OWNERSHIP_INVALID', 'Chapter inheritance requires its original accepted coverage') : state.goal(update.request_id).requirements.map(requirement => requirement.requirement_id)
            state.updateAttempt({ ...state.attempt(attemptId), state: 'succeeded', result_ref: { task_id: task, kind: 'record', id: recordId } })
            const manifest: ChapterManifest = { ...latest, chapters: assembled.chapters, ...('tree' in assembled ? { content_tree: assembled.tree } : {}), view_revision: view.revision + 1, state_revision: view.state_revision + 1, bundle_resource_id: installedResource!, manifest_revision: latest.manifest_revision + 1, ...(latest.artifact_revision ? { artifact_revision: latest.artifact_revision + 1 } : {}) }
            chapters.installManifest(manifest, latest.manifest_revision)
            for (const keep of assembled.kept) if (proposal.tree_operations || !update.region_ids.includes(keep.region_id)) chapters.keep({ task_id: task, update_id: updateId, view_id: view.id, region_id: keep.region_id, region_revision: keep.revision, source_bundle_resource_id: latest.bundle_resource_id, source_manifest_revision: latest.manifest_revision, request_id: latest.request_id, intent_revision: latest.intent_revision, ...(latest.artifact_id ? { artifact_id: latest.artifact_id, artifact_revision: latest.artifact_revision } : {}), requirement_ids: requirements, dependencies: keep.dependencies, valid: true })
            const result = { operation_id: operationId, action_id: actionId, state: 'published', view_id: view.id, view_revision: manifest.view_revision, state_revision: manifest.state_revision, manifest_revision: manifest.manifest_revision, surface_record_id: recordId, surface_revision: surfaceRevision }
            chapters.publicationStage(task, operationId, 'published', result)
            const succeeded = chapters.stage(task, updateId, 'succeeded')
            if (latest.artifact_id) this.runnerArtifacts().installChapterAssembly({ update: succeeded, latestManifest: latest, proposal, publisherOwner: owner, published: { operation_id: operationId, action_id: actionId, bundle_resource_id: installedResource!, view_id: view.id, view_revision: manifest.view_revision, state_revision: manifest.state_revision, surface_record_id: recordId, surface_revision: surfaceRevision }, requirement_ids: requirements })
            this.recordRunnerAnswer(task, { owner, purpose: 'final_answer', text: '更新已完成。', request_id: update.request_id, input_event_id: update.input_event_id, run_id: runId, intent_revision: update.intent_revision, update_id: updateId, operation_id: operationId })
            this.record(task, 'chapter.update.ended', { update_id: updateId, scope_revision: proposal.scope_revision, state: 'succeeded', operation_id: operationId })
            return result
          }
        }
        try {
          chapters.publicationStage(task, operationId, 'dispatched')
          await this.replaceSurface(task, runId, request, signal, context, hooks)
          if (chapters.publication(task, operationId)?.operation.state !== 'published') fail('CHAPTER_CONFLICT', 'Query the original chapter publication result')
          this.refreshRunnerScope(task)
          return
        } catch (error) {
          if (chapters.publication(task, operationId)?.operation.state === 'published') return
          const code = error instanceof ContractError ? error.code : 'CHAPTER_PUBLICATION_FAILED'
          const action = this.db.prepare('SELECT state,result FROM actions WHERE id=? AND task_id=?').get(actionId, task) as Row | undefined
          const denied = !!this.db.prepare("SELECT 1 FROM approvals WHERE action_id=? AND decision='deny'").get(actionId)
          const unknown = !action || action.state !== 'ended' || !['failure', 'not_executed'].includes(action.result)
          chapters.publicationStage(task, operationId, unknown ? 'unknown' : signal.aborted ? 'failure' : 'failure', { code, ...(denied ? { denied: true } : {}) })
          if (unknown) { chapters.stage(task, updateId, 'unknown', { reason: code }); state.updateAttempt({ ...state.attempt(attemptId), state: 'unknown', dispatch_state: 'unknown' }); return }
          if (!denied && code === 'VERSION_CONFLICT' && !signal.aborted) {
            chapters.assertCurrent(task, updateId)
            previousOperation = operationId
            continue
          }
          throw error
        }
      }
    } catch (error) {
      const attempt = state.attempt(attemptId)
      // The producer receives a known ineffective failure in its current tool
      // call. Keep this host child live while that producer may correct it.
      const update = chapters.update(task, updateId), publication = update?.publication_operation_id ? chapters.publication(task, update.publication_operation_id) : null
      const correctable = parent && !signal.aborted && error instanceof ContractError && isCorrectableContentError(error.code) && (!publication || publication.operation.state === 'failure') && !(publication?.result as Row | null)?.denied
      if (!correctable && !['succeeded', 'failed', 'cancelled', 'revoked', 'unknown'].includes(attempt.state)) state.updateAttempt({ ...attempt, state: signal.aborted ? 'cancelled' : 'failed' })
      throw error
    }
  }
  private runnerComposition(): RunnerCompositionState { return this.runnerCompositionState ??= new RunnerCompositionState(this.db, new RunnerWorkState(this.db, this.epoch), this.runnerArtifacts()) }
  private runnerHostComposition(): RunnerHostComposition { return new RunnerHostComposition(this.db, new RunnerWorkState(this.db, this.epoch), this.runnerArtifacts(), this.runnerComposition()) }
  prepareRunnerComposition(taskId: string, triggerRequestId: string, options: PrepareRunnerCompositionOptions = {}): PreparedRunnerComposition {
    this.acceptWork(); this.recovery.assertWrite(); this.task(taskId)
    const request = this.one('SELECT config_selection_json FROM requests WHERE task_id=? AND id=?', taskId, triggerRequestId), selection = JSON.parse(request.config_selection_json)
    const main = this.models.acquire(selection.id, 'main')
    let approval: ModelLease | undefined, prepared: PreparedRunnerComposition | undefined
    try {
      if (main.revision !== selection.revision) fail('MODEL_CONFIGURATION_CHANGED', 'Composition trigger configuration changed')
      if (selection.approval_mode === 'assisted') {
        if (!selection.approval_id) fail('MODEL_CONFIGURATION_CHANGED', 'Composition requires the original approval configuration')
        approval = this.models.acquire(selection.approval_id, 'approval')
        if (approval.revision !== selection.approval_revision) fail('MODEL_CONFIGURATION_CHANGED', 'Composition approval configuration changed')
      }
      this.refreshRunnerScope(taskId)
      prepared = this.runnerHostComposition().prepare(taskId, triggerRequestId, main, options)
      const controller = new AbortController(), budget = new RunBudget(main.config)
      this.agents.set(prepared.run_id, { controller, main, ...(approval ? { approval } : {}), budget, mode: selection.approval_mode === 'assisted' ? 'assisted' : 'manual', managed: true })
      this.record(taskId, 'runner.composition.prepared', { run_id: prepared.run_id, batch_id: prepared.batch.batch_id, composition_version: prepared.batch.composition_version, trigger_request_id: triggerRequestId, operation_id: prepared.batch.operation_id })
      return prepared
    } catch (error) {
      if (!prepared) { main.release(); approval?.release() }
      if (!(error instanceof ContractError && error.code === 'COMPOSITION_NOT_READY')) this.record(taskId, 'runner.composition.blocked', { trigger_request_id: triggerRequestId, code: error instanceof ContractError ? error.code : 'COMPOSITION_PREPARATION_FAILED' })
      throw error
    }
  }
  runnerPublicationOperation(taskId: string, operationId: string): PublicationOperation | null {
    this.task(taskId)
    return this.runnerHostComposition().operation(taskId, operationId)
  }
  publishRunnerComposition(taskId: string, batchId: string, plan: PresentationPlan, options: PublishRunnerCompositionOptions = {}): Promise<PublicationResult> {
    const host = this.runnerHostComposition(), batch = this.runnerComposition().batch(taskId, batchId)
    if (!batch?.operation_id) return Promise.reject(new ContractError('RUNNER_NOT_FOUND', 'Composition publication is unavailable'))
    if (!batch.indexes.length) return Promise.reject(new ContractError('COMPOSITION_NOT_READY', 'A feedback-only batch has no fragments to publish'))
    const original = host.operation(taskId, batch.operation_id)
    if (original?.result) return Promise.resolve(original.result)
    const pending = this.compositionPublications.get(batch.operation_id)
    if (pending) return pending
    const epoch = this.epoch, state = new RunnerWorkState(this.db, epoch), owner = host.publisher(taskId, batchId), attempt = state.attempt(owner.attempt_id)
    if (!['registered', 'queued'].includes(attempt.state)) return Promise.reject(new ContractError('RUNNER_PUBLICATION_CONFLICT', 'Query the original publication before another dispatch'))
    state.updateAttempt({ ...attempt, state: 'queued' })
    const promise = new Promise<PublicationResult>((resolve, reject) => {
      const failedBeforeDispatch = (error: unknown) => {
        if (this.closed || !this.db.open || this.epoch !== epoch) { reject(error); return }
        try {
          let code = error instanceof ContractError ? error.code : 'COMPOSITION_ADMISSION_FAILED'
          try { this.runnerComposition().checkBatch(taskId, batchId) } catch (cause) { if (cause instanceof ContractError) code = cause.code }
          const cancelled = !!options.signal?.aborted || !!this.agents.get(batch.run_id)?.controller.signal.aborted || this.task(taskId).state !== 'active'
          const result = host.recordFailure(taskId, batchId, plan, code, cancelled)
          host.setBatchState(taskId, batchId, cancelled ? 'cancelled' : 'failed')
          this.record(taskId, 'runner.composition.blocked', { run_id: batch.run_id, batch_id: batchId, operation_id: batch.operation_id, code, state: result.state })
          this.finish(taskId, batch.run_id, cancelled ? 'cancelled' : 'failed', code)
          resolve(result)
        } catch (failure) { reject(failure) }
      }
      this.pendingWorkers.set(owner.attempt_id, { task: taskId, work: admissionWork(state.work(owner.work_id)), reject: failedBeforeDispatch, start: () => {
        void this.executeRunnerCompositionPublication(taskId, batchId, plan, options).then(resolve, reject).finally(() => this.pumpRunnerWorkers(taskId))
      } })
    })
    this.compositionPublications.set(batch.operation_id, promise)
    void promise.finally(() => this.compositionPublications.delete(batch.operation_id!)).catch(() => {})
    this.pumpRunnerWorkers(taskId)
    return promise
  }
  private async executeRunnerCompositionPublication(taskId: string, batchId: string, plan: PresentationPlan, options: PublishRunnerCompositionOptions): Promise<PublicationResult> {
    const state = new RunnerWorkState(this.db, this.epoch), host = this.runnerHostComposition(), batch = this.runnerComposition().batch(taskId, batchId)!
    const owner = host.publisher(taskId, batchId), agent = this.agents.get(batch.run_id)
    if (!agent?.managed) fail('RUNNER_OWNERSHIP_INVALID', 'Composition configuration lease is unavailable')
    const signal = options.signal ? AbortSignal.any([agent!.controller.signal, options.signal]) : agent!.controller.signal
    const valid = () => {
      if (signal.aborted) fail('SOURCE_INVALID', 'Composition publication was cancelled')
      const qualified = state.qualify(owner.attempt_id)
      this.qualify(taskId, batch.run_id)
      if (qualified.work.work_id !== owner.work_id || qualified.run.purpose !== 'composition' || qualified.run.batch_id !== batchId) fail('RUNNER_OWNERSHIP_INVALID', 'Composition publisher ownership changed')
      this.runnerComposition().checkBatch(taskId, batchId)
    }
    const accounting = new RunnerBudgetAccounting(new RunnerBudgetLedger(this.db), { task_id: taskId, budget_id: state.run(batch.run_id).budget_id, attempt_id: owner.attempt_id })
    let dispatched = false
    try {
      valid()
      host.checkInputs(taskId, batch.trigger_request_id, batch.indexes.map(index => this.runnerArtifacts().artifact(taskId, index.artifact_id, index.artifact_revision)!), agent!.main)
      const collatorWork = state.taskWorks(taskId).find(work => work.run_id === batch.run_id && work.current_attempt_id && state.attempt(work.current_attempt_id).profile_id === 'collator-indexed-v1')!
      const collatorAttempt = state.attempt(collatorWork.current_attempt_id!)
      if (['registered', 'queued'].includes(collatorAttempt.state)) {
        state.updateAttempt({ ...collatorAttempt, state: 'dispatched', dispatch_state: 'dispatched', operation_id: id() })
        const recordId = this.record(taskId, 'runner.composition.rule_plan', { run_id: batch.run_id, batch_id: batchId, plan })
        state.updateAttempt({ ...state.attempt(collatorAttempt.attempt_id), state: 'succeeded', result_ref: { task_id: taskId, kind: 'record', id: recordId } })
      } else if (collatorAttempt.state !== 'succeeded') fail('RUNNER_OWNERSHIP_INVALID', 'Composition requires its finished exact Collator plan')
      accounting.tool(batch.operation_id!, 'reserved')
      state.updateAttempt({ ...state.attempt(owner.attempt_id), state: 'dispatched', dispatch_state: 'dispatched', operation_id: batch.operation_id })
      state.updateAttempt({ ...state.attempt(owner.attempt_id), state: 'running' })
      accounting.tool(batch.operation_id!, 'dispatched'); dispatched = true
      const publication = host.publication(taskId, batchId, plan, this.features, resource => {
        const loaded = loadBundleSource(this.db, this.root, taskId, { type: 'resource', resource: { kind: 'resource', id: resource } }, source => this.journal.assertResource(source))
        return { bundle: loaded.bundle, byte_length: loaded.source!.byte_length }
      }, options)
      const context: ExecutionActionContext = { id: publication.action_id, owner, signal, hostPublication: true, valid, authorize: request => { if (json(request) !== json(publication.request)) fail('WORKER_CAPABILITY_DENIED', 'Composition publisher can execute only its exact compiled action') } }
      host.setBatchState(taskId, batchId, 'publishing')
      await this.replaceSurface(taskId, batch.run_id, publication.request, signal, context, publication.hooks)
      const result = host.operation(taskId, publication.operation_id)?.result
      if (!result || result.state !== 'published') fail('RUNNER_PUBLICATION_CONFLICT', 'Publication must be queried by its original operation identity')
      this.db.transaction(() => this.publishCompositionAnswers(state, taskId)).immediate()
      accounting.tool(batch.operation_id!, 'completed')
      const recordId = this.record(taskId, 'runner.composition.ended', { run_id: batch.run_id, batch_id: batchId, operation_id: batch.operation_id, result })
      state.updateAttempt({ ...state.attempt(owner.attempt_id), state: 'succeeded', result_ref: { task_id: taskId, kind: 'record', id: recordId } })
      return result!
    } catch (error) {
      const original = host.operation(taskId, batch.operation_id!)
      if (original?.result?.state === 'published') {
        accounting.tool(batch.operation_id!, 'completed')
        const attempt = state.attempt(owner.attempt_id)
        if (!['succeeded', 'failed', 'cancelled', 'revoked'].includes(attempt.state)) state.updateAttempt({ ...attempt, state: 'succeeded' })
        return original.result
      }
      const code = error instanceof ContractError ? error.code : 'COMPOSITION_PUBLICATION_FAILED'
      const action = this.db.prepare('SELECT state,result FROM actions WHERE id=? AND task_id=?').get(batch.action_id, taskId) as Row | undefined
      const unknown = !!original && (!action || action.state !== 'ended' || !['not_executed', 'failure'].includes(action.result))
      if (dispatched) accounting.tool(batch.operation_id!, unknown ? 'unknown' : 'failed')
      let result: PublicationResult
      if (original) result = host.publications.recordOutcome(taskId, batch.operation_id!, { state: unknown ? 'unknown' : signal.aborted ? 'cancelled' : 'failure', code })
      else {
        try { result = host.recordFailure(taskId, batchId, plan, code, signal.aborted) }
        catch { result = { operation_id: batch.operation_id!, state: signal.aborted ? 'cancelled' : 'failure', code } }
      }
      host.setBatchState(taskId, batchId, result.state === 'unknown' ? 'unknown' : result.state === 'cancelled' ? 'cancelled' : 'failed')
      this.record(taskId, 'runner.composition.blocked', { run_id: batch.run_id, batch_id: batchId, operation_id: batch.operation_id, code, state: result.state })
      const attempt = state.attempt(owner.attempt_id)
      if (!['succeeded', 'failed', 'cancelled', 'revoked'].includes(attempt.state)) {
        if (dispatched) state.updateAttempt({ ...attempt, state: unknown ? 'unknown' : signal.aborted ? 'cancelled' : 'failed', dispatch_state: unknown ? 'unknown' : attempt.dispatch_state })
        else state.revokeWork(owner.work_id)
      }
      return result
    } finally {
      if (!this.closed) this.aggregateWorkerRun(taskId, batch.run_id)
    }
  }
  private async assessRunnerComposition(taskId: string, runId: string, approvalId: string, input: unknown, context: ExecutionActionContext, signal: AbortSignal): Promise<void> {
    const agent = this.agents.get(runId), owner = context.owner!
    if (!agent?.approval) return
    const budget = agent.budget.forAttempt()
    const run = new RunnerWorkState(this.db, this.epoch).run(runId)
    if (run.purpose !== 'composition' && !run.update_id) fail('RUNNER_OWNERSHIP_INVALID', 'Host publication requires its exact publisher Run')
    const accounting = new RunnerBudgetAccounting(new RunnerBudgetLedger(this.db), { task_id: taskId, budget_id: run.budget_id, attempt_id: owner.attempt_id })
    const lease: ModelLease = { ...agent.approval, owner, release() {} }
    lease.evidence = event => { context.valid(); return this.record(taskId, 'model.request.evidence', { ...event, run_id: runId }) }
    lease.accounting = event => {
      if (['reserved', 'dispatched'].includes(event.phase)) context.valid()
      accounting.model(event)
      this.record(taskId, 'model.request.accounting', { ...event, run_id: runId, owner })
    }
    try {
      context.valid()
      const request = this.one('SELECT input_json FROM requests WHERE id=? AND task_id=?', run.purpose === 'composition' ? run.trigger_request_id : run.request_id, taskId)
      const chapter = run.purpose === 'production' && run.update_id ? this.chapters().state.update(taskId, run.update_id) : null
      const messages: ChatMessage[] = [{ role: 'system', content: approvalTemplate }, { role: 'user', content: json({ source: owner, action: input, permission: 'Only this exact compiled Surface action. Input discard requires separate explicit human confirmation.', user_request: chapter?.text ?? request.input_json }) }]
      const reservation = budget.reserve(messages, undefined, lease.config, 'approval-input')
      const response = await this.models.request(lease, taskId, messages, undefined, signal, undefined, lease.config.max_output_tokens, undefined, 'approval')
      context.valid(); budget.settle(reservation, response)
      const evaluation: unknown = JSON.parse(response.text)
      assertContract<{ decision: 'approve' | 'deny' | 'escalate'; reason: string }>('approval_decision', evaluation)
      const approval = this.one('SELECT validity,decision FROM approvals WHERE id=?', approvalId)
      if (approval.validity !== 'valid' || approval.decision !== 'pending') return
      this.db.prepare('UPDATE approvals SET evaluation_json=? WHERE id=?').run(json({ ...evaluation, model_id: lease.id, model_revision: lease.revision, template: 'approval-v0.1' }), approvalId)
      if (evaluation.decision === 'escalate') this.db.prepare("UPDATE approvals SET handling='awaiting_human' WHERE id=?").run(approvalId)
      else this.decide(taskId, approvalId, evaluation.decision, 'model', evaluation.reason)
    } catch (error) {
      if (!this.closed && !signal.aborted) this.db.prepare("UPDATE approvals SET handling='awaiting_human',evaluation_json=? WHERE id=? AND decision='pending' AND validity='valid'").run(json({ code: error instanceof ModelError || error instanceof ContractError ? error.code : 'INVALID_APPROVAL_RESPONSE', template: 'approval-v0.1' }), approvalId)
    } finally {
      if (!this.closed) this.db.prepare('UPDATE runs SET budget_json=? WHERE id=?').run(json(agent.budget.state), runId)
    }
  }
  private removePendingContent(task: string, request: string, origin: string, message: string): void {
    const db = this.db, scope = this.runnerComposition().scope(task)
    const target = scope?.targets.find(item => item.request_id === request)
    if (!target || !db.prepare(`SELECT 1 FROM runner_content_plans p JOIN runner_inputs i ON i.task_id=p.task_id AND i.input_event_id=p.input_event_id
      WHERE p.task_id=? AND p.request_id=? AND p.intent_revision=? AND i.record_id=?`).get(task, request, target.intent_revision, origin))
      return fail('CONTENT_REQUIREMENT_UNAVAILABLE', 'The referenced message has no current undelivered requirement')
    if (db.prepare(`SELECT 1 FROM runner_view_mappings m JOIN runner_artifacts a
      ON a.task_id=m.task_id AND a.artifact_id=m.artifact_id AND a.artifact_revision=m.artifact_revision
      WHERE m.task_id=? AND json_extract(a.payload_json,'$.request_id')=? LIMIT 1`).get(task, request))
      fail('CONTENT_ALREADY_PUBLISHED', 'Use a content edit to remove published content')
    const batches = db.prepare(`SELECT json_extract(b.payload_json,'$.run_id') AS id,p.state
      FROM runner_batches b JOIN json_each(b.payload_json,'$.targets') t
      JOIN runs r ON r.task_id=b.task_id AND r.id=json_extract(b.payload_json,'$.run_id')
      LEFT JOIN runner_publications p ON p.task_id=b.task_id AND p.batch_id=b.batch_id
      WHERE b.task_id=? AND json_extract(t.value,'$.request_id')=? AND (r.state IN ('running','waiting') OR p.state='unknown')`).all(task, request) as Row[]
    if (batches.some(batch => batch.state === 'unknown')) fail('CHAPTER_OUTCOME_UNKNOWN', 'Resolve the original publication before changing its requirement')
    const production = db.prepare(`SELECT n.run_id AS id FROM runner_runs n JOIN runs r ON r.task_id=n.task_id AND r.id=n.run_id
      WHERE n.task_id=? AND n.request_id=? AND n.purpose='production' AND r.state IN ('running','waiting')`).all(task, request) as Row[]
    db.prepare('INSERT INTO runner_content_removals(task_id,request_id,intent_revision,message_id) VALUES (?,?,?,?)').run(task, request, target.intent_revision, message)
    db.prepare(`UPDATE requests SET state='rejected',input_json=json_set(input_json,'$.code','CONTENT_REQUIREMENT_UNAVAILABLE')
      WHERE task_id=? AND state IN ('queued','confirmation_required') AND json_extract(input_json,'$.correction_pending')=1
        AND json_extract(input_json,'$.user_record_id')=?`).run(task, origin)
    const artifacts = this.runnerArtifacts(), outline = artifacts.outline(task)
    if (outline?.sections.some(section => section.request_id === request)) artifacts.installOutline({ ...outline,
      base_outline_revision: outline.outline_revision, outline_revision: outline.outline_revision + 1, sections: outline.sections.filter(section => section.request_id !== request) })
    this.refreshRunnerScope(task)
    const current = this.runnerComposition().scope(task)!
    this.record(task, 'content.requirement.removed', { message_id: message, source_message_id: origin, request_id: request, intent_revision: target.intent_revision, previous_version: scope!.composition_version, composition_version: current.composition_version })
    // Changing scope revokes only runs and batches which include this requirement.
    // Other contributions can still be published under the new scope.
    for (const row of [...production, ...batches]) this.finish(task, row.id, 'cancelled', 'content_requirement_removed')
    const trigger = current.targets.find(item => item.contribution_inventory)?.request_id
    if (trigger) queueMicrotask(() => { if (!this.closed && this.db === db) this.scheduleRunnerComposition(task, trigger) })
  }
  private pendingCorrectionTarget(task: string, request: string, message: string): ContentPlan {
    const work = new RunnerWorkState(this.db, this.epoch)
    const named = conversationContentPlan(this.db, task, message)
    if (!named) {
      const saved = this.one('SELECT state,input_json FROM requests WHERE task_id=? AND id=?', task, request), input = JSON.parse(saved.input_json)
      if (saved.state !== 'queued' || input.admission_route?.kind !== 'new' || input.user_record_id !== message) fail('CONTENT_REQUIREMENT_UNAVAILABLE', 'The original message does not identify an undelivered content request')
      const inspected = this.requests.handle({ type: 'request.status', task_id: task, request_id: request }).materials as Row[]
      if (inspected.some(item => item.state !== 'success')) fail('REQUEST_MATERIALS_INCOMPLETE', 'Resolve the original request materials before correction')
      delete input.admission_route
      this.db.prepare("UPDATE requests SET state='started',input_json=? WHERE task_id=? AND id=? AND state='queued'").run(json({ ...input, code: null, content_plan: true, bound_materials: inspected.map(item => this.requestMaterial(task, item.id)) }), task, request)
      const source = this.runner().receive({ input_event_id: `request:${request}`, task_id: task, request_id: request, record_id: message, kind: 'request', stage: 'received' })
      work.consume(source.input_event_id, 'routed', () => ({ route: 'direct', kind: 'request', request_id: request } as const))
      work.consume(source.input_event_id, 'installed', () => work.installContentPlan(source, initialDeliveryRequirements('new', input.admission_dispatch?.plan)))
      return work.goal(request)
    }
    const goal = work.goal(named.request_id)
    if (goal.task_id !== task || goal.state !== 'active' || named.intent_revision !== 1 && named.intent_revision !== goal.intent_revision) fail('CONTENT_REQUIREMENT_UNAVAILABLE', 'The correction target is no longer current')
    if (this.db.prepare(`SELECT 1 FROM runner_view_mappings m JOIN runner_artifacts a ON a.task_id=m.task_id AND a.artifact_id=m.artifact_id AND a.artifact_revision=m.artifact_revision
      WHERE m.task_id=? AND json_extract(a.payload_json,'$.request_id')=? LIMIT 1`).get(task, goal.request_id)) fail('CONTENT_ALREADY_PUBLISHED', 'Use a scoped edit to change published content')
    if (conversationPublicationRun(this.db, task, goal.request_id, goal.intent_revision)?.publication_state === 'unknown') fail('CHAPTER_OUTCOME_UNKNOWN', 'Resolve the original publication before changing its requirement')
    return goal
  }
  private refreshRunnerScope(task: string): void {
    const composition = this.runnerComposition(), previous = composition.scope(task)
    const goals = new RunnerWorkState(this.db, this.epoch).contentPlans(task).filter(goal => !this.features.runner?.conversationRouting || goal.requirements.some(requirement => requirement.kind !== 'answer'))
    const inventories = new Map(goals.map(goal => {
      let inventory = composition.inventory(task, goal.request_id, goal.intent_revision)
      if (inventory) {
        try { composition.checkInventory(task, goal.request_id, goal.intent_revision, inventory.inventory_revision) }
        catch (error) {
          if (!(error instanceof ContractError) || !['RUNNER_OUTPUT_INCOMPLETE', 'RUNNER_OWNERSHIP_INVALID', 'RUNNER_DEPENDENCY_INVALID'].includes(error.code)) throw error
          inventory = null
        }
      }
      return [goal.request_id, inventory] as const
    }))
    const targets = goals.map(goal => {
      const inventory = inventories.get(goal.request_id)
      return { request_id: goal.request_id, intent_revision: goal.intent_revision, required: goal.requirements.some(requirement => requirement.required), requirement_ids: goal.requirements.map(requirement => requirement.requirement_id), ...(inventory ? { contribution_inventory: { task_id: task, request_id: goal.request_id, intent_revision: goal.intent_revision, inventory_revision: inventory.inventory_revision } } : {}) }
    })
    const unresolved = goals.flatMap(goal => {
      const inventory = inventories.get(goal.request_id)
      return inventory ? unresolvedDeliveryRequirements(this.db, inventory) : goal.requirements.filter(requirement => requirement.required).map(requirement => ({ task_id: task, request_id: goal.request_id, intent_revision: goal.intent_revision, requirement_id: requirement.requirement_id }))
    })
    if (previous && json(previous.targets) === json(targets) && json(previous.unresolved) === json(unresolved) && (previous.state !== 'complete' || this.runnerHostComposition().completeness(task).state === 'complete')) return
    composition.installScope({ task_id: task, composition_version: (previous?.composition_version ?? 0) + 1, ...(previous ? { previous_version: previous.composition_version } : {}), state: 'working', targets, unresolved })
  }
  private runner(): TaskRunner {
    return this.taskRunner ??= new TaskRunner(new RunnerWorkState(this.db, this.epoch), {
      goal: (input, current) => {
        if (this.features.runner?.conversationRouting && !(input.kind === 'correction' && current && input.caused_by_event_id === current.input_event_id && this.db.prepare(`SELECT 1 FROM requests q JOIN records r ON r.task_id=q.task_id AND r.id=json_extract(q.input_json,'$.user_record_id')
          WHERE q.task_id=? AND q.state='queued' AND json_extract(q.input_json,'$.correction_pending')=1 AND r.kind='message.user' AND r.id=? AND q.id=json_extract(r.payload_json,'$.request_id')
          AND json_extract(q.input_json,'$.conversation_route')='correct_pending' AND json_extract(q.input_json,'$.corrects_request_id')=?`).get(input.task_id, input.record_id, current.request_id))) fail('UNSUPPORTED_OPERATION', 'Only a correction from an accepted conversation message can revise a content plan')
        if (input.kind !== 'request' && !current) fail('RUNNER_NOT_FOUND', 'The target goal does not exist')
        if (input.kind === 'request' && current) fail('RUNNER_INPUT_CONFLICT', 'A new goal cannot replace an existing goal')
        return {
          task_id: input.task_id, request_id: input.request_id!, input_event_id: input.input_event_id,
          intent_revision: (current?.intent_revision ?? 0) + 1,
          state: input.kind === 'withdraw_goal' ? 'withdrawn' : 'active',
          requirements: current?.requirements ?? [{ requirement_id: 'answer', kind: 'answer', required: true, provenance_required: false }],
          ...(current ? { previous_revision: current.intent_revision } : {})
        }
      },
      install: (input, route, goal) => this.installRunnerInput(input, route, goal),
      operationOwner: input => this.runnerOperationOwner(input),
      status: query => this.runnerStatusPage(query)
    })
  }
  receiveRunnerInput(input: InputEvent): InputEvent {
    this.acceptWork(); this.recovery.assertWrite(); this.task(input.task_id)
    return this.runner().receive(input)
  }
  advanceRunnerInput(inputId: string): TaskRunnerInstallation {
    this.acceptWork(); this.recovery.assertWrite()
    const receipt = this.runner().advance(inputId)
    if (receipt.state === 'installed') {
      const state = new RunnerWorkState(this.db, this.epoch)
      for (const work of state.taskWorks(receipt.task_id)) if (['cancelled', 'dependency_cancelled', 'invalidated', 'dependency_failed', 'failed'].includes(work.state)) {
        const attempts = state.attempts(work.work_id).map(attempt => attempt.attempt_id)
        this.revokeRunActions(work.run_id, attempts)
        for (const attemptId of attempts) {
          this.pluginCalls.cancelAttempt(attemptId); this.monty.cancelAttempt(attemptId)
          this.workers.get(attemptId)?.controller.abort()
        }
      }
      if (receipt.route.route === 'direct' && receipt.route.kind === 'cancel_run') this.finish(receipt.task_id, receipt.route.run_id, 'cancelled', 'user_cancelled')
      if (receipt.route.route === 'direct' && receipt.route.kind === 'stop_task') this.handle({ type: 'task.stop', task_id: receipt.task_id })
      for (const row of this.db.prepare("SELECT id FROM runs WHERE task_id=? AND state IN ('running','waiting')").all(receipt.task_id) as Row[]) this.aggregateWorkerRun(receipt.task_id, row.id)
      this.pumpRunnerWorkers(receipt.task_id)
      this.pumpRunnerGoals(receipt.task_id)
    }
    return receipt
  }
  runnerStatus(query: TaskRunnerStatusQuery): TaskRunnerStatusPage { this.task(query.task_id); return this.runner().status(query) }
  runnerGoals(query: TaskRunnerStatusQuery): RunnerProjection { this.task(query.task_id); return new RunnerHostStatus(this.db, this.epoch).page(query) }
  private runnerHostInput(raw: Row): TaskRunnerInstallation {
    if (this.features.runner?.conversationRouting && ['correction', 'withdraw_goal'].includes(raw.kind)) fail('INVALID_REQUEST', 'Send a new task message to change the requested content')
    const allowed = ['type', 'task_id', 'input_event_id', 'kind', 'text', 'request_id', 'run_id', 'work_id']
    if (Array.isArray(raw) || Object.keys(raw).some(key => !allowed.includes(key)) || !['query', 'explanation', 'correction', 'cancel_work', 'cancel_run', 'stop_task', 'withdraw_goal'].includes(raw.kind)) fail('INVALID_REQUEST', 'Invalid runner input')
    for (const key of ['task_id', 'input_event_id']) assertRunnerId(raw[key], key)
    for (const key of ['request_id', 'run_id', 'work_id']) if (raw[key] !== undefined) assertRunnerId(raw[key], key)
    if (raw.text !== undefined && (typeof raw.text !== 'string' || !raw.text.trim() || Buffer.byteLength(raw.text) > defaults.data.object_bytes) || raw.kind === 'correction' && raw.text === undefined) fail('INVALID_INPUT', 'Correction input requires nonempty bounded text')
    this.task(raw.task_id); this.recovery.assertWrite()
    const original = { task_id: raw.task_id, input_event_id: raw.input_event_id, kind: raw.kind, ...(raw.text !== undefined ? { text: raw.text } : {}), ...(raw.request_id !== undefined ? { request_id: raw.request_id } : {}), ...(raw.run_id !== undefined ? { run_id: raw.run_id } : {}), ...(raw.work_id !== undefined ? { work_id: raw.work_id } : {}) }
    this.db.transaction(() => {
      const existing = this.db.prepare('SELECT i.task_id,r.payload_json FROM runner_inputs i JOIN records r ON r.id=i.record_id AND r.task_id=i.task_id WHERE i.input_event_id=?').get(raw.input_event_id) as Row | undefined
      if (existing) {
        if (existing.task_id !== raw.task_id || json(JSON.parse(existing.payload_json).runner_input) !== json(original)) fail('RUNNER_INPUT_CONFLICT', 'Input event identity retains its original payload')
        return
      }
      const recordId = this.record(raw.task_id, 'runner.input.received', { runner_input: original, text: raw.text ?? '', purpose: 'control_input', ...(raw.kind === 'correction' ? { conversation: captureConversation(this.db, raw.task_id) } : {}) })
      this.receiveRunnerInput({ input_event_id: raw.input_event_id, task_id: raw.task_id, kind: raw.kind, record_id: recordId, stage: 'received', ...(raw.request_id !== undefined ? { request_id: raw.request_id } : {}), ...(raw.run_id !== undefined ? { run_id: raw.run_id } : {}), ...(raw.work_id !== undefined ? { work_id: raw.work_id } : {}) })
    })()
    return this.advanceRunnerInput(raw.input_event_id)
  }
  private installRunnerInput(input: InputEvent, route: TaskRunnerRoute, goal?: ContentPlan): TaskRunnerEffect {
    const state = new RunnerWorkState(this.db, this.epoch), task = input.task_id
    const refs: TaskRunnerEffect['refs'] = [{ task_id: task, kind: 'input', id: input.input_event_id }]
    if (route.route === 'clarification') return { refs, waits: [{ reason: route.reason }] }
    if (goal) refs.push({ task_id: task, kind: 'goal', id: goal.request_id, revision: goal.intent_revision })
    if (goal) {
      for (const row of this.db.prepare("SELECT run_id FROM runner_runs WHERE task_id=? AND request_id=? AND intent_revision!=?").all(task, goal.request_id, goal.intent_revision) as Row[]) {
        const run = state.run(row.run_id)
        if (['completed', 'failed', 'cancelled', 'interrupted'].includes(run.state)) continue
        state.closeRun(row.run_id)
        this.db.prepare("UPDATE runs SET intended_terminal='interrupted',primary_reason='goal_revision_changed' WHERE id=?").run(row.run_id)
      }
      state.reconcileDependencies(task)
      const current = this.runnerArtifacts().outline(task)
      if (goal.state === 'active') this.runnerArtifacts().installOutline(ruleRouterOutline(goal, current))
      else if (current?.sections.some(section => section.request_id === goal.request_id)) this.runnerArtifacts().installOutline({ ...current, base_outline_revision: current.outline_revision, outline_revision: current.outline_revision + 1, sections: current.sections.filter(section => section.request_id !== goal.request_id) })
      this.refreshRunnerScope(task)
    }
    if (route.kind === 'cancel_work') {
      const work = state.work(route.work_id)
      if (work.task_id !== task || work.run_id !== route.run_id) fail('RUNNER_OWNERSHIP_INVALID', 'Cancellation target belongs to another Task')
      state.revokeWork(work.work_id)
      refs.push({ task_id: task, kind: 'work', id: work.work_id })
    } else if (route.kind === 'cancel_run' || route.kind === 'stop_task') {
      const runs = route.kind === 'cancel_run' ? [state.run(route.run_id)] : (this.db.prepare("SELECT run_id FROM runner_runs WHERE task_id=?").all(task) as Row[]).map(row => state.run(row.run_id))
      if (route.kind === 'stop_task') this.db.prepare("UPDATE tasks SET state='stopping' WHERE id=? AND state='active'").run(task)
      for (const run of runs) {
        if (run.task_id !== task) fail('RUNNER_OWNERSHIP_INVALID', 'Cancellation target belongs to another Task')
        if (['completed', 'failed', 'cancelled', 'interrupted'].includes(run.state)) continue
        state.closeRun(run.run_id)
        const work = state.taskWorks(task).find(work => work.run_id === run.run_id)
        if (work) state.revokeRun(run.run_id, { kind: 'cancellation', work_id: work.work_id })
        this.db.prepare('UPDATE actions SET commit_valid=0 WHERE run_id=? OR json_extract(source_json,\'$.owner.run_id\')=?').run(run.run_id, run.run_id)
        this.db.prepare("UPDATE approvals SET validity='revoked' WHERE validity='valid' AND action_id IN (SELECT id FROM actions WHERE run_id=? OR json_extract(source_json,'$.owner.run_id')=?)").run(run.run_id, run.run_id)
        this.record(task, 'runner.cancelled', { run_id: run.run_id, scope: route.kind === 'stop_task' ? 'task' : 'run', input_event_id: input.input_event_id })
      }
    } else if (route.kind === 'query' || route.kind === 'explanation') {
      const page = this.runnerStatusPage({ task_id: task, ...(route.request_id ? { request_id: route.request_id } : {}), limit: 16 })
      const record = this.record(task, 'runner.status.reply', { input_event_id: input.input_event_id, purpose: 'query_reply', ...page })
      refs.push({ task_id: task, kind: 'record', id: record })
    } else if (route.kind === 'operation_completed' || route.kind === 'approval_decided') {
      refs.push({ task_id: task, kind: 'operation', id: route.operation_id }, { task_id: task, kind: 'work', id: route.owner.work_id })
      this.record(task, 'runner.operation.installed', { input_event_id: input.input_event_id, operation_id: route.operation_id, owner: route.owner })
    }
    this.record(task, 'runner.input.installed', { input_event_id: input.input_event_id, route, ...(goal ? { goal: { request_id: goal.request_id, intent_revision: goal.intent_revision, state: goal.state } } : {}) })
    return { refs, waits: [] }
  }
  private runnerOperationOwner(input: InputEvent): { operation_id: string; owner: ExecutionScope } | null {
    if (!input.operation_id) return null
    const call = this.db.prepare('SELECT limits_json FROM calls WHERE task_id=? AND id=?').get(input.task_id, input.operation_id) as Row | undefined
    const action = call ? undefined : this.db.prepare('SELECT source_json FROM actions WHERE task_id=? AND id=?').get(input.task_id, input.operation_id) as Row | undefined
    const attempt = !call && !action ? this.db.prepare("SELECT payload_json FROM runner_attempts WHERE task_id=? AND json_extract(payload_json,'$.operation_id')=?").get(input.task_id, input.operation_id) as Row | undefined : undefined
    let owner: ExecutionScope | undefined
    if (call || action) owner = captureExecutionScope(JSON.parse(call?.limits_json ?? action!.source_json).owner, input.task_id)
    else if (attempt) {
      const state = new RunnerWorkState(this.db, this.epoch), value = state.attempt(JSON.parse(attempt.payload_json).attempt_id), work = state.work(value.work_id), run = state.run(value.run_id)
      owner = this.workerOwner({ task_id: input.task_id, runtime_epoch: value.runtime_epoch, run, work, attempt: value })
    }
    return owner ? { operation_id: input.operation_id, owner } : null
  }
  private runnerStatusPage(query: TaskRunnerStatusQuery): TaskRunnerStatusPage {
    const { task_id: task, request_id: request } = query, limit = query.limit ?? 32
    let after = 0
    if (query.cursor) {
      let value: Row
      try { value = JSON.parse(Buffer.from(query.cursor, 'base64url').toString()) } catch { fail('INVALID_CURSOR', 'Runner status cursor is invalid') }
      if (value!.epoch !== this.epoch || value!.task !== task || value!.request !== (request ?? null) || !Number.isSafeInteger(value!.after) || value!.after < 0) fail('INVALID_CURSOR', 'Runner status cursor belongs to another query')
      after = value!.after
    }
    const rows = this.db.prepare("SELECT h.position position,h.request_id,h.intent_revision,h.payload_json FROM runner_current_content_plans h WHERE h.task_id=? AND (? IS NULL OR h.request_id=?) AND h.position>? ORDER BY h.position LIMIT ?").all(task, request ?? null, request ?? null, after, limit + 1) as Row[]
    const items = rows.slice(0, limit).map(row => {
      const goal = JSON.parse(row.payload_json) as ContentPlan
      const runs = this.db.prepare("SELECT run_id FROM runner_runs WHERE task_id=? AND request_id=? ORDER BY rowid DESC LIMIT 8").all(task, row.request_id) as Row[]
      const waits = (this.db.prepare("SELECT id,wait_reason FROM runs WHERE task_id=? AND request_id=? AND state='waiting' LIMIT 8").all(task, row.request_id) as Row[]).map(run => ({ reason: /^[A-Za-z0-9_.:-]{1,128}$/.test(run.wait_reason ?? '') ? run.wait_reason : 'work_waiting', ref: { task_id: task, kind: 'run' as const, id: run.id } }))
      return { ref: { task_id: task, kind: 'goal' as const, id: row.request_id, revision: row.intent_revision }, state: goal.state, refs: runs.map(run => ({ task_id: task, kind: 'run' as const, id: run.run_id })), waits }
    })
    return { task_id: task, items, next_cursor: rows.length > limit ? Buffer.from(json({ epoch: this.epoch, task, request: request ?? null, after: rows[limit - 1]!.position })).toString('base64url') : null }
  }
  async workerTool(attemptId: string, raw: unknown, signal: AbortSignal): Promise<unknown> {
    const { run, task_id: task } = this.qualifyWorker(attemptId), worker = this.workers.get(attemptId)!
    worker.profile.authorize(raw)
    const accounting = new RunnerBudgetAccounting(new RunnerBudgetLedger(this.db), { task_id: task, budget_id: run.budget_id, attempt_id: attemptId })
    const operation = id()
    accounting.tool(operation, 'reserved')
    try {
      this.qualifyWorker(attemptId); worker.profile.authorize(raw)
      accounting.tool(operation, 'dispatched')
      const request = validateModel(raw)
      this.record(task, 'worker.tool.started', { operation_id: operation, owner: worker.owner, run_id: run.run_id, plan_revision: new RunnerWorkState(this.db, this.epoch).work(worker.owner.work_id).plan_revision, request_type: request.type, ...(request.type === 'call' ? { capability: request.input.capability } : request.type === 'read' || request.type === 'list' ? { kind: request.input.kind } : {}) })
      const value = await this.dispatchWorkerTool(attemptId, raw, signal)
      const result = value as Row | null
      accounting.tool(operation, result?.execution === 'unknown' ? 'unknown' : 'completed')
      const recordId = this.record(task, 'worker.tool.ended', { operation_id: operation, ...(typeof result?.operation_id === 'string' ? { source_operation_id: result.operation_id } : {}), owner: worker.owner, run_id: run.run_id, state: result?.execution === 'unknown' ? 'unknown' : 'completed' })
      if (result?.execution === 'success' && result.delivery === 'delivered' && !worker.collator && !worker.diagnostic) {
        let provenance_ref: { task_id: string; kind: 'record' | 'resource' | 'action'; id: string } = { task_id: task, kind: 'record', id: recordId }
        if (request.type === 'read' && ['event', 'resource', 'action'].includes(request.input.target.kind)) {
          const target = request.input.target
          provenance_ref = { task_id: task, kind: target.kind === 'event' ? 'record' : target.kind as 'resource' | 'action', id: target.id }
        } else if (request.type === 'write' && request.input.type === 'resource.create') provenance_ref = { task_id: task, kind: 'resource', id: result.data.id }
        this.runnerArtifacts().checkProvenance(task, provenance_ref)
        return { ...result, provenance_ref }
      }
      return value
    } catch (error) {
      if (!this.closed && this.db.open) {
        const unknown = !!this.db.prepare("SELECT 1 FROM calls WHERE run_id=? AND json_extract(limits_json,'$.owner.attempt_id')=? AND (state!='ended' OR execution='unknown') LIMIT 1").get(run.run_id, attemptId)
        accounting.tool(operation, unknown ? 'unknown' : 'failed')
        this.record(task, 'worker.tool.ended', { operation_id: operation, owner: worker.owner, run_id: run.run_id, state: unknown ? 'unknown' : 'failed', code: error instanceof ContractError ? error.code : 'TOOL_EXECUTION_FAILED' })
      }
      throw error
    }
  }
  private async dispatchWorkerTool(attemptId: string, raw: unknown, signal: AbortSignal): Promise<unknown> {
    const qualified = this.qualifyWorker(attemptId), worker = this.workers.get(attemptId)!, { owner } = worker
    worker.profile.authorize(raw)
    const request = validateModel(raw)
    if (Buffer.byteLength(json(raw)) > defaults.transport.rpc_message_bytes) fail('INPUT_TOO_LARGE', 'Model request exceeds transport limit')
    assertReadDispatch(worker.state === 'waiting' ? worker.reason : null)
    const valid = () => {
      this.qualifyWorker(attemptId); worker.profile.authorize(request)
      if (signal.aborted || worker.controller.signal.aborted) fail('RUNNER_OWNERSHIP_INVALID', 'Worker execution cancelled')
    }
    valid()
    if (worker.collator) return worker.collator.read(request)
    let value: unknown
    if (request.type === 'list' || request.type === 'read') value = await this.query(owner.task_id, request, attemptId)
    else if (request.type === 'call') {
      if (request.input.capability === READ_BOUND_INPUT) {
        if (owner.purpose !== 'production' || owner.update_id || request.input.references.length) fail('WORKER_CAPABILITY_DENIED', 'Read only entries assigned to this Worker attempt')
        const data = await this.boundContentReader.read(this.db, qualified.work, attemptId, request.input.arguments, resource => this.bundle(resource), (read, source) => this.query(owner.task_id, read, source))
        valid()
        return { request_type: 'call', execution: 'success', delivery: 'delivered', data }
      }
      if (request.input.capability === READ_WORK_OUTPUT) {
        if (qualified.work.purpose !== 'production' || request.input.references.length) fail('WORKER_CAPABILITY_DENIED', 'Only exact assigned work outputs can be read')
        const args = request.input.arguments as Row | null
        if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['work_id', 'plan_revision', 'result_revision', 'output_key', 'offset'].includes(key))) fail('INVALID_RUNNER_CONTRACT', 'Use input_json with work_id, plan_revision, result_revision, output_key and optional offset. Pass the returned next_offset value as offset; omit next_offset and kind.')
        const output = this.boundAssignmentOutputs(new RunnerWorkState(this.db, this.epoch), qualified.work).find(output => output.kind === 'answer' && output.work_id === args.work_id && output.plan_revision === args.plan_revision && output.result_revision === args.result_revision && output.output_key === args.output_key)
        if (!output || output.kind !== 'answer') fail('WORKER_CAPABILITY_DENIED', 'Use the exact work_id, output_key and revisions from work_outputs')
        const { text } = this.one("SELECT json_extract(payload_json,'$.value.answer') AS text FROM records WHERE task_id=? AND id=?", owner.task_id, output.record_id) as { text: string }
        const offset = args.offset === undefined ? 0 : args.offset
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length || /[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(text.slice(Math.max(0, offset - 1), offset + 1))) fail('INVALID_RUNNER_CONTRACT', 'Use the exact next_offset returned for this answer, or omit offset to start')
        const { work_id, output_key, plan_revision, result_revision } = output
        const page = (chunk: string, nextOffset: number | null) => ({
          request_type: 'call', execution: 'success', delivery: 'delivered', truncated: nextOffset !== null,
          data: { text: chunk, next_offset: nextOffset, ...(nextOffset === null ? {} : { next_call: { name: 'call', arguments: { capability: READ_WORK_OUTPUT, input_json: json({ work_id, output_key, plan_revision, result_revision, offset: nextOffset }) } } }) }
        })
        const provenance_ref = { task_id: owner.task_id, kind: 'record', id: output.record_id }
        const deliveryBytes = (result: ReturnType<typeof page>) => Buffer.byteLength(json({ ...result, provenance_ref, notice: WORK_OUTPUT_REPEAT_NOTICE }))
        const remaining = text.slice(offset)
        const complete = page(remaining, null)
        if (deliveryBytes(complete) <= defaults.read.text_bytes) return complete
        const room = defaults.read.text_bytes - deliveryBytes(page('', text.length))
        let end = offset, bytes = 0
        for (const point of remaining) {
          const size = Buffer.byteLength(json(point)) - 2
          if (bytes + size > room) break
          end += point.length; bytes += size
        }
        return page(text.slice(offset, end), end)
      }
      if (orchestrationCapability(request.input.capability)) return this.db.transaction(() => {
        valid()
        return { execution: 'success', delivery: 'delivered', data: dispatchOrchestrationTool(request.input, owner, worker.orchestration) }
      }).immediate()
      if (request.input.capability === CONTENT_OPERATIONS) value = await this.submitContentOperations(owner.task_id, owner, request.input.arguments, signal, valid)
      else if (request.input.capability === MONTY_ID && this.monty.available) value = await this.monty.call(owner.task_id, owner.run_id, request.input.arguments, request.input.references, signal, { owner, valid, authorize: current => worker.profile.authorize(current) })
      else if (request.input.capability.startsWith('plugin:')) value = await this.invokePlugin(owner.task_id, owner.run_id, request.input, signal, worker)
      else value = this.modelTool(owner.task_id, owner.run_id, request)
      valid()
      return value
    } else {
      const actionId = id(), context: ExecutionActionContext = { id: actionId, signal, owner, authorize: current => worker.profile.authorize(current), valid }
      this.db.transaction(() => {
        valid()
        this.db.prepare("INSERT INTO actions (id,task_id,run_id,kind,state,source_json,request_json,commit_valid,created_at) VALUES (?,?,?,'mutation','registered',?,?,1,?)").run(actionId, owner.task_id, owner.run_id, json({ type: 'worker', owner, epoch: this.epoch }), json(request.input), now())
      })()
      if (request.input.type === 'resource.create') return this.resourceCreate(owner.task_id, owner.run_id, request.input, context)
      if (request.input.type === 'task_data.create' || request.input.type === 'task_data.replace' || request.input.type === 'task_data.remove') return this.dataWrite(owner.task_id, owner.run_id, request.input, signal, context)
      if (request.input.operations.some(operation => operation.type !== 'view.create')) value = await this.replaceSurface(owner.task_id, owner.run_id, request as SurfaceWrite, signal, context)
      else value = this.publish(owner.task_id, owner.run_id, request, context)
    }
    valid()
    return { request_type: request.type, execution: 'success', delivery: 'delivered', truncated: false, data: value }
  }
  private recordContextRejection(taskId: string, runId: string, error: ContextRejectedError, lease?: ModelLease): string {
    try {
      this.qualify(taskId, runId)
      if (!lease || lease.id !== error.diagnostic.model_id) throw new ModelError('CONTEXT_DIAGNOSTIC_UNAVAILABLE')
      const event = { version: 1, run_id: runId, model_revision: lease.revision, ...error.diagnostic }
      assertContract('context_rejected', event)
      this.db.transaction(() => this.record(taskId, 'model.context.rejected', event))()
      return error.code
    } catch { return 'CONTEXT_DIAGNOSTIC_UNAVAILABLE' }
  }
  private fixture(taskId: string, runId: string, text: string): void {
    try {
      const surface = this.snapshot(taskId).surface
      const bundle: Bundle = {
        profile: 'managed-v1', html: '<section id="reflection"><h2>思考与记录</h2><p id="prompt"></p><label for="response">你的想法</label><textarea id="response" rows="5" placeholder="在这里记录，保存后可明确提交"></textarea><button id="submit" type="button">提交答案</button></section>',
        css: 'section { display: grid; gap: 1rem; } h2 { font-size: 22px; } textarea { width: 100%; box-sizing: border-box; }',
        state: { schema: { type: 'object', properties: { response: { type: 'string', minLength: 1, maxLength: 10000 }, prompt: { type: 'string' } }, required: ['response'], additionalProperties: false }, initial: { response: '', prompt: text }, compatibility_version: 'fixture-reflection-v1' },
        forms: [{ id: 'reflection', fields: ['/response'] }], behaviors: [{ type: 'text', element_id: 'prompt', field: '/prompt' }, { type: 'input', element_id: 'response', field: '/response', control: 'textarea' }, { type: 'submit', element_id: 'submit', form_id: 'reflection' }],
        references: [], export: [{ id: 'reflection', category: 'unclassified', source: { type: 'element', element_id: 'reflection' } }]
      }
      // The fixture uses the model boundary rather than bypassing publication checks.
      this.modelTool(taskId, runId, { type: 'write', input: { type: 'surface.update', surface_id: surface.id, expected_revision: surface.revision, operations: [{ type: 'view.create', client_ref: 'reflection', slot_id: 'main', bundle: { type: 'inline', bundle } }] } })
      this.db.transaction(() => { this.qualify(taskId, runId); this.record(taskId, 'message.assistant', { text: '开发夹具已通过 write 发布界面；不是来自真实模型的教学反馈。', run_id: runId, model_config_id: 'fixture' }); this.finish(taskId, runId, 'completed', 'fixture_complete') })()
    } catch (error) {
      const run = this.db.prepare('SELECT state FROM runs WHERE id=?').get(runId) as Row | undefined
      if (run && ['running', 'waiting'].includes(run.state)) this.finish(taskId, runId, 'failed', error instanceof ContractError ? error.code : 'runtime_error')
    }
  }
  private async agent(taskId: string, runId: string, text: string): Promise<void> {
    const agent = this.agents.get(runId)!
    try {
      this.qualify(taskId, runId)
      if (agent.compactOnly) {
        await this.prepareContext(taskId, runId, [{ role: 'system', content: agentTemplate }])
      } else await runAgent(this.models, agent.main, taskId, [], {
        context: (messages, recovery) => this.prepareContext(taskId, runId, messages, recovery),
        valid: () => { this.qualify(taskId, runId) },
        state: (state, reason) => { this.qualify(taskId, runId); this.db.prepare('UPDATE runs SET state=?,wait_reason=? WHERE id=?').run(state, reason ?? null, runId) },
        budget: value => { this.qualify(taskId, runId); this.db.prepare('UPDATE runs SET budget_json=? WHERE id=?').run(json(value), runId) },
        record: (kind, payload) => {
          this.qualify(taskId, runId)
          const eventId = this.db.transaction(() => this.record(taskId, kind, { ...payload, run_id: runId, model_config_id: agent.main.id }))()
          if (payload.message) recordedMessage({ id: eventId, sequence: this.task(taskId).next_sequence - 1, kind, payload: { ...payload, run_id: runId } })
        },
        tool: (request, signal) => this.agentTool(taskId, runId, request, signal)
      }, agent.controller.signal, agent.budget)
      this.qualify(taskId, runId)
      if (agent.manualCompact && !agent.compactOnly) await this.prepareContext(taskId, runId, agent.messages ?? [{ role: 'system', content: agentTemplate }])
      this.finish(taskId, runId, 'completed', agent.compactOnly ? agent.compactUnchanged ?? 'context_organized' : 'model_stop')
    } catch (error) {
      if (!this.closed) {
        const run = this.db.prepare('SELECT state FROM runs WHERE id=?').get(runId) as Row | undefined
        if (run && ['running', 'waiting'].includes(run.state)) {
          let code = error instanceof ContractError || error instanceof ModelError ? error.code : 'MODEL_EXECUTION_FAILED'
          if (error instanceof ContextRejectedError) {
            code = this.recordContextRejection(taskId, runId, error, [agent.main, agent.compact, agent.approval].find(value => value?.id === error.diagnostic.model_id))
          }
          this.finish(taskId, runId, error instanceof ModelError && error.partial ? 'interrupted' : 'failed', code)
        }
      }
    } finally {
      agent.main.release(); agent.compact?.release(); agent.approval?.release(); this.agents.delete(runId)
      this.settlePluginCleanup()
      if (!this.closed && (this.db.prepare('SELECT state FROM tasks WHERE id=?').get(taskId) as Row | undefined)?.state === 'deleting') this.purge(taskId)
    }
  }
  private currentSummary(taskId: string): InstalledSummary | null {
    const row = this.db.prepare("SELECT payload_json FROM records WHERE task_id=? AND kind='context.summary.installed' ORDER BY sequence DESC LIMIT 1").get(taskId) as Row | undefined
    if (!row) return null
    const value = JSON.parse(row.payload_json) as InstalledSummary
    try { assertContract('installed_summary', value) } catch { fail('SUMMARY_STORED_INVALID', 'Stored summary structure or version is invalid; raw records are retained') }
    if (!value.text.trim()) fail('SUMMARY_STORED_INVALID', 'Stored summary text is empty; raw records are retained')
    const ids = [...(value.latest_user_id ? [value.latest_user_id] : []), ...value.retained_interactions.flat()]
    if (new Set(ids).size !== ids.length) fail('SUMMARY_STORED_INVALID', 'Stored summary contains repeated references')
    const retained = ids.map(id => this.summaryRecord(taskId, id, value.through_sequence))
    if (value.latest_user_id && retained[0]?.kind !== 'message.user') fail('SUMMARY_STORED_INVALID', 'Stored latest input is not a user record')
    try {
      for (const group of value.retained_interactions) {
        const records = group.map(id => retained.find(record => record.id === id)!)
        if (records.some((record, index) => index > 0 && record.sequence <= records[index - 1]!.sequence)) throw new Error()
        const messages = records.map(record => recordedMessage(record))
        if (records.some(record => !['model.response','model.tool_result'].includes(record.kind) && !(record.kind === 'message.assistant' && record.payload.model_config_id === 'fixture')) || messages.some(message => !message) || interactions(messages as ChatMessage[]).length !== 1 || messages[0]?.role !== 'assistant') throw new Error()
      }
      const rounds = value.retained_interactions.map(group => group.map(id => retained.find(record => record.id === id)!))
      if (rounds.length === 2 && rounds[1]![0]!.sequence <= rounds[0]!.at(-1)!.sequence) throw new Error()
      if (retained.some(record => record.sequence > value.through_sequence)) throw new Error()
    } catch { fail('SUMMARY_STORED_INVALID', 'Stored retained interaction is incomplete; raw records are retained') }
    return value
  }
  private contextRecords(taskId: string, after: number, currentRun: string, byteLimit: number, pageRecords = 512): { records: HistoryRecord[]; more: boolean } {
    const rows = this.db.prepare("SELECT id,sequence,kind,length(CAST(payload_json AS BLOB)) bytes,CASE WHEN length(CAST(payload_json AS BLOB))<=1048576 THEN payload_json END payload_json FROM records WHERE task_id=? AND sequence>? AND kind IN ('message.user','model.response','model.tool_result','message.assistant','answer.submitted') ORDER BY sequence LIMIT 4097").iterate(taskId, after) as Iterable<Row>
    const records: HistoryRecord[] = [], calls = new Set<string>(); let bytes = 0, boundary = 0
    for (const row of rows) {
      // Page only at complete request boundaries, including requests within the active Run.
      if (boundary && (records.length >= pageRecords || bytes + row.bytes > byteLimit)) break
      if (records.length >= 4096 || bytes + row.bytes > 8 * 1024 * 1024) break
      if (typeof row.payload_json !== 'string' || row.bytes > 1048576) fail('CONTEXT_RECORD_LIMIT', 'An original event exceeds the enabled context loader limit; read it with continuation')
      const payload = JSON.parse(row.payload_json), message = payload.message as ChatMessage | undefined
      records.push({ id: row.id, sequence: row.sequence, kind: row.kind, payload }); bytes += row.bytes
      for (const call of message?.tool_calls ?? []) calls.add(call.id)
      if (message?.role === 'tool') calls.delete(message.tool_call_id!)
      if (!calls.size && row.kind !== 'message.user') boundary = records.length
    }
    const hasMore = (through: number) => !!this.db.prepare("SELECT 1 FROM records WHERE task_id=? AND sequence>? AND kind IN ('message.user','model.response','model.tool_result','message.assistant','answer.submitted') LIMIT 1").get(taskId, through)
    if (records.length && hasMore(records.at(-1)!.sequence)) {
      if (!boundary) fail('CONTEXT_GROUP_LIMIT', 'A complete tool group exceeds the enabled loader limit; raw events are retained')
      records.length = boundary
    }
    return { records, more: hasMore(records.at(-1)?.sequence ?? after) }
  }
  private summaryRecord(taskId: string, id: string, through: number): HistoryRecord {
    const row = this.db.prepare('SELECT id,sequence,kind,CASE WHEN length(CAST(payload_json AS BLOB))<=1048576 THEN payload_json END payload_json FROM records WHERE task_id=? AND id=? AND sequence<=?').get(taskId, id, through) as Row | undefined
    if (!row || typeof row.payload_json !== 'string') fail('SUMMARY_STORED_INVALID', 'Retained original is unavailable or exceeds the loader limit; raw records are retained')
    return { id: row.id, sequence: row.sequence, kind: row.kind, payload: JSON.parse(row.payload_json) }
  }
  private loadContext(taskId: string, system: ChatMessage, old: InstalledSummary | null): ChatMessage[] {
    const page = this.contextRecords(taskId, old?.through_sequence ?? 0, '', 8 * 1024 * 1024, 4096)
    if (page.more) throw new ModelError('CONTEXT_RECORD_LIMIT')
    const ids = old ? [...(old.latest_user_id ? [old.latest_user_id] : []), ...old.retained_interactions.flat()] : []
    const retained = ids.map(id => this.summaryRecord(taskId, id, old!.through_sequence))
    const originals = [...retained, ...page.records]
    if (originals.length > 4096 || originals.reduce((bytes, record) => bytes + Buffer.byteLength(json(record.payload)), 0) > 8 * 1024 * 1024) throw new ModelError('CONTEXT_RECORD_LIMIT')
    const messages = restoreMessages(originals)
    interactions(messages)
    return [system, ...(old ? [summaryMessage(old)] : []), ...messages]
  }
  private async prepareContext(taskId: string, runId: string, live: ChatMessage[], recovery?: import('./model/agent').ContextRecovery): Promise<ChatMessage[]> {
    const agent = this.agents.get(runId)!
    this.qualify(taskId, runId)
    const old = this.currentSummary(taskId)
    // Load persisted context once. Every later boundary uses the agent's actual messages.
    const assembled = agent.messages ? live : this.loadContext(taskId, live[0]!, old)
    if (!agent.messages) {
      // Recover only a completed main request whose actual prefix is still intact.
      let index = -1
      for (let i = assembled.length - 1; i >= 0; i--) if (assembled[i]!.role === 'assistant' && messageEvidence(assembled[i]!)?.response_request && (messageEvidence(assembled[i]!)?.recorded_sequence ?? 0) > (old?.through_sequence ?? 0)) { index = i; break }
      if (index >= 0) {
        const link = messageEvidence(assembled[index]!)!.response_request!
        const row = this.db.prepare("SELECT payload_json FROM records WHERE task_id=? AND kind='model.request.accounting' AND json_extract(payload_json,'$.request_id')=? AND json_extract(payload_json,'$.phase')='completed' ORDER BY sequence DESC LIMIT 1").get(taskId, link.request_id) as Row | undefined
        if (row) {
          const event = JSON.parse(row.payload_json) as RequestAccounting
          if (event.purpose === 'main' && event.model_id === agent.main.id && event.model_revision === agent.main.revision && event.usage) agent.budget.observe(assembled.slice(0, index), modelTools, event.usage)
        }
      }
    }
    annotateReads(assembled)
    agent.messages = assembled
    if (!recovery && !agent.manualCompact && !agent.budget.plan(assembled, modelTools).needsCompaction) return assembled
    const fresh = this.db.prepare("SELECT 1 FROM records WHERE task_id=? AND sequence>? AND (kind IN ('message.user','model.response','model.tool_result') OR (kind='message.assistant' AND json_extract(payload_json,'$.model_config_id')='fixture')) LIMIT 1").get(taskId, old?.through_sequence ?? 0)
    if (!fresh && !recovery) {
      agent.manualCompact = false; agent.compactUnchanged = 'context_no_new_history'
      if (!agent.compactOnly && !agent.budget.fits(assembled, modelTools)) throw agent.budget.rejection(assembled, modelTools, 'protected-input', 'CONTEXT_MINIMUM_TOO_LARGE')
      return assembled
    }
    const snapshotSequence = this.task(taskId).next_sequence - 1
    const overflow = recovery ?? (!agent.budget.fits(assembled, modelTools) ? { overflow: true as const } : undefined)
    const updated = await compactContext(this.models, agent.compact ?? agent.main, taskId, agent.budget, agent.controller.signal, assembled, snapshotSequence, modelTools, {
      valid: () => { this.qualify(taskId, runId) },
      state: reason => { this.qualify(taskId, runId); this.db.prepare("UPDATE runs SET state='waiting',wait_reason=? WHERE id=?").run(reason, runId) },
      budget: () => { this.db.prepare('UPDATE runs SET budget_json=? WHERE id=?').run(json(agent.budget.state), runId) },
      install: value => this.db.transaction(() => {
        this.qualify(taskId, runId)
        if (this.db.prepare("SELECT 1 FROM records WHERE task_id=? AND sequence>? AND (kind LIKE 'message.%' OR kind='answer.submitted') LIMIT 1").get(taskId, snapshotSequence)) fail('SUMMARY_SNAPSHOT_CHANGED', 'New task input arrived during organization; previous summary retained')
        this.record(taskId, 'context.summary.installed', { ...value, run_id: runId })
      })()
    }, overflow)
    agent.manualCompact = false; agent.messages = updated
    this.db.prepare("UPDATE runs SET state='running',wait_reason=NULL WHERE id=?").run(runId)
    return updated
  }
  private manualCompaction(taskId: string, config: string): unknown {
    this.acceptWork()
    this.recovery.assertWrite(); this.task(taskId)
    if (this.task(taskId).state !== 'active') fail('TASK_STOPPED', 'Resume task first')
    const active = this.db.prepare("SELECT id FROM runs WHERE task_id=? AND state IN ('running','waiting')").get(taskId) as Row | undefined
    if (active) {
      const agent = this.agents.get(active.id)
      if (!agent || agent.controller.signal.aborted) fail('RUN_BUSY', 'Execution is ending or cannot organize context')
      agent.manualCompact = true; return { run_id: active.id, scheduled: true }
    }
    if (this.db.prepare("SELECT 1 FROM requests WHERE task_id=? AND state IN ('queued','confirmation_required') LIMIT 1").get(taskId)) fail('REQUEST_QUEUE_PENDING', 'Resolve queued requests first')
    const old = this.currentSummary(taskId)
    const fresh = this.db.prepare("SELECT 1 FROM records WHERE task_id=? AND sequence>? AND (kind IN ('message.user','model.response','model.tool_result') OR (kind='message.assistant' AND json_extract(payload_json,'$.model_config_id')='fixture')) LIMIT 1").get(taskId, old?.through_sequence ?? 0)
    if (!fresh) return { status: 'unchanged', reason: 'no_new_history', scheduled: false, model_requests: 0 }
    const main = this.models.acquire(config, 'main'); let compact: ModelLease | undefined
    const runId = id()
    try {
      compact = this.models.acquireCompaction(main)
      if (this.task(taskId).state !== 'active') fail('TASK_STOPPED', 'Resume task first')
      this.db.prepare("INSERT INTO runs (id,task_id,state,runtime_epoch,limits_json,budget_json,created_at) VALUES (?,?,'running',?,?,?,?)").run(runId, taskId, this.epoch, json({ ...defaults, run: main.config.limits ?? {}, output_policy: main.config.max_output_tokens === undefined ? 'service-default' : 'configured' }), json({}), now())
    } catch (error) { main.release(); compact?.release(); throw error }
    const controller = new AbortController(), budget = new RunBudget(main.config)
    this.accountLease(taskId, runId, main); if (compact) this.accountLease(taskId, runId, compact)
    this.agents.set(runId, { controller, main, compact, budget, mode: 'manual', compactOnly: true, manualCompact: true })
    void this.agent(taskId, runId, '')
    return { run_id: runId, scheduled: false }
  }
  private modelConfiguration(raw: unknown): unknown {
    assertContract<import('../shared/contracts.generated').HostModelRequest>('host_model_request', raw)
    switch (raw.type) {
      case 'model.configure': return this.models.configureConnection(raw)
      case 'model.channel.configure': return this.models.configureChannel(raw)
      case 'model.channel.model': return this.models.configureChannelModel(raw)
      case 'model.channel.remove': return this.models.removeChannel(raw.channel_id)
      case 'model.channel.discover': return this.models.discoverChannel(raw.channel_id, raw.operation_id)
      case 'model.list': return { models: this.models.list(), channels: this.models.channelList(), storage: this.models.storageStatus(), approval: { mode: this.approvalMode, model_id: this.approvalModel }, features: { view_replacement: this.features.viewReplacement } }
      case 'model.test': return raw.role ? this.models.test(raw.model_id, raw.role, raw.operation_id).then(result => {
        void this.recoverRunnerWork().catch(() => {})
        return result
      }) : this.models.testConnection(raw.model_id, raw.operation_id)
      case 'model.discover': return this.models.discover(raw.model_id, raw.operation_id, raw.include_metadata)
      case 'model.probe': return this.models.probe(raw)
      case 'model.cancel': return this.models.cancel(raw.operation_id)
      case 'model.remove': return this.models.removeConnection(raw.model_id).then(() => ({ removed: true }))
      case 'model.remember': return this.models.remember(raw.model_id).then(() => ({ remembered: true }))
      case 'model.credential.delete': return this.models.deleteCredential(raw.model_id).then(() => ({ deleted: true }))
      case 'approval.configure': {
        if (this.agents.size) fail('CONFIGURATION_BUSY', 'Approval policy is fixed for unfinished executions')
        if (raw.mode === 'assisted') {
          if (!raw.confirm_external_processing) fail('CONFIRMATION_REQUIRED', 'Explicitly confirm sending necessary approval data to this service')
          const lease = this.models.acquire(raw.model_id, 'approval'); lease.release()
        }
        this.approvalMode = raw.mode; this.approvalModel = raw.model_id
        return { mode: this.approvalMode, model_id: this.approvalModel }
      }
    }
  }
  private approvals(taskId: string): Snapshot['approvals'] {
    return boundedRecent((this.db.prepare("SELECT p.id,p.action_id,p.decision,p.validity,p.handling,p.mode,p.expires_at,CASE WHEN length(CAST(p.evaluation_json AS BLOB))<=4096 THEN p.evaluation_json ELSE NULL END evaluation_json,CASE WHEN length(CAST(CASE WHEN json_extract(p.binding_json,'$.version')=2 THEN json_extract(p.binding_json,'$.resolved') ELSE a.request_json END AS BLOB))<=4096 THEN CASE WHEN json_extract(p.binding_json,'$.version')=2 THEN json_extract(p.binding_json,'$.resolved') ELSE a.request_json END END request_json,json_extract(a.request_json,'$.type') request_type,substr(json_extract(a.request_json,'$.capability'),1,160) capability,substr(json_extract(a.request_json,'$.id'),1,160) target_id,COALESCE(json_extract(a.source_json,'$.approval_operations'),CASE WHEN json_extract(a.request_json,'$.type')='surface.update' THEN (SELECT json_group_array(DISTINCT json_extract(value,'$.type')) FROM json_each(a.request_json,'$.operations')) END) operation_types,a.run_id,a.result FROM approvals p JOIN actions a ON a.id=p.action_id WHERE a.task_id=? ORDER BY CASE WHEN p.decision='pending' AND p.validity='valid' THEN 0 ELSE 1 END,a.rowid DESC LIMIT 100").all(taskId) as Row[]).map(p => ({ id: p.id, action_id: p.action_id, run_id: p.run_id, ...(p.run_id && p.decision === 'pending' && p.validity === 'valid' ? { message_ids: approvalMessages(this.db, taskId, p.run_id) } : {}), decision: p.decision, validity: p.validity, handling: p.handling, mode: p.mode, expires_at: p.expires_at, summary: { type: p.request_type, ...(p.capability || p.target_id ? { target: p.capability || p.target_id } : {}), ...(p.operation_types ? { operations: JSON.parse(p.operation_types) } : {}) }, request: p.request_json ? JSON.parse(p.request_json) : { type: 'long_request', source: { kind: 'action', id: p.action_id } }, ...(p.request_json ? {} : { request_truncated: true }), evaluation: p.evaluation_json ? snapshotValue(p.evaluation_json, { kind: 'approval', id: p.id }) : null, result: p.result })), 96 * 1024)
  }
  modelTool(taskId: string, runId: string, input: unknown): unknown {
    const request = validateModel(input)
    if (Buffer.byteLength(json(input)) > defaults.transport.rpc_message_bytes) fail('INPUT_TOO_LARGE', 'Model request exceeds transport limit')
    const source = this.qualify(taskId, runId)
    assertReadDispatch(source.wait_reason)
    if (request.type === 'read' || request.type === 'list') return this.query(taskId, request, runId)
    if (request.type === 'write' && request.input.type === 'resource.create') return this.resourceCreate(taskId, runId, request.input)
    if (request.type === 'call' && request.input.capability === MONTY_ID && this.monty.available) return this.monty.call(taskId,runId,request.input.arguments,request.input.references,this.agents.get(runId)?.controller.signal ?? new AbortController().signal)
    if (request.type === 'call' && request.input.capability.startsWith('plugin:')) return this.invokePlugin(taskId, runId, request.input, this.agents.get(runId)?.controller.signal ?? new AbortController().signal)
    if (request.type === 'call') {
      const callId = id()
      this.db.prepare("INSERT INTO calls (id,task_id,run_id,capability_id,state,dispatch,execution,delivery,input_json,result_json,limits_json,commit_valid,created_at,ended_at) VALUES (?,?,?,?,'ended','not_sent','not_executed','delivered',?,?,?,0,?,?)").run(callId, taskId, runId, request.input.capability, json(request.input), json({ code: 'CAPABILITY_DISABLED' }), json(defaults), now(), now())
      return { request_type: 'call', operation_id: callId, execution: 'not_executed', delivery: 'delivered', truncated: false, error: { code: 'CAPABILITY_DISABLED', message: 'No executable capabilities are enabled; approval cannot enable them' } }
    }
    if (request.type !== 'write' || request.input.type !== 'surface.update') fail('UNSUPPORTED_OPERATION', 'This model operation is not enabled in the development slice')
    return this.publish(taskId, runId, request)
  }
  private query(taskId: string, request: Extract<ModelRequest, { type: 'list' | 'read' }>, source = 'host'): unknown {
    const kind = request.type === 'list' ? request.input.kind : request.input.target.kind
    if (kind === 'content_tree' || kind === 'content_node') return this.contentTreeQuery(taskId, request, source)
    if (request.type === 'read' && modelReadOptions(request)) return this.readCursors.read(taskId, source, request, restored => this.queryPage(taskId, restored, source))
    return this.queryPage(taskId, request, source)
  }
  private queryPage(taskId: string, request: Extract<ModelRequest, { type: 'list' | 'read' }>, source: string): unknown {
    if (request.type === 'read' && request.input.target.kind !== 'resource' && (request.input.content || request.input.cursor?.startsWith('c.'))) fail('RESOURCE_RANGE_INVALID', 'Content selection applies only to immutable text resources')
    this.journal.assertMaterials(this.db.prepare('SELECT r.id,r.storage_key FROM resources r JOIN task_resources t ON t.resource_id=r.id WHERE t.task_id=?').all(taskId) as Row[])
    this.task(taskId)
    const kind = request.type === 'list' ? request.input.kind : request.input.target.kind
    if (kind === 'summary') {
      const current = this.currentSummary(taskId)
      const row = this.db.prepare("SELECT id FROM records WHERE task_id=? AND kind='context.summary.installed' ORDER BY sequence DESC LIMIT 1").get(taskId) as Row | undefined
      if (request.type === 'list') return { items: current && row ? [{ kind: 'summary', id: row.id, through_sequence: current.through_sequence }] : [], next_cursor: null }
      if (!current || request.input.target.id !== row?.id) fail('NOT_FOUND', 'Current summary is absent; use list summary')
      if (request.input.target.expected_revision !== undefined) fail('READ_VERSION_CHANGED', 'Summary uses an immutable record ID, not a mutable revision')
      const options = modelReadOptions(request)
      if (options) return this.summaryPager.page(current, [taskId, source, request.input.target], options, request.input.cursor, { metadata: { kind: 'summary', id: row.id } })
      return { metadata: { kind: 'summary', id: row.id }, data: current, truncated: false }
    }
    if (kind === 'plugin' || kind === 'capability') {
      const epoch = this.epoch
      return this.pluginQueries.query(taskId, source, request).then(result => {
        if (this.closed || this.epoch !== epoch) fail('QUERY_SOURCE_CHANGED', 'Runtime changed during plugin query; restart the query explicitly')
        this.task(taskId)
        return result
      })
    }
    return this.queries.query(taskId, source, request, this.agents.get(source)?.controller.signal)
  }
  private validateDataReferences(taskId: string, references: { name: string; target: { kind: string; id: string; expected_revision?: number } }[]): void {
    const names = new Set<string>()
    for (const reference of references) {
      if (names.has(reference.name)) fail('INVALID_REFERENCES', 'Reference names must be locally unique')
      names.add(reference.name)
      if (reference.target.kind === 'task_data') {
        if (reference.target.expected_revision === undefined) fail('INVALID_REFERENCES', 'Task data references require an exact expected_revision')
        const target = this.db.prepare('SELECT revision FROM task_data WHERE id=? AND task_id=?').get(reference.target.id, taskId) as Row | undefined
        if (!target) fail('REFERENCE_UNAVAILABLE', 'Referenced data is unavailable within this task')
        if (target.revision !== reference.target.expected_revision) fail('VERSION_CONFLICT', 'Referenced data revision changed; read the current target and explicitly update the reference')
        continue
      }
      if (reference.target.kind !== 'resource') fail('UNSUPPORTED_REFERENCES', 'Only same-task resource and task_data references are enabled')
      if (reference.target.expected_revision !== undefined) fail('INVALID_REFERENCES', 'Immutable resources use exact resource IDs, not mutable revision numbers')
      const resource = this.db.prepare('SELECT r.* FROM resources r JOIN task_resources t ON t.resource_id=r.id WHERE r.id=? AND t.task_id=?').get(reference.target.id, taskId) as Row | undefined
      if (!resource) fail('REFERENCE_UNAVAILABLE', 'Referenced resource is unavailable within this task')
      this.journal.assertResource(resource)
      resourceBody(this.root, resource as Parameters<typeof resourceBody>[1])
    }
  }
  private checkDataRemoval(taskId: string, dataId: string): void {
    const incoming = this.db.prepare("SELECT 1 FROM object_references WHERE task_id=? AND target_kind='task_data' AND target_id=? AND blocks_remove=1 LIMIT 1").get(taskId, dataId)
    if (incoming) fail('OBJECT_REFERENCED', 'Current business references (including stale versions) block removal. Explicitly unlink referencing objects first; nothing was removed or cascaded.')
  }
  private resourceCreate(taskId: string, runId: string | null, input: Extract<Extract<ModelRequest, { type: 'write' }>['input'], { type: 'resource.create' }>, context?: ExecutionActionContext): unknown {
    const serialized = input.content.type === 'text' ? input.content.text : json(input.content.value)
    const body = Buffer.from(serialized)
    if (input.content.type === 'text' && body.toString('utf8') !== serialized) fail('INVALID_DATA', 'Text must contain valid Unicode scalar values')
    if (body.length > defaults.resource.inline_bytes || Buffer.byteLength(json(input)) > defaults.transport.rpc_message_bytes) fail('RESOURCE_LIMIT', 'Inline resource exceeds the bounded text/JSON limit')
    const actionId = context?.id ?? id(), resourceId = id(), stageId = id(), sha256 = digest(body)
    if (!context) this.db.prepare("INSERT INTO actions (id,task_id,run_id,kind,state,source_json,request_json,commit_valid,created_at) VALUES (?,?,?,'mutation','registered',?,?,1,?)").run(actionId, taskId, runId, json({ type: 'run', id: runId, level: 'task' }), json(input), now())
    try {
      if (context?.owner?.purpose === 'production' && input.content.type === 'json') {
        const value = input.content.value
        if (value && typeof value === 'object' && !Array.isArray(value) && value.profile === 'managed-v1') {
          const bundle = validateProducerBundle(value)
          checkPersonalBindings(this.db, taskId, bundle, true)
          this.checkedBundle(taskId, bundle, context.owner.attempt_id)
        }
      }
      this.journal.assertResource({ id: resourceId, storage_key: resourceId })
      this.storage.publish({ id: stageId, taskId, actionId, key: resourceId, bytes: body.length, sha256 }, body)
      const mediaType = input.content.type === 'text' ? 'text/plain; charset=utf-8' : 'application/json'
      resourceBody(this.root, { id: resourceId, storage_key: resourceId, sha256, byte_length: body.length, media_type: mediaType, display_name: input.display_name, created_at: now() })
      return this.db.transaction(() => {
        this.sourceValid(taskId, runId, context)
        const action = this.one('SELECT * FROM actions WHERE id=? AND task_id=?', actionId, taskId)
        if (!action.commit_valid || action.state === 'ended') fail('SOURCE_INVALID', 'Resource action no longer has commit permission')
        this.db.prepare('INSERT INTO resources VALUES (?,?,?,?,?,?,?)').run(resourceId, resourceId, sha256, body.length, mediaType, input.display_name, now())
        this.db.prepare('INSERT INTO task_resources VALUES (?,?)').run(taskId, resourceId)
        this.storage.commit(stageId, resourceId)
        const result = { request_type: 'write', operation_id: actionId, execution: 'success', delivery: 'delivered', truncated: false, data: { id: resourceId, media_type: mediaType, byte_length: body.length, sha256 } }
        this.record(taskId, 'resource.created', { action_id: actionId, resource_id: resourceId })
        this.db.prepare("UPDATE actions SET state='ended',result='success',commit_valid=0,authorization_json=?,result_json=?,ended_at=? WHERE id=?").run(json({ basis: 'default_resource_create' }), json(result), now(), actionId)
        return result
      })()
    } catch (error) {
      this.db.prepare("UPDATE actions SET state='ended',result='not_executed',commit_valid=0,result_json=?,ended_at=? WHERE id=? AND state!='ended'").run(json({ code: error instanceof ContractError ? error.code : 'RESOURCE_SAVE_FAILED' }), now(), actionId)
      this.storage.failed(actionId)
      if (error instanceof ContractError) throw error
      fail('RESOURCE_SAVE_FAILED', 'Resource publication failed; no valid resource reference was committed')
    }
  }
  async agentTool(taskId: string, runId: string, raw: unknown, signal: AbortSignal): Promise<unknown> {
    const request = validateModel(raw)
    if (Buffer.byteLength(json(raw)) > defaults.transport.rpc_message_bytes) fail('INPUT_TOO_LARGE', 'Model request exceeds transport limit')
    const source = this.qualify(taskId, runId)
    assertReadDispatch(source.state === 'waiting' ? source.wait_reason : null)
    if (signal.aborted) fail('SOURCE_INVALID', 'Execution cancelled')
    if (request.type === 'write' && request.input.type === 'resource.create') return this.resourceCreate(taskId, runId, request.input)
    if (request.type === 'write' && (request.input.type === 'task_data.create' || request.input.type === 'task_data.replace' || request.input.type === 'task_data.remove')) return this.dataWrite(taskId, runId, request.input, signal)
    if (request.type === 'write' && request.input.type === 'surface.update' && request.input.operations.some(op => op.type !== 'view.create')) {
      const data = await this.replaceSurface(taskId, runId, request as SurfaceWrite, signal)
      return { request_type: 'write', execution: 'success', delivery: 'delivered', truncated: false, data }
    }
    const value = await this.modelTool(taskId, runId, request)
    if (request.type === 'call') return value
    this.qualify(taskId, runId)
    if (signal.aborted) fail('SOURCE_INVALID', 'Execution cancelled during tool read')
    return { request_type: request.type, execution: 'success', delivery: 'delivered', truncated: false, data: value }
  }
  private dataWrite(taskId: string, runId: string | null, input: Extract<ModelRequest, { type: 'write' }>['input'] & { type: 'task_data.create' | 'task_data.replace' | 'task_data.remove' }, signal: AbortSignal, context?: ExecutionActionContext): Promise<unknown> {
    const isNew = input.type === 'task_data.create'
    const removing = input.type === 'task_data.remove'
    const policy = removing ? 'task-data-remove-v1' : 'task-data-v1'
    const prior = isNew ? undefined : this.one('SELECT * FROM task_data WHERE id=? AND task_id=?', input.id, taskId)
    if (!isNew && prior!.revision !== input.expected_revision) fail('VERSION_CONFLICT', 'Data revision changed')
    if (!isNew && this.db.prepare("SELECT p.id FROM approvals p JOIN actions a ON a.id=p.action_id WHERE a.run_id=? AND p.decision='deny' AND json_extract(a.request_json,'$.id')=?").get(runId, input.id)) fail('APPROVAL_DENIED', 'This target was denied in the current Run; only a new explicit user request may reconsider it')
    if (removing) this.checkDataRemoval(taskId, input.id)
    if (!removing) {
      const schema = isNew ? input.data.schema : JSON.parse(prior!.schema_json)
      const value = isNew ? input.data.value : input.value, references = isNew ? input.data.references : input.references
      this.validateDataReferences(taskId, references)
      if (Buffer.byteLength(json({ schema, value, references })) > defaults.data.object_bytes || Buffer.byteLength(json(schema)) > defaults.data.local_schema_bytes) fail('DATA_LIMIT', 'Data/schema exceeds limit')
      schemaCheck(schema)
      const validator = new Ajv2020({ allErrors: true, strict: false })
      if (!validator.validate(schema, value)) {
        const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
        const rootTypeError = validator.errors?.find(error => error.keyword === 'type' && error.instancePath === '')
        const detail = rootTypeError ? `value: expected ${rootTypeError.params.type}, received ${actual}. ` : ''
        const hint = actual === 'string' && ['object', 'array'].includes(schema.type) ? 'Do not JSON.stringify value or wrap JSON in quotes; supply the actual JSON object/array matching the fixed schema. ' : ''
        fail('INVALID_DATA', `${detail}${hint}${validator.errorsText(validator.errors)}. Validation rejected before action/approval registration; no data was changed. Read the fixed schema and correct the value type before submitting a new operation.`)
      }
    }
    const actionId = context?.id ?? id(), dataId = isNew ? id() : input.id
    if (!context) this.db.prepare("INSERT INTO actions (id,task_id,run_id,kind,state,source_json,request_json,commit_valid,created_at) VALUES (?,?,?,'mutation','registered',?,?,1,?)").run(actionId, taskId, runId, json({ type: 'run', id: runId, level: 'task' }), json(input), now())
    const auto = !removing && (isNew || (runId !== null && prior!.creator_run_id === runId && prior!.auto_edit_valid === 1))
    const commit = () => this.db.transaction(() => {
      this.sourceValid(taskId, runId, context)
      const action = this.one('SELECT * FROM actions WHERE id=? AND task_id=?', actionId, taskId)
      if (!action.commit_valid || action.state === 'ended' || signal.aborted) fail('SOURCE_INVALID', 'Action is no longer executable')
      if (!auto) this.checkApproval(actionId, input, taskId, runId, policy)
      if (!isNew) {
        const current = this.one('SELECT * FROM task_data WHERE id=? AND task_id=?', dataId, taskId)
        if (current.revision !== input.expected_revision) fail('VERSION_CONFLICT', 'Approved data version changed; create a new action after reading')
        if (auto && (current.creator_run_id !== runId || !current.auto_edit_valid)) fail('AUTHORIZATION_CHANGED', 'Automatic modification eligibility changed')
      }
      if (removing) {
        this.checkDataRemoval(taskId, dataId)
        this.db.prepare('DELETE FROM task_data WHERE id=? AND task_id=?').run(dataId, taskId)
      } else {
        const references = isNew ? input.data.references : input.references
        this.validateDataReferences(taskId, references)
        if (isNew) this.db.prepare('INSERT INTO task_data VALUES (?,?,1,?,?,?,?,1)').run(dataId, taskId, json(input.data.schema), json(input.data.value), json(references), runId)
        else this.db.prepare('UPDATE task_data SET revision=revision+1,value_json=?,references_json=? WHERE id=? AND task_id=?').run(json(input.value), json(references), dataId, taskId)
      }
      this.db.prepare("DELETE FROM object_references WHERE task_id=? AND source_kind='task_data' AND source_id=?").run(taskId, dataId)
      if (!removing) for (const reference of isNew ? input.data.references : input.references) this.db.prepare("INSERT INTO object_references VALUES (?,'task_data',?,?,?,?,?,?,?)").run(taskId, dataId, reference.name, reference.target.kind, reference.target.id, reference.target.expected_revision ?? null, reference.target.kind === 'resource' ? 1 : 0, reference.target.kind === 'task_data' ? 1 : 0)
      const result = { request_type: 'write', operation_id: actionId, execution: 'success', delivery: 'delivered', truncated: false, data: removing ? { id: dataId, removed: true, removed_revision: input.expected_revision } : { id: dataId, revision: isNew ? 1 : input.expected_revision + 1 } }
      this.record(taskId, removing ? 'task_data.removed' : 'task_data.changed', { action_id: actionId, ...result.data })
      this.db.prepare("UPDATE actions SET state='ended',result='success',commit_valid=0,authorization_json=?,result_json=?,ended_at=? WHERE id=?").run(json({ basis: auto ? 'default' : 'single_approval' }), json(result), now(), actionId)
      return result
    })()
    const execute = async () => {
      try {
        if (!auto) await this.awaitApproval(taskId, runId, actionId, input, signal, policy, context)
        return commit()
      } catch (e) {
        if (!this.closed) this.db.prepare("UPDATE actions SET state='ended',result='not_executed',commit_valid=0,result_json=?,ended_at=? WHERE id=? AND state!='ended'").run(json({ code: e instanceof ContractError ? e.code : 'ACTION_FAILED' }), now(), actionId)
        throw e
      }
    }
    return execute()
  }
  private checkApproval(actionId: string, input: unknown, taskId: string, runId: string | null, policy = 'task-data-v1', resolved?: unknown): void {
    const approval = this.one('SELECT * FROM approvals WHERE action_id=?', actionId)
    const binding = JSON.parse(approval.binding_json)
    if (resolved !== undefined ? binding.version !== 2 || json(binding.resolved) !== json(resolved) : binding.version !== undefined || binding.resolved !== undefined) fail('APPROVAL_BINDING_CHANGED', 'Resolved bundle approval changed')
    if (approval.decision !== 'approve' || approval.validity !== 'valid' || Date.parse(approval.expires_at) <= Date.now()) fail('APPROVAL_INVALID', 'Approval denied, expired or revoked')
    if (this.one('SELECT request_json FROM actions WHERE id=?', actionId).request_json !== json(input)) fail('APPROVAL_BINDING_CHANGED', 'Action payload changed')
    if (binding.action_id !== actionId || binding.policy !== policy || binding.task_id !== taskId || binding.run_id !== runId || binding.runtime_epoch !== this.epoch || binding.request !== json(input)) fail('APPROVAL_BINDING_CHANGED', 'Single action binding changed')
    const source = JSON.parse(this.one('SELECT source_json FROM actions WHERE id=? AND task_id=?', actionId, taskId).source_json)
    if (json(binding.owner) !== json(source.owner)) fail('APPROVAL_BINDING_CHANGED', 'Approval execution ownership changed')
  }
  private async awaitApproval(taskId: string, runId: string | null, actionId: string, input: unknown, signal: AbortSignal, policy = 'task-data-v1', context?: ExecutionActionContext, resolved?: { version: number; effective_request: unknown; sources: BundleSource[] }): Promise<void> {
    const agent = context?.hostPublication && runId ? this.agents.get(runId) : context?.owner ? this.workers.get(context.owner.attempt_id) : runId ? this.agents.get(runId) : undefined, mode = policy === 'task-data-remove-v1' ? 'manual' : agent?.mode ?? 'manual', approvalId = id(), expiry = new Date(Date.now() + defaults.approval.ttl_ms).toISOString()
    this.db.transaction(() => {
      this.sourceValid(taskId, runId, context)
      this.db.prepare("UPDATE actions SET state='waiting',wait_reason='approval' WHERE id=?").run(actionId)
      this.db.prepare('INSERT INTO approvals VALUES (?,?,\'pending\',\'valid\',?,?,?,NULL,?)').run(approvalId, actionId, mode, mode === 'assisted' ? 'evaluating' : 'awaiting_human', expiry, json({ action_id: actionId, task_id: taskId, run_id: runId, runtime_epoch: this.epoch, request: json(input), policy, created_at: now(), ...(context?.owner ? { owner: context.owner } : {}), ...(resolved ? { version: 2, resolved } : {}) }))
      this.actionState(runId, 'waiting', 'approval', context)
    })()
    const waiting = new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.expireApproval(approvalId); resolve() }, defaults.approval.ttl_ms)
      this.approvalWaiters.set(approvalId, { resolve, timer })
    })
    const abort = () => this.wakeApproval(approvalId)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    const assessmentController = new AbortController()
    const stopAssessment = () => assessmentController.abort()
    signal.addEventListener('abort', stopAssessment, { once: true })
    const assessment = mode === 'assisted' && agent?.approval && runId ? context?.hostPublication ? this.assessRunnerComposition(taskId, runId, approvalId, resolved?.effective_request ?? input, context, assessmentController.signal) : this.assess(taskId, runId, approvalId, resolved?.effective_request ?? input, agent, assessmentController.signal) : Promise.resolve()
    try {
      await waiting
      assessmentController.abort(); await assessment
      this.sourceValid(taskId, runId, context)
      if (signal.aborted) fail('SOURCE_INVALID', 'Cancelled while awaiting approval')
      this.checkApproval(actionId, input, taskId, runId, policy, resolved)
    } finally {
      assessmentController.abort(); await assessment
      signal.removeEventListener('abort', stopAssessment)
      signal.removeEventListener('abort', abort); this.wakeApproval(approvalId)
      if (context?.identity?.call_id) { this.pluginProcesses.waiting(context.identity.call_id, false); if (!this.closed) this.db.prepare("UPDATE calls SET wait_reason=NULL WHERE id=? AND wait_reason='plugin_approval'").run(context.identity.call_id) }
      this.restoreActionState(runId, context)
    }
  }
  private wakeApproval(approvalId: string): void { const waiter = this.approvalWaiters.get(approvalId); if (waiter) { clearTimeout(waiter.timer); this.approvalWaiters.delete(approvalId); waiter.resolve() } }
  private expireApproval(approvalId: string): void {
    if (this.closed) return
    this.db.prepare("UPDATE approvals SET validity='expired' WHERE id=? AND validity='valid' AND expires_at<=?").run(approvalId, now())
    this.wakeApproval(approvalId)
  }
  private decide(taskId: string, approvalId: string, decision: 'approve' | 'deny', actor: 'human' | 'model', reason?: string): unknown {
    const expiring = this.one('SELECT p.expires_at FROM approvals p JOIN actions a ON a.id=p.action_id WHERE p.id=? AND a.task_id=?', approvalId, taskId)
    if (Date.parse(expiring.expires_at) <= Date.now()) { this.expireApproval(approvalId); fail('APPROVAL_EXPIRED', 'Approval expired') }
    return this.db.transaction(() => {
      const p = this.one('SELECT p.*,a.task_id,a.run_id,a.commit_valid,a.source_json,a.state AS action_state FROM approvals p JOIN actions a ON a.id=p.action_id WHERE p.id=? AND a.task_id=?', approvalId, taskId)
      if (p.validity !== 'valid' || p.decision !== 'pending' || !p.commit_valid || p.action_state !== 'waiting') fail('APPROVAL_INVALID', 'Approval is no longer pending/executable')
      if (Date.parse(p.expires_at) <= Date.now()) { this.expireApproval(approvalId); fail('APPROVAL_EXPIRED', 'Approval expired') }
      if (p.run_id) this.qualify(taskId, p.run_id)
      else { const source = this.pluginInvocationSources.get(p.action_id); if (source) source.valid(); else if (!this.pluginActions.owner(p.action_id, taskId)) fail('PLUGIN_SOURCE_INVALID', 'Independent action source ended') }
      if (actor === 'human' && p.handling !== 'awaiting_human') fail('APPROVAL_EVALUATING', 'Assisted evaluation is still in progress')
      this.db.prepare("UPDATE approvals SET decision=?,handling='resolved',evaluation_json=? WHERE id=?").run(decision, json({ ...(p.evaluation_json ? JSON.parse(p.evaluation_json) : {}), decided_by: actor, decided_at: now(), reason: reason ?? 'Explicit host UI choice' }), approvalId)
      const record = this.record(taskId, 'approval.decided', { approval_id: approvalId, action_id: p.action_id, decision, actor })
      const owner = captureExecutionScope(JSON.parse(p.source_json).owner, taskId)
      if (owner) {
        const inputId = `approval:${approvalId}`
        this.runner().receive({ input_event_id: inputId, task_id: taskId, kind: 'approval_decided', record_id: record, operation_id: p.action_id, run_id: owner.run_id, work_id: owner.work_id, ...(owner.purpose === 'production' ? { request_id: owner.request_id } : {}), stage: 'received' })
        this.runner().advance(inputId)
      }
      this.wakeApproval(approvalId)
      return { decision, validity: 'valid', action_id: p.action_id }
    })()
  }
  private async assess(taskId: string, runId: string, approvalId: string, input: unknown, agent: { approval?: ModelLease; controller: AbortController; budget: RunBudget; owner?: ExecutionScope }, signal: AbortSignal): Promise<void> {
    const lease = agent.approval!
    const surface = (input as { type?: string }).type === 'surface.update'
    const messages: ChatMessage[] = [{ role: 'system', content: approvalTemplate }, { role: 'user', content: json({ source: { type: 'run', id: runId, task_id: taskId, level: 'task' }, action: input, permission: surface ? 'This exact Surface View replacement only. Input discard requires separate human confirmation; your approval cannot supply it. No trust, deletion, new capability or cross-task permission.' : 'This exact existing task_data replacement only. No trust, deletion, input discard, new capability or cross-task permission.', user_request: this.one('SELECT q.input_json FROM requests q JOIN runs r ON r.request_id=q.id WHERE r.id=?', runId).input_json }) }]
    try {
      const reservation = agent.budget.reserve(messages, undefined, lease.config, 'approval-input')
      this.db.prepare('UPDATE runs SET budget_json=? WHERE id=?').run(json(agent.budget.state), runId)
      const response = await this.models.request(lease, taskId, messages, undefined, signal, undefined, lease.config.max_output_tokens, undefined, 'approval')
      this.qualify(taskId, runId); if (agent.owner) this.qualifyWorker(agent.owner.attempt_id); agent.budget.settle(reservation, response)
      const evaluation: unknown = JSON.parse(response.text)
      assertContract<{ decision: 'approve' | 'deny' | 'escalate'; reason: string }>('approval_decision', evaluation)
      const approval = this.one('SELECT * FROM approvals WHERE id=?', approvalId)
      if (approval.validity !== 'valid' || approval.decision !== 'pending') return
      this.db.prepare('UPDATE approvals SET evaluation_json=? WHERE id=?').run(json({ ...evaluation, model_id: lease.id, model_revision: lease.revision, template: 'approval-v0.1' }), approvalId)
      if (evaluation.decision === 'escalate') this.db.prepare("UPDATE approvals SET handling='awaiting_human' WHERE id=?").run(approvalId)
      else this.decide(taskId, approvalId, evaluation.decision, 'model', evaluation.reason)
    } catch (e) {
      if (this.closed || signal.aborted) return
      if (!agent.owner && e instanceof ContextRejectedError) { this.finish(taskId, runId, 'failed', this.recordContextRejection(taskId, runId, e, lease)); return }
      if (!agent.owner && e instanceof ModelError && (e.code.includes('BUDGET') || e.code === 'RUN_WALL_LIMIT')) { this.finish(taskId, runId, 'failed', e.code); return }
      this.db.prepare("UPDATE approvals SET handling='awaiting_human',evaluation_json=? WHERE id=? AND decision='pending' AND validity='valid'").run(json({ error: e instanceof ModelError ? e.code : 'INVALID_APPROVAL_RESPONSE', template: 'approval-v0.1' }), approvalId)
    } finally { if (!this.closed) this.db.prepare('UPDATE runs SET budget_json=? WHERE id=?').run(json(agent.budget.state), runId) }
  }
  private inspectReplacement(taskId: string, runId: string | null, input: SurfaceWrite['input'], context?: ExecutionActionContext): PreparedView[] {
    this.sourceValid(taskId, runId, context)
    const surface = this.one('SELECT * FROM surfaces WHERE id=? AND task_id=?', input.surface_id, taskId)
    if (surface.revision !== input.expected_revision) fail('VERSION_CONFLICT', 'Surface version changed; read again and submit a new action')
    const targets = new Set<string>(), clients = new Set<string>()
    const prepared = input.operations.filter(op => op.type !== 'layout.set').map(op => {
      if (op.type === 'view.create' && op.slot_id !== 'main') fail('UNSUPPORTED_OPERATION', 'Only main slot is enabled')
      const viewId = op.type === 'view.create' ? id() : op.view_id
      if (op.type === 'view.create') {
        if (clients.has(op.client_ref)) fail('INVALID_REQUEST', 'Duplicate client_ref')
        clients.add(op.client_ref)
      } else {
        if (targets.has(viewId)) fail('INVALID_REQUEST', 'A View may appear only once in a change set')
        targets.add(viewId)
      }
      const loaded = op.type === 'view.remove' ? { bundle: this.bundle(this.view(taskId, viewId, op.expected_view_revision, op.expected_state_revision).bundle_resource_id) } : loadBundleSource(this.db, this.root, taskId, op.bundle, r => this.journal.assertResource(r))
      if (op.type !== 'view.remove') checkPersonalBindings(this.db, taskId, loaded.bundle, true)
      const checked = this.checkedBundle(taskId, loaded.bundle, 'v-' + viewId), bundle = checked.bundle
      let draft = bundle.state.initial as Record<string, unknown>, hasLocalInput = false, answers = 0
      if (op.type === 'view.replace' || op.type === 'view.remove') {
        const current = this.view(taskId, viewId, op.expected_view_revision, op.type === 'view.remove' ? op.expected_state_revision : op.state_transition.expected_state_revision)
        if (current.surface_id !== surface.id) fail('INVALID_TARGET', 'View is not in the requested Surface')
        const previous = op.type === 'view.remove' ? bundle : this.bundle(current.bundle_resource_id)
        draft = op.type === 'view.remove' ? JSON.parse(current.draft_json) : replacementDraft(previous, bundle, JSON.parse(current.draft_json), op.state_transition)
        hasLocalInput = previous.behaviors.length > 0
        answers = this.one('SELECT count(*) AS count FROM answers a JOIN view_history h ON h.id=a.view_history_id WHERE h.view_id=? AND a.task_id=?', viewId, taskId).count
        if (op.type === 'view.remove') {
          const denied = this.db.prepare("SELECT a.request_json FROM approvals p JOIN actions a ON a.id=p.action_id WHERE a.run_id=? AND p.decision='deny'").all(runId) as Row[]
          if (denied.some(a => { const r = JSON.parse(a.request_json); return r.type === 'surface.update' && r.operations.some((item: Row) => item.type === 'view.remove' && item.view_id === viewId) })) fail('APPROVAL_DENIED', 'View removal was denied in this Run; a new explicit request is required')
        }
      }
      const body = Buffer.from(json(bundle))
      return { op, viewId, resourceId: id(), stageId: id(), hash: createHash('sha256').update(body).digest('hex'), body, bundle, draft, hasLocalInput, answers, source: loaded.source, direct: bundleResources(this.db, taskId, bundle) }
    })
    this.surfaceLayout(input, prepared)
    return prepared
  }
  private surfaceLayout(input: SurfaceWrite['input'], prepared: PreparedView[]): Row {
    const surface = this.one('SELECT layout_json FROM surfaces WHERE id=?', input.surface_id)
    const layout = JSON.parse(surface.layout_json), current = new Set((this.db.prepare('SELECT id FROM views WHERE surface_id=?').all(input.surface_id) as Row[]).map(v => v.id))
    for (const p of prepared) {
      if (p.op.type === 'view.remove') current.delete(p.viewId)
      if (p.op.type === 'view.create') { current.add(p.viewId); layout.slots[0].groups.push({ id: id(), type: 'column', views: [p.viewId] }) }
    }
    for (const slot of layout.slots) slot.groups = slot.groups.map((g: Row) => ({ ...g, views: g.views.filter((v: string) => current.has(v)) })).filter((g: Row) => g.views.length)
    const changes = input.operations.filter(op => op.type === 'layout.set')
    if (changes.length > 1) fail('INVALID_LAYOUT', 'At most one layout.set is permitted')
    if (!changes.length) return layout
    const requested = changes[0]!.layout, seen = new Set<string>(), groups = new Set<string>()
    if (requested.slots.length !== 1 || requested.slots[0]!.slot_id !== 'main') fail('INVALID_LAYOUT', 'Only main slot is enabled')
    const resolved = requested.slots[0]!.groups.map(group => {
      if (groups.has(group.id) || group.views.length > 50 || group.column_weights && (group.mode !== 'responsive_columns' || group.column_weights.length !== group.views.length)) fail('INVALID_LAYOUT', 'Duplicate group or invalid column weights')
      groups.add(group.id)
      const views = group.views.map(locator => {
        const target = locator.type === 'existing' ? locator.view_id : prepared.find(p => p.op.type === 'view.create' && p.op.client_ref === locator.client_ref)?.viewId
        if (!target || !current.has(target) || seen.has(target)) fail('INVALID_LAYOUT', 'Layout must reference each remaining View exactly once')
        seen.add(target); return target
      })
      return { id: group.id, type: group.mode, views, gap: group.gap, align: group.align, ...(group.column_weights ? { column_weights: group.column_weights } : {}) }
    })
    if (seen.size !== current.size) fail('INVALID_LAYOUT', 'Layout may not silently hide a current View; use view.remove')
    return { slots: [{ id: 'main', groups: resolved }] }
  }
  private canAutoReplaceView(task: string, run: string | null, op: Extract<SurfaceWrite['input']['operations'][number], { type: 'view.replace' }>): boolean {
    const current = this.view(task, op.view_id, op.expected_view_revision, op.state_transition.expected_state_revision)
    return run !== null && current.creator_run_id === run && current.auto_edit_valid === 1
  }
  private async replaceSurface(taskId: string, runId: string | null, request: SurfaceWrite, signal: AbortSignal, context?: ExecutionActionContext, publication?: CompositionPublicationHooks): Promise<unknown> {
    const input = request.input, actionId = context?.id ?? id()
    try {
      if (!this.features.viewReplacement) fail('CAPABILITY_DISABLED', 'View replacement is not yet verified and remains disabled')
      const prepared = this.inspectReplacement(taskId, runId, input, context)
      const replacements = input.operations.filter(op => op.type === 'view.replace')
      const autoReplace = () => replacements.every(op => this.canAutoReplaceView(taskId, runId, op))
      const needsApproval = !!publication?.approvalOperations?.length || input.operations.some(op => op.type === 'view.remove' || op.type === 'layout.set') || !autoReplace()
      const discardsInput = input.operations.some(op => op.type === 'view.remove' || op.type === 'view.replace' && op.state_transition.type === 'reset')
      const needsHostCheck = !!publication || discardsInput || input.operations.some(op => op.type === 'layout.set') || prepared.some(p => p.op.type === 'view.replace' && p.hasLocalInput)
      const resolved = needsApproval && prepared.some(p => p.source) ? { version: 1, effective_request: { ...input, operations: input.operations.map(op => { const p = prepared.find(p => p.op === op); return p?.source && op.type !== 'view.remove' && op.type !== 'layout.set' ? { ...op, bundle: { type: 'inline', bundle: p.bundle } } : op }) }, sources: prepared.filter(p => p.source).map(p => p.source!) } : undefined
      const evidence = captureEvidence(this.db, this.root, taskId, input.snapshot_sources)
      const check = (verifyFiles = true) => { this.checkSurfaceVersions(taskId, runId, input, prepared, context); checkEvidence(this.db, this.root, taskId, evidence, verifyFiles); publication?.check() }
      if (!context) this.db.prepare("INSERT INTO actions (id,task_id,run_id,kind,state,source_json,request_json,commit_valid,created_at) VALUES (?,?,?,'mutation','registered',?,?,1,?)").run(actionId, taskId, runId, json({ type: 'run', id: runId, level: 'task' }), json(input), now())
      if (needsApproval) await this.awaitApproval(taskId, runId, actionId, input, signal, 'surface-replace-v1', context, resolved)
      check()
      // Editable Views still flush local input; only discard requires a human response.
      const confirmation = needsHostCheck ? await this.awaitSurfaceHost(taskId, runId, actionId, request, signal, check, context) : undefined
      this.sourceValid(taskId, runId, context)
      if (signal.aborted) fail('SOURCE_INVALID', 'Execution cancelled')
      if (needsApproval) this.checkApproval(actionId, input, taskId, runId, 'surface-replace-v1', resolved)
      for (const p of prepared) {
        if (p.op.type === 'view.remove') continue
        this.journal.assertResource({ id: p.resourceId, storage_key: p.resourceId })
        this.storage.publish({ id: p.stageId, taskId, actionId, key: p.resourceId, bytes: p.body.length, sha256: p.hash }, p.body)
      }
      check()
      return this.db.transaction(() => {
        if (confirmation && Date.parse(confirmation.expires_at) <= Date.now()) fail('CONFIRMATION_EXPIRED', 'Host confirmation expired before commit')
        check(false)
        const action = this.one('SELECT * FROM actions WHERE id=? AND task_id=?', actionId, taskId)
        if (!action.commit_valid || action.state === 'ended' || signal.aborted) fail('SOURCE_INVALID', 'Action is no longer executable')
        if (needsApproval) this.checkApproval(actionId, input, taskId, runId, 'surface-replace-v1', resolved)
        else if (!autoReplace()) fail('AUTHORIZATION_CHANGED', 'Automatic View modification eligibility changed')
        const surface = this.one('SELECT * FROM surfaces WHERE id=? AND task_id=?', input.surface_id, taskId), layout = this.surfaceLayout(input, prepared)
        const views: Row[] = []
        for (const p of prepared) {
          if (p.op.type === 'view.remove') { this.db.prepare('DELETE FROM views WHERE id=? AND surface_id=?').run(p.viewId, surface.id); views.push({ view_id: p.viewId, removed: true }); continue }
          bundleResources(this.db, taskId, p.bundle).forEach(r => this.journal.assertResource(r))
          const draft = p.draft
          this.db.prepare('INSERT INTO resources VALUES (?,?,?,?,?,?,?)').run(p.resourceId, p.resourceId, p.hash, p.body.length, 'application/vnd.pliuna.bundle+json', 'managed-v1 bundle', now())
          this.db.prepare('INSERT INTO task_resources VALUES (?,?)').run(taskId, p.resourceId)
          const revision = p.op.type === 'view.create' ? 1 : p.op.expected_view_revision + 1
          if (p.op.type === 'view.create') {
            this.db.prepare('INSERT INTO views VALUES (?,?,1,?,1,?,?,?,1)').run(p.viewId, surface.id, p.resourceId, json(draft), p.bundle.state.compatibility_version, runId)
          } else {
            this.db.prepare('UPDATE views SET revision=revision+1,bundle_resource_id=?,state_revision=state_revision+1,draft_json=?,compatibility_version=? WHERE id=? AND surface_id=?').run(p.resourceId, json(draft), p.bundle.state.compatibility_version, p.viewId, surface.id)
          }
          saveHistory(this.db, id(), taskId, p.viewId, revision, p.resourceId, draft, evidence, bundleResources(this.db, taskId, p.bundle))
          this.storage.commit(p.stageId, p.resourceId)
          views.push({ ...(p.op.type === 'view.create' ? { client_ref: p.op.client_ref } : {}), view_id: p.viewId, revision })
        }
        publication?.prepared(prepared)
        this.db.prepare('UPDATE surfaces SET revision=revision+1,layout_json=? WHERE id=?').run(json(layout), surface.id)
        const result = { action_id: actionId, revision: surface.revision + 1, views }
        const recordId = this.record(taskId, 'surface.published', result)
        this.db.prepare("UPDATE actions SET state='ended',wait_reason=NULL,result='success',commit_valid=0,authorization_json=?,result_json=?,ended_at=? WHERE id=?").run(json({ basis: needsApproval ? 'single_approval' : 'default', host_checked: !!confirmation, reset_confirmed: discardsInput, ...(confirmation ? { confirmed_by: discardsInput ? 'human' : 'host', ...confirmation } : {}) }), json(result), now(), actionId)
        publication?.committed(recordId, result.revision)
        if (context?.owner?.purpose === 'composition') {
          const sources = this.db.prepare(`SELECT DISTINCT i.record_id AS message_id,p.request_id
            FROM runner_view_mappings m JOIN runner_artifacts a ON a.task_id=m.task_id AND a.artifact_id=m.artifact_id AND a.artifact_revision=m.artifact_revision
            JOIN runner_content_plans p ON p.task_id=a.task_id AND p.request_id=json_extract(a.payload_json,'$.request_id') AND p.intent_revision=json_extract(a.payload_json,'$.intent_revision')
            JOIN runner_inputs i ON i.task_id=p.task_id AND i.input_event_id=p.input_event_id
            JOIN records r ON r.id=i.record_id AND r.task_id=i.task_id AND r.kind='message.user'
            WHERE m.task_id=? AND m.batch_id=? ORDER BY r.sequence`).all(taskId, context.owner.batch_id) as Row[]
          for (const source of sources) this.record(taskId, 'conversation.delivery', { text: '内容已发布。', request_id: source.request_id, reply_to: source.message_id, run_id: runId, action_id: actionId })
        }
        this.registerPublishedChapters(taskId, prepared)
        return result
      })()
    } catch (error) {
      if (!this.closed) {
        this.db.prepare("UPDATE actions SET state='ended',wait_reason=NULL,result='not_executed',commit_valid=0,result_json=?,ended_at=? WHERE id=? AND state!='ended'").run(json({ code: error instanceof ContractError ? error.code : 'SAVE_FAILED' }), now(), actionId)
        this.storage.failed(actionId)
      }
      throw error
    } finally {
      this.surfaceCompletions.get(actionId)?.resolve(); this.surfaceCompletions.delete(actionId)
      if (!this.closed) {
        this.db.prepare("UPDATE approvals SET validity='revoked' WHERE action_id=? AND validity='valid'").run(actionId)
        this.restoreActionState(runId, context)
      }
    }
  }
  private registerPublishedChapters(task: string, prepared: { viewId: string }[]): void {
    if (!this.features.runner) return
    for (const item of prepared) {
      const view = this.db.prepare('SELECT revision FROM views WHERE id=?').get(item.viewId) as { revision: number } | undefined
      if (!view) continue
      try { this.chapters().map(task, item.viewId, view.revision) }
      catch (error) {
        if (!(error instanceof ContractError) || !['CHAPTER_MAPPING_REQUIRED', 'CHAPTER_MAPPING_INVALID', 'CHAPTER_OWNERSHIP_INVALID', 'CHAPTER_STYLE_INVALID'].includes(error.code)) throw error
        this.record(task, 'chapter.mapping.required', { view_id: item.viewId, view_revision: view.revision, reason: error.code })
      }
    }
  }
  private checkSurfaceVersions(taskId: string, runId: string | null, input: SurfaceWrite['input'], prepared: PreparedView[], context?: ExecutionActionContext): void {
    this.sourceValid(taskId, runId, context)
    if (this.one('SELECT revision FROM surfaces WHERE id=? AND task_id=?', input.surface_id, taskId).revision !== input.expected_revision) fail('VERSION_CONFLICT', 'Surface version changed; submit a new action')
    for (const p of prepared) {
      if (p.source && p.op.type !== 'view.remove') { const current = loadBundleSource(this.db, this.root, taskId, p.op.bundle, r => this.journal.assertResource(r)); if (json(current.source) !== json(p.source) || json(current.bundle) !== json(p.bundle)) fail('RESOURCE_CHANGED', 'Bundle source changed after inspection') }
      checkPersonalBindings(this.db, taskId, p.bundle, p.op.type !== 'view.remove')
      const direct = bundleResources(this.db, taskId, p.bundle); direct.forEach(r => this.journal.assertResource(r))
      if (json(direct) !== json(p.direct)) fail('RESOURCE_CHANGED', 'View resource identity changed since inspection')
      if (p.op.type !== 'view.replace' && p.op.type !== 'view.remove') continue
      const current = this.view(taskId, p.viewId, p.op.expected_view_revision, p.op.type === 'view.remove' ? p.op.expected_state_revision : p.op.state_transition.expected_state_revision)
      if (current.surface_id !== input.surface_id) fail('INVALID_TARGET', 'View moved outside the target Surface')
      const answers = this.one('SELECT count(*) AS count FROM answers a JOIN view_history h ON h.id=a.view_history_id WHERE h.view_id=? AND a.task_id=?', p.viewId, taskId).count
      if (answers !== p.answers) fail('VERSION_CONFLICT', 'User submitted an answer after replacement inspection; submit a new action')
    }
  }
  private async awaitSurfaceHost(taskId: string, runId: string | null, actionId: string, request: SurfaceWrite, signal: AbortSignal, check: () => void, context?: ExecutionActionContext): Promise<{ confirmed_at: string; expires_at: string }> {
    this.sourceValid(taskId, runId, context)
    const expires = new Date(Date.now() + defaults.approval.ttl_ms).toISOString()
    const reset = request.input.operations.some(op => op.type === 'view.remove' || op.type === 'view.replace' && op.state_transition.type === 'reset')
    this.db.prepare("UPDATE actions SET state='waiting',wait_reason='surface_host' WHERE id=? AND commit_valid=1").run(actionId)
    this.actionState(runId, 'waiting', 'surface_host', context)
    let resolve!: (proceed: boolean | ContractError) => void
    const waiting = new Promise<boolean | ContractError>(done => { resolve = done })
    let completed!: () => void
    const promise = new Promise<void>(done => { completed = done })
    this.surfaceCompletions.set(actionId, { promise, resolve: completed })
    const timer = setTimeout(() => resolve(false), defaults.approval.ttl_ms)
    this.surfaceWaiters.set(actionId, { taskId, runId, context, request, reset, expires, check, resolve, timer })
    const abort = () => resolve(false)
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
    try {
      const confirmed = await waiting
      if (confirmed instanceof ContractError) throw confirmed
      if (!confirmed) fail('SURFACE_NOT_CONFIRMED', 'Replacement cancelled, expired or host could not preserve local input')
      if (Date.parse(expires) <= Date.now()) fail('CONFIRMATION_EXPIRED', 'Host confirmation expired')
      return { confirmed_at: now(), expires_at: expires }
    }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort); this.surfaceWaiters.delete(actionId) }
  }
  private async respondSurface(r: Extract<IpcRequest, { type: 'surface.respond' }>): Promise<unknown> {
    const waiter = this.surfaceWaiters.get(r.action_id)
    if (!waiter || waiter.taskId !== r.task_id) fail('SOURCE_INVALID', 'No pending host check for this action')
    this.sourceValid(r.task_id, waiter.runId, waiter.context)
    const action = this.one('SELECT * FROM actions WHERE id=? AND task_id=?', r.action_id, r.task_id)
    if (!action.commit_valid || action.state !== 'waiting' || Date.parse(waiter.expires) <= Date.now()) {
      this.surfaceWaiters.delete(r.action_id); clearTimeout(waiter.timer); waiter.resolve(false)
      await this.surfaceCompletions.get(r.action_id)?.promise
      fail('SOURCE_INVALID', 'Host check expired or action invalidated')
    }
    if (r.proceed && waiter.reset && !r.confirm_discard) fail('CONFIRMATION_REQUIRED', 'Reset requires a separate explicit human input-discard confirmation')
    if (r.proceed) {
      try { waiter.check() }
      catch (error) {
        const completion = this.surfaceCompletions.get(r.action_id)!
        this.surfaceWaiters.delete(r.action_id); clearTimeout(waiter.timer); waiter.resolve(error instanceof ContractError ? error : new ContractError('SAVE_FAILED', 'Host check failed'))
        await completion.promise
        throw error
      }
    }
    // Consume the response before waking the executor; it is not a reusable permit.
    const completion = this.surfaceCompletions.get(r.action_id)!
    this.surfaceWaiters.delete(r.action_id); clearTimeout(waiter.timer); waiter.resolve(r.proceed)
    await completion.promise
    const result = this.one('SELECT state,result,result_json FROM actions WHERE id=? AND task_id=?', r.action_id, r.task_id)
    if (r.proceed && result.result !== 'success') fail('SURFACE_NOT_COMMITTED', 'Replacement did not commit; query the action result, never automatically replay')
    return { accepted: true, ...result }
  }
  private publish(taskId: string, runId: string | null, request: Extract<ModelRequest, { type: 'write' }>, context?: ExecutionActionContext): unknown {
    const input = request.input
    if (input.type !== 'surface.update') fail('UNSUPPORTED_OPERATION', 'Unsupported write')
    const evidence = captureEvidence(this.db, this.root, taskId, input.snapshot_sources)
    const actionId = context?.id ?? id()
    if (!context) this.db.prepare("INSERT INTO actions (id,task_id,run_id,kind,state,source_json,request_json,commit_valid,created_at) VALUES (?,?,?,'mutation','registered',?,?,1,?)").run(actionId, taskId, runId, json({ type: 'run', id: runId }), json(request), now())
    try {
      const clientRefs = new Set<string>()
      const prepared = input.operations.map(op => {
        if (op.type !== 'view.create' || op.slot_id !== 'main') fail('UNSUPPORTED_OPERATION', 'Only create in main is enabled')
        if (clientRefs.has(op.client_ref)) fail('INVALID_REQUEST', 'Duplicate client_ref')
        clientRefs.add(op.client_ref)
        const viewId = id(), resourceId = id(), stageId = id()
        const loaded = loadBundleSource(this.db, this.root, taskId, op.bundle, r => this.journal.assertResource(r))
        checkPersonalBindings(this.db, taskId, loaded.bundle, true)
        const checked = this.checkedBundle(taskId, loaded.bundle, 'v-' + viewId)
        const body = Buffer.from(json(checked.bundle)), hash = createHash('sha256').update(body).digest('hex')
        this.journal.assertResource({ id: resourceId, storage_key: resourceId })
        this.storage.publish({ id: stageId, taskId, actionId, key: resourceId, bytes: body.length, sha256: hash }, body)
        return { op, viewId, resourceId, stageId, hash, body, bundle: checked.bundle, source: loaded.source, direct: bundleResources(this.db, taskId, checked.bundle) }
      })
      checkEvidence(this.db, this.root, taskId, evidence)
      const result = this.db.transaction(() => {
        this.sourceValid(taskId, runId, context)
        const surface = this.one('SELECT * FROM surfaces WHERE id=? AND task_id=?', input.surface_id, taskId)
        if (surface.revision !== input.expected_revision) fail('VERSION_CONFLICT', 'Surface version changed')
        checkEvidence(this.db, this.root, taskId, evidence, false)
        const layout = JSON.parse(surface.layout_json)
        for (const p of prepared) {
          if (p.source) { const loaded = loadBundleSource(this.db, this.root, taskId, p.op.bundle, r => this.journal.assertResource(r)); if (json(loaded.source) !== json(p.source) || json(loaded.bundle) !== json(p.bundle)) fail('RESOURCE_CHANGED', 'Bundle source changed') }
          checkPersonalBindings(this.db, taskId, p.bundle, true)
          const direct = bundleResources(this.db, taskId, p.bundle); direct.forEach(r => this.journal.assertResource(r))
          if (json(direct) !== json(p.direct)) fail('RESOURCE_CHANGED', 'View resource identity changed before publication')
          this.db.prepare('INSERT INTO resources VALUES (?,?,?,?,?,?,?)').run(p.resourceId, p.resourceId, p.hash, p.body.length, 'application/vnd.pliuna.bundle+json', 'managed-v1 bundle', now())
          this.db.prepare('INSERT INTO task_resources VALUES (?,?)').run(taskId, p.resourceId)
          this.db.prepare('INSERT INTO views VALUES (?,?,1,?,1,?,?,?,1)').run(p.viewId, surface.id, p.resourceId, json(p.bundle.state.initial), p.bundle.state.compatibility_version, runId)
          saveHistory(this.db, id(), taskId, p.viewId, 1, p.resourceId, p.bundle.state.initial, evidence, bundleResources(this.db, taskId, p.bundle))
          this.storage.commit(p.stageId, p.resourceId)
          layout.slots[0].groups.push({ id: id(), type: 'column', views: [p.viewId] })
        }
        this.db.prepare('UPDATE surfaces SET revision=revision+1,layout_json=? WHERE id=?').run(json(layout), surface.id)
        const data = { action_id: actionId, revision: surface.revision + 1, views: prepared.map(p => ({ client_ref: p.op.client_ref, view_id: p.viewId })) }
        this.record(taskId, 'surface.published', data)
        this.db.prepare("UPDATE actions SET state='ended',result='success',commit_valid=0,result_json=?,ended_at=? WHERE id=?").run(json(data), now(), actionId)
        this.registerPublishedChapters(taskId, prepared)
        return data
      })()
      return result
    } catch (error) {
      this.db.prepare("UPDATE actions SET state='ended',result='not_executed',commit_valid=0,result_json=?,ended_at=? WHERE id=?").run(json({ code: error instanceof ContractError ? error.code : 'SAVE_FAILED' }), now(), actionId)
      this.storage.failed(actionId)
      throw error
    }
  }
  private recoverableProductionProfile(work: LogicalWork, attempt: ExecutionAttempt): boolean {
    return attempt.profile_id === 'producer-output-v1' || attempt.profile_id === 'work-router-v1' && work.role === 'router' && repairRoutingWork(this.db, work.task_id, work.work_id)
  }
  private preservedShutdownWork(work: LogicalWork): boolean {
    if (work.purpose !== 'production' || !['producer', 'lightweight', 'integrator', 'router'].includes(work.role) || !['planned', 'queued', 'running', 'waiting'].includes(work.state)) return false
    const state = new RunnerWorkState(this.db, this.epoch)
    if (!work.current_attempt_id) return state.pendingAssignmentRecoveryFailure(work) === null
    const attempt = state.attempt(work.current_attempt_id)
    return !!state.clarifiedAssignment(work) || this.recoverableProductionProfile(work, attempt) && new RunnerHostRecovery(this.db, this.epoch).undispatchedAttempt(attempt.attempt_id)
  }
  private finish(taskId: string, runId: string, state: string, reason: string, runnerFinal = false): void {
    if (!runnerFinal && state === 'cancelled') {
      const row = this.db.prepare('SELECT chapter_update_id FROM runs WHERE id=? AND task_id=?').get(runId, taskId) as Row | undefined
      if (row?.chapter_update_id) {
        const chapters = this.chapters().state, update = chapters.update(taskId, row.chapter_update_id)
        if (update && !chapterTerminal.has(update.state) && update.state !== 'unknown') chapters.stage(taskId, update.update_id, 'cancelled', { reason })
      }
    }
    if (!runnerFinal && this.db.prepare('SELECT 1 FROM runner_runs WHERE run_id=?').get(runId)) {
      const core = this.one('SELECT state FROM runs WHERE id=? AND task_id=?', runId, taskId)
      if (!['running', 'waiting'].includes(core.state)) return
      const workState = new RunnerWorkState(this.db, this.epoch)
      const affected = this.db.transaction(() => {
        if (state === 'cancelled') this.record(taskId, 'runner.cancelled', { run_id: runId, scope: this.task(taskId).state === 'stopping' ? 'task' : 'run', reason })
        if (state === 'interrupted') this.db.prepare('UPDATE runs SET intended_terminal=COALESCE(intended_terminal,?),primary_reason=COALESCE(primary_reason,?) WHERE id=?').run(state, reason, runId)
        workState.closeRun(runId)
        const works = workState.taskWorks(taskId).filter(work => work.run_id === runId)
        const terminal = this.one('SELECT intended_terminal,primary_reason FROM runs WHERE id=?', runId)
        let affected: LogicalWork[] = []
        if (terminal.intended_terminal === 'interrupted' && terminal.primary_reason === 'host_shutdown') {
          affected = works.filter(work => !this.preservedShutdownWork(work)).flatMap(work => workState.revokeWork(work.work_id, { kind: 'failure', work_id: work.work_id }))
        } else if (works.length) affected = workState.revokeRun(runId, { kind: state === 'cancelled' ? 'cancellation' : 'failure', work_id: works[0]!.work_id })
        this.revokeRunActions(runId)
        return affected
      })()
      this.pluginCalls.cancelRun(runId); this.monty.cancelRun(runId)
      this.agents.get(runId)?.controller.abort()
      for (const worker of this.workers.values()) if (worker.owner.run_id === runId) worker.controller.abort()
      this.settleDependentRuns(taskId, affected, runId)
      this.aggregateWorkerRun(taskId, runId)
      this.pumpRunnerWorkers(taskId)
      return
    }
    const active = runnerFinal
      ? this.workersForRun(runId) || this.pluginCalls.busyRun(runId) || this.runnerCleanupPending(runId) || this.monty.busyRun(runId)
      : this.agents.has(runId) || this.pluginCalls.busyRun(runId) || this.pluginProcesses.cleaning(taskId)
    this.db.prepare("UPDATE runs SET commit_valid=0,intended_terminal=COALESCE(intended_terminal,?),primary_reason=COALESCE(primary_reason,?),state=?,wait_reason=?,ended_at=? WHERE id=? AND task_id=? AND state IN ('running','waiting')").run(state, reason, active ? 'waiting' : state, active ? 'ending_cleanup' : null, active ? null : now(), runId, taskId)
    this.monty.cancelRun(runId)
    this.pluginCalls.cancelRun(runId)
    this.agents.get(runId)?.controller.abort()
    this.db.prepare("UPDATE actions SET state='ended',result=COALESCE(result,'cancelled'),commit_valid=0,ended_at=? WHERE run_id=? AND state!='ended'").run(now(), runId)
    this.db.prepare("UPDATE approvals SET validity='revoked' WHERE action_id IN (SELECT id FROM actions WHERE run_id=?) AND validity='valid'").run(runId)
    for (const [approvalId, waiter] of this.approvalWaiters) {
      const owner = this.db.prepare('SELECT a.run_id FROM approvals p JOIN actions a ON a.id=p.action_id WHERE p.id=?').get(approvalId) as Row | undefined
      if (owner?.run_id === runId) { clearTimeout(waiter.timer); this.approvalWaiters.delete(approvalId); waiter.resolve() }
    }
    for (const waiter of this.surfaceWaiters.values()) if (waiter.runId === runId) waiter.resolve(false)
    const timer = this.timers.get(runId); if (timer) clearTimeout(timer); this.timers.delete(runId)
    if (!active && runnerFinal && !this.closed && !this.closing) queueMicrotask(() => {
      if (!this.closed && !this.closing) {
        void this.recoverRunnerWork().catch(() => {})
        this.pumpRunnerGoals(taskId)
        this.pumpRunnerWorkers(taskId)
        this.settleRunnerDeliveries(taskId)
      }
    })
  }
  private revokeRunActions(runId: string, attempts?: readonly string[]): void {
    const actions = (this.db.prepare("SELECT id,source_json FROM actions WHERE run_id=? OR json_extract(source_json,'$.owner.run_id')=?").all(runId, runId) as Row[]).filter(action => !attempts || attempts.includes(JSON.parse(action.source_json).owner?.attempt_id))
    for (const action of actions) {
      this.db.prepare('UPDATE actions SET commit_valid=0 WHERE id=?').run(action.id)
      this.db.prepare("UPDATE approvals SET validity='revoked' WHERE action_id=? AND validity='valid'").run(action.id)
    }
    const ids = new Set(actions.map(action => action.id))
    for (const approvalId of this.approvalWaiters.keys()) {
      const approval = this.db.prepare('SELECT action_id FROM approvals WHERE id=?').get(approvalId) as Row | undefined
      if (approval && ids.has(approval.action_id)) this.wakeApproval(approvalId)
    }
    for (const [actionId, waiter] of this.surfaceWaiters) if (ids.has(actionId)) waiter.resolve(false)
    for (const action of actions) this.pluginActions.cancel(action.id)
  }
  handle(raw: unknown): unknown {
    this.acceptWork()
    if (raw && typeof raw === 'object' && (raw as Row).type === 'host.runner.input') return this.runnerHostInput(raw as Row)
    if (raw && typeof raw === 'object' && (raw as Row).type === 'host.runner.flow') {
      const query = raw as Row
      if (typeof query.task_id !== 'string') fail('INVALID_REQUEST', 'Task is required for execution flow')
      this.task(query.task_id)
      return liveRunnerFlow(this.db, query, this.epoch, {
        checking: id => this.requests.checkingRequest(id),
        compositionWaiting: this.runnerCompositionMerges.has(query.task_id) || this.runnerCompositionWaiting.has(query.task_id),
        canCompose: (artifact, revision) => {
          try { this.runnerComposition().checkArtifact(query.task_id, artifact, revision); return true }
          catch (error) {
            if (error instanceof ContractError && ['RUNNER_DEPENDENCY_INVALID', 'RUNNER_OWNERSHIP_INVALID'].includes(error.code)) return false
            throw error
          }
        }
      })
    }
    if (raw && typeof raw === 'object' && (raw as Row).type === 'host.runner.status') {
      if (this.features.runner?.conversationRouting) fail('UNSUPPORTED_OPERATION', 'Open execution details from the originating message')
      const { type: _type, ...query } = raw as Row
      if (Object.keys(query).some(key => !['task_id', 'request_id', 'cursor', 'limit'].includes(key))) fail('INVALID_REQUEST', 'Invalid runner status lookup')
      return this.runnerGoals(query as unknown as TaskRunnerStatusQuery)
    }
    if (raw && typeof raw === 'object' && (raw as Row).type === 'host.run.activity') {
      const r = raw as Row
      if (Object.keys(r).sort().join(',') !== 'run_id,task_id,type' || typeof r.task_id !== 'string' || typeof r.run_id !== 'string') fail('INVALID_REQUEST', 'Invalid Run activity lookup')
      this.task(r.task_id); this.one('SELECT id FROM runs WHERE id=? AND task_id=?', r.run_id, r.task_id)
      return runActivity(this.db, r.task_id, r.run_id)
    }
    if (raw && typeof raw === 'object' && (raw as Row).type === 'host.messages.latest') {
      const r = raw as Row
      if (Object.keys(r).sort().join(',') !== 'task_id,type' || typeof r.task_id !== 'string') fail('INVALID_REQUEST', 'Invalid latest message lookup')
      this.task(r.task_id)
      const latest = (condition: string) => this.db.prepare(`SELECT id,kind,created_at FROM records WHERE task_id=? AND ${condition} ORDER BY sequence DESC LIMIT 1`).get(r.task_id) ?? null
      return { request: latest("kind='message.user'"), reply: latest("kind IN ('message.assistant','message.assistant.partial')") }
    }
    if (raw && typeof raw === 'object' && ['host.messages.page', 'host.messages.read'].includes((raw as Row).type)) {
      const r = raw as Row, page = r.type === 'host.messages.page'
      const fields = page ? ['type', 'task_id', 'before', 'after'] : ['type', 'task_id', 'message_id', 'cursor']
      if (Object.keys(r).some(key => !fields.includes(key)) || typeof r.task_id !== 'string' || !r.task_id || r.task_id.length > 200
        || [r.before, r.after, r.cursor].some(value => value !== undefined && (typeof value !== 'string' || !value || value.length > 4096))
        || (page ? r.before !== undefined && r.after !== undefined : typeof r.message_id !== 'string' || !r.message_id || r.message_id.length > 200)) fail('INVALID_REQUEST', 'Invalid task message lookup')
      return page ? this.queries.messages(r.task_id, r.before, r.after) : this.queries.messageText(r.task_id, r.message_id, r.cursor)
    }
    if (raw && typeof raw === 'object' && (raw as Row).type === 'host.run.accounting') {
      const r = raw as Row
      if (Object.keys(r).some(key => !['type', 'task_id', 'run_id', 'cursor'].includes(key)) || typeof r.task_id !== 'string' || typeof r.run_id !== 'string' || (r.cursor !== undefined && (typeof r.cursor !== 'string' || r.cursor.length > 2048))) fail('INVALID_REQUEST', 'Invalid paged Run accounting lookup')
      this.task(r.task_id)
      return this.queries.accounting(r.task_id, r.run_id, r.cursor)
    }
    if (raw && typeof raw === 'object' && (raw as Row).type === 'host.task.usage') {
      const r = raw as Row
      if (Object.keys(r).sort().join(',') !== 'task_id,type' || typeof r.task_id !== 'string' || !r.task_id || r.task_id.length > 200) fail('INVALID_REQUEST', 'Invalid task usage lookup')
      this.task(r.task_id)
      return this.queries.taskUsage(r.task_id)
    }
    if (raw && typeof raw === 'object' && (raw as Row).type === 'host.run.usage') {
      const r = raw as Row
      if (Object.keys(r).sort().join(',') !== 'run_id,task_id,type' || [r.task_id, r.run_id].some(id => typeof id !== 'string' || !id || id.length > 200)) fail('INVALID_REQUEST', 'Invalid Run usage lookup')
      this.task(r.task_id)
      return this.queries.runUsage(r.task_id, r.run_id)
    }
    if (raw && typeof raw === 'object' && (raw as Row).type === 'host.run.results') {
      const r = raw as Row
      if (Object.keys(r).sort().join(',') !== 'offset,run_id,task_id,type' || typeof r.task_id !== 'string' || typeof r.run_id !== 'string' || !Number.isSafeInteger(r.offset) || r.offset < 0) fail('INVALID_REQUEST', 'Invalid Run result lookup')
      this.task(r.task_id); this.one('SELECT id FROM runs WHERE id=? AND task_id=?', r.run_id, r.task_id)
      const from = "(SELECT id,'action' kind,state,result,created_at FROM actions WHERE task_id=? AND run_id=? UNION ALL SELECT id,'call' kind,state,execution result,created_at FROM calls WHERE task_id=? AND run_id=?)"
      const args = [r.task_id, r.run_id, r.task_id, r.run_id]
      const total = this.one(`SELECT count(*) n FROM ${from}`, ...args).n
      return { items: this.db.prepare(`SELECT * FROM ${from} ORDER BY created_at,id LIMIT 50 OFFSET ?`).all(...args, r.offset), total, offset: r.offset, notice: '只读原操作结果，不重放；success仅表示对应动作成功。' }
    }
    if (raw && typeof raw === 'object' && (raw as Row).type === 'host.views.page') {
      const r = raw as Row
      if (Object.keys(r).sort().join(',') !== 'expected_revision,offset,task_id,type' || typeof r.task_id !== 'string' || !Number.isSafeInteger(r.offset) || r.offset < 0 || r.offset % 10 || !Number.isSafeInteger(r.expected_revision)) fail('INVALID_REQUEST', 'Invalid View page')
      this.task(r.task_id)
      if (this.one('SELECT revision FROM surfaces WHERE task_id=?', r.task_id).revision !== r.expected_revision) fail('VERSION_CONFLICT', 'Surface changed; refresh before changing page')
      return this.snapshot(r.task_id, r.offset)
    }
    if (raw && typeof raw === 'object' && typeof (raw as Row).type === 'string' && (raw as Row).type.startsWith('export.')) return this.exportRequest(raw as Row)
    if (raw && typeof raw === 'object' && Object.keys(raw).length === 1 && (raw as Row).type === 'host.tasks') return this.tasks()
    if (raw && typeof raw === 'object' && typeof (raw as Row).type === 'string' && ((raw as Row).type.startsWith('model.') || (raw as Row).type === 'approval.configure')) { assertContract<import('../shared/contracts.generated').HostModelRequest>('host_model_request', raw); if ((raw as Row).type !== 'model.list') { this.recovery.assertWrite(); if (!['model.discover', 'model.probe', 'model.test', 'model.cancel', 'model.remember'].includes((raw as Row).type)) this.requests.invalidateConfiguration() }; return this.modelConfiguration(raw) }
    if (raw && typeof raw === 'object' && typeof (raw as Row).type === 'string' && (raw as Row).type.startsWith('plugin.')) return this.pluginConfiguration(raw)
    const r = validateIpc(raw)
    const reads = ['storage.status', 'task.query', 'host.tasks.page', 'task.snapshot', 'task.data.read', 'operation.list', 'material.list', 'material.status', 'material.read', 'request.list', 'request.status', 'chapter.status']
    if (!reads.includes(r.type) && !r.type.startsWith('maintenance.')) this.recovery.assertWrite(r.type === 'draft.save' ? r.maintenance_token : undefined)
    if (r.type.startsWith('request.')) {
      this.task((r as Row).task_id)
      if (r.type === 'request.cancel') this.chapterRoutes.get(r.request_id)?.controller.abort()
      return this.requests.handle(r)
    }
    if (r.type.startsWith('material.')) { this.task((r as Row).task_id); return this.materials.handle(r) }
    switch (r.type) {
      case 'chapters.map': this.task(r.task_id); return this.chapters().map(r.task_id, r.view_id, r.expected_view_revision)
      case 'chapter.update': return this.startChapterUpdate(r)
      case 'chapter.status': {
        this.task(r.task_id); this.chapters().reconcile(r.task_id)
        return this.chapters().state.update(r.task_id, r.update_id) ?? fail('NOT_FOUND', 'Chapter update is unavailable')
      }
      case 'chapter.cancel': {
        this.task(r.task_id)
        const chapters = this.chapters().state, update = chapters.update(r.task_id, r.update_id) ?? fail('NOT_FOUND', 'Chapter update is unavailable')
        if (!chapterTerminal.has(update.state) && update.state !== 'unknown') {
          chapters.stage(r.task_id, r.update_id, 'cancelled', { reason: 'user_cancelled' })
          this.cancelChapterExecution(r.task_id, r.update_id)
          this.record(r.task_id, 'chapter.update.ended', { update_id: r.update_id, state: 'cancelled' })
        }
        return chapters.update(r.task_id, r.update_id)
      }
      case 'maintenance.status': return { ...(this.recovery.status() as Row), gc: this.gc.status(), gc_enabled: (this.gc.status() as Row).enabled && (this.recovery.status() as Row).phase !== 'blocked', gc_scope: 'registered_staging_verified_replicas_and_deleted_task_resources' }
      case 'maintenance.begin': return this.recovery.begin(r.inputs)
      case 'maintenance.cancel': return this.recovery.cancel(r.token)
      case 'maintenance.restore': return this.recovery.restore(r.token, r.point_id, r.database_sha256)
      case 'maintenance.create': return this.recovery.create(r.token, r.replace_id)
      case 'maintenance.resource.list': return this.resourceCleanup.list(r.before, r.summary)
      case 'maintenance.resource.status': return this.resourceCleanup.status(r.operation_id)
      case 'maintenance.resource.preview': this.recovery.checkPreparation(r.token); return this.resourceCleanup.preview(r.token, r.operation_id)
      case 'maintenance.resource.execute': return this.recovery.collect(r.token, () => this.resourceCleanup.execute(r.token, r.operation_id, false))
      case 'maintenance.resource.retry': return this.recovery.collect(r.token, () => this.resourceCleanup.execute(r.token, r.operation_id, true))
      case 'maintenance.replica.list': return this.replicas.list(r.summary, r.before)
      case 'maintenance.replica.status': return this.replicas.status(r.operation_id, r.authorization_id)
      case 'maintenance.replica.preview': this.recovery.checkPreparation(r.token); return this.replicas.preview(r.token, r.replica_id)
      case 'maintenance.replica.execute': return this.recovery.collect(r.token, () => this.replicas.execute(r.token, r.operation_id, false))
      case 'maintenance.replica.retry': return this.recovery.collect(r.token, () => this.replicas.execute(r.token, r.operation_id, true))
      case 'maintenance.replica.reauthorize.preview': this.recovery.checkPreparation(r.token); return this.replicas.previewReauthorization(r.token, r.operation_id)
      case 'maintenance.replica.reauthorize.confirm': return this.replicas.reauthorizationConfirmed(r.operation_id, r.authorization_id) ? this.replicas.status(r.operation_id, r.authorization_id) : this.recovery.collect(r.token, () => this.replicas.confirmReauthorization(r.token, r.operation_id, r.authorization_id))
      case 'maintenance.gc.status': return this.gc.status(r.operation_id)
      case 'maintenance.gc.list': return this.gc.list(r.before)
      case 'maintenance.gc.preview': this.recovery.checkPreparation(r.token); return this.gc.preview(r.token, r.after)
      case 'maintenance.gc.execute': return this.recovery.collect(r.token, () => this.gc.execute(r.token, r.operation_id, false))
      case 'maintenance.gc.retry': return this.recovery.collect(r.token, () => this.gc.execute(r.token, r.operation_id, true))
      case 'storage.status': return this.storage.status(r.after)
      case 'storage.retry': return this.storage.retry(r.job_id)
      case 'task.query': return this.query(r.task_id, r.query)
      case 'host.tasks.page': {
        const now = Date.now()
        const discardActions = [...this.surfaceWaiters].filter(([, waiter]) => waiter.reset && Date.parse(waiter.expires) > now).map(([id]) => id)
        return this.queries.taskPage(r.input, r.archived ?? false, discardActions)
      }
      case 'sync.subscribe': return this.subscribe(r.task_id, r.view_offset, r.after)
      case 'context.status': this.task(r.task_id); return { current: this.currentSummary(r.task_id), notice: 'Model-generated lossy navigation; sources and current state take precedence' }
      case 'context.compact': return this.manualCompaction(r.task_id, r.model_config_id)
      case 'task.create': return this.create(r.title)
      case 'host.task.organize': {
        this.task(r.task_id)
        const current = this.db.prepare('SELECT archived,pin_order,archived_at FROM task_organization WHERE task_id=?').get(r.task_id) as { archived: number; pin_order: number | null; archived_at: number | null } | undefined
        const archived = r.field === 'archived' ? r.value : current?.archived === 1
        const pinned = r.field === 'pinned' ? r.value : current?.pin_order != null
        if (archived !== (current?.archived === 1) || pinned !== (current?.pin_order != null)) {
          const archivedAt = archived ? (current?.archived === 1 ? current.archived_at : Date.now()) : null
          this.db.prepare(`INSERT INTO task_organization(task_id,archived,pin_order,archived_at)
            VALUES (?,?,CASE WHEN ? THEN COALESCE(?,(SELECT COALESCE(MAX(pin_order),0)+1 FROM task_organization)) END,?)
            ON CONFLICT(task_id) DO UPDATE SET archived=excluded.archived,pin_order=excluded.pin_order,archived_at=excluded.archived_at`)
            .run(r.task_id, Number(archived), Number(pinned), current?.pin_order ?? null, archivedAt)
          this.queries.taskOrganizationChanged()
        }
        return { task_id: r.task_id, archived, pinned }
      }
      case 'task.snapshot': return this.snapshot(r.task_id, r.view_offset)
      case 'task.data.read': {
        this.task(r.task_id)
        const row = this.one('SELECT id,revision,schema_json,value_json FROM task_data WHERE id=? AND task_id=?', r.id, r.task_id)
        if (row.revision !== r.expected_revision) fail('VERSION_CONFLICT', 'Data revision changed; refresh the object list before reading')
        return { id: row.id, revision: row.revision, schema: JSON.parse(row.schema_json), value: JSON.parse(row.value_json) }
      }
      case 'task.submit': {
        if (this.features.runner?.conversationRouting && r.model_config_id !== 'fixture') fail('UNSUPPORTED_OPERATION', 'Submit a message through request.submit')
        return { run_id: this.start(r.task_id, r.text, r.model_config_id, r.attachments) }
      }
      case 'draft.save': if (r.maintenance_token) this.recovery.consumeInput(r.maintenance_token, r.task_id, r.view_id); return this.saveDraft(r)
      case 'answer.submit': return this.submitAnswer(r)
      case 'run.cancel': return this.db.transaction(() => {
        this.task(r.task_id)
        const run = this.one('SELECT id,request_id,state FROM runs WHERE id=? AND task_id=?', r.run_id, r.task_id)
        const routing = run.request_id && this.chapterRoutes.get(run.request_id)
        if (routing && routing.runId === run.id && ['running', 'waiting'].includes(run.state)) {
          this.requests.handle({ type: 'request.cancel', task_id: r.task_id, request_id: run.request_id })
          routing.controller.abort()
        }
        this.finish(r.task_id, r.run_id, 'cancelled', 'user_cancelled')
        return this.snapshot(r.task_id)
      })()
      case 'task.stop': {
        for (const [request, { controller }] of this.chapterRoutes) if (this.db.prepare('SELECT 1 FROM requests WHERE id=? AND task_id=?').get(request, r.task_id)) controller.abort()
        this.db.transaction(() => {
          this.task(r.task_id)
          this.db.prepare("UPDATE tasks SET state='stopping' WHERE id=?").run(r.task_id)
          this.db.prepare('UPDATE runs SET commit_valid=0 WHERE task_id=?').run(r.task_id)
          this.db.prepare('UPDATE actions SET commit_valid=0 WHERE task_id=?').run(r.task_id)
          this.db.prepare("UPDATE approvals SET validity='revoked' WHERE action_id IN (SELECT id FROM actions WHERE task_id=?) AND validity='valid'").run(r.task_id)
          const state = new RunnerWorkState(this.db, this.epoch)
          for (const row of this.db.prepare("SELECT run_id FROM runner_runs WHERE task_id=? AND json_extract(payload_json,'$.state') IN ('running','waiting','closing')").all(r.task_id) as Row[]) {
            state.closeRun(row.run_id)
            const work = state.taskWorks(r.task_id).find(work => work.run_id === row.run_id)
            if (work) state.revokeRun(row.run_id, { kind: 'cancellation', work_id: work.work_id })
          }
        })()
        for (const run of this.db.prepare("SELECT id FROM runs WHERE task_id=? AND state IN ('running','waiting')").all(r.task_id) as Row[]) this.finish(r.task_id, run.id, 'cancelled', 'task_stopped')
        this.pluginUploads.cancelTask(r.task_id)
        for (const pending of this.pluginIndependentCalls.values()) if (pending.task === r.task_id) pending.controller.abort()
        this.pluginDrafts.cancelTask(r.task_id); this.pluginActions.cancelTask(r.task_id); this.pluginCalls.cancelTask(r.task_id); this.pluginProcesses.stopTask(r.task_id); this.requests.cancelTask(r.task_id); this.materials.cancelTask(r.task_id)
        this.settlePluginCleanup()
        return this.snapshot(r.task_id)
      }
      case 'task.resume': this.settlePluginCleanup(); if (this.pluginProcesses.cleaning(r.task_id)) fail('PLUGIN_CLEANUP_PENDING', 'Wait for confirmed plugin process exit before resuming'); return this.db.transaction(() => { const task = this.task(r.task_id); if (task.state !== 'stopped') fail('INVALID_STATE', 'Only stopped tasks may resume'); this.db.prepare("UPDATE tasks SET state='active',revision=revision+1 WHERE id=?").run(r.task_id); return this.snapshot(r.task_id) })()
      case 'task.delete': this.task(r.task_id); void this.exportChecks.stop(r.task_id).catch(() => {}); if (this.monty.busy(r.task_id)) fail('MONTY_EXECUTION_ACTIVE', 'Stop calculation and wait for confirmed cleanup before deleting the task'); if ([...this.exportReaders.keys()].some(id => this.exports.get(id).task_id === r.task_id)) return Promise.all([...this.exportReaders.keys()].filter(id => this.exports.get(id).task_id === r.task_id).map(id => this.cancelExport(id))).then(() => this.handle(r)); this.exports.cancelTask(r.task_id); if (this.pluginProcesses.ownsTask(r.task_id) || this.pluginCalls.busy(r.task_id) || this.pluginActions.busy(r.task_id) || this.pluginUploads.busy(r.task_id)) fail('PLUGIN_EXECUTION_ACTIVE', 'Stop plugin work and wait for its recorded result before deleting the task'); this.recovery.invalidateForDelete(r.task_id, r.invalidate_recovery_id); this.handle({ type: 'task.stop', task_id: r.task_id }); this.db.prepare("UPDATE tasks SET state='deleting' WHERE id=?").run(r.task_id); if (!this.db.prepare("SELECT id FROM runs WHERE task_id=? AND state IN ('running','waiting')").get(r.task_id)) this.purge(r.task_id); return { deleted: true, resource_cleanup: 'retained_pending_explicit_confirmation' }
      case 'approval.decide': return this.decide(r.task_id, r.approval_id, r.decision, 'human')
      case 'surface.respond': return this.respondSurface(r)
      case 'operation.list': this.task(r.task_id); return boundedRecent((this.db.prepare("SELECT id,state,result,created_at,CASE WHEN length(CAST(result_json AS BLOB))<=4096 THEN result_json END result_json FROM actions WHERE task_id=? ORDER BY rowid DESC LIMIT ?").all(r.task_id, r.limit) as Row[]).map(row => ({ ...row, ...(row.result_json === null ? { detail_notice: '详情请按原动作 ID 读取；未重新执行' } : {}) })), 96 * 1024)
      default: return fail('UNSUPPORTED_OPERATION', 'This IPC method is not enabled in the development slice')
    }
  }
  private saveDraft(r: Extract<IpcRequest, { type: 'draft.save' }>): unknown {
    if (Buffer.byteLength(json(r.fields)) > defaults.data.object_bytes) fail('INPUT_TOO_LARGE', 'Draft too large')
    return this.db.transaction(() => {
      const v = this.view(r.task_id, r.view_id, r.view_revision, r.expected_state_revision), bundle = this.bundle(v.bundle_resource_id), draft = JSON.parse(v.draft_json)
      for (const field of r.fields) {
        fieldSchema(bundle.state.schema, field.path)
        if (!bundle.behaviors.some(b => (b.type === 'input' || b.type === 'toggle') && b.field === field.path)) fail('INVALID_FIELD', 'Field is not user editable')
        setField(draft, field.path, field.value)
      }
      checkDraft(bundle, draft)
      this.db.prepare('UPDATE views SET draft_json=?,state_revision=state_revision+1,auto_edit_valid=0 WHERE id=?').run(json(draft), v.id)
      return { state_revision: v.state_revision + 1 }
    })()
  }
  private submitAnswer(r: Extract<IpcRequest, { type: 'answer.submit' }>): unknown {
    return this.db.transaction(() => {
      const v = this.view(r.task_id, r.view_id, r.view_revision, r.expected_state_revision), bundle = this.bundle(v.bundle_resource_id), draft = JSON.parse(v.draft_json)
      const value = answerValues(bundle, draft, r.form_id), raw: Row = {}
      for (const field of bundle.forms.find(f => f.id === r.form_id)!.fields) { const val = getField(draft, field); if (val !== undefined) setField(raw, field, val) }
      const history = this.one('SELECT id FROM view_history WHERE view_id=? AND view_revision=? AND task_id=?', v.id, v.revision, r.task_id)
      const answerId = id(), eventId = this.record(r.task_id, 'answer.submitted', { answer_id: answerId, view_id: v.id, form_id: r.form_id })
      this.db.prepare('INSERT INTO answers VALUES (?,?,?,?,?,?,?,?)').run(answerId, r.task_id, history.id, r.form_id, json(raw), json(value), eventId, now())
      this.db.prepare('UPDATE views SET auto_edit_valid=0 WHERE id=?').run(v.id)
      return { answer_id: answerId, event_id: eventId }
    })()
  }
  private purge(taskId: string): void {
    // Marked deleting before cleanup; a crash can only resume deletion, never restore access.
    if(this.monty?.busy(taskId))return
    this.journal.beforeDelete(taskId, this.db)
    this.db.transaction(() => {
      purgeRunnerTask(this.db, taskId)
      this.db.prepare('DELETE FROM approvals WHERE action_id IN (SELECT id FROM actions WHERE task_id=?)').run(taskId)
      for (const table of ['answers', 'view_history', 'object_references', 'staging', 'cleanup_jobs', 'task_resources', 'task_data', 'actions', 'calls']) this.db.prepare(`DELETE FROM ${table} WHERE task_id=?`).run(taskId)
      this.db.prepare('DELETE FROM views WHERE surface_id IN (SELECT id FROM surfaces WHERE task_id=?)').run(taskId)
      for (const table of ['surfaces', 'runs', 'requests', 'records']) this.db.prepare(`DELETE FROM ${table} WHERE task_id=?`).run(taskId)
      this.db.prepare('DELETE FROM tasks WHERE id=?').run(taskId)
    })()

  }
}
