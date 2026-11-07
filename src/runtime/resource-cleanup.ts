import type Database from 'better-sqlite3'
import fs from 'node:fs'
import { join } from 'node:path'
import { flushDirectorySync,managedFile,openRegularFileSync, type DirectoryDurability } from '../platform/files'
import defaults from '../shared/contracts/development-defaults.json'
import { ContractError } from '../shared/validation'
import type { RestrictedGc } from './gc'
import type { RecoveryManager } from './recovery'
import { digest } from './resources'
import type { RestoreJournal } from './restore-journal'

type Row = Record<string, any>
type Identity = { dev: number; ino: number; size: number; mtime: number; ctime: number; hash: string }
export type TaskDeletion = { task_id: string; resources: Row[]; stages: Row[] }
export type ResourceCleanup = { version: 1; id: string; resource: Row; source_tasks: string[]; stages: Row[]; phase: 'candidate' | 'retired' | 'deleting' | 'file_deleted' | 'complete'; preview: { token: string; selected: string; graph: string; identity: Identity } | null; identity: Identity | null; selected: string | null; attempt: number; next_retry_at: string | null; reason: string; file_result: 'deleted' | 'absent' | null; created_at: string }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const key = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]+$/.test(v)
const fail = (code: string): never => { throw new ContractError(code, 'Resource retained or cleanup incomplete; query the original cleanup. No business request is replayed') }
function validIdentity(i: any): boolean { return !!i && [i.dev, i.ino, i.size, i.mtime, i.ctime].every(Number.isFinite) && i.size >= 0 && /^[a-f0-9]{64}$/.test(i.hash) }
export function validateResourceCleanup(r: any): asserts r is ResourceCleanup {
  const resource = r?.resource
  if (!r || r.version !== 1 || !uuid.test(r.id) || !resource || !uuid.test(resource.id) || !key(resource.storage_key) || !/^[a-f0-9]{64}$/.test(resource.sha256) || !Number.isSafeInteger(resource.byte_length) || resource.byte_length < 0 || typeof resource.display_name !== 'string' || typeof resource.media_type !== 'string' || typeof resource.created_at !== 'string' || !Array.isArray(r.source_tasks) || !r.source_tasks.length || r.source_tasks.some((t: unknown) => typeof t !== 'string' || !uuid.test(t)) || !Array.isArray(r.stages) || !['candidate', 'retired', 'deleting', 'file_deleted', 'complete'].includes(r.phase) || !Number.isInteger(r.attempt) || r.attempt < 0 || r.attempt > 4 || (r.next_retry_at !== null && !Number.isFinite(Date.parse(r.next_retry_at))) || typeof r.reason !== 'string' || !Number.isFinite(Date.parse(r.created_at)) || ![null, 'deleted', 'absent'].includes(r.file_result)) fail('RESOURCE_CLEANUP_CONTROL_INVALID')
  if (r.preview !== null && (!r.preview || !uuid.test(r.preview.token) || typeof r.preview.selected !== 'string' || !/^[a-f0-9]{64}$/.test(r.preview.graph) || !validIdentity(r.preview.identity))) fail('RESOURCE_CLEANUP_CONTROL_INVALID')
  if (r.phase !== 'candidate' && (!validIdentity(r.identity) || typeof r.selected !== 'string')) fail('RESOURCE_CLEANUP_CONTROL_INVALID')
  if (['file_deleted', 'complete'].includes(r.phase) && r.file_result === null) fail('RESOURCE_CLEANUP_CONTROL_INVALID')
  for (const s of r.stages) if (!s || typeof s.id !== 'string' || !r.source_tasks.includes(s.task_id) || !key(s.storage_key)) fail('RESOURCE_CLEANUP_CONTROL_INVALID')
}

