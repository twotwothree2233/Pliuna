import { createHash } from 'node:crypto'
import { ContractError } from '../../shared/validation'
import type { PluginControl } from './control'
import { readPluginEntry } from './package'
import { pluginCapabilities, type PluginCapability } from './process'

export function pluginCapabilityId(digest: string, contribution: string): string {
  return 'plugin:' + digest + ':' + createHash('sha256').update(contribution).digest('hex').slice(0, 32)
}
export function pluginContentId(digest: string, contribution: string): string {
  return 'plugin-content:' + digest + ':' + createHash('sha256').update(contribution).digest('hex').slice(0, 32)
}
const fail = (code: string): never => { throw new ContractError(code, 'Plugin content or capability is unavailable in this task; review its current enablement and dependencies') }
export class PluginDirectory {
  constructor(private root: string, private control: PluginControl, private builtin?: { id: string; description: string; contract: unknown }) {}
  summaries(task: string): Record<string, unknown>[] {
    const workflow = this.control.configuration(task).workflow
    return this.control.list().map(copy => ({ id: 'package:' + copy.digest, digest: copy.digest, plugin_id: copy.manifest.id, version: copy.manifest.version, access_level: copy.manifest.access_level, enabled: this.control.available(task, copy.digest), contribution_count: copy.manifest.contributes.length, workflow: workflow?.digest === copy.digest && this.control.available(task, copy.digest) ? { kind: 'plugin', id: pluginContentId(copy.digest, workflow.contribution_id) } : null }))
  }
  discovery(task: string): Record<string, unknown>[] {
    return [...(this.builtin ? [{id:this.builtin.id,kind:'capability',description:this.builtin.description,read_contract_before_call:true}] : []), ...this.control.list().filter(copy => this.control.available(task, copy.digest)).flatMap(copy => copy.manifest.contributes.filter(c => c.kind === 'tool').map(c => ({ id: pluginCapabilityId(copy.digest, c.id), kind: 'capability', description: c.description.slice(0, 300), package_digest: copy.digest, read_contract_before_call: true })))]
  }
  async read(task: string, id: string): Promise<unknown> {
    if (id === this.builtin?.id) return this.builtin.contract
    if (id.startsWith('plugin:')) return this.capability(task, id)
    const parts = id.split(':'), copy = this.control.get(parts[1] ?? '')
    if (parts.length !== (parts[0] === 'package' ? 2 : 3) || !this.control.available(task, copy.digest)) return fail('PLUGIN_CONTENT_DISABLED')
    if (parts[0] === 'package') return { ...copy.manifest, digest: copy.digest, contributes: copy.manifest.contributes.map(c => ({ ...c, entry: undefined, id: c.kind === 'tool' ? pluginCapabilityId(copy.digest, c.id) : pluginContentId(copy.digest, c.id) })) }
    if (parts[0] !== 'plugin-content') return fail('PLUGIN_CONTENT_TARGET_REQUIRED')
    const contribution = copy.manifest.contributes.find(c => pluginContentId(copy.digest, c.id) === id)
    if (!contribution || contribution.kind === 'tool') return fail('PLUGIN_CONTENT_TARGET_REQUIRED')
    const body = await readPluginEntry(this.root, copy, contribution.entry)
    if (!this.control.available(task, copy.digest)) return fail('PLUGIN_CONTENT_DISABLED')
    try { return { id, kind: contribution.kind, text: new TextDecoder('utf-8', { fatal: true }).decode(body) } } catch { return fail('PLUGIN_CONTENT_BINARY') }
  }
  async context(task: string): Promise<unknown> {
    const capabilities = this.discovery(task), workflow = this.control.configuration(task).workflow
    let selected: unknown = null
    if (workflow && this.control.available(task, workflow.digest)) {
      const content = await this.content(task, workflow.digest, workflow.contribution_id) as Record<string, unknown>
      selected = { id: pluginContentId(workflow.digest, workflow.contribution_id), ...content }
    }
    return { capabilities: capabilities.slice(0, 20), more_capabilities: capabilities.length > 20, discovery: 'Use list plugin/capability and read exact IDs for current enabled contracts and content; discovery never starts a process.', workflow: selected }
  }
  list(task: string, before = 0): unknown {
    if (!Number.isSafeInteger(before) || before < 0) fail('PLUGIN_CURSOR_INVALID')
    const copies = this.control.list(), configuration = this.control.configuration(task)
    return { items: copies.slice(before, before + 20).map(copy => ({ digest: copy.digest, id: copy.manifest.id, version: copy.manifest.version, access_level: copy.manifest.access_level, executable: !!copy.manifest.backend, trusted: !!copy.manifest.backend && this.control.trusted(copy.digest), enabled: configuration.enabled.some(e => e.digest === copy.digest), available: this.control.available(task, copy.digest), contributions: copy.manifest.contributes.map(c => ({ id: c.id, kind: c.kind, description: c.description.slice(0, 300) })), dependencies: copy.manifest.dependencies ?? [], workflow: configuration.workflow?.digest === copy.digest ? configuration.workflow.contribution_id : null })), next_before: copies.length > before + 20 ? before + 20 : null }
  }
  async content(task: string, digest: string, contribution: string, offset = 0): Promise<unknown> {
    const copy = this.control.get(digest), declared = copy.manifest.contributes.find(c => c.id === contribution)
    if (!declared || !this.control.available(task, digest) || declared.kind === 'tool') return fail('PLUGIN_CONTENT_DISABLED')
    if (!Number.isSafeInteger(offset) || offset < 0) fail('PLUGIN_CURSOR_INVALID')
    const body = await readPluginEntry(this.root, copy, declared.entry)
    if (!this.control.available(task, digest)) fail('PLUGIN_CONTENT_DISABLED')
    if (offset > body.length || (offset < body.length && (body[offset]! & 0xc0) === 0x80)) fail('PLUGIN_CURSOR_INVALID')
    let end = Math.min(body.length, offset + 8192)
    while (end < body.length && (body[end]! & 0xc0) === 0x80) end--
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(body.subarray(offset, end)) } catch { return fail('PLUGIN_CONTENT_BINARY') }
    return { digest, contribution_id: contribution, kind: declared.kind, text, offset, next_offset: end < body.length ? end : null, truncated: end < body.length }
  }
  async capabilities(task: string): Promise<{ id: string; digest: string; capability: PluginCapability }[]> {
    const items: { id: string; digest: string; capability: PluginCapability }[] = []
    for (const copy of this.control.list()) {
      if (!this.control.available(task, copy.digest)) continue
      for (const descriptor of await pluginCapabilities(this.root, copy)) items.push({ id: pluginCapabilityId(copy.digest, descriptor.capability.id), digest: copy.digest, capability: descriptor.capability })
      if (!this.control.available(task, copy.digest)) fail('PLUGIN_CONFIGURATION_CHANGED')
    }
    return items
  }
  async capability(task: string, id: string): Promise<{ id: string; digest: string; capability: PluginCapability }> {
    if (!/^plugin:[a-f0-9]{64}:[a-f0-9]{32}$/.test(id)) return fail('PLUGIN_CAPABILITY_UNAVAILABLE')
    const digest = id.split(':')[1]!, copy = this.control.get(digest)
    if (!this.control.available(task, digest)) return fail('PLUGIN_CAPABILITY_UNAVAILABLE')
    const match = (await pluginCapabilities(this.root, copy)).find(item => pluginCapabilityId(digest, item.capability.id) === id)
    if (!match || !this.control.available(task, digest)) return fail('PLUGIN_CAPABILITY_UNAVAILABLE')
    return { id, digest, capability: match.capability }
  }
  async retention(task: string, records: { payload: Record<string, any> }[]): Promise<unknown> {
    const workflow = this.control.configuration(task).workflow
    const used = new Map<string, number>()
    for (const record of records) for (const call of record.payload.message?.tool_calls ?? []) {
      try { const input = JSON.parse(call.function.arguments); if (call.function.name === 'call' && typeof input.capability === 'string') used.set(input.capability, 1); if (call.function.name === 'read' && typeof input?.id === 'string') used.set(input.id, Math.min(used.get(input.id) ?? 2, 2)) } catch { /* Invalid historical calls carry no retention authority. */ }
    }
    const selected: { priority: number; id: string; text: string }[] = []
    for (const copy of this.control.list()) {
      if (!this.control.available(task, copy.digest)) continue
      const guidance = copy.manifest.extensions?.context_retention
      if (typeof guidance !== 'string' || Buffer.byteLength(guidance) > 2048) continue
      const current = workflow?.digest === copy.digest
      const relevant = Math.min(3, ...copy.manifest.contributes.map(c => used.get(c.kind === 'tool' ? pluginCapabilityId(copy.digest, c.id) : pluginContentId(copy.digest, c.id)) ?? 3))
      if (current || relevant < 3) selected.push({ priority: current ? 0 : relevant, id: copy.digest, text: guidance })
    }
    selected.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
    let bytes = 0
    return selected.filter(item => { bytes += Buffer.byteLength(JSON.stringify(item)); return bytes <= 4096 })
  }
  async validateArguments(task: string, id: string, value: unknown): Promise<void> {
    const resolved = await this.capability(task,id), copy = this.control.get(resolved.digest)
    const descriptor = (await pluginCapabilities(this.root,copy)).find(d => d.capability.id === resolved.capability.id)
    if (!descriptor) return fail('PLUGIN_ARGUMENTS_INVALID')
    if (!descriptor.input(value)) {
      const issues = (descriptor.input.errors ?? []).slice(0, 4).map(error => ({ path: error.instancePath.slice(0, 200), rule: error.keyword, message: error.message?.slice(0, 200) }))
      throw new ContractError('PLUGIN_ARGUMENTS_INVALID', 'arguments does not match the read capability input_schema. Supply the actual JSON value, not a JSON-encoded string or the whole call envelope. Rejected before Call/approval registration and dispatch. ' + JSON.stringify(issues))
    }
  }
}
