import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import defaults from '../../shared/contracts/development-defaults.json'
import { ContractError } from '../../shared/validation'
import type { PluginIdentity } from './process'

type Row = Record<string, any>
export type PluginActionContext = { id: string; identity: PluginIdentity; signal: AbortSignal; valid(): void }
type Pending = { task: string; input: unknown; context: PluginActionContext; controller: AbortController; timer: ReturnType<typeof setTimeout> }
const now = () => new Date().toISOString()
export class PluginActions {
  private pending = new Map<string, Pending>()
  private closed = false
  constructor(private db: Database.Database, private epoch: string, private qualify: (identity: PluginIdentity, task: string) => void, private execute: (task: string, input: unknown, context: PluginActionContext) => Promise<unknown>, private changed: (identity: PluginIdentity, action: string, state: string) => void) {}
  submit(identity: PluginIdentity, task: string, input: unknown, sourceCheck: () => void = () => {}): unknown {
    this.qualify(identity, task)
    if (this.pending.size >= 100 || [...this.pending.values()].filter(p => p.context.identity.instance_id === identity.instance_id).length >= 20) throw new ContractError('PLUGIN_ACTION_LIMIT', 'Too many pending plugin actions')
    const id = randomUUID(), controller = new AbortController()
    const context: PluginActionContext = { id, identity, signal: controller.signal, valid: () => {
      if (this.closed || controller.signal.aborted) throw new ContractError('PLUGIN_SOURCE_INVALID', 'Independent action was cancelled or ended')
      this.qualify(identity, task)
      sourceCheck()
      const row = this.db.prepare('SELECT commit_valid,state,request_json FROM actions WHERE id=? AND task_id=?').get(id, task) as Row | undefined
      if (!row?.commit_valid || row.state === 'ended' || row.request_json !== JSON.stringify(input)) throw new ContractError('PLUGIN_SOURCE_INVALID', 'Independent action no longer has commit eligibility')
    } }
    this.db.prepare("INSERT INTO actions (id,task_id,call_id,kind,state,source_json,request_json,commit_valid,created_at) VALUES (?,?,?,'mutation','registered',?,?,1,?)").run(id, task, identity.call_id, JSON.stringify({ type: 'plugin', instance_id: identity.instance_id, package_digest: identity.digest, epoch: this.epoch }), JSON.stringify(input), now())
    const timer = setTimeout(() => this.cancel(id), defaults.run.wall_ms); timer.unref?.()
    this.pending.set(id, { task, input, context, controller, timer })
    // The registration RPC ends before approval or deterministic execution begins.
    setImmediate(() => { if (this.closed) { clearTimeout(timer); this.pending.delete(id); return }; void Promise.resolve().then(() => this.execute(task, input, context)).catch(error => {
      if (!this.closed) this.db.prepare("UPDATE actions SET state='ended',result='not_executed',commit_valid=0,result_json=?,ended_at=? WHERE id=? AND state!='ended'").run(JSON.stringify({ code: error instanceof ContractError ? error.code : 'PLUGIN_ACTION_FAILED' }), now(), id)
    }).finally(() => {
      clearTimeout(timer); this.pending.delete(id)
      if (!this.closed) {
        this.db.prepare("UPDATE approvals SET validity='revoked' WHERE action_id=? AND validity='valid' AND decision='pending'").run(id)
        const row = this.db.prepare('SELECT result FROM actions WHERE id=?').get(id) as Row | undefined; this.changed(identity, id, row?.result ?? 'unknown')
      }
    }) })
    return { action_id: id, status: 'registered' }
  }
  get(identity: PluginIdentity, id: string): unknown {
    const row = this.db.prepare('SELECT * FROM actions WHERE id=?').get(id) as Row | undefined
    if (!row || JSON.parse(row.source_json).instance_id !== identity.instance_id) throw new ContractError('PLUGIN_ACTION_UNAVAILABLE', 'Action does not belong to this connection')
    this.qualify(identity, row.task_id)
    return { action_id: id, state: row.state, result: row.result, data: row.result_json ? JSON.parse(row.result_json) : null }
  }
  owner(action: string, task: string): boolean { const p = this.pending.get(action); if (!p || p.task !== task) return false; try { p.context.valid(); return true } catch { return false } }
  cancel(id: string): void {
    const p = this.pending.get(id); if (!p) return
    if (!this.closed) this.db.transaction(() => {
      this.db.prepare("UPDATE actions SET commit_valid=0 WHERE id=? AND state!='ended'").run(id)
      this.db.prepare("UPDATE approvals SET validity='revoked' WHERE action_id=? AND validity='valid' AND decision='pending'").run(id)
    })()
    p.controller.abort()
  }
  check(): void { for (const [id, pending] of this.pending) { try { pending.context.valid() } catch { this.cancel(id) } } }
  cancelTask(task: string): void { for (const [id, pending] of this.pending) if (pending.task === task) this.cancel(id) }
  busy(task: string): boolean { return [...this.pending.values()].some(pending => pending.task === task) }
  close(): void { for (const id of this.pending.keys()) this.cancel(id); this.closed = true }
}
