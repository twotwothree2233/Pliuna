import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js'
import { assertContract, ContractError } from '../../shared/validation'
import defaults from '../../shared/contracts/development-defaults.json'
import { PluginRpc, RpcError } from './rpc'
import { readPluginEntry, type PluginCopy } from './package'

export type PluginCapability = { id: string; description: string; when_to_use: string; input_schema: Record<string, unknown>; output_schema: Record<string, unknown>; effect: 'read' | 'task-write' | 'external-write'; timeout_ms: number; errors: string[]; examples: { input: unknown; output: unknown }[] }
type Descriptor = { capability: PluginCapability; input: ValidateFunction; output: ValidateFunction }
const fail = (code: string): never => { throw new ContractError(code, 'Plugin execution unavailable or interrupted; inspect its original call result before explicitly starting new work') }
export async function pluginCapabilities(root: string, copy: PluginCopy): Promise<Descriptor[]> {
  const validator = new Ajv2020({ strict: false, allErrors: true, validateFormats: false })
  const result: Descriptor[] = []
  for (const contribution of copy.manifest.contributes.filter(c => c.kind === 'tool')) {
    const body = await readPluginEntry(root, copy, contribution.entry)
    if (body.length > 64 * 1024) fail('PLUGIN_CAPABILITY_INVALID')
    let value: unknown
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) } catch { fail('PLUGIN_CAPABILITY_INVALID') }
    assertContract<PluginCapability>('capability', value)
    if (value.id !== contribution.id || value.description.length > 4000 || value.when_to_use.length > 4000) fail('PLUGIN_CAPABILITY_INVALID')
    // Local schemas cannot fetch references or register executable validators.
    try { result.push({ capability: value, input: validator.compile(value.input_schema), output: validator.compile(value.output_schema) }) }
    catch { fail('PLUGIN_CAPABILITY_INVALID') }
  }
  return result
}
export type PluginExecution = { call_id: string; capability: string; arguments: unknown; references: unknown[]; signal: AbortSignal; nested?: boolean; dispatch(state: 'sent' | 'unknown'): void; valid(): void; started?(instance: string): void; ended?(reason: string): void; settle?(output: unknown): unknown | Promise<unknown> }
export type PluginIdentity = { instance_id: string; digest: string; task_id: string | null; call_id: string | null }
type Instance = { id: string; copy: PluginCopy; task: string | null; activeTask?: string; process: ChildProcessWithoutNullStreams; rpc: PluginRpc; ready: Promise<void>; exited: Promise<void>; exitConfirmed: boolean; cleanup_error?: string; cleanupTimer?: ReturnType<typeof setTimeout>; active: PluginExecution | null; pending: number; tail: Promise<void>; invalid: boolean; stderr_bytes: number }

