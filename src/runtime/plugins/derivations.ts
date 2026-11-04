import type Database from 'better-sqlite3'
import { assertContract, ContractError } from '../../shared/validation'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { verifyPluginFile, pluginFileIdentity } from './resource-reader'

type Row = Record<string, any>
type Identity = { id: string; sha256: string; byte_length: number }
type Proposal = { task_id: string; input_resource_id: string; output_resource_id: string; pages: { page: number; start: number; end: number }[]; partial: boolean; notice: string }
const fail = (): never => { throw new ContractError('DERIVATION_INVALID', 'Derived material provenance is unavailable or changed; no repair or recursive protection was applied') }
const identity = (row: Row): Identity => ({ id: row.id, sha256: row.sha256, byte_length: row.byte_length })
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export class PluginDerivations {
  private reads = new Map<string, Map<string, Identity>>()
  private pending = new Map<string, Proposal[]>()
  private verifiedFiles = new Map<string, Map<string, string>>()
  constructor(private db: Database.Database, private root: string) {}
  read(call: string, resource: Row): void {
    const reads = this.reads.get(call) ?? new Map<string, Identity>()
    if (reads.size >= 32 && !reads.has(resource.id)) fail()
    reads.set(resource.id, identity(resource)); this.reads.set(call, reads)
  }
  propose(call: string, value: unknown): { state: 'prepared'; published: false } {
    assertContract<Proposal>('plugin_derivation', value)
    if (!this.reads.get(call)?.has(value.input_resource_id)) fail()
    const proposals = this.pending.get(call) ?? []
    if (proposals.length >= 32 || proposals.some(p => p.output_resource_id === value.output_resource_id)) fail()
    proposals.push(structuredClone(value)); this.pending.set(call, proposals)
    return { state: 'prepared', published: false }
  }
  private source(task: string, id: string): Row {
    return this.db.prepare('SELECT r.* FROM resources r JOIN task_resources t ON t.resource_id=r.id WHERE t.task_id=? AND r.id=?').get(task, id) as Row ?? fail()
  }
  async prepare(call: string, valid: () => void): Promise<void> {
    for (const p of this.pending.get(call) ?? []) {
      valid(); const row = this.source(p.task_id, p.input_resource_id)
      if (!equal(identity(row), this.reads.get(call)?.get(row.id))) fail()
      const fileIdentity = await verifyPluginFile(this.root, row as any)
      valid(); if (!equal(identity(this.source(p.task_id, row.id)), identity(row))) fail()
      const files = this.verifiedFiles.get(call) ?? new Map<string, string>()
      files.set(row.id, fileIdentity); this.verifiedFiles.set(call, files)
    }
  }
  commit(call: string, resources: Row[], record: (task: string, kind: string, payload: Row) => void, pluginVersion: string): void {
    if (!this.db.inTransaction) fail()
    const original = this.db.prepare('SELECT * FROM calls WHERE id=?').get(call) as Row
    for (const p of this.pending.get(call) ?? []) {
      if (!original || original.task_id !== p.task_id || !original.commit_valid || original.state !== 'finalizing' || JSON.parse(original.limits_json).plugin_version !== pluginVersion) fail()
      const input = this.source(p.task_id, p.input_resource_id), output = resources.find(r => r.id === p.output_resource_id) ?? fail()
      if (!equal(identity(input), this.reads.get(call)?.get(input.id))) fail()
      if (!/^[A-Za-z0-9_-]+$/.test(input.storage_key) || pluginFileIdentity(lstatSync(join(this.root, 'resources', input.storage_key))) !== this.verifiedFiles.get(call)?.get(input.id)) fail()
      let previousEnd = 0, previousPage = 0
      for (const page of p.pages) {
        if (page.page <= previousPage || page.start < previousEnd || page.end < page.start || page.end > output.byte_length) fail()
        previousEnd = page.end; previousPage = page.page
      }
      const payload = { version: 1, call_id: call, capability_id: original.capability_id, package_digest: JSON.parse(original.limits_json).package_digest, plugin_version: JSON.parse(original.limits_json).plugin_version, input: identity(input), output: identity(output), parameters: JSON.parse(original.input_json).arguments, pages: p.pages, partial: p.partial, notice: p.notice, location_verification: 'tool_reported' }
      assertContract('derived_material', payload)
      record(p.task_id, 'material.derived', payload)
    }
  }
  settled(call: string): void { this.reads.delete(call); this.pending.delete(call); this.verifiedFiles.delete(call) }
  validate(task: string, value: unknown): Row {
    try {
      assertContract<Row>('derived_material', value)
      const call = this.db.prepare("SELECT * FROM calls WHERE id=? AND task_id=? AND state='ended' AND execution='success' AND delivery='delivered'").get(value.call_id, task) as Row
      if (!call || call.capability_id !== value.capability_id || JSON.parse(call.limits_json).package_digest !== value.package_digest || JSON.parse(call.limits_json).plugin_version !== value.plugin_version || !equal(JSON.parse(call.input_json).arguments, value.parameters)) fail()
      if (!equal(identity(this.source(task, value.input.id)), value.input) || !equal(identity(this.source(task, value.output.id)), value.output)) fail()
      if (!JSON.parse(call.result_json).resources?.some((r: Row) => equal(identity(r), value.output))) fail()
      let end = 0, number = 0
      for (const page of value.pages) { if (page.page <= number || page.start < end || page.end < page.start || page.end > value.output.byte_length) fail(); number = page.page; end = page.end }
      return value
    } catch { return fail() }
  }
  validateStored(): void {
    for (const row of this.db.prepare("SELECT task_id,payload_json FROM records WHERE kind='material.derived' ORDER BY task_id,sequence").iterate() as Iterable<Row>) {
      try { this.validate(row.task_id, JSON.parse(row.payload_json)) } catch { fail() }
    }
  }
  forOutput(task: string, output: string): Row | null {
    const rows = this.db.prepare("SELECT payload_json FROM records WHERE task_id=? AND kind='material.derived' AND json_extract(payload_json,'$.output.id')=? ORDER BY sequence DESC LIMIT 2").all(task, output) as Row[]
    if (rows.length > 1) fail()
    return rows.length ? this.validate(task, JSON.parse(rows[0]!.payload_json)) : null
  }
  navigation(task: string, output: string): Row | null {
    const value = this.forOutput(task, output)
    if (!value) return null
    const { parameters: _, ...navigation } = value
    return navigation
  }
  fromInput(task: string, input: string): Row {
    const rows = this.db.prepare("SELECT id,sequence,payload_json FROM records WHERE task_id=? AND kind='material.derived' AND json_extract(payload_json,'$.input.id')=? ORDER BY sequence DESC LIMIT 21").all(task, input) as Row[]
    return { items: rows.slice(0, 20).map(row => { const value = this.validate(task, JSON.parse(row.payload_json)); return { event_id: row.id, resource_id: value.output.id, call_id: value.call_id, partial: value.partial, plugin_version: value.plugin_version } }), truncated: rows.length > 20, notice: 'Only the latest 20 derived results are listed. Older provenance remains in the original event records. No automatic reuse or parsing.' }
  }
}
