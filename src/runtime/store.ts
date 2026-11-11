import { newTestIdentityEncoding } from './file-format'
import { assertDirectorySync, managedRegularFile } from '../platform/files'
import { protectPrivatePath } from '../platform/permissions'
import { MontyCalls } from './monty/calls'
import { MONTY_ID, montyContract } from './monty/contract'
import { deadline } from './model/limits'
import Database from 'better-sqlite3'
import { randomUUID, createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import coreSql from '../shared/contracts/001-core.sql?raw'
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
import { RunBudget, runAgent } from './model/agent'
import { ContextRejectedError } from './model/capacity'
import { modelReadOptions } from './model/tool-input'
import { RepresentationPager } from './model/representation'
import { ReadCursors } from './model/read-cursor'
import { ModelError, type ChatMessage } from './model/adapter'
import defaults from '../shared/contracts/development-defaults.json'
import type { Bundle, IpcRequest, ModelRequest } from '../shared/contracts.generated'
import type { Snapshot, Task } from '../shared/types'
import { ContractError, assertContract, validateIpc, validateModel } from '../shared/validation'
import { answerValues, checkBundle, checkDraft, fieldSchema, getField, setField, schemaCheck } from './managed'
import { replacementDraft } from './surface-transition'
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
import { PluginProcesses, type PluginIdentity } from './plugins/process'
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

const id = () => randomUUID()
const now = () => new Date().toISOString()
const json = JSON.stringify
function fail(code: string, message: string): never { throw new ContractError(code, message) }
type Row = Record<string, any>
type SurfaceWrite = Extract<ModelRequest, { type: 'write' }> & { input: Extract<Extract<ModelRequest, { type: 'write' }>['input'], { type: 'surface.update' }> }
type SurfaceOperation = SurfaceWrite['input']['operations'][number]
type PreparedView = { op: Extract<SurfaceOperation, { type: 'view.create' | 'view.replace' | 'view.remove' }>; viewId: string; resourceId: string; stageId: string; hash: string; body: Buffer; bundle: Bundle; draft: Record<string, unknown>; auto: boolean; answers: number; direct: import('./export-control').ExportResource[]; source?: BundleSource }
export class RuntimeStore {
  private summaryPager = new RepresentationPager()
  private readCursors = new ReadCursors()
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
  private runDeadlines = new Map<string, () => void>()
  private storage!: StorageLifecycle
  private queries: ObjectQueries
  private root: string
  private sync = new TaskSync()
  private viewPages = new Map<string, number>()
  private syncFacts = new Map<string, { key: string; snapshot: Snapshot }>()
  private closed = false
  private closing = false
  private acceptWork(): void { if (this.closing || this.closed) fail('SHUTTING_DOWN', 'Host is shutting down; no new work is accepted') }
  private agents = new Map<string, { controller: AbortController; main: ModelLease; compact?: ModelLease; manualCompact?: boolean; compactOnly?: boolean; compactUnchanged?: string; messages?: ChatMessage[]; approval?: ModelLease; budget: RunBudget; mode: 'manual' | 'assisted' }>()
  private approvalMode: 'manual' | 'assisted' = 'manual'
  private approvalModel = ''
  private approvalWaiters = new Map<string, { resolve: () => void; timer: ReturnType<typeof setTimeout> }>()
  private surfaceWaiters = new Map<string, { taskId: string; runId: string | null; context?: PluginActionContext; request: SurfaceWrite; reset: boolean; expires: string; check(): void; resolve: (proceed: boolean | ContractError) => void; timer: ReturnType<typeof setTimeout> }>()
  private surfaceCompletions = new Map<string, { promise: Promise<void>; resolve(): void }>()
  constructor(directory: string, readonly models = new ModelService(), private features: { viewReplacement: boolean; monty?: boolean } = { viewReplacement: false }, private exportRunner?: ExportRunner, private appRuntime?: string, checkRunner: CheckRunner = backgroundCheck) {
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
    this.db = new Database(managedRegularFile(directory, this.journal.selected()))
    protectPrivatePath(managedRegularFile(directory, this.journal.selected()), 'file')
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = FULL')
    const version = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'").get()
    if (!version) this.db.transaction(() => { this.db.exec(coreSql); this.db.prepare('UPDATE schema_version SET applied_at=?').run(now()) })()
    const versions = this.db.prepare('SELECT version FROM schema_version ORDER BY version').all() as { version: number }[]
    if (versions.length !== 1 || versions[0]?.version !== 1) { fail('SCHEMA_VERSION', 'Unsupported database version; migration required') }
    this.storage = new StorageLifecycle(this.db, this.root, this.epoch, (action, task) => this.pluginActions?.owner(action, task) || this.pluginUploads?.owns(action, task) || false)
    this.recovery = new RecoveryManager(this.db, this.root, () => this.executionBusy(), held => this.storage.pause(held), () => ({ models: this.models.recoverySettings(), approval: { mode: this.approvalMode, model_id: this.approvalModel }, features: { ...this.features } }), this.journal, file => this.rebindDatabase(file), () => this.plugins.list(), () => this.pluginProcesses.stopForRebind())
    this.gc = new RestrictedGc(this.root, () => this.db, () => this.journal.selected(), () => this.journal.retainedDatabases(), key => this.exports.protects(key) || this.journal.resourceRetired(key) || this.recovery.protects(key), () => this.recovery.retainedPointIds(), file => this.journal.retired(file), file => this.journal.released(file), this.journal.identityEncoding)
    this.resourceCleanup = new ResourceCleanupManager(this.root, () => this.db, this.journal, this.recovery, this.gc)
    this.replicas = new ReplicaRetirement(this.root, this.journal, this.recovery, (exclude?: string) => this.gc.assertDependencies(exclude))
    this.materials = new MaterialImports(this.db, this.root, this.epoch, this.storage, this.journal, (task, kind, data) => { this.record(task, kind, data) })
    if ((this.recovery.status() as Row).phase !== 'blocked') this.db.transaction(() => {
      this.db.prepare("UPDATE runs SET state=COALESCE(intended_terminal,'interrupted'), primary_reason=COALESCE(primary_reason,'runtime_restart'), commit_valid=0,ended_at=? WHERE state IN ('running','waiting')").run(now())
      this.db.prepare("UPDATE calls SET state='ended',commit_valid=0,execution=COALESCE(execution,CASE WHEN dispatch='not_sent' THEN 'not_executed' ELSE 'unknown' END),ended_at=? WHERE state!='ended'").run(now())
      this.db.prepare("UPDATE actions SET state='ended',result=COALESCE(result,'not_executed'),commit_valid=0,ended_at=? WHERE state!='ended'").run(now())
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
    this.monty = new MontyCalls(this.db,this.root,this.storage,(task,run)=>{this.qualify(task,run)},(task,refs)=>this.validateDataReferences(task,refs),(task,kind,value)=>this.record(task,kind,value),this.appRuntime ?? process.execPath,!!this.features.monty)
    this.pluginDirectory = new PluginDirectory(this.root, this.plugins, this.monty.available ? {id:MONTY_ID,description:montyContract.description,contract:montyContract} : undefined)
    this.pluginQueries = new PluginQueries(this.pluginDirectory)
    this.pluginProcesses = new PluginProcesses(this.root, async (copy, task) => {
      this.acceptWork()
      this.task(task)
      if (!this.plugins.available(task, copy.digest)) fail('PLUGIN_DISABLED', 'Plugin is not currently enabled for this task')
      await this.plugins.executable(copy.digest)
    }, (identity, method, params) => this.pluginCallback(identity, method, params), () => { if (!this.closed) { this.pluginActions?.check(); this.pluginUploads?.check(); for (const pending of this.pluginIndependentCalls.values()) { try { pending.context.valid() } catch { pending.controller.abort() } } } }, this.appRuntime)
    this.pluginActions = new PluginActions(this.db, this.epoch, (identity, task) => this.qualifyPlugin(identity, task), (task, raw, context) => this.executePluginAction(task, raw, context), (identity, action, status) => this.pluginProcesses.changed(identity, action, status))
    this.pluginUploads = new PluginUploads(this.db, this.root, this.epoch, this.storage, (identity, task, call) => {
      this.qualifyPlugin({ ...identity, call_id: call }, task)
      if (identity.call_id !== call) fail('PLUGIN_UPLOAD_SOURCE_INVALID', 'Upload must belong to the active call on this connection')
      const source = this.pluginCalls.source(call), row = this.db.prepare('SELECT commit_valid,state FROM calls WHERE id=?').get(call) as Row | undefined
      if (!source || source.digest !== identity.digest || !row?.commit_valid || !['executing', 'finalizing'].includes(row.state)) fail('PLUGIN_UPLOAD_SOURCE_INVALID', 'Call is no longer executable')
    }, resource => this.journal.assertResource({ id: resource, storage_key: resource }), (identity, task) => this.qualifyPlugin(identity, task))
    this.pluginCalls = new PluginCalls(this.db, this.epoch, this.plugins, this.pluginDirectory, this.pluginProcesses, (task, references) => this.validateDataReferences(task, references as any), (task, kind, data) => { this.record(task, kind, data) }, call => this.pluginUploads.commit(call), (call, success) => { this.pluginUploads.settled(call, success); this.pluginActions.check() }, (task, call, instance, digest, global, bytes) => this.pluginUploads.receiveResult({ instance_id: instance, digest, task_id: global ? null : task, call_id: call }, task, call, bytes), this.derivations)
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
  private sourceValid(task: string, run: string | null, context?: PluginActionContext): void {
    if (context) context.valid()
    else if (run) this.qualify(task, run)
    else fail('SOURCE_INVALID', 'No live execution source')
  }
  private invokePlugin(task: string, run: string, input: Extract<ModelRequest, { type: 'call' }>['input'], signal: AbortSignal): Promise<unknown> {
    return this.pluginCalls.call(task, input.capability, input.arguments, input.references, { run_id: run, chain: [], signal, valid: () => { this.qualify(task, run) }, approve: (action, request, cancellation) => this.awaitApproval(task, run, action, request, cancellation, 'plugin-invoke-v1'), checkApproval: (action, request) => this.checkApproval(action, request, task, run, 'plugin-invoke-v1') })
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
      return Promise.resolve(this.query(target, query, 'plugin:' + identity.instance_id)).then(result => { if (!this.pluginProcesses.live(identity)) fail('PLUGIN_SOURCE_INVALID', 'Connection ended during query'); allowed(target); return result })
    }
    if (method === 'resources.read_bytes' || method === 'materials.derive') {
      const target = allowed(task)
      if (!identity.call_id) fail('PLUGIN_SOURCE_INVALID', 'Binary reads and derivation require a live Call')
      const call = identity.call_id!
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
      if (request.input.operations.some(op => op.type !== 'view.create') && !this.features.viewReplacement) fail('CAPABILITY_DISABLED', 'View replacement remains disabled')
      const context: PluginActionContext = { id: '', identity, signal: new AbortController().signal, valid: () => this.qualifyPlugin(identity, target) }
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
        if (action?.type === 'resource.upload') { const { type: _, ...declaration } = action; return this.pluginUploads.register(identity, allowed(task), declaration) }
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
    return new Promise((resolve, reject) => {
      void this.pluginCalls.call(task, request.input.capability, request.input.arguments, request.input.references, {
        run_id: active.source.run_id, parent_call_id: identity.call_id!, instance_id: identity.instance_id, chain: active.source.chain, budget: active.source.budget, signal: active.controller.signal, valid,
        approve: async (action, input, signal) => {
          const context: PluginActionContext = { id: action, identity, signal, valid }
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
    this.requests = new RequestQueue(this.db, this.epoch, config => this.requestSelection(config), (task, resource) => this.requestMaterial(task, resource), (task, text, config, attachments, request) => this.start(task, text, config, attachments, request), () => !this.closing && !this.closed && (this.recovery.status() as Row).phase === 'idle', async (task, resources) => {
      for (const resource of resources) {
        this.acceptWork()
        const row = this.one('SELECT r.* FROM resources r JOIN task_resources t ON t.resource_id=r.id WHERE t.task_id=? AND r.id=?', task, resource.id)
        await readPluginResource(this.root, row as any, 0, true)
        this.acceptWork()
        this.journal.assertResource(row)
        const current = this.one('SELECT r.* FROM resources r JOIN task_resources t ON t.resource_id=r.id WHERE t.task_id=? AND r.id=?', task, resource.id)
        if (json(current) !== json(row)) fail('REQUEST_MATERIAL_UNAVAILABLE', 'Material changed during final verification')
      }
    })
    if (this.closing) this.requests.close()
  }
  private requestSelection(config: string): Row {
    const list = this.models.list() as Row[]
    const main = config === 'fixture' ? { id: 'fixture', revision: 1 } : list.find(m => m.id === config)
    if (!main || (config !== 'fixture' && (!main.roles.includes('main') || main.credential_missing))) fail('MODEL_NOT_VERIFIED', 'Select an available verified main model')
    const approval = this.approvalMode === 'assisted' ? list.find(m => m.id === this.approvalModel) : undefined
    if (this.approvalMode === 'assisted' && (!approval || !approval.roles.includes('approval') || approval.credential_missing)) fail('MODEL_NOT_VERIFIED', 'Approval configuration is unavailable')
    return { id: config, revision: main.revision, ...(config !== 'fixture' ? { base_url: main.base_url, wire_model_id: main.wire_model_id, compatibility_profile: main.compatibility_profile } : {}), approval_mode: this.approvalMode, ...(approval ? { approval_id: approval.id, approval_revision: approval.revision } : {}) }
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
    this.requests?.close()
    this.materials.close()
    this.pluginDrafts.close(); for (const pending of this.pluginIndependentCalls.values()) pending.controller.abort(); this.pluginIndependentCalls.clear(); this.pluginUploads.close(); this.pluginActions.close(); this.pluginCalls.close(); this.pluginProcesses.close()
    this.storage.close()
    if (this.db.open) this.db.close()
    this.db = new Database(managedRegularFile(this.root, file), { fileMustExist: true })
    this.db.pragma('foreign_keys=ON'); this.db.pragma('journal_mode=WAL'); this.db.pragma('synchronous=FULL')
    this.epoch = id(); this.sync.clear(); this.syncFacts.clear()
    this.storage = new StorageLifecycle(this.db, this.root, this.epoch, (action, task) => this.pluginActions?.owner(action, task) || this.pluginUploads?.owns(action, task) || false)
    this.materials = new MaterialImports(this.db, this.root, this.epoch, this.storage, this.journal, (task, kind, data) => { this.record(task, kind, data) })
    this.storage.pause(true)
    this.queries.rebind(this.db)
    this.summaryPager.reset()
    this.readCursors.reset()
    this.initializePlugins()
    this.initializeRequests()
    return this.db
  }
  private executionBusy(): boolean {
    return !!(this.pluginProcesses?.cleaning() || this.monty?.busy() || this.exports?.busy() || this.requests?.busy() || this.agents.size || this.surfaceWaiters.size || this.surfaceCompletions.size || this.approvalWaiters.size || this.models.busy() || this.db.prepare("SELECT id FROM runs WHERE state IN ('running','waiting') UNION ALL SELECT id FROM actions WHERE state!='ended' UNION ALL SELECT id FROM calls WHERE state!='ended' UNION ALL SELECT id FROM cleanup_jobs WHERE necessary=1 AND state!='done' LIMIT 1").get())
  }
  private settlePluginCleanup(): void {
    if (this.closed || !this.db?.open) return
    for (const row of this.db.prepare("SELECT id,task_id FROM runs WHERE commit_valid=0 AND intended_terminal IS NOT NULL AND state IN ('running','waiting')").all() as Row[]) {
      if (!this.agents.has(row.id) && !this.pluginCalls.busyRun(row.id) && !this.pluginProcesses.cleaning(row.task_id)) this.db.prepare("UPDATE runs SET state=intended_terminal,wait_reason=NULL,ended_at=? WHERE id=?").run(now(), row.id)
    }
    for (const row of this.db.prepare("SELECT id FROM tasks WHERE state='stopping'").all() as Row[]) {
      if (!this.pluginProcesses.cleaning(row.id) && !this.pluginCalls.busy(row.id) && !this.pluginActions.busy(row.id) && !this.db.prepare("SELECT 1 FROM runs WHERE task_id=? AND state IN ('running','waiting')").get(row.id)) this.db.prepare("UPDATE tasks SET state='stopped',revision=revision+1 WHERE id=? AND state='stopping'").run(row.id)
    }
  }
  async shutdown(): Promise<void> {
    this.closing = true
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
    void this.exportChecks.stop().catch(() => {})
    if (this.monty?.busy()) fail('MONTY_CLEANUP_ACTIVE', 'Wait for calculation shutdown before closing storage')
    if (this.exportReaders.size) fail('EXPORT_GENERATION_ACTIVE', 'Wait for shutdown before closing an active export reader')
    this.pluginDrafts?.close(); for (const pending of this.pluginIndependentCalls.values()) pending.controller.abort(); this.pluginIndependentCalls.clear(); this.pluginUploads?.close(); this.pluginActions?.close(); this.pluginCalls?.close(); this.pluginProcesses?.close()
    this.closed = true
    this.requests?.close()
    this.materials.close()
    this.storage.close()
    for (const agent of this.agents.values()) agent.controller.abort()
    for (const waiter of this.approvalWaiters.values()) { clearTimeout(waiter.timer); waiter.resolve() }
    this.approvalWaiters.clear(); this.models.close()
    for (const waiter of this.surfaceWaiters.values()) { clearTimeout(waiter.timer); waiter.resolve(false) }; this.surfaceWaiters.clear()
    for (const completion of this.surfaceCompletions.values()) completion.resolve(); this.surfaceCompletions.clear()
    for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); for (const clear of this.runDeadlines.values()) clear(); this.runDeadlines.clear(); this.exports.close(); this.gc.close(); this.recovery.close(); this.journal.close(); this.plugins.close(); if (this.db.open) this.db.close(); this.owner.close() }
  private one(sql: string, ...args: unknown[]): Row { const row = this.db.prepare(sql).get(...args) as Row | undefined; if (!row) fail('NOT_FOUND', 'Object not found'); return row }
  private task(taskId: string): Row { const t = this.one('SELECT * FROM tasks WHERE id=?', taskId); if (t.state === 'deleting') fail('NOT_FOUND', 'Task deleted'); return t }
  tasks(): Task[] { return this.db.prepare("SELECT id,title,state,revision FROM tasks WHERE state!='deleting' ORDER BY rowid DESC").all() as Task[] }
  private record(taskId: string, kind: string, payload: unknown): string {
    const t = this.task(taskId), eventId = id()
    this.db.prepare('INSERT INTO records VALUES (?,?,?,?,?,?)').run(eventId, taskId, t.next_sequence, kind, json(payload), now())
    this.db.prepare('UPDATE tasks SET next_sequence=next_sequence+1,revision=revision+1 WHERE id=?').run(taskId)
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
  private resolveExportSelection(r: Row): { rows: Row[]; selected: Row[]; resources: Map<string, any>; input: ExportInput } {
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
    return { rows, selected, resources, input }
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
      const { rows, selected, input } = this.resolveExportSelection(r)
      const issues: Row[] = []
      const generated = generateExport(input, issue => {
        const original = issue.answer_index !== undefined, source = original ? selected[issue.answer_index!]! : rows[issue.view_index]!
        issues.push({ ...issue, source: original ? 'original_question' : 'current_view', view_id: original ? source.view_id : source.id, revision: original ? source.view_revision : source.revision, history_id: source.history_id, ...(original ? { answer_id: source.id } : {}) })
      })
      const offset = r.offset ?? 0
      return { complete: generated.issues.length === 0, selection_hash: createHash('sha256').update(json([input, issues, generated.issues])).digest('hex'), issues: issues.slice(offset, offset + 50), issue_count: issues.length, offset, next_offset: offset + 50 < issues.length ? offset + 50 : null, notice: 'Read-only check of this exact selection, including frozen original questions. No job or pin was created. Actual export validates again.' }
    }
    if (r.type === 'export.check.start') {
      if (Object.hasOwn(r, 'offset')) fail('INVALID_REQUEST', 'Start does not accept a diagnosis offset')
      if (this.exportChecks.busy()) fail('EXPORT_CHECK_BUSY', 'Cancel the active check and wait for worker exit before starting another')
      const request = JSON.parse(json(r)), resolved = this.resolveExportSelection(request)
      const identity = (value: typeof resolved) => json([value.rows.map(v => [v.id, v.revision, v.history_id, v.fragments]), value.selected.map(v => [v.id, v.history_id, v.view_revision]), value.input])
      const source = identity(resolved), captured = captureCheck(resolved.input), fingerprint = captured.fingerprint, epoch = this.epoch
      const current = resolved.rows.map(v => ({ view_id: v.id, revision: v.revision, history_id: v.history_id }))
      const originals = resolved.selected.map(v => ({ view_id: v.view_id, revision: v.view_revision, history_id: v.history_id, answer_id: v.id }))
      return this.exportChecks.start(r.task_id, captured, () => {
        if (this.closed || this.epoch !== epoch) fail('EXPORT_SOURCE_CHANGED', 'Runtime generation changed')
        this.task(request.task_id)
        const next = this.resolveExportSelection(request)
        if (identity(next) !== source || captureCheck(next.input).fingerprint !== fingerprint) fail('EXPORT_SOURCE_CHANGED', 'Selection or verified resource source changed')
      }, result => ({ ...result, issues: result.issues.map(issue => ({ ...issue, source: issue.answer_index === undefined ? 'current_view' : 'original_question', ...(issue.answer_index === undefined ? current[issue.view_index] : originals[issue.answer_index]) })) }))
    }
    if (r.type === 'export.check.status' || r.type === 'export.check.cancel') {
      if (Object.keys(r).filter(key => key !== 'offset').sort().join(',') !== 'check_id,task_id,type' || typeof r.check_id !== 'string' || (r.offset !== undefined && (r.type !== 'export.check.status' || !Number.isSafeInteger(r.offset) || r.offset < 0))) fail('INVALID_REQUEST', 'Invalid ephemeral check lookup')
      return r.type === 'export.check.cancel' ? this.exportChecks.cancel(r.task_id, r.check_id) : this.exportChecks.status(r.task_id, r.check_id, r.offset ?? 0)
    }
    if (r.type === 'export.prepare') {
      if (Object.hasOwn(r, 'offset')) fail('INVALID_REQUEST', 'Export prepare does not accept a diagnosis offset')
      this.recovery.assertWrite()
      const { rows, resources, input } = this.resolveExportSelection(r)
      const task = this.task(r.task_id), job = this.exports.create(task.id, this.epoch, this.journal.selected(), [...resources.values()], { version: 1, title: task.title, views: rows.map(v => ({ view_id: v.id, history_id: v.history_id, view_revision: v.revision, fragments: v.fragments })), answer_ids: r.answer_ids })
      if (!this.exportRunner) {
        try { const result = generateExport(input); this.exports.preview(job.id, result.html, result.issues); return { ...this.exports.public(job.id), html: result.html } }
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
  snapshot(taskId: string): Snapshot {
    this.settlePluginCleanup()
    const row = this.task(taskId)
    const task: Task = { id: row.id, title: row.title, state: row.state, revision: row.revision }
    const surface = this.one('SELECT * FROM surfaces WHERE task_id=?', taskId)
    const total = this.one('SELECT count(*) n FROM views WHERE surface_id=?', surface.id).n
    const offset = Math.min(this.viewPages.get(taskId) ?? 0, Math.max(0, Math.floor((total - 1) / 10) * 10))
    this.viewPages.set(taskId, offset)
    if (this.viewPages.size > 64) this.viewPages.delete(this.viewPages.keys().next().value!)
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
      return { id: v.id, revision: v.revision, state_revision: v.state_revision, draft: JSON.parse(v.draft_json), bundle: checked.bundle, presentation: { html: checked.html, css: checked.css, ...(error ? { error } : {}) } }
    })
    return {
      runtime_epoch: this.epoch, task, surface: { id: surface.id, revision: surface.revision, layout }, view_page: { offset, limit: 10, total },
      task_data: { items: this.db.prepare('SELECT id,revision FROM task_data WHERE task_id=? ORDER BY rowid DESC LIMIT 200').all(taskId) as { id: string; revision: number }[], total: this.one('SELECT count(*) AS total FROM task_data WHERE task_id=?', taskId).total },
      views,
      approval_total: this.one('SELECT count(*) n FROM approvals p JOIN actions a ON a.id=p.action_id WHERE a.task_id=?', taskId).n,
      record_total: this.one('SELECT count(*) n FROM records WHERE task_id=?', taskId).n,
      approvals: this.approvals(taskId),
      surface_updates: [...this.surfaceWaiters].filter(([, w]) => w.taskId === taskId).map(([action_id, w]) => ({ action_id, run_id: w.runId, request: { input: { operations: (w.request as Row).input.operations.map((op: Row) => ({ type: op.type, ...(op.view_id ? { view_id: op.view_id } : {}) })) } }, request_truncated: true, reset_requires_confirmation: w.reset, expires_at: w.expires })),
      runs: this.db.prepare('SELECT id,state,primary_reason,wait_reason,budget_json FROM runs WHERE task_id=? ORDER BY rowid DESC LIMIT 50').all(taskId) as Snapshot['runs'],
      records: boundedRecent((this.db.prepare("SELECT id,kind,created_at,CASE WHEN length(CAST(payload_json AS BLOB))<=4096 THEN payload_json ELSE json_object('text',substr(json_extract(payload_json,'$.text'),1,600),'truncated',json('true'),'original_event_id',id) END payload_json FROM records WHERE task_id=? ORDER BY sequence DESC LIMIT 200").all(taskId) as Row[]).map(r => ({ id: r.id, kind: r.kind, payload: snapshotValue(r.payload_json, { kind: 'event', id: r.id }), created_at: r.created_at })), 96 * 1024).reverse(),
      answer_total: this.one('SELECT count(*) AS n FROM answers WHERE task_id=?', taskId).n,
      answers: boundedRecent((this.db.prepare("SELECT id,created_at,CASE WHEN length(CAST(raw_json AS BLOB))+length(CAST(value_json AS BLOB))<=4096 THEN raw_json ELSE 'null' END raw_json,CASE WHEN length(CAST(raw_json AS BLOB))+length(CAST(value_json AS BLOB))<=4096 THEN value_json END value_json FROM answers WHERE task_id=? ORDER BY rowid DESC LIMIT 200").all(taskId) as Row[]).map(a => ({ id: a.id, raw: JSON.parse(a.raw_json), value: a.value_json === null ? null : JSON.parse(a.value_json), ...(a.value_json === null ? { truncated: true } : {}), created_at: a.created_at })), 96 * 1024).reverse()
    }
  }
  private subscribe(task: string, after?: { runtime_epoch: string; sequence: number }): unknown {
    this.settlePluginCleanup()
    this.task(task)
    const facts = json([
      this.one('SELECT revision FROM tasks WHERE id=?', task), this.viewPages.get(task) ?? 0,
      this.db.prepare('SELECT revision,state_revision FROM views WHERE surface_id IN (SELECT id FROM surfaces WHERE task_id=?) ORDER BY id').all(task),
      this.db.prepare('SELECT state,wait_reason,primary_reason,budget_json FROM runs WHERE task_id=? ORDER BY rowid DESC LIMIT 50').all(task),
      this.approvals(task),
      [...this.surfaceWaiters].filter(([, value]) => value.taskId === task).map(([key]) => key)
    ])
    let cached = this.syncFacts.get(task)
    if (!cached || cached.key !== facts) { cached = { key: facts, snapshot: this.snapshot(task) }; this.syncFacts.set(task, cached) }
    if (this.syncFacts.size > 8) for (const key of this.syncFacts.keys()) if (key !== task) { this.syncFacts.delete(key); break }
    return this.sync.subscribe(cached.snapshot, after)
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
  start(taskId: string, text: string, config: string, attachments: unknown[], queuedRequestId?: string): string {
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
      if (this.db.prepare("SELECT id FROM runs WHERE task_id=? AND state IN ('running','waiting')").get(taskId)) fail('RUN_BUSY', 'An unfinished Run already exists')
      if (queuedRequestId) {
        const request = this.one("SELECT state,input_json FROM requests WHERE id=? AND task_id=?", requestId, taskId)
        if (request.state !== 'queued' || JSON.parse(request.input_json).epoch !== this.epoch) fail('REQUEST_SOURCE_INVALID', 'Request is no longer eligible')
        this.db.prepare("UPDATE requests SET state='started',input_json=? WHERE id=?").run(json({ ...JSON.parse(request.input_json), bound_materials: boundMaterials, code: null }), requestId)
      } else this.db.prepare("INSERT INTO requests VALUES (?,?,'started',?,?,?)").run(requestId, taskId, json({ id: config, revision: main?.revision ?? 1, approval_id: approval?.id, approval_revision: approval?.revision, approval_mode: this.approvalMode }), json({ text, attachments }), now())
      this.db.prepare("INSERT INTO runs (id,task_id,request_id,state,runtime_epoch,limits_json,budget_json,created_at) VALUES (?,?,?,'running',?,?,?,?)").run(runId, taskId, requestId, this.epoch, json({ ...defaults, run: main?.config.limits ?? {}, output_policy: main?.config.max_output_tokens === undefined ? 'service-default' : 'configured' }), json({ model_requests: 0, tool_requests: 0, tokens: 0, fixture: config === 'fixture' }), now())
      this.record(taskId, 'message.user', { text, run_id: runId, ...(queuedRequestId ? { request_id: requestId, materials: boundMaterials } : {}) })
    })()
    } catch (e) { main?.release(); compact?.release(); approval?.release(); throw e }
    if (main) {
      const controller = new AbortController(), budget = new RunBudget(main.config)
      this.accountLease(taskId, runId, main); if (compact) this.accountLease(taskId, runId, compact); if (approval) this.accountLease(taskId, runId, approval)
      this.agents.set(runId, { controller, main, compact, approval, budget, mode: this.approvalMode })
      this.runDeadlines.set(runId, deadline(main.config.limits?.run_wall_ms, () => { this.finish(taskId, runId, 'failed', 'RUN_WALL_LIMIT') }))
      void this.agent(taskId, runId, text)
    } else this.timers.set(runId, setTimeout(() => { this.timers.delete(runId); this.fixture(taskId, runId, text) }, 150))
    return runId
  }
  private accountLease(taskId: string, runId: string, lease: ModelLease): void {
    lease.evidence = (event: RequestEvidence) => {
      this.qualify(taskId, runId)
      assertContract('request_evidence', event)
      if (Buffer.byteLength(json({ ...event, run_id: runId })) > 1048576) throw new ModelError('CONTEXT_RECORD_LIMIT')
      return this.db.transaction(() => this.record(taskId, 'model.request.evidence', { ...event, run_id: runId }))()
    }
    lease.accounting = (event: RequestAccounting) => {
      if (this.closed || !this.db.open) throw new ModelError('ACCOUNTING_UNAVAILABLE')
      assertContract('request_accounting', event)
      this.db.transaction(() => {
        this.one('SELECT state FROM runs WHERE id=? AND task_id=?', runId, taskId)
        if (['reserved', 'dispatched'].includes(event.phase)) this.qualify(taskId, runId)
        // Late accounting is factual only: it never resumes a terminal Run.
        this.record(taskId, 'model.request.accounting', { ...event, run_id: runId })
      })()
    }
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
    this.runDeadlines.set(runId, deadline(main.config.limits?.run_wall_ms, () => this.finish(taskId, runId, 'failed', 'RUN_WALL_LIMIT')))
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
      case 'model.test': return this.models.test(raw.model_id, raw.role, raw.operation_id)
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
    return boundedRecent((this.db.prepare("SELECT p.id,p.action_id,p.decision,p.validity,p.handling,p.mode,p.expires_at,CASE WHEN length(CAST(p.evaluation_json AS BLOB))<=4096 THEN p.evaluation_json ELSE NULL END evaluation_json,CASE WHEN length(CAST(CASE WHEN json_extract(p.binding_json,'$.version')=2 THEN json_extract(p.binding_json,'$.resolved') ELSE a.request_json END AS BLOB))<=4096 THEN CASE WHEN json_extract(p.binding_json,'$.version')=2 THEN json_extract(p.binding_json,'$.resolved') ELSE a.request_json END END request_json,a.run_id,a.result FROM approvals p JOIN actions a ON a.id=p.action_id WHERE a.task_id=? ORDER BY CASE WHEN p.decision='pending' AND p.validity='valid' THEN 0 ELSE 1 END,a.rowid DESC LIMIT 100").all(taskId) as Row[]).map(p => ({ id: p.id, action_id: p.action_id, run_id: p.run_id, decision: p.decision, validity: p.validity, handling: p.handling, mode: p.mode, expires_at: p.expires_at, request: p.request_json ? JSON.parse(p.request_json) : { type: 'long_request', source: { kind: 'action', id: p.action_id } }, ...(p.request_json ? {} : { request_truncated: true }), evaluation: p.evaluation_json ? snapshotValue(p.evaluation_json, { kind: 'approval', id: p.id }) : null, result: p.result })), 96 * 1024)
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
    return this.queries.query(taskId, source, request, false, this.agents.get(source)?.controller.signal)
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
  private resourceCreate(taskId: string, runId: string | null, input: Extract<Extract<ModelRequest, { type: 'write' }>['input'], { type: 'resource.create' }>, context?: PluginActionContext): unknown {
    const serialized = input.content.type === 'text' ? input.content.text : json(input.content.value)
    const body = Buffer.from(serialized)
    if (input.content.type === 'text' && body.toString('utf8') !== serialized) fail('INVALID_DATA', 'Text must contain valid Unicode scalar values')
    if (body.length > defaults.resource.inline_bytes || Buffer.byteLength(json(input)) > defaults.transport.rpc_message_bytes) fail('RESOURCE_LIMIT', 'Inline resource exceeds the bounded text/JSON limit')
    const actionId = context?.id ?? id(), resourceId = id(), stageId = id(), sha256 = digest(body)
    if (!context) this.db.prepare("INSERT INTO actions (id,task_id,run_id,kind,state,source_json,request_json,commit_valid,created_at) VALUES (?,?,?,'mutation','registered',?,?,1,?)").run(actionId, taskId, runId, json({ type: 'run', id: runId, level: 'task' }), json(input), now())
    try {
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
  private dataWrite(taskId: string, runId: string | null, input: Extract<ModelRequest, { type: 'write' }>['input'] & { type: 'task_data.create' | 'task_data.replace' | 'task_data.remove' }, signal: AbortSignal, context?: PluginActionContext): Promise<unknown> {
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
  }
  private async awaitApproval(taskId: string, runId: string | null, actionId: string, input: unknown, signal: AbortSignal, policy = 'task-data-v1', context?: PluginActionContext, resolved?: { version: number; effective_request: unknown; sources: BundleSource[] }): Promise<void> {
    const agent = runId ? this.agents.get(runId) : undefined, mode = policy === 'task-data-remove-v1' ? 'manual' : agent?.mode ?? 'manual', approvalId = id(), expiry = new Date(Date.now() + defaults.approval.ttl_ms).toISOString()
    this.db.transaction(() => {
      this.sourceValid(taskId, runId, context)
      this.db.prepare("UPDATE actions SET state='waiting',wait_reason='approval' WHERE id=?").run(actionId)
      this.db.prepare('INSERT INTO approvals VALUES (?,?,\'pending\',\'valid\',?,?,?,NULL,?)').run(approvalId, actionId, mode, mode === 'assisted' ? 'evaluating' : 'awaiting_human', expiry, json({ action_id: actionId, task_id: taskId, run_id: runId, runtime_epoch: this.epoch, request: json(input), policy, created_at: now(), ...(resolved ? { version: 2, resolved } : {}) }))
      this.db.prepare("UPDATE runs SET state='waiting',wait_reason='approval' WHERE id=?").run(runId)
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
    const assessment = mode === 'assisted' && agent?.approval && runId ? this.assess(taskId, runId, approvalId, resolved?.effective_request ?? input, agent, assessmentController.signal) : Promise.resolve()
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
      if (context?.identity.call_id) { this.pluginProcesses.waiting(context.identity.call_id, false); if (!this.closed) this.db.prepare("UPDATE calls SET wait_reason=NULL WHERE id=? AND wait_reason='plugin_approval'").run(context.identity.call_id) }
      if (!this.closed && runId) this.db.prepare("UPDATE runs SET state='running',wait_reason=NULL WHERE id=? AND commit_valid=1").run(runId)
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
      const p = this.one('SELECT p.*,a.task_id,a.run_id,a.commit_valid,a.state AS action_state FROM approvals p JOIN actions a ON a.id=p.action_id WHERE p.id=? AND a.task_id=?', approvalId, taskId)
      if (p.validity !== 'valid' || p.decision !== 'pending' || !p.commit_valid || p.action_state !== 'waiting') fail('APPROVAL_INVALID', 'Approval is no longer pending/executable')
      if (Date.parse(p.expires_at) <= Date.now()) { this.expireApproval(approvalId); fail('APPROVAL_EXPIRED', 'Approval expired') }
      if (p.run_id) this.qualify(taskId, p.run_id)
      else { const source = this.pluginInvocationSources.get(p.action_id); if (source) source.valid(); else if (!this.pluginActions.owner(p.action_id, taskId)) fail('PLUGIN_SOURCE_INVALID', 'Independent action source ended') }
      if (actor === 'human' && p.handling !== 'awaiting_human') fail('APPROVAL_EVALUATING', 'Assisted evaluation is still in progress')
      this.db.prepare("UPDATE approvals SET decision=?,handling='resolved',evaluation_json=? WHERE id=?").run(decision, json({ ...(p.evaluation_json ? JSON.parse(p.evaluation_json) : {}), decided_by: actor, decided_at: now(), reason: reason ?? 'Explicit host UI choice' }), approvalId)
      this.wakeApproval(approvalId)
      return { decision, validity: 'valid', action_id: p.action_id }
    })()
  }
  private async assess(taskId: string, runId: string, approvalId: string, input: unknown, agent: { approval?: ModelLease; controller: AbortController; budget: RunBudget }, signal: AbortSignal): Promise<void> {
    const lease = agent.approval!
    const surface = (input as { type?: string }).type === 'surface.update'
    const messages: ChatMessage[] = [{ role: 'system', content: approvalTemplate }, { role: 'user', content: json({ source: { type: 'run', id: runId, task_id: taskId, level: 'task' }, action: input, permission: surface ? 'This exact Surface View replacement only. Input discard requires separate human confirmation; your approval cannot supply it. No trust, deletion, new capability or cross-task permission.' : 'This exact existing task_data replacement only. No trust, deletion, input discard, new capability or cross-task permission.', user_request: this.one('SELECT q.input_json FROM requests q JOIN runs r ON r.request_id=q.id WHERE r.id=?', runId).input_json }) }]
    try {
      const reservation = agent.budget.reserve(messages, undefined, lease.config, 'approval-input')
      this.db.prepare('UPDATE runs SET budget_json=? WHERE id=?').run(json(agent.budget.state), runId)
      const response = await this.models.request(lease, taskId, messages, undefined, signal, undefined, lease.config.max_output_tokens, undefined, 'approval')
      this.qualify(taskId, runId); agent.budget.settle(reservation, response)
      const evaluation: unknown = JSON.parse(response.text)
      assertContract<{ decision: 'approve' | 'deny' | 'escalate'; reason: string }>('approval_decision', evaluation)
      const approval = this.one('SELECT * FROM approvals WHERE id=?', approvalId)
      if (approval.validity !== 'valid' || approval.decision !== 'pending') return
      this.db.prepare('UPDATE approvals SET evaluation_json=? WHERE id=?').run(json({ ...evaluation, model_id: lease.id, model_revision: lease.revision, template: 'approval-v0.1' }), approvalId)
      if (evaluation.decision === 'escalate') this.db.prepare("UPDATE approvals SET handling='awaiting_human' WHERE id=?").run(approvalId)
      else this.decide(taskId, approvalId, evaluation.decision, 'model', evaluation.reason)
    } catch (e) {
      if (this.closed || signal.aborted) return
      if (e instanceof ContextRejectedError) { this.finish(taskId, runId, 'failed', this.recordContextRejection(taskId, runId, e, lease)); return }
      if (e instanceof ModelError && (e.code.includes('BUDGET') || e.code === 'RUN_WALL_LIMIT')) { this.finish(taskId, runId, 'failed', e.code); return }
      this.db.prepare("UPDATE approvals SET handling='awaiting_human',evaluation_json=? WHERE id=? AND decision='pending' AND validity='valid'").run(json({ error: e instanceof ModelError ? e.code : 'INVALID_APPROVAL_RESPONSE', template: 'approval-v0.1' }), approvalId)
    } finally { if (!this.closed) this.db.prepare('UPDATE runs SET budget_json=? WHERE id=?').run(json(agent.budget.state), runId) }
  }
  private inspectReplacement(taskId: string, runId: string | null, input: SurfaceWrite['input'], context?: PluginActionContext): PreparedView[] {
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
      let draft = bundle.state.initial as Record<string, unknown>, auto = true, answers = 0
      if (op.type === 'view.replace' || op.type === 'view.remove') {
        const current = this.view(taskId, viewId, op.expected_view_revision, op.type === 'view.remove' ? op.expected_state_revision : op.state_transition.expected_state_revision)
        if (current.surface_id !== surface.id) fail('INVALID_TARGET', 'View is not in the requested Surface')
        draft = op.type === 'view.remove' ? JSON.parse(current.draft_json) : replacementDraft(this.bundle(current.bundle_resource_id), bundle, JSON.parse(current.draft_json), op.state_transition)
        auto = op.type !== 'view.remove' && runId !== null && current.creator_run_id === runId && current.auto_edit_valid === 1
        answers = this.one('SELECT count(*) AS count FROM answers a JOIN view_history h ON h.id=a.view_history_id WHERE h.view_id=? AND a.task_id=?', viewId, taskId).count
        const denied = this.db.prepare("SELECT a.request_json FROM approvals p JOIN actions a ON a.id=p.action_id WHERE a.run_id=? AND p.decision='deny'").all(runId) as Row[]
        if (denied.some(a => { const r = JSON.parse(a.request_json); return r.type === 'surface.update' && r.operations.some((item: Row) => (item.type === 'view.replace' || item.type === 'view.remove') && item.view_id === viewId) })) fail('APPROVAL_DENIED', 'View replacement was denied in this Run; a new explicit request is required')
      }
      const body = Buffer.from(json(bundle))
      return { op, viewId, resourceId: id(), stageId: id(), hash: createHash('sha256').update(body).digest('hex'), body, bundle, draft, auto, answers, source: loaded.source, direct: bundleResources(this.db, taskId, bundle) }
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
  private async replaceSurface(taskId: string, runId: string | null, request: SurfaceWrite, signal: AbortSignal, context?: PluginActionContext): Promise<unknown> {
    if (!this.features.viewReplacement) fail('CAPABILITY_DISABLED', 'View replacement is not yet verified and remains disabled')
    const input = request.input, prepared = this.inspectReplacement(taskId, runId, input, context)
    const resolved = prepared.some(p => p.source) ? { version: 1, effective_request: { ...input, operations: input.operations.map(op => { const p = prepared.find(p => p.op === op); return p?.source && op.type !== 'view.remove' && op.type !== 'layout.set' ? { ...op, bundle: { type: 'inline', bundle: p.bundle } } : op }) }, sources: prepared.filter(p => p.source).map(p => p.source!) } : undefined
    const evidence = captureEvidence(this.db, this.root, taskId, input.snapshot_sources)
    const check = (verifyFiles = true) => { this.checkSurfaceVersions(taskId, runId, input, prepared, context); checkEvidence(this.db, this.root, taskId, evidence, verifyFiles) }
    const actionId = context?.id ?? id(), needsApproval = prepared.some(p => !p.auto) || input.operations.some(op => op.type === 'layout.set')
    if (!context) this.db.prepare("INSERT INTO actions (id,task_id,run_id,kind,state,source_json,request_json,commit_valid,created_at) VALUES (?,?,?,'mutation','registered',?,?,1,?)").run(actionId, taskId, runId, json({ type: 'run', id: runId, level: 'task' }), json(input), now())
    try {
      if (needsApproval) await this.awaitApproval(taskId, runId, actionId, input, signal, 'surface-replace-v1', context, resolved)
      check()
      // All reset operations require explicit host confirmation, even with an empty draft.
      const confirmation = await this.awaitSurfaceHost(taskId, runId, actionId, request, signal, check, context)
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
        if (Date.parse(confirmation.expires_at) <= Date.now()) fail('CONFIRMATION_EXPIRED', 'Host confirmation expired before commit')
        check(false)
        const action = this.one('SELECT * FROM actions WHERE id=? AND task_id=?', actionId, taskId)
        if (!action.commit_valid || action.state === 'ended' || signal.aborted) fail('SOURCE_INVALID', 'Action is no longer executable')
        if (needsApproval) this.checkApproval(actionId, input, taskId, runId, 'surface-replace-v1', resolved)
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
        this.db.prepare('UPDATE surfaces SET revision=revision+1,layout_json=? WHERE id=?').run(json(layout), surface.id)
        const result = { action_id: actionId, revision: surface.revision + 1, views }
        this.record(taskId, 'surface.published', result)
        this.db.prepare("UPDATE actions SET state='ended',wait_reason=NULL,result='success',commit_valid=0,authorization_json=?,result_json=?,ended_at=? WHERE id=?").run(json({ basis: needsApproval ? 'single_approval' : 'default', host_checked: true, reset_confirmed: prepared.some(p => p.op.type === 'view.replace' && p.op.state_transition.type === 'reset'), confirmed_by: 'human', ...confirmation }), json(result), now(), actionId)
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
        this.db.prepare("UPDATE runs SET state='running',wait_reason=NULL WHERE id=? AND commit_valid=1").run(runId)
      }
    }
  }
  private checkSurfaceVersions(taskId: string, runId: string | null, input: SurfaceWrite['input'], prepared: PreparedView[], context?: PluginActionContext): void {
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
      if (p.auto && (current.creator_run_id !== runId || !current.auto_edit_valid)) fail('AUTHORIZATION_CHANGED', 'Automatic modification eligibility changed')
    }
  }
  private async awaitSurfaceHost(taskId: string, runId: string | null, actionId: string, request: SurfaceWrite, signal: AbortSignal, check: () => void, context?: PluginActionContext): Promise<{ confirmed_at: string; expires_at: string }> {
    this.sourceValid(taskId, runId, context)
    const expires = new Date(Date.now() + defaults.approval.ttl_ms).toISOString()
    const reset = request.input.operations.some(op => op.type === 'view.remove' || op.type === 'view.replace' && op.state_transition.type === 'reset')
    this.db.prepare("UPDATE actions SET state='waiting',wait_reason='surface_host' WHERE id=? AND commit_valid=1").run(actionId)
    this.db.prepare("UPDATE runs SET state='waiting',wait_reason='surface_host' WHERE id=? AND commit_valid=1").run(runId)
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
  private publish(taskId: string, runId: string | null, request: Extract<ModelRequest, { type: 'write' }>, context?: PluginActionContext): unknown {
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
        return data
      })()
      return result
    } catch (error) {
      this.db.prepare("UPDATE actions SET state='ended',result='not_executed',commit_valid=0,result_json=?,ended_at=? WHERE id=?").run(json({ code: error instanceof ContractError ? error.code : 'SAVE_FAILED' }), now(), actionId)
      this.storage.failed(actionId)
      throw error
    }
  }
  private finish(taskId: string, runId: string, state: string, reason: string): void {
    const active = this.agents.has(runId) || this.pluginCalls.busyRun(runId) || this.pluginProcesses.cleaning(taskId)
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
    this.runDeadlines.get(runId)?.(); this.runDeadlines.delete(runId)
  }
  handle(raw: unknown): unknown {
    this.acceptWork()
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
    if (raw && typeof raw === 'object' && (raw as Row).type === 'host.run.accounting') {
      const r = raw as Row
      if (Object.keys(r).some(key => !['type', 'task_id', 'run_id', 'cursor'].includes(key)) || typeof r.task_id !== 'string' || typeof r.run_id !== 'string' || (r.cursor !== undefined && (typeof r.cursor !== 'string' || r.cursor.length > 2048))) fail('INVALID_REQUEST', 'Invalid paged Run accounting lookup')
      this.task(r.task_id)
      return this.queries.accounting(r.task_id, r.run_id, r.cursor)
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
      const previous = this.viewPages.get(r.task_id)
      this.viewPages.set(r.task_id, r.offset); this.syncFacts.delete(r.task_id)
      try { return this.snapshot(r.task_id) }
      catch (error) { if (previous === undefined) this.viewPages.delete(r.task_id); else this.viewPages.set(r.task_id, previous); throw error }
    }
    if (raw && typeof raw === 'object' && typeof (raw as Row).type === 'string' && (raw as Row).type.startsWith('export.')) return this.exportRequest(raw as Row)
    if (raw && typeof raw === 'object' && Object.keys(raw).length === 1 && (raw as Row).type === 'host.tasks') return this.tasks()
    if (raw && typeof raw === 'object' && typeof (raw as Row).type === 'string' && ((raw as Row).type.startsWith('model.') || (raw as Row).type === 'approval.configure')) { assertContract<import('../shared/contracts.generated').HostModelRequest>('host_model_request', raw); if ((raw as Row).type !== 'model.list') { this.recovery.assertWrite(); if (!['model.discover', 'model.probe', 'model.cancel', 'model.remember'].includes((raw as Row).type)) this.requests.invalidateConfiguration() }; return this.modelConfiguration(raw) }
    if (raw && typeof raw === 'object' && typeof (raw as Row).type === 'string' && (raw as Row).type.startsWith('plugin.')) return this.pluginConfiguration(raw)
    const r = validateIpc(raw)
    const reads = ['storage.status', 'task.query', 'host.tasks.page', 'task.snapshot', 'task.data.read', 'operation.list', 'material.list', 'material.status', 'material.read', 'request.list', 'request.status']
    if (!reads.includes(r.type) && !r.type.startsWith('maintenance.')) this.recovery.assertWrite(r.type === 'draft.save' ? r.maintenance_token : undefined)
    if (r.type.startsWith('request.')) { this.task((r as Row).task_id); return this.requests.handle(r) }
    if (r.type.startsWith('material.')) { this.task((r as Row).task_id); return this.materials.handle(r) }
    switch (r.type) {
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
      case 'maintenance.replica.status': return this.replicas.status(r.operation_id)
      case 'maintenance.replica.preview': this.recovery.checkPreparation(r.token); return this.replicas.preview(r.token, r.replica_id)
      case 'maintenance.replica.execute': return this.recovery.collect(r.token, () => this.replicas.execute(r.token, r.operation_id, false))
      case 'maintenance.replica.retry': return this.recovery.collect(r.token, () => this.replicas.execute(r.token, r.operation_id, true))
      case 'maintenance.gc.status': return this.gc.status(r.operation_id)
      case 'maintenance.gc.list': return this.gc.list(r.before)
      case 'maintenance.gc.preview': this.recovery.checkPreparation(r.token); return this.gc.preview(r.token, r.after)
      case 'maintenance.gc.execute': return this.recovery.collect(r.token, () => this.gc.execute(r.token, r.operation_id, false))
      case 'maintenance.gc.retry': return this.recovery.collect(r.token, () => this.gc.execute(r.token, r.operation_id, true))
      case 'storage.status': return this.storage.status(r.after)
      case 'storage.retry': return this.storage.retry(r.job_id)
      case 'task.query': return this.query(r.task_id, r.query)
      case 'host.tasks.page': return this.queries.query('', 'host', { type: 'list', input: r.input }, true)
      case 'sync.subscribe': return this.subscribe(r.task_id, r.after)
      case 'context.status': this.task(r.task_id); return { current: this.currentSummary(r.task_id), notice: 'Model-generated lossy navigation; sources and current state take precedence' }
      case 'context.compact': return this.manualCompaction(r.task_id, r.model_config_id)
      case 'task.create': return this.create(r.title)
      case 'task.snapshot': return this.snapshot(r.task_id)
      case 'task.data.read': {
        this.task(r.task_id)
        const row = this.one('SELECT id,revision,schema_json,value_json FROM task_data WHERE id=? AND task_id=?', r.id, r.task_id)
        if (row.revision !== r.expected_revision) fail('VERSION_CONFLICT', 'Data revision changed; refresh the object list before reading')
        return { id: row.id, revision: row.revision, schema: JSON.parse(row.schema_json), value: JSON.parse(row.value_json) }
      }
      case 'task.submit': return { run_id: this.start(r.task_id, r.text, r.model_config_id, r.attachments) }
      case 'draft.save': if (r.maintenance_token) this.recovery.consumeInput(r.maintenance_token, r.task_id, r.view_id); return this.saveDraft(r)
      case 'answer.submit': return this.submitAnswer(r)
      case 'run.cancel': return this.db.transaction(() => { this.task(r.task_id); this.one('SELECT id FROM runs WHERE id=? AND task_id=?', r.run_id, r.task_id); this.finish(r.task_id, r.run_id, 'cancelled', 'user_cancelled'); return this.snapshot(r.task_id) })()
      case 'task.stop': this.pluginUploads.cancelTask(r.task_id); for (const pending of this.pluginIndependentCalls.values()) if (pending.task === r.task_id) pending.controller.abort(); this.pluginDrafts.cancelTask(r.task_id); this.pluginActions.cancelTask(r.task_id); this.pluginCalls.cancelTask(r.task_id); this.pluginProcesses.stopTask(r.task_id); this.requests.cancelTask(r.task_id); this.materials.cancelTask(r.task_id); return this.db.transaction(() => { this.task(r.task_id); this.db.prepare("UPDATE tasks SET state='stopping' WHERE id=?").run(r.task_id); for (const run of this.db.prepare("SELECT id FROM runs WHERE task_id=? AND state IN ('running','waiting')").all(r.task_id) as Row[]) this.finish(r.task_id, run.id, 'cancelled', 'task_stopped'); this.settlePluginCleanup(); return this.snapshot(r.task_id) })()
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
      this.db.prepare('DELETE FROM approvals WHERE action_id IN (SELECT id FROM actions WHERE task_id=?)').run(taskId)
      for (const table of ['answers', 'view_history', 'object_references', 'staging', 'cleanup_jobs', 'task_resources', 'task_data', 'actions', 'calls']) this.db.prepare(`DELETE FROM ${table} WHERE task_id=?`).run(taskId)
      this.db.prepare('DELETE FROM views WHERE surface_id IN (SELECT id FROM surfaces WHERE task_id=?)').run(taskId)
      for (const table of ['surfaces', 'runs', 'requests', 'records']) this.db.prepare(`DELETE FROM ${table} WHERE task_id=?`).run(taskId)
      this.db.prepare('DELETE FROM tasks WHERE id=?').run(taskId)
    })()

  }
}
