import { randomUUID } from 'node:crypto'
import { ContractError } from '../../shared/validation'
import type { PluginIdentity } from './process'

type Draft = { instance: string; digest: string; call: string | null; task: string; body: string; expires: number; check?: () => void; claim?: symbol }
export class PluginDrafts {
  private drafts = new Map<string, Draft>()
  constructor(private ttl: number, private qualify: (identity: PluginIdentity, task: string) => void) {}
  private prune(): void { for (const [id, draft] of this.drafts) if (draft.expires <= Date.now()) this.drafts.delete(id) }
  stage(identity: PluginIdentity, task: string, value: unknown, inspect: () => void | (() => void)): unknown {
    this.qualify(identity, task); this.prune()
    const body = JSON.stringify(value), bytes = Buffer.byteLength(body)
    if (bytes > 1024 * 1024 || this.drafts.size >= 100 || [...this.drafts.values()].filter(d => d.instance === identity.instance_id).length >= 20 || [...this.drafts.values()].reduce((size, d) => size + Buffer.byteLength(d.body), bytes) > 8 * 1024 * 1024) throw new ContractError('PLUGIN_DRAFT_LIMIT', 'Surface draft storage limit reached; wait for expiry or discard drafts')
    const check = inspect(); this.qualify(identity, task)
    const id = randomUUID(), expires = Date.now() + this.ttl
    this.drafts.set(id, { instance: identity.instance_id, digest: identity.digest, call: identity.call_id, task, body, expires, ...(check ? { check } : {}) })
    return { draft_id: id, expires_at: new Date(expires).toISOString(), checks: { structure: 'valid', current_versions: 'valid', authority: 'not_granted', commit_rechecks_required: true } }
  }
  read(identity: PluginIdentity, task: string, id: string): unknown {
    this.prune(); this.qualify(identity, task)
    const draft = this.drafts.get(id)
    if (!draft || draft.instance !== identity.instance_id || draft.digest !== identity.digest || draft.call !== identity.call_id || draft.task !== task) throw new ContractError('PLUGIN_DRAFT_UNAVAILABLE', 'Draft expired or does not belong to this connection, call and task')
    draft.check?.()
    // Return a detached value: approval and execution bind to these exact bytes, not plugin-owned objects.
    return JSON.parse(draft.body)
  }
  submit(identity: PluginIdentity, task: string, id: string, register: (value: unknown, check: () => void) => unknown): unknown {
    const value = this.read(identity, task, id), draft = this.drafts.get(id)!
    if (draft.claim) throw new ContractError('PLUGIN_DRAFT_SUBMITTED', 'This immutable draft already has an action; query that action or stage a new draft')
    const claim = Symbol(); draft.claim = claim
    try {
      return register(value, () => {
        this.read(identity, task, id)
        if (this.drafts.get(id)?.claim !== claim) throw new ContractError('PLUGIN_DRAFT_UNAVAILABLE', 'Draft submission no longer belongs to this action')
      })
    } catch (error) { delete draft.claim; throw error }
  }
  revoke(digest: string): void { for (const [id, draft] of this.drafts) if (draft.digest === digest) this.drafts.delete(id) }
  cancelTask(task: string): void { for (const [id, draft] of this.drafts) if (draft.task === task) this.drafts.delete(id) }
  close(): void { this.drafts.clear() }
}
