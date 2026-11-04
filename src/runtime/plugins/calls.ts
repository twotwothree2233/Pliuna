import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import defaults from '../../shared/contracts/development-defaults.json'
import { ContractError } from '../../shared/validation'
import type { PluginControl } from './control'
import type { PluginDirectory } from './directory'
import { PluginProcesses } from './process'
import { RpcError } from './rpc'
import type { PluginDerivations } from './derivations'

type Row = Record<string, any>
export type CallSource = { run_id: string | null; action_id?: string; parent_call_id?: string; instance_id?: string; chain: string[]; budget?: { calls: number }; signal: AbortSignal; valid(): void; approve(action: string, input: unknown, signal: AbortSignal): Promise<void>; checkApproval(action: string, input: unknown): void }
type Active = { task: string; digest: string; source: CallSource; controller: AbortController; settled: Promise<void>; instance?: string; ended_reason?: string }
const now = () => new Date().toISOString()
export class PluginCalls {
  private active = new Map<string, Active>()
  private closed = false
  constructor(private db: Database.Database, private epoch: string, private control: PluginControl, private directory: PluginDirectory, private processes: PluginProcesses, private references: (task: string, refs: unknown[]) => void, private record: (task: string, kind: string, payload: Row) => void, private commitUploads: (call: string) => Row[] = () => [], private settleUploads: (call: string, success: boolean) => void = () => {}, private saveOutput?: (task: string, call: string, instance: string, digest: string, global: boolean, bytes: Buffer) => Promise<void>, private derivations?: PluginDerivations) {}
  async call(task: string, capabilityId: string, args: unknown, references: unknown[], source: CallSource, registered?: (id: string) => void): Promise<unknown> {
    source.valid(); this.references(task, references)
    const resolved = await this.directory.capability(task, capabilityId), copy = this.control.get(resolved.digest)
    await this.directory.validateArguments(task,capabilityId,args)
    source.valid()
    const instanceKey = resolved.digest + ':' + (copy.manifest.access_level === 'global' ? 'global' : task)
    if (source.chain.includes(instanceKey) || source.chain.length >= defaults.tool.nested_max_depth) throw new ContractError('PLUGIN_CALL_CYCLE', 'Nested calls cannot reenter an instance or exceed the source depth limit')
    const budget = source.budget ?? { calls: 0 }
    if (++budget.calls > defaults.run.tool_requests) throw new ContractError('PLUGIN_CALL_BUDGET', 'Nested call budget exhausted')
    const id = randomUUID(), controller = new AbortController(), abort = () => controller.abort()
    source.signal.addEventListener('abort', abort, { once: true }); if (source.signal.aborted) abort()
    let settled!: () => void
    const entry: Active = { task, digest: resolved.digest, source: { ...source, budget, chain: [...source.chain, instanceKey] }, controller, settled: new Promise(resolve => { settled = resolve }) }
    this.active.set(id, entry)
    this.db.prepare("INSERT INTO calls (id,task_id,run_id,parent_call_id,instance_id,capability_id,state,dispatch,delivery,input_json,limits_json,commit_valid,created_at) VALUES (?,?,?,?,?,?,'registered','not_sent','pending',?,?,1,?)").run(id, task, source.run_id, source.parent_call_id ?? null, source.instance_id ?? null, capabilityId, JSON.stringify({ arguments: args, references }), JSON.stringify({ ...defaults, package_digest: resolved.digest, plugin_version: copy.manifest.version, runtime_epoch: this.epoch, chain: entry.source.chain }), now())
    registered?.(id)
    let action: string | null = source.action_id ?? null, committed = false, returned = false
    const input = { type: 'plugin.invoke', call_id: id, capability: capabilityId, arguments: args, references, effect: resolved.capability.effect, package_digest: resolved.digest }
    if (action) this.db.prepare("UPDATE actions SET call_id=?,kind='invocation',request_json=? WHERE id=? AND state='registered' AND commit_valid=1").run(id, JSON.stringify(input), action)
    const valid = () => {
      if (this.closed || controller.signal.aborted || !this.control.available(task, resolved.digest)) throw new ContractError('PLUGIN_SOURCE_INVALID', 'Plugin call no longer has commit eligibility')
      source.valid()
      const row = this.db.prepare('SELECT state,commit_valid,dispatch FROM calls WHERE id=?').get(id) as Row | undefined
      if (!row?.commit_valid || row.state === 'ended') throw new ContractError('PLUGIN_SOURCE_INVALID', 'Original call has ended')
      if (action && resolved.capability.effect !== 'read' && row.dispatch === 'not_sent' && row.state === 'executing') source.checkApproval(action, input)
    }
    const wall = setTimeout(() => { this.invalidate(id); controller.abort() }, defaults.run.wall_ms); wall.unref?.()
    try {
      if (resolved.capability.effect !== 'read') {
        if (!action) {
          action = randomUUID()
          this.db.prepare("INSERT INTO actions (id,task_id,run_id,call_id,kind,state,source_json,request_json,commit_valid,created_at) VALUES (?,?,?,?,'invocation','registered',?,?,1,?)").run(action, task, source.run_id, id, JSON.stringify({ type: source.run_id ? 'run' : 'plugin', id: source.run_id ?? source.instance_id, epoch: this.epoch }), JSON.stringify(input), now())
        }
        this.db.prepare("UPDATE calls SET state='waiting',wait_reason='approval' WHERE id=?").run(id)
        await source.approve(action, input, controller.signal); valid()
        source.checkApproval(action, input)
      }
      valid(); this.references(task, references)
      this.db.prepare("UPDATE calls SET state='executing',wait_reason=NULL WHERE id=?").run(id)
      return await this.processes.execute(copy, task, { call_id: id, capability: resolved.capability.id, arguments: args, references, signal: controller.signal, nested: !!source.parent_call_id, valid, started: instance => { entry.instance = instance; this.db.prepare('UPDATE calls SET instance_id=? WHERE id=?').run(instance, id) }, ended: reason => { entry.ended_reason = reason; this.invalidate(id); controller.abort() }, dispatch: state => {
        if (this.closed) return
        this.db.transaction(() => {
          this.db.prepare("UPDATE calls SET dispatch=? WHERE id=? AND dispatch='not_sent'").run(state, id)
          if (action) this.db.prepare("UPDATE actions SET state='ended',result=?,commit_valid=0,authorization_json=?,result_json=?,ended_at=? WHERE id=? AND state!='ended'").run(state === 'sent' ? 'success' : 'unknown', JSON.stringify({ basis: resolved.capability.effect === 'read' ? 'default' : 'single_approval' }), JSON.stringify({ call_id: id, dispatched: state, tool_execution: 'not_proven' }), now(), action)
        })()
      }, settle: async output => {
      valid()
      const pending = this.db.prepare("SELECT id FROM actions WHERE call_id=? AND state!='ended' AND json_extract(request_json,'$.type')!='plugin.result.upload' UNION ALL SELECT id FROM calls WHERE parent_call_id=? AND state!='ended' LIMIT 1").get(id, id)
      if (pending) throw new ContractError('PLUGIN_DEPENDENT_WORK_PENDING', 'Tool returned before its related actions or child calls ended')
      returned = true
      // Business mutation proposals are data only; they must be submitted as independent actions.
      const encoded = JSON.stringify(output)
      const truncated = Buffer.byteLength(encoded) > defaults.tool.preview_bytes
      this.db.prepare("UPDATE calls SET state='finalizing',wait_reason='result_storage' WHERE id=?").run(id)
      if (truncated) {
        if (!this.saveOutput || !entry.instance) throw new ContractError('PLUGIN_RESULT_REQUIRES_RESOURCE', 'Large result storage is unavailable')
        await this.saveOutput(task, id, entry.instance, resolved.digest, copy.manifest.access_level === 'global', Buffer.from(encoded))
      }
      await this.derivations?.prepare(id, valid)
      const result = { request_type: 'call', operation_id: id, execution: 'success', delivery: 'delivered', truncated, data: truncated ? { preview: encoded.slice(0, 1000), notice: 'Preview only. Read the immutable result resource for complete JSON; no path is read automatically.' } : output }
      this.db.transaction(() => {
        valid()
        const resources = this.commitUploads(id)
        this.derivations?.commit(id, resources, this.record, copy.manifest.version)
        if (resources.length) Object.assign(result, { resources })
        this.db.prepare("UPDATE calls SET state='ended',execution='success',delivery='delivered',result_json=?,commit_valid=0,ended_at=? WHERE id=?").run(JSON.stringify(result), now(), id)
        this.record(task, 'plugin.call.ended', { call_id: id, package_digest: resolved.digest, execution: 'success' })
      })()
      committed = true
      return result
      } })
    } catch (error) {
      await this.cancelChildren(id)
      if (this.closed) throw error
      const row = this.db.prepare('SELECT dispatch FROM calls WHERE id=?').get(id) as Row
      const execution = row.dispatch === 'not_sent' ? 'not_executed' : returned ? 'success' : controller.signal.aborted && (!entry.ended_reason || ['PLUGIN_PROCESS_REVOKED', 'PLUGIN_TASK_STOPPED', 'PLUGIN_HOST_CLOSED'].includes(entry.ended_reason)) ? 'cancelled' : error instanceof RpcError ? 'failure' : 'unknown'
      const delivery = returned || (error instanceof ContractError && error.code === 'PLUGIN_OUTPUT_INVALID') ? 'failed' : 'delivered'
      const declaredCode = error instanceof RpcError && resolved.capability.errors.includes(error.message) ? error.message : null
      const result = { request_type: 'call', operation_id: id, execution, delivery, truncated: false, error: { code: error instanceof ContractError ? error.code : declaredCode ?? 'PLUGIN_CALL_FAILED', message: 'Original call ended; inspect its recorded dispatch and result. No automatic replay.' } }
      this.db.transaction(() => {
        this.db.prepare("UPDATE calls SET state='ended',execution=?,delivery=?,result_json=?,commit_valid=0,ended_at=? WHERE id=?").run(execution, delivery, JSON.stringify(result), now(), id)
        if (action) this.db.prepare("UPDATE actions SET state='ended',result=?,commit_valid=0,result_json=?,ended_at=? WHERE id=? AND state!='ended'").run(row.dispatch === 'not_sent' ? 'not_executed' : 'unknown', JSON.stringify(result), now(), action)
        this.record(task, 'plugin.call.ended', { call_id: id, package_digest: resolved.digest, execution })
      })()
      return result
    } finally {
      clearTimeout(wall); source.signal.removeEventListener('abort', abort)
      try {
        await this.cancelChildren(id)
        this.derivations?.settled(id)
        if (!this.closed) this.settleUploads(id, committed)
      } finally { this.active.delete(id); settled() }
    }
  }
  private async cancelChildren(parent: string): Promise<void> {
    const children = [...this.active].filter(([, active]) => active.source.parent_call_id === parent)
    for (const [id, active] of children) { this.invalidate(id); active.controller.abort() }
    await Promise.all(children.map(([, active]) => active.settled))
  }
  private invalidate(id: string): void { if (!this.closed) this.db.prepare('UPDATE calls SET commit_valid=0 WHERE id=?').run(id) }
  cancelRun(run: string): void { for (const [id, active] of this.active) if (active.source.run_id === run) { this.invalidate(id); active.controller.abort() } }
  cancelAll(): void { for (const [id, active] of this.active) { this.invalidate(id); active.controller.abort() } }
  cancelTask(task: string): void { for (const [id, active] of this.active) if (active.task === task) { this.invalidate(id); active.controller.abort() } }
  revoke(): void { for (const [id, active] of this.active) if (!this.control.available(active.task, active.digest)) { this.invalidate(id); active.controller.abort() } }
  source(id: string): Active | undefined { return this.active.get(id) }
  busyRun(run: string): boolean { return [...this.active.values()].some(active => active.source.run_id === run) }
  async drain(): Promise<void> { while (this.active.size) await Promise.all([...this.active.values()].map(active => active.settled)) }
  busy(task: string): boolean { return [...this.active.values()].some(active => active.task === task) }
  cancel(id: string): void { const active = this.active.get(id); if (active) { this.invalidate(id); active.controller.abort() } }
  status(id: string): unknown {
    const row = this.db.prepare('SELECT id,task_id,parent_call_id,state,dispatch,execution,delivery,result_json FROM calls WHERE id=?').get(id) as Row | undefined
    if (!row) throw new ContractError('PLUGIN_CALL_UNAVAILABLE', 'Original call does not exist')
    return { call_id: row.id, task_id: row.task_id, parent_call_id: row.parent_call_id, state: row.state, dispatch: row.dispatch, execution: row.execution, delivery: row.delivery, result: row.result_json ? JSON.parse(row.result_json) : null }
  }
  close(): void { for (const [id, active] of this.active) { this.invalidate(id); active.controller.abort() }; this.closed = true }
}