export class PluginProcesses {
  private instances = new Map<string, Instance>()
  private children = new Set<Instance>()
  private opening = new Map<string, Promise<Instance>>()
  private closed = false
  private generation = 0
  private pdfTasks = new Set<string>()
  private clocks = new Map<string, { remaining: number; started: number; timer?: ReturnType<typeof setTimeout>; timeout(): void; paused: boolean }>()
  constructor(private root: string, private qualify: (copy: PluginCopy, task: string) => Promise<void>, private callback: (identity: PluginIdentity, method: string, params: Record<string, unknown>) => unknown | Promise<unknown>, private disconnected: () => void = () => {}, private appRuntime?: string) {}
  live(identity: PluginIdentity): boolean { return [...this.children].some(i => !i.invalid && i.id === identity.instance_id && i.copy.digest === identity.digest && i.task === identity.task_id) }
  status(task: string, digest: string): unknown[] { return [...this.children].filter(i => i.copy.digest === digest && (i.task === null || i.task === task)).map(i => ({ instance_id: i.id, access_level: i.task === null ? 'global' : 'task', state: i.cleanup_error ? 'cleanup_failed' : i.invalid ? 'stopping' : i.active ? 'executing_or_finalizing' : 'idle', call_id: i.active?.call_id ?? null, pending: i.pending, ...(i.cleanup_error ? { cleanup_error: i.cleanup_error } : {}) })) }
  cleaning(task?: string): boolean { return [...this.children].some(i => i.invalid && !i.exitConfirmed && (task === undefined || i.task === task || i.activeTask === task)) }
  ownsTask(task: string): boolean { return [...this.children].some(i => !i.exitConfirmed && (i.task === task || i.activeTask === task)) }
  changed(identity: PluginIdentity, action: string, status: string): void {
    const instance = [...this.children].find(i => !i.invalid && i.id === identity.instance_id)
    if (instance) { try { instance.rpc.notify('actions.changed', { action_id: action, status }) } catch {} }
  }
  waiting(call: string, paused: boolean): void {
    const clock = this.clocks.get(call)
    if (!clock || clock.paused === paused) return
    if (paused) { clock.remaining = Math.max(0, clock.remaining - (Date.now() - clock.started)); clearTimeout(clock.timer) }
    else { clock.started = Date.now(); clock.timer = setTimeout(clock.timeout, clock.remaining); clock.timer.unref?.() }
    clock.paused = paused
  }
  private key(copy: PluginCopy, task: string): string { return copy.digest + ':' + (copy.manifest.access_level === 'global' ? 'global' : task) }
  private async instance(copy: PluginCopy, task: string): Promise<Instance> {
    if (this.closed) fail('PLUGIN_PROCESS_CLOSED')
    const key = this.key(copy, task), current = this.instances.get(key)
    if (current?.invalid) fail('PLUGIN_CLEANUP_PENDING')
    if (current && !current.invalid) { await current.ready; await this.qualify(copy, task); return current }
    if (this.opening.has(key)) return this.opening.get(key)!
    const generation = this.generation
    const opening = this.start(copy, task, generation).finally(() => this.opening.delete(key))
    this.opening.set(key, opening); return opening
  }
  private async start(copy: PluginCopy, task: string, generation: number): Promise<Instance> {
    await this.qualify(copy, task)
    const descriptors = await pluginCapabilities(this.root, copy)
    await this.qualify(copy, task)
    if (this.closed || generation !== this.generation || !copy.manifest.backend) fail('PLUGIN_PROCESS_REVOKED')
    const env: NodeJS.ProcessEnv = {}
    // Do not inherit host/model/AO secrets. External runtimes remain user-managed, not sandboxed.
    for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL']) if (process.env[name]) env[name] = process.env[name]
    const backend = copy.manifest.backend
    if (!backend) return fail('PLUGIN_BACKEND_UNAVAILABLE')
    const bundled = 'runtime' in backend
    if (bundled && !this.appRuntime) fail('PLUGIN_APP_RUNTIME_UNAVAILABLE')
    if (bundled) env.ELECTRON_RUN_AS_NODE = '1'
    const child = spawn(bundled ? this.appRuntime! : backend.command, bundled ? [backend.entry] : backend.args, { cwd: join(this.root, 'plugins', copy.digest), env, shell: false, windowsHide: true, stdio: 'pipe' })
    const instance = { id: randomUUID(), copy, task: copy.manifest.access_level === 'global' ? null : task, process: child, active: null, pending: 0, tail: Promise.resolve(), invalid: false, exitConfirmed: false, stderr_bytes: 0 } as unknown as Instance
    instance.exited = new Promise(resolve => {
      const exited = () => {
        if (instance.exitConfirmed) return
        instance.exitConfirmed = true; clearTimeout(instance.cleanupTimer)
        this.terminate(instance, 'PLUGIN_PROCESS_EXITED')
        if (this.instances.get(this.key(copy, task)) === instance) this.instances.delete(this.key(copy, task))
        this.children.delete(instance); resolve(); this.disconnected()
      }
      child.once('exit', exited)
      // A failed spawn has no process to wait for. Runtime errors are not exit facts.
      child.on('error', () => { if (child.pid === undefined) exited(); else { instance.cleanup_error = 'PLUGIN_PROCESS_ERROR'; this.disconnected() } })
    })
    instance.rpc = new PluginRpc(child.stdout, child.stdin, (method, params) => {
      if (instance.invalid) fail('PLUGIN_PROCESS_REVOKED')
      return this.callback({ instance_id: instance.id, digest: copy.digest, task_id: instance.task, call_id: instance.active?.call_id ?? null }, method, params)
    }, reason => this.terminate(instance, reason))
    child.stderr.on('data', (chunk: Buffer) => { instance.stderr_bytes = Math.min(65536, instance.stderr_bytes + chunk.length) })
    child.once('error', () => this.terminate(instance, 'PLUGIN_START_FAILED'))
    this.instances.set(this.key(copy, task), instance)
    this.children.add(instance)
    const handshake = { protocol_version: '0.1', plugin_id: copy.manifest.id, package_digest: copy.digest, access_level: copy.manifest.access_level, instance_id: instance.id, task_id: instance.task, capabilities: descriptors.map(d => d.capability.id) }
    assertContract('plugin_initialize', handshake)
    instance.ready = instance.rpc.request('initialize', handshake, { timeout: 10000 }).then(async value => {
      try { assertContract('plugin_initialized', value) } catch { fail('PLUGIN_HANDSHAKE_INVALID') }
      const response = value as { protocol_version?: unknown; capabilities?: unknown; plugin_id?: unknown }
      if (!response || Object.keys(response).sort().join(',') !== 'capabilities,plugin_id,protocol_version' || response.protocol_version !== '0.1' || response.plugin_id !== copy.manifest.id || JSON.stringify(response.capabilities) !== JSON.stringify(descriptors.map(d => d.capability.id))) fail('PLUGIN_HANDSHAKE_INVALID')
      await this.qualify(copy, task)
      if (instance.invalid || this.closed || generation !== this.generation) fail('PLUGIN_PROCESS_REVOKED')
    }).catch(error => { this.terminate(instance, 'PLUGIN_HANDSHAKE_FAILED'); throw error })
    try { await instance.ready } catch (error) { await instance.exited; throw error }
    return instance
  }
  async execute(copy: PluginCopy, task: string, request: PluginExecution): Promise<unknown> {
    if (copy.manifest.id !== 'trellis.pdf-text') return this.executeOne(copy, task, request)
    if (this.pdfTasks.has(task) || this.pdfTasks.size >= defaults.pdf.active_app) fail('PDF_CONCURRENCY_LIMIT')
    this.pdfTasks.add(task)
    try { return await this.executeOne(copy, task, request) }
    finally { this.pdfTasks.delete(task) }
  }
  private async executeOne(copy: PluginCopy, task: string, request: PluginExecution): Promise<unknown> {
    request.valid()
    if (request.signal.aborted) fail('PLUGIN_CALL_CANCELLED')
    const descriptor = (await pluginCapabilities(this.root, copy)).find(d => d.capability.id === request.capability)
    if (!descriptor || !descriptor.input(request.arguments)) fail('PLUGIN_ARGUMENTS_INVALID')
    if (!descriptor) return fail('PLUGIN_ARGUMENTS_INVALID')
    const instance = await this.instance(copy, task)
    if (request.nested && (instance.active || instance.pending)) fail('PLUGIN_INSTANCE_BUSY')
    if (instance.pending >= defaults.queues.plugin_top_level_pending) fail('PLUGIN_QUEUE_FULL')
    instance.pending++
    const previous = instance.tail
    let release!: () => void
    instance.tail = new Promise(resolve => { release = resolve })
    try {
      await this.wait(previous, request.signal)
      request.valid(); await this.qualify(copy, task)
      if (instance.invalid || request.signal.aborted || (request.nested && instance.active)) fail('PLUGIN_CALL_CANCELLED')
      instance.active = request
      instance.activeTask = task
      request.started?.(instance.id)
      let grace: ReturnType<typeof setTimeout> | undefined
      const cancel = () => {
        if (grace || instance.exitConfirmed) return
        instance.invalid = true
        // Owner revokes commit eligibility before aborting the signal; notification is not a stop guarantee.
        try { instance.rpc.notify('tools.cancel', { call_id: request.call_id }) } catch {}
        grace = setTimeout(() => this.terminate(instance, 'PLUGIN_CANCEL_GRACE_EXCEEDED'), defaults.cleanup.cancel_grace_ms); grace.unref?.()
      }
      request.signal.addEventListener('abort', cancel, { once: true })
      if (request.signal.aborted) cancel()
      const clock = { remaining: descriptor.capability.timeout_ms, started: Date.now(), paused: false, timeout: () => this.terminate(instance, 'PLUGIN_REQUEST_TIMEOUT'), timer: undefined as ReturnType<typeof setTimeout> | undefined }
      clock.timer = setTimeout(clock.timeout, clock.remaining); clock.timer.unref?.(); this.clocks.set(request.call_id, clock)
      try {
        const result = await instance.rpc.request('tools.execute', { call_id: request.call_id, task_id: task, capability: request.capability, arguments: request.arguments, references: request.references }, { timeout: defaults.run.wall_ms, signal: request.signal, dispatch: request.dispatch })
        request.valid()
        if (request.signal.aborted || instance.invalid) fail('PLUGIN_CALL_CANCELLED')
        if (!descriptor.output(result)) fail('PLUGIN_OUTPUT_INVALID')
        return request.settle ? await request.settle(result) : result
      } catch (error) {
        if (!request.signal.aborted && !(error instanceof RpcError)) this.terminate(instance, 'PLUGIN_CALL_FAILED')
        else if (request.signal.aborted && copy.manifest.id === 'trellis.pdf-text') this.terminate(instance, 'PLUGIN_CALL_CANCELLED')
        else if (request.signal.aborted) {
          // An aborted RPC cannot prove the plugin has stopped; do not reuse its serial slot.
          instance.invalid = true
        }
        throw error
      } finally {
        clearTimeout(clock.timer); this.clocks.delete(request.call_id)
        request.signal.removeEventListener('abort', cancel)
        if (!request.signal.aborted) clearTimeout(grace)
        if (instance.invalid) await instance.exited
        clearTimeout(grace)
        instance.active = null
        instance.activeTask = undefined
      }
    } finally { instance.pending--; void previous.finally(release) }
  }
  private wait(previous: Promise<void>, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new ContractError('PLUGIN_CALL_CANCELLED', 'Queued call was cancelled before dispatch'))
    return new Promise((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(new ContractError('PLUGIN_CALL_CANCELLED', 'Queued call was cancelled before dispatch')) }
      signal.addEventListener('abort', abort, { once: true })
      void previous.then(() => { signal.removeEventListener('abort', abort); resolve() }, error => { signal.removeEventListener('abort', abort); reject(error) })
    })
  }
  private terminate(instance: Instance, reason: string): void {
    if (!instance.invalid) { instance.invalid = true; instance.active?.ended?.(reason) }
    instance.rpc.close(reason)
    if (!instance.exitConfirmed) {
      clearTimeout(instance.cleanupTimer)
      try {
        if (!instance.process.kill('SIGKILL')) instance.cleanup_error = 'PLUGIN_TERMINATION_UNCONFIRMED'
        else instance.cleanup_error = undefined
      } catch { instance.cleanup_error = 'PLUGIN_TERMINATION_FAILED' }
      instance.cleanupTimer = setTimeout(() => { if (!instance.exitConfirmed) { instance.cleanup_error ??= 'PLUGIN_EXIT_UNCONFIRMED'; this.disconnected() } }, defaults.cleanup.cancel_grace_ms)
      instance.cleanupTimer.unref?.()
    }
    this.disconnected()
  }
  revoke(digest: string, task?: string | null): void {
    this.generation++
    for (const instance of this.children) if (instance.copy.digest === digest && (task === undefined || task === null || instance.task === task)) this.terminate(instance, 'PLUGIN_PROCESS_REVOKED')
  }
  reconcile(available: (task: string, digest: string) => boolean): void {
    for (const instance of this.children) if (!available(instance.task ?? '', instance.copy.digest)) this.terminate(instance, 'PLUGIN_PROCESS_REVOKED')
  }
  stopTask(task: string): void {
    this.generation++
    for (const instance of this.children) if (instance.task === task || instance.activeTask === task) this.terminate(instance, 'PLUGIN_TASK_STOPPED')
  }
  retryCleanup(): void { for (const instance of this.children) if (instance.invalid && !instance.exitConfirmed) this.terminate(instance, 'PLUGIN_HOST_CLOSED') }
  async stopForRebind(): Promise<void> {
    this.generation++
    const instances = [...this.children]
    for (const instance of instances) this.terminate(instance, 'PLUGIN_DATABASE_SWITCH')
    await Promise.all(instances.map(instance => instance.exited))
  }
  async shutdown(reason = 'host_shutdown', grace = defaults.cleanup.cancel_grace_ms): Promise<void> {
    this.closed = true; this.generation++
    await Promise.all([...this.children].map(async instance => {
      instance.active?.ended?.('PLUGIN_HOST_CLOSED')
      instance.invalid = true
      try { await instance.rpc.request('shutdown', { reason }, { timeout: grace }) } catch {}
      finally { this.terminate(instance, 'PLUGIN_HOST_CLOSED'); await instance.exited }
    }))
  }
  close(): void { if (this.closed) return; this.closed = true; this.generation++; for (const instance of this.children) this.terminate(instance, 'PLUGIN_HOST_CLOSED') }
}