// Serialized by the maintenance barrier. A resources row alone is metadata, not a liveness root.
export class ResourceCleanupManager {
  constructor(private root: string, private database: () => Database.Database, private journal: RestoreJournal, private recovery: RecoveryManager, private gc: RestrictedGc) {}
  private graph(): string { return digest(Buffer.from(JSON.stringify([this.journal.retirementGraph(), this.recovery.replicaGraph()]))) }
  private read(id: string): ResourceCleanup { const r = this.journal.resourceRecord(id); if (!r) fail('RESOURCE_CLEANUP_NOT_FOUND'); return r! }
  private present(file: string): boolean { try { fs.lstatSync(file); return true } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e } }
  private path(r: ResourceCleanup): string { return managedFile(this.root, 'resources', r.resource.storage_key) }
  private identity(r: ResourceCleanup): Identity {
    const directory = join(this.root, 'resources')
    if (!fs.lstatSync(directory).isDirectory()) fail('RESOURCE_UNSAFE_FILE')
    const path = this.path(r), stat = fs.lstatSync(path)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== r.resource.byte_length || stat.size > defaults.transport.resource_bytes) fail('RESOURCE_UNSAFE_FILE')
    const fd = openRegularFileSync(path)
    try {
      const opened = fs.fstatSync(fd), hash = digest(fs.readFileSync(fd)), end = fs.fstatSync(fd)
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || end.size !== stat.size || end.mtimeMs !== stat.mtimeMs || end.ctimeMs !== stat.ctimeMs || hash !== r.resource.sha256) fail('RESOURCE_FILE_CHANGED')
      return { dev: stat.dev, ino: stat.ino, size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs, hash }
    } finally { fs.closeSync(fd) }
  }
  private sync(): DirectoryDurability {
    return flushDirectorySync(managedFile(this.root, 'resources'))
  }
  private protection(r: ResourceCleanup): string | null {
    const db = this.database(), material = r.resource, ids = new Set([material.id])
    const current = db.prepare('SELECT * FROM resources WHERE id=?').get(material.id) as Row | undefined
    if (current && JSON.stringify(current) !== JSON.stringify(material)) return 'RESOURCE_METADATA_CHANGED'
    if (!current && !['file_deleted', 'complete'].includes(r.phase)) return 'RESOURCE_METADATA_MISSING'
    const aliases = db.prepare('SELECT id FROM resources WHERE storage_key=? AND id!=?').all(material.storage_key, material.id) as Row[]
    if (aliases.length) return 'SHARED_STORAGE_KEY'
    if (r.source_tasks.some(t => db.prepare('SELECT 1 FROM tasks WHERE id=?').get(t))) return 'TASK_DELETION_INCOMPLETE'
    if (db.prepare('SELECT 1 FROM task_resources WHERE resource_id=? LIMIT 1').get(material.id)) return 'TASK_ASSOCIATION'
    if (db.prepare("SELECT 1 FROM object_references WHERE target_kind='resource' AND target_id IN (?,?) LIMIT 1").get(material.id, material.storage_key)) return 'EXPLICIT_REFERENCE'
    if (db.prepare('SELECT 1 FROM views WHERE bundle_resource_id=? UNION ALL SELECT 1 FROM view_history WHERE bundle_resource_id=? UNION ALL SELECT 1 FROM recovery_resources WHERE resource_id=? LIMIT 1').get(material.id, material.id, material.id)) return 'VIEW_HISTORY_OR_RECOVERY'
    try {
      // Registered references are a projection; frozen history is independently authoritative.
      for (const data of db.prepare('SELECT references_json FROM task_data').iterate() as Iterable<Row>) {
        const refs = JSON.parse(data.references_json)
        if (!Array.isArray(refs) || refs.some((ref: Row) => !ref?.target || !['resource', 'task_data'].includes(ref.target.kind) || typeof ref.target.id !== 'string')) return 'REFERENCE_FACTS_UNCERTAIN'
        if (refs.some((ref: Row) => ref?.target?.kind === 'resource' && [material.id, material.storage_key].includes(ref.target.id))) return 'TASK_DATA_REFERENCE'
      }
      for (const history of db.prepare('SELECT evidence_snapshot_json FROM view_history').iterate() as Iterable<Row>) {
        const saved = JSON.parse(history.evidence_snapshot_json), sources = saved.evidence?.sources ?? []
        if (saved.resources !== undefined && (!Array.isArray(saved.resources) || saved.resources.some((v: Row) => typeof v?.id !== 'string'))) return 'HISTORY_FACTS_UNCERTAIN'
        if ((saved.resources ?? []).some((v: Row) => ids.has(v.id) || v.storage_key === material.storage_key)) return 'FROZEN_VIEW_RESOURCE'
        if (!Array.isArray(sources)) return 'HISTORY_FACTS_UNCERTAIN'
        for (const source of sources) {
          if (!Array.isArray(source.resources) || source.resources.some((v: Row) => typeof v?.id !== 'string') || !Array.isArray(source.references) || source.references.some((ref: Row) => !ref?.target || !['resource', 'task_data'].includes(ref.target.kind) || typeof ref.target.id !== 'string')) return 'HISTORY_FACTS_UNCERTAIN'
          if (source.resources.some((v: Row) => ids.has(v.id)) || source.references.some((v: Row) => v?.target?.kind === 'resource' && [material.id, material.storage_key].includes(v.target.id))) return 'FROZEN_HISTORY'
        }
      }
    } catch { return 'REFERENCE_FACTS_UNCERTAIN' }
    if (db.prepare('SELECT 1 FROM staging WHERE storage_key=? OR resource_id=? LIMIT 1').get(material.storage_key, material.id)) return 'STAGING_PIN_OR_UNCERTAIN'
    // Only exact successful committed handoff records captured before source-task deletion are discharged.
    if (r.stages.some(s => s.owner_kind !== 'action' || s.state !== 'committed' || s.resource_id !== material.id || s.storage_key !== material.storage_key || s.sha256 !== material.sha256 || s.expected_bytes !== material.byte_length || s.owner_state !== 'ended' || s.owner_result !== 'success' || s.owner_commit_valid !== 0)) return 'ARCHIVED_STAGING_UNCERTAIN'
    try {
      if (this.recovery.protects(material.id) || this.recovery.protects(material.storage_key)) return 'INDEPENDENT_RECOVERY_OR_REPLICA'
      const protectedKeys = this.gc.protectionKeys()
      if (protectedKeys.has(material.id) || protectedKeys.has(material.storage_key)) return 'RETAINED_DATABASE'
    } catch { return 'PROTECTION_FACTS_UNCERTAIN' }
    return null
  }
  list(before = Number.MAX_SAFE_INTEGER, summary = false): unknown {
    const page = this.journal.resourcePage(before)
    return { items: page.records.map(r => {
      const reason = summary ? null : r.phase === 'complete' ? (this.present(this.path(r)) ? 'RESOURCE_FILE_REAPPEARED' : null) : this.protection(r)
      return { ...this.public(r), checked: !summary, can_request: r.phase === 'candidate', eligible: !summary && r.phase === 'candidate' && !reason, protection_reason: reason }
    }), next_before: page.next_before }
  }
  status(id: string): unknown { return this.public(this.read(id)) }
  preview(token: string, id: string): unknown {
    const r = this.read(id)
    if (r.phase !== 'candidate') fail('RESOURCE_ORIGINAL_OPERATION_OWNS_FILE')
    const protection = this.protection(r); if (protection) fail(protection)
    const identity = this.identity(r)
    r.preview = { token, selected: this.journal.selected(), graph: this.graph(), identity }; r.reason = 'RESOURCE_PREVIEW_VERIFIED'
    this.journal.saveResourceCleanup(r); return this.public(r)
  }
  execute(token: string, id: string, retry: boolean): unknown {
    let r = this.read(id)
    if (retry ? r.phase === 'candidate' || r.phase === 'complete' : r.phase !== 'candidate' || r.preview?.token !== token) fail('RESOURCE_CONFIRMATION_EXPIRED')
    if (r.attempt >= 4 || (r.next_retry_at && Date.parse(r.next_retry_at) > Date.now())) return this.public(r)
    const protection = this.protection(r); if (protection) fail(protection)
    if (!retry) {
      if (!r.preview || r.preview.selected !== this.journal.selected() || r.preview.graph !== this.graph() || JSON.stringify(this.identity(r)) !== JSON.stringify(r.preview.identity)) fail('RESOURCE_FACTS_CHANGED')
      const preview = r.preview!
      r.identity = preview.identity; r.selected = preview.selected; r.phase = 'retired'; r.preview = null; r.reason = 'RESOURCE_RETIREMENT_DURABLE'; this.journal.saveResourceCleanup(r)
    } else if (r.selected !== this.journal.selected()) fail('RESOURCE_GENERATION_CHANGED')
    try {
      r.attempt++; r.next_retry_at = null; this.journal.saveResourceCleanup(r)
      if (r.phase === 'file_deleted') {
        if (this.present(this.path(r))) fail('RESOURCE_FILE_REAPPEARED')
      } else {
        let durability: DirectoryDurability
        if (this.present(this.path(r))) {
          if (JSON.stringify(this.identity(r)) !== JSON.stringify(r.identity)) fail('RESOURCE_FILE_CHANGED')
          r.phase = 'deleting'; r.reason = 'RESOURCE_DELETE_INTENT'; this.journal.saveResourceCleanup(r)
          const protectedNow = this.protection(r); if (protectedNow) fail(protectedNow)
          if (JSON.stringify(this.identity(r)) !== JSON.stringify(r.identity)) fail('RESOURCE_FILE_CHANGED')
          fs.unlinkSync(this.path(r)); durability = this.sync(); r.file_result = 'deleted'
        } else { durability = this.sync(); r.file_result = 'absent' }
        r.phase = 'file_deleted'; r.reason = durability === 'directory-synced' ? 'RESOURCE_FILE_DELETED_DURABLE' : 'RESOURCE_FILE_DELETED_CONFIRMED'; this.journal.saveResourceCleanup(r)
      }
      // The file result precedes metadata cleanup. A failed transaction can only retry this exact cleanup.
      this.database().transaction(() => {
        const protectedNow = this.protection(r); if (protectedNow) fail(protectedNow)
        if (this.present(this.path(r))) fail('RESOURCE_FILE_REAPPEARED')
        this.database().prepare('DELETE FROM resources WHERE id=? AND storage_key=? AND sha256=? AND byte_length=?').run(r.resource.id, r.resource.storage_key, r.resource.sha256, r.resource.byte_length)
      })()
      r.phase = 'complete'; r.reason = 'RESOURCE_CLEANUP_COMPLETE'; this.journal.saveResourceCleanup(r)
    } catch (error) {
      const code = error instanceof ContractError ? error.code : (error as NodeJS.ErrnoException).code
      r = this.read(id); r.reason = /^[A-Z][A-Z0-9_]+$/.test(code ?? '') ? code! : 'RESOURCE_CLEANUP_RECORD_FAILED'
      const delay = defaults.cleanup.retry_delays_ms[r.attempt - 1]; r.next_retry_at = delay === undefined ? null : new Date(Date.now() + delay).toISOString()
      this.journal.saveResourceCleanup(r)
    }
    return this.status(id)
  }
  private public(r: ResourceCleanup): Record<string, unknown> {
    return { id: r.id, resource_id: r.resource.id, display_name: r.resource.display_name, bytes: r.resource.byte_length, phase: r.phase, reason: r.reason, attempt: r.attempt, next_retry_at: r.next_retry_at, file_result: r.file_result, files_deleted: r.file_result === 'deleted' ? 1 : 0, deleted_bytes: r.file_result === 'deleted' ? r.resource.byte_length : 0, metadata_cleaned: r.phase === 'complete', created_at: r.created_at, business_replayed: false }
  }
}
