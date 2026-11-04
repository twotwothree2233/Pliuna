import { ContractError, assertContract } from '../../shared/validation'
import { randomUUID } from 'node:crypto'
import type { HostModelRequest, ModelConfiguration } from '../../shared/contracts.generated'
import { modelTools } from './tools'
import defaults from '../../shared/contracts/development-defaults.json'
import { ChatAdapter, ModelError, endpoint, type ChatMessage, type Completion, type ToolDefinition } from './adapter'
import { legacyMetadata, unknownCapabilities } from './metadata'
import { modelProtocol } from './protocol'
import { deadline } from './limits'
import { requestAccounting, type RequestAccounting, type RequestPurpose } from './accounting'
import type { ModelPersistence, SavedConnection } from './persistence'
import { requestEvidence, type RequestEvidence, type RequestLink } from './request-evidence'
import { capacityPlan } from './capacity'

interface Configuration { config: ModelConfiguration; key: string; channel: string; roles: Set<'main' | 'approval' | 'compaction'>; locks: number; revision: number; remembered?: boolean; credentialMissing?: boolean }
interface Job { task: string; channel: string; signal: AbortSignal; run: () => Promise<unknown>; resolve: (v: any) => void; reject: (e: unknown) => void; abort: () => void }
export class ModelScheduler {
  private active = 0
  private channels = new Map<string, number>()
  private pending: Job[] = []
  private taskOrder: string[] = []
  private lastTask: string | undefined
  schedule<T>(task: string, channel: string, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    if (signal.aborted) return Promise.reject(new ModelError('MODEL_CANCELLED'))
    if (this.pending.length >= defaults.queues.model_pending_app) return Promise.reject(new ModelError('MODEL_QUEUE_FULL'))
    return new Promise<T>((resolve, reject) => {
      const job: Job = { task, channel, signal, run, resolve, reject, abort: () => { const index = this.pending.indexOf(job); if (index >= 0) { this.pending.splice(index, 1); reject(new ModelError('MODEL_CANCELLED')); this.pump() } } }
      if (!this.taskOrder.includes(task)) this.taskOrder.push(task)
      this.pending.push(job); signal.addEventListener('abort', job.abort, { once: true }); this.pump()
    })
  }
  private pump(): void {
    while (this.active < defaults.queues.model_active_app) {
      const eligible = (j: Job) => !j.signal.aborted && (this.channels.get(j.channel) ?? 0) < defaults.queues.model_active_channel
      this.taskOrder = this.taskOrder.filter(task => task === this.lastTask || this.pending.some(job => job.task === task))
      let index = -1
      const start = this.lastTask === undefined ? 0 : this.taskOrder.indexOf(this.lastTask) + 1
      for (let n = 0; n < this.taskOrder.length; n++) {
        const task = this.taskOrder[(start + n) % this.taskOrder.length]!
        index = this.pending.findIndex(job => job.task === task && eligible(job))
        if (index >= 0) break
      }
      if (index < 0) return
      const job = this.pending.splice(index, 1)[0]!
      this.lastTask = job.task
      job.signal.removeEventListener('abort', job.abort)
      if (job.signal.aborted) { job.reject(new ModelError('MODEL_CANCELLED')); continue }
      this.active++; this.channels.set(job.channel, (this.channels.get(job.channel) ?? 0) + 1)
      Promise.resolve().then(() => { if (job.signal.aborted) throw new ModelError('MODEL_CANCELLED'); return job.run() }).then(job.resolve, job.reject).finally(() => {
        this.active--; this.channels.set(job.channel, this.channels.get(job.channel)! - 1); this.pump()
      })
    }
  }
}
export interface ModelLease { id: string; revision: number; config: ModelConfiguration; release: () => void; accounting?: (event: RequestAccounting) => void; evidence?: (event: RequestEvidence) => string }
export class ModelService {
  private configurations = new Map<string, Configuration>()
  private allControllers = new Set<AbortController>()
  private lifetime = new AbortController()
  private operations = new Map<string, AbortController>()
  private saving = false
  private storage = { available: false, backend: 'unavailable', error: '' }
  constructor(readonly adapter = new ChatAdapter(), private scheduler = new ModelScheduler(), private persistence?: ModelPersistence, private protocol = modelProtocol) {}
  async restore(): Promise<void> {
    if (!this.persistence) return
    try {
      const loaded = await this.persistence.load()
      this.storage = { available: loaded.available, backend: loaded.backend, error: loaded.error ?? '' }
      if (loaded.error) return
      const restored = new Map<string, Configuration>()
      for (const raw of loaded.records) {
        const saved = raw as SavedConnection
        if (!saved || !Number.isSafeInteger(saved.revision) || saved.revision < 1 || typeof saved.protocol !== 'string' || !Array.isArray(saved.roles) || saved.roles.some(role => role !== 'main' && role !== 'approval' && role !== 'compaction') || (saved.key !== null && typeof saved.key !== 'string')) throw new Error()
        const entry = this.prepare({ type: 'model.configure', configuration: saved.configuration, api_key: saved.key ?? '', confirm_memory_only: true }, saved.key === null)
        if (restored.has(entry.config.id)) throw new Error()
        entry.revision = saved.revision; entry.remembered = true; entry.credentialMissing = saved.key === null
        if (saved.protocol === this.protocol && !entry.credentialMissing) entry.roles = new Set(saved.roles)
        restored.set(entry.config.id, entry)
        // Validate shared channel invariants against the entries already restored.
        this.configurations = restored
      }
    } catch { this.configurations.clear(); this.storage.error = this.storage.backend === 'plain-file' ? 'SETTINGS_READ_FAILED' : 'SECURE_STORAGE_READ_FAILED' }
  }
  storageStatus(): unknown { return this.storage }
  recoverySettings(): ModelConfiguration[] { return [...this.configurations.values()].map(entry => structuredClone(entry.config)) }
  busy(): boolean { return this.saving || this.operations.size > 0 || this.allControllers.size > 0 || [...this.configurations.values()].some(e => e.locks > 0) }
  private idle(): void { if (this.saving) throw new ContractError('CONFIGURATION_BUSY', 'Secure configuration update is in progress') }
  private prepare(input: unknown, credentialMissing = false): Configuration {
    this.idle()
    assertContract<HostModelRequest>('host_model_request', input)
    if (input.type !== 'model.configure') throw new ContractError('INVALID_REQUEST', 'Expected model.configure')
    const config = input.configuration
    endpoint(config.base_url, 'chat/completions')
    if (config.id === 'fixture') throw new ContractError('INVALID_CONFIGURATION', 'Distinct model ID is required')
    this.checkKey(input.api_key)
    const previous = this.configurations.get(config.id), channel = new URL(config.base_url).origin
    if (previous?.locks) throw new ContractError('CONFIGURATION_BUSY', 'Model configuration is occupied')
    for (const [id, entry] of this.configurations) {
      if (id === config.id) continue
      if (entry.channel !== channel) continue
      // One origin is one credential boundary; model-specific fields remain independent.
      const sharedChanged = entry.config.base_url !== config.base_url || (!entry.credentialMissing && !credentialMissing && entry.key !== input.api_key) || entry.config.compatibility_profile !== config.compatibility_profile
      if (sharedChanged) throw new ContractError(entry.locks ? 'CONFIGURATION_BUSY' : 'CHANNEL_CONFIGURATION_CONFLICT', 'Shared channel address, profile and credential must remain consistent')
    }
    const same = previous && JSON.stringify(previous.config) === JSON.stringify(config) && previous.key === input.api_key && !previous.credentialMissing
    return { config: structuredClone(config), key: input.api_key, roles: same ? new Set(previous.roles) : new Set(), locks: 0, revision: same ? previous.revision : (previous?.revision ?? 0) + 1, channel }
  }
  configure(input: unknown): unknown {
    const entry = this.prepare(input)
    this.configurations.set(entry.config.id, entry)
    return this.list()
  }
  private async persist(next: Map<string, Configuration>): Promise<void> {
    this.idle()
    if (this.storage.backend === 'plain-file' && (!this.storage.available || this.storage.error)) throw new ContractError(this.storage.error || 'SETTINGS_UNAVAILABLE', 'Settings files are unavailable; inspect files before saving again')
    if (!this.persistence || !this.storage.available || this.storage.error) throw new ContractError(this.storage.error || 'SECURE_STORAGE_UNAVAILABLE', 'Secure storage is unavailable; nothing was saved and no plaintext fallback is permitted')
    const records: SavedConnection[] = [...next.values()].filter(entry => entry.remembered).map(entry => ({ configuration: entry.config, key: entry.credentialMissing ? null : entry.key, revision: entry.revision, protocol: this.protocol, roles: [...entry.roles] }))
    this.saving = true
    try { await this.persistence.save(records) }
    catch (error) {
      if (this.storage.backend === 'plain-file') {
        const code = error instanceof Error && /^SETTINGS_[A-Z_]+$/.test(error.message) ? error.message : 'SETTINGS_WRITE_FAILED'
        this.storage.error = code === 'SETTINGS_TIMEOUT' ? 'SETTINGS_RESULT_UNKNOWN' : code
        throw new ContractError(this.storage.error, 'Settings save did not complete; restart and inspect actual files before retrying. No automatic replay')
      }
      if (error instanceof Error && error.message === 'SECURE_STORAGE_TIMEOUT') {
        this.storage.error = 'SECURE_STORAGE_RESULT_UNKNOWN'
        throw new ContractError('SECURE_STORAGE_RESULT_UNKNOWN', 'Secure write result is unknown; do not retry. Restart and inspect the restored configuration')
      }
      throw new ContractError('SECURE_STORAGE_WRITE_FAILED', 'Secure configuration write failed; previous state was retained')
    }
    finally { this.saving = false }
  }
  async configureConnection(raw: unknown): Promise<unknown> {
    assertContract<HostModelRequest>('host_model_request', raw)
    if (raw.type !== 'model.configure') throw new ContractError('INVALID_REQUEST', 'Expected model.configure')
    if (raw.remember_connection && !(this.storage.backend === 'plain-file' ? raw.confirm_plaintext_storage : raw.confirm_secure_storage)) throw new ContractError('CONFIRMATION_REQUIRED', 'Explicitly confirm the selected credential storage')
    let input = raw
    if (raw.use_saved_credential) {
      const previous = this.entry(raw.configuration.id)
      if (previous.credentialMissing || raw.api_key || previous.config.base_url !== raw.configuration.base_url || previous.config.compatibility_profile !== raw.configuration.compatibility_profile) throw new ContractError('CREDENTIAL_REQUIRED', 'Reusing a credential requires the same saved address and profile')
      input = { ...raw, api_key: previous.key }
    }
    const previous = this.configurations.get(raw.configuration.id), target = raw.configuration.compaction_model_id
    if (target && target !== raw.configuration.id) {
      const compact = this.entry(target)
      if (!compact.roles.has('compaction') || compact.credentialMissing) throw new ContractError('MODEL_NOT_VALIDATED', 'Select an explicitly validated compaction role')
      const binding = { id: target, revision: compact.revision, base_url: compact.config.base_url }
      if (!raw.confirm_history_processing && JSON.stringify(previous?.config.compaction_target) !== JSON.stringify(binding)) throw new ContractError('CONFIRMATION_REQUIRED', 'Explicitly confirm task history processing by the selected compaction service')
      input = { ...input, configuration: { ...input.configuration, compaction_target: binding } }
    } else {
      const { compaction_target: _target, ...configuration } = input.configuration
      input = { ...input, configuration }
    }
    const entry = this.prepare(input)
    entry.remembered = raw.remember_connection === true
    const next = new Map(this.configurations).set(entry.config.id, entry)
    if (entry.remembered || previous?.remembered) await this.persist(next)
    this.configurations = next
    return this.list()
  }
  async remember(id: string): Promise<void> {
    this.idle(); const entry = this.entry(id)
    if (entry.locks) throw new ContractError('CONFIGURATION_BUSY', 'Model configuration is occupied')
    const next = new Map(this.configurations).set(id, { ...entry, remembered: true })
    await this.persist(next); this.configurations = next
  }
  async deleteCredential(id: string): Promise<void> {
    this.idle(); const entry = this.entry(id)
    const affected = [...this.configurations].filter(([, other]) => other.channel === entry.channel)
    if (affected.some(([, other]) => other.locks)) throw new ContractError('CONFIGURATION_BUSY', 'Related channel is occupied')
    const next = new Map(this.configurations)
    for (const [modelId, other] of affected) next.set(modelId, { ...other, key: '', credentialMissing: true, roles: new Set(), revision: other.revision + 1 })
    if (affected.some(([, other]) => other.remembered)) await this.persist(next)
    this.configurations = next
  }
  async removeConnection(id: string): Promise<void> {
    this.idle(); const entry = this.entry(id)
    if (entry.locks) throw new ContractError('CONFIGURATION_BUSY', 'Model configuration is occupied')
    const next = new Map(this.configurations); next.delete(id)
    if (entry.remembered) await this.persist(next)
    this.configurations = next
  }
  list(): unknown { return [...this.configurations].map(([id, e]) => ({ ...e.config, id, revision: e.revision, roles: [...e.roles], occupied: e.locks > 0 || this.saving, credential_storage: e.remembered ? (this.storage.backend === 'plain-file' ? 'plain-file' : 'system-secure') : 'memory-only', credential_missing: !!e.credentialMissing, metadata: { ...(e.config.metadata ?? legacyMetadata()), capabilities: { ...unknownCapabilities(), ...(e.roles.has('main') ? { tools: 'supported', streaming: 'supported' } : {}), ...(e.roles.has('approval') ? { structured_output: 'supported' } : {}) } } })) }
  private entry(id: string): Configuration { const entry = this.configurations.get(id); if (!entry) throw new ContractError('MODEL_NOT_CONFIGURED', 'Model configuration is absent; configure and explicitly test it'); return entry }
  private checkKey(key: string): void {
    if (/[^\x21-\x7e]/.test(key)) throw new ContractError('INVALID_CREDENTIAL', 'Credential must contain visible ASCII only; remove whitespace')
  }
  cancel(operationId: string): unknown {
    const controller = this.operations.get(operationId)
    if (!controller) throw new ContractError('MODEL_OPERATION_NOT_FOUND', 'Operation has already ended or is absent; query configuration state')
    controller.abort()
    return { cancellation_requested: true }
  }
  private async operation<T>(operationId: string | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const id = operationId ?? randomUUID()
    if (this.operations.has(id)) throw new ContractError('MODEL_OPERATION_BUSY', 'Operation ID is still in use')
    if (this.operations.size >= defaults.queues.model_pending_app) throw new ModelError('MODEL_QUEUE_FULL')
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal])
    this.operations.set(id, controller)
    try {
      const value = await run(signal)
      if (signal.aborted) throw new ModelError('MODEL_CANCELLED')
      return value
    } catch (error) {
      if (controller.signal.aborted || this.lifetime.signal.aborted) throw new ModelError('MODEL_CANCELLED')
      throw error
    } finally { this.operations.delete(id) }
  }
  async probe(input: unknown): Promise<unknown> {
    assertContract<HostModelRequest>('host_model_request', input)
    if (input.type !== 'model.probe') throw new ContractError('INVALID_REQUEST', 'Expected model.probe')
    endpoint(input.base_url, 'models'); this.checkKey(input.api_key)
    // This connection-only request creates no model configuration or enabled role.
    return this.operation(input.operation_id, signal => this.scheduler.schedule<unknown>('configuration:' + input.operation_id, new URL(input.base_url).origin, signal,
      () => input.include_metadata ? this.adapter.catalogue({ base_url: input.base_url }, input.api_key, signal) : this.adapter.discover({ base_url: input.base_url }, input.api_key, signal)))
  }
  remove(id: string): void {
    this.idle()
    const entry = this.entry(id)
    if (entry.locks) throw new ContractError('CONFIGURATION_BUSY', 'Related channel is occupied')
    entry.key = ''; this.configurations.delete(id)
  }
  acquire(id: string, role: 'main' | 'approval' | 'compaction'): ModelLease {
    this.idle()
    const entry = this.entry(id)
    if (!entry.roles.has(role)) throw new ContractError('MODEL_NOT_VALIDATED', 'Role must pass an explicit synthetic test before use')
    entry.locks++
    let released = false
    return { id, revision: entry.revision, config: structuredClone(entry.config), release: () => { if (!released) { released = true; entry.locks-- } } }
  }
  acquireCompaction(main: ModelLease): ModelLease | undefined {
    const target = main.config.compaction_model_id
    if (!target || target === main.id) return undefined
    const entry = this.entry(target), binding = main.config.compaction_target
    if (!binding || binding.id !== target || binding.revision !== entry.revision || binding.base_url !== entry.config.base_url) throw new ContractError('COMPACTION_CONFIGURATION_CHANGED', 'Compaction service changed; explicitly select and confirm it again before sending history')
    return this.acquire(target, 'compaction')
  }
  async request(lease: ModelLease, task: string, messages: ChatMessage[], tools: ToolDefinition[] | undefined, signal: AbortSignal, onText?: (text: string) => void, outputLimit?: number, onStart?: () => void, purpose: RequestPurpose = 'main', onRequest?: (link: RequestLink) => void): Promise<Completion> {
    const requestId = randomUUID()
    const entry = this.entry(lease.id)
    if (entry.revision !== lease.revision) throw new ContractError('CONFIGURATION_CHANGED', 'Configuration changed')
    const record = requestAccounting(lease, messages, tools, outputLimit, purpose, requestId)
    record('reserved')
    let dispatched = false
    try {
      const evidenceId = lease.evidence?.(requestEvidence(messages, requestId, purpose))
      if (evidenceId) onRequest?.({ request_id: requestId, evidence_event_id: evidenceId })
      const result = await this.send(entry, task, signal, inner => {
        onStart?.(); record('dispatched'); dispatched = true
        return this.adapter.complete(lease.config, entry.key, messages, tools, inner, onText, outputLimit)
      })
      record('completed', result.usage ?? null)
      return evidenceId ? { ...result, request_link: { request_id: requestId, evidence_event_id: evidenceId } } : result
    } catch (error) {
      let reason = error instanceof ModelError || error instanceof ContractError ? error.code : 'MODEL_REQUEST_FAILED'
      if (error instanceof ModelError && error.code === 'INVALID_TOOL_ARGUMENTS' && error.inputDiagnostic) {
        const location = /offset (\d+).*line (\d+), column (\d+)/.exec(error.inputDiagnostic)
        if (location) reason += `; outer JSON UTF16 offset=${location[1]} line=${location[2]} column=${location[3]}`
      }
      record(dispatched ? 'unknown' : 'failed', error instanceof ModelError ? error.usage ?? null : null, reason)
      throw error
    }
  }
  private async send<T>(entry: Configuration, task: string, signal: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const combined = AbortSignal.any([signal, this.lifetime.signal])
    return this.scheduler.schedule(task, entry.channel, combined, async () => {
      const controller = new AbortController(), abort = () => controller.abort()
      combined.addEventListener('abort', abort, { once: true }); if (combined.aborted) controller.abort()
      const clear = deadline(entry.config.limits?.request_timeout_ms, () => controller.abort())
      this.allControllers.add(controller)
      try { return await run(controller.signal) }
      catch (e) { if (controller.signal.aborted && !combined.aborted) throw new ModelError('MODEL_TIMEOUT', e instanceof ModelError && e.partial, false, e instanceof ModelError ? e.usage : undefined); throw e }
      finally { clear(); combined.removeEventListener('abort', abort); this.allControllers.delete(controller) }
    })
  }
  async discover(id: string, operationId?: string, metadata = false): Promise<unknown> {
    this.idle()
    const entry = this.entry(id); entry.locks++
    if (entry.credentialMissing) { entry.locks--; throw new ContractError('CREDENTIAL_REQUIRED', 'Credential was deleted; enter a new credential') }
    try { return await this.operation(operationId, signal => this.send<unknown>(entry, 'configuration:' + id, signal, inner => metadata ? this.adapter.catalogue(entry.config, entry.key, inner) : this.adapter.discover(entry.config, entry.key, inner))) }
    finally { entry.locks-- }
  }
  async test(id: string, role: 'main' | 'approval' | 'compaction', operationId?: string): Promise<unknown> {
    this.idle()
    const entry = this.entry(id)
    if (entry.credentialMissing) throw new ContractError('CREDENTIAL_REQUIRED', 'Credential was deleted; enter a new credential')
    if (entry.locks) throw new ContractError('CONFIGURATION_BUSY', 'Role validation cannot change while the model is occupied')
    entry.locks++
    const messages: ChatMessage[] = role === 'main' ? [{ role: 'user', content: 'Synthetic capability test only. First call list exactly once with {"kind":"capability"}. After receiving the synthetic tool result reply TRELLIS_OK, with no further tools. Do not perform any business operation.' }] : role === 'compaction' ? [{ role: 'user', content: 'Synthetic compaction format test only. Summarize this synthetic goal in plain text: continue the synthetic task. Do not use tools.' }] : [{ role: 'user', content: 'Synthetic approval format test only. Return exactly {"decision":"escalate","reason":"synthetic test"} with no tools or other text.' }]
    const tools: ToolDefinition[] | undefined = role === 'main' ? modelTools : undefined
    const outputLimit = entry.config.max_output_tokens
    let invalidated = false
    try {
      const unverified = new Set(entry.roles); unverified.delete(role)
      if (entry.remembered) await this.persist(new Map(this.configurations).set(id, { ...entry, roles: unverified }))
      entry.roles = unverified
      invalidated = true
      await this.operation(operationId, async testSignal => {
      if (!capacityPlan(entry.config, messages, tools).fits) throw new ModelError('CONTEXT_BUDGET_EXCEEDED')
      const result = await this.send(entry, 'configuration:' + id, testSignal, signal => this.adapter.complete(entry.config, entry.key, messages, tools, signal, undefined, outputLimit))
      if (role === 'main') {
        const call = result.calls[0]
        if (result.calls.length !== 1 || call?.function.name !== 'list') throw new ModelError('MAIN_CAPABILITY_TEST_FAILED')
        const args = JSON.parse(call.function.arguments)
        assertContract<{ kind: string }>('list', args)
        if (args.kind !== 'capability' || Object.keys(args).length !== 1) throw new ModelError('MAIN_CAPABILITY_TEST_FAILED')
      } else if (role === 'approval') { const value: unknown = JSON.parse(result.text); assertContract<{ decision: string }>('approval_decision', value); if (value.decision !== 'escalate' || result.calls.length) throw new ModelError('ROLE_FORMAT_TEST_FAILED') } else if (result.calls.length || !result.text.trim()) throw new ModelError('ROLE_FORMAT_TEST_FAILED')
      if (role === 'main') {
        const call = result.calls[0]!
        const followup: ChatMessage[] = [...messages, { role: 'assistant', content: result.text || null, tool_calls: result.calls }, { role: 'tool', tool_call_id: call.id, content: '{"synthetic":true,"items":[]}' }]
        if (!capacityPlan(entry.config, followup, tools).fits) throw new ModelError('CONTEXT_BUDGET_EXCEEDED')
        const terminal = await this.send(entry, 'configuration:' + id, testSignal, signal => this.adapter.complete(entry.config, entry.key, followup, tools, signal, undefined, outputLimit))
        if (terminal.calls.length || !terminal.text.trim()) throw new ModelError('MAIN_CAPABILITY_TEST_FAILED')
      }
      if (testSignal.aborted) throw new ModelError('MODEL_CANCELLED')
      })
      const roles = new Set(entry.roles); roles.add(role)
      if (entry.remembered) await this.persist(new Map(this.configurations).set(id, { ...entry, roles }))
      entry.roles = roles
      return { id, role, enabled: true, scope: 'synthetic sample only; not model quality assurance' }
    } catch (e) { if (invalidated) entry.roles.delete(role); if (e instanceof ModelError || e instanceof ContractError) throw e; throw new ModelError('ROLE_FORMAT_TEST_FAILED') }
    finally { entry.locks-- }
  }
  close(): void { this.lifetime.abort(); for (const c of this.allControllers) c.abort(); for (const e of this.configurations.values()) e.key = ''; this.configurations.clear() }
}
