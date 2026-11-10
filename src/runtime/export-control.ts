import { encodeFileIdentity,validStoredFileIdentity,type IdentityEncoding,type IdentityInput,type StoredFileIdentity } from '../platform/file-identity'
import { newTestIdentityEncoding } from './file-format'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { entryExistsSync as existsSync,flushDirectorySync,flushFileSync,managedRegularFile } from '../platform/files'
import { protectPrivatePath } from '../platform/permissions'
import { ContractError } from '../shared/validation'

export interface ExportResource { id: string; storage_key: string; sha256: string; byte_length: number; media_type: string; display_name: string }
export type ExportPhase = 'preparing' | 'preview' | 'saving' | 'saved' | 'cancelled' | 'failed' | 'interrupted' | 'unknown'
export interface ExportJob {
  version: IdentityEncoding; id: string; task_id: string; epoch: string; selected: string; created_at: string;
  phase: ExportPhase; resources: ExportResource[]; snapshot: unknown; issues: string[]; html: string | null;
  partial_confirmed: boolean; destination: null | { target: string; temporary: string; identity: StoredFileIdentity | null }; reason: string | null
}
const uuid = /^[0-9a-f-]{36}$/
const terminal = new Set<ExportPhase>(['saved', 'cancelled', 'failed'])
const fail = (code = 'EXPORT_CONTROL_INVALID'): never => { throw new ContractError(code, 'Export state cannot be safely used; retained files were not replayed or deleted') }
function regular(file: string): void { const s = lstatSync(file); if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1) fail() }
function flush(root: string, file: string): void {
  flushFileSync(file)
  flushDirectorySync(root)
}

export class ExportControl {
  private db: Database.Database
  readonly encoding: IdentityEncoding
  constructor(private root: string, established: boolean, reconcile = true, expectedEncoding?: IdentityEncoding) {
    const createEncoding = expectedEncoding ?? newTestIdentityEncoding(root)
    const file = managedRegularFile(root, 'export-control.sqlite'), present = existsSync(file)
    if (established && !present) fail()
    if (present) regular(file)
    this.db = new Database(file)
    try {
      this.db.pragma('journal_mode=DELETE'); this.db.pragma('synchronous=FULL'); this.db.pragma('busy_timeout=0'); protectPrivatePath(file, 'file')
      if (!present) this.db.transaction(() => {
        this.db.exec('CREATE TABLE export_version(version INTEGER NOT NULL); CREATE TABLE export_jobs(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, phase TEXT NOT NULL, manifest TEXT NOT NULL); CREATE INDEX export_jobs_task ON export_jobs(task_id,phase)')
        this.db.prepare('INSERT INTO export_version VALUES(?)').run(createEncoding)
      })()
      const versions = this.db.prepare('SELECT version FROM export_version').all() as { version: number }[]
      if (versions.length !== 1 || ![1, 2].includes(versions[0]!.version) || this.db.pragma('quick_check', { simple: true }) !== 'ok') fail()
      this.encoding = versions[0]!.version as IdentityEncoding
      if (expectedEncoding !== undefined && this.encoding !== expectedEncoding) fail()
      if ((this.db.prepare("SELECT count(*) n FROM export_jobs WHERE phase NOT IN ('saved','failed','cancelled')").get() as any).n > 1) fail()
      let after = 0
      while (true) {
        const rows = this.db.prepare('SELECT rowid ordinal,id,task_id,phase,length(CAST(manifest AS BLOB)) bytes FROM export_jobs WHERE rowid>? ORDER BY rowid LIMIT 50').all(after) as any[]
        if (!rows.length) break
        for (const row of rows) {
          if (row.bytes > 32 * 1024 * 1024 || !Number.isSafeInteger(row.bytes)) fail()
          const job = this.get(row.id)
          if (job.task_id !== row.task_id || job.phase !== row.phase) fail()
          if (reconcile && !terminal.has(job.phase) && !['unknown', 'interrupted'].includes(job.phase)) this.put({ ...job, phase: job.destination ? 'unknown' : 'interrupted', reason: 'runtime_restart' })
        }
        after = rows.at(-1)!.ordinal
      }
      flush(root, file)
    } catch (error) { this.db.close(); throw error }
  }
  static validate(job: ExportJob): void {
    if (!job || Object.keys(job).sort().join(',') !== 'created_at,destination,epoch,html,id,issues,partial_confirmed,phase,reason,resources,selected,snapshot,task_id,version' || ![1, 2].includes(job.version) || !uuid.test(job.id) || !uuid.test(job.task_id) || !uuid.test(job.epoch) || !Number.isFinite(Date.parse(job.created_at)) || !['preparing', 'preview', 'saving', 'saved', 'cancelled', 'failed', 'interrupted', 'unknown'].includes(job.phase) || typeof job.selected !== 'string' || !/^(trellis|restore-[0-9a-f-]{36}-(target|rollback))\.sqlite$/.test(job.selected) || typeof job.partial_confirmed !== 'boolean' || !Array.isArray(job.resources) || job.resources.length > 1024 || !Array.isArray(job.issues) || job.issues.length > 1024 || job.issues.some(v => typeof v !== 'string' || v.length > 1000) || (job.html !== null && typeof job.html !== 'string') || (job.reason !== null && (typeof job.reason !== 'string' || !/^[a-zA-Z0-9_]+$/.test(job.reason)))) fail()
    const ids = new Set<string>()
    const snapshot = job.snapshot as any
    if (snapshot && typeof snapshot === 'object' && 'version' in snapshot) {
      const keys = (value: any, expected: string) => !!value && typeof value === 'object' && Object.keys(value).sort().join(',') === expected
      const unique = (values: unknown[]) => values.every(v => typeof v === 'string' && uuid.test(v)) && new Set(values).size === values.length
      if (!keys(snapshot, 'answer_ids,title,version,views') || snapshot.version !== 1 || typeof snapshot.title !== 'string' || !Array.isArray(snapshot.views) || !snapshot.views.length || snapshot.views.length > 50 || !Array.isArray(snapshot.answer_ids) || snapshot.answer_ids.length > 50 || !unique(snapshot.answer_ids) || !unique(snapshot.views.map((v: any) => v?.view_id))) fail()
      for (const view of snapshot.views) {
        if (!keys(view, 'fragments,history_id,view_id,view_revision') || !uuid.test(view.history_id) || !Number.isSafeInteger(view.view_revision) || view.view_revision < 1 || !Array.isArray(view.fragments) || new Set(view.fragments.map((f: any) => f?.id)).size !== view.fragments.length) fail()
        for (const f of view.fragments) {
          if (!keys(f, f?.personal_binding ? 'category,id,personal_binding' : 'category,id') || typeof f.id !== 'string' || !f.id || !['learning', 'answer', 'feedback', 'mixed_personal'].includes(f.category)) fail()
          if (f.category === 'learning' ? f.personal_binding !== undefined : !keys(f.personal_binding, 'answer_id,version,view_history_id') || f.personal_binding.version !== 1 || !uuid.test(f.personal_binding.answer_id) || !uuid.test(f.personal_binding.view_history_id) || !snapshot.answer_ids.includes(f.personal_binding.answer_id)) fail()
        }
      }
    }
    for (const r of job.resources) { if (!r || !uuid.test(r.id) || ids.has(r.id) || !/^[A-Za-z0-9_-]+$/.test(r.storage_key) || !/^[a-f0-9]{64}$/.test(r.sha256) || !Number.isSafeInteger(r.byte_length) || r.byte_length < 0 || r.byte_length > 268435456 || typeof r.media_type !== 'string' || typeof r.display_name !== 'string') fail(); ids.add(r.id) }
    if (job.destination && (Object.keys(job.destination).sort().join(',') !== 'identity,target,temporary' || typeof job.destination.target !== 'string' || typeof job.destination.temporary !== 'string' || !job.destination.target || !job.destination.temporary || job.destination.target.includes('\0') || job.destination.temporary.includes('\0') || job.destination.target === job.destination.temporary || (job.destination.identity !== null && (Object.keys(job.destination.identity).sort().join(',') !== 'dev,ino' || !validStoredFileIdentity(job.destination.identity, job.version))))) fail()
    if (job.phase === 'saving' && (!job.destination || !job.html)) fail()
    if (Buffer.byteLength(JSON.stringify(job)) > 32 * 1024 * 1024) fail('EXPORT_SNAPSHOT_LIMIT')
  }
  get(id: string): ExportJob {
    const row = this.db.prepare('SELECT id,task_id,phase,manifest,length(CAST(manifest AS BLOB)) bytes FROM export_jobs WHERE id=?').get(id) as any
    if (!row || row.bytes > 32 * 1024 * 1024) fail('EXPORT_NOT_FOUND')
    let job: ExportJob; try { job = JSON.parse(row.manifest); ExportControl.validate(job); if (this.encoding === 1 && job.version !== 1) fail(); if (job.id !== row.id || job.task_id !== row.task_id || job.phase !== row.phase) fail() } catch { return fail() }
    return job
  }
  private put(job: ExportJob): void {
    ExportControl.validate(job)
    if (this.encoding === 1 && job.version !== 1) fail()
    this.db.prepare('INSERT INTO export_jobs VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET phase=excluded.phase,manifest=excluded.manifest').run(job.id, job.task_id, job.phase, JSON.stringify(job))
  }
  create(task: string, epoch: string, selected: string, resources: ExportResource[], snapshot: unknown): ExportJob {
    if (this.busy()) fail('EXPORT_BUSY')
    const job: ExportJob = { version: this.encoding, id: randomUUID(), task_id: task, epoch, selected, resources, snapshot, created_at: new Date().toISOString(), phase: 'preparing', issues: [], html: null, partial_confirmed: false, destination: null, reason: null }
    this.put(job); return job
  }
  generationFailed(id: string, reason: string): void { const job = this.get(id); if (job.phase !== 'preparing') fail('EXPORT_STATE_CHANGED'); this.put({ ...job, phase: 'failed', reason }) }
  preview(id: string, html: string, issues: string[]): ExportJob { const job = this.get(id); if (job.phase !== 'preparing') fail('EXPORT_STATE_CHANGED'); this.put({ ...job, phase: 'preview', html, issues }); return this.get(id) }
  beginSave(id: string, target: string, temporary: string, partial: boolean): ExportJob {
    const job = this.get(id)
    if (job.phase !== 'preview' || (job.issues.length && !partial)) fail('EXPORT_CONFIRMATION_REQUIRED')
    this.put({ ...job, phase: 'saving', destination: { target, temporary, identity: null }, partial_confirmed: partial }); return this.get(id)
  }
  created(id: string, identity: IdentityInput): void {
    const job = this.get(id)
    if (job.phase !== 'saving' || !job.destination || job.destination.identity) fail('EXPORT_STATE_CHANGED')
    this.put({ ...job, destination: { ...job.destination!, identity: encodeFileIdentity(identity, job.version) } })
  }
  resolve(id: string, phase: 'saved' | 'failed'): void {
    const job = this.get(id)
    if (job.phase !== 'unknown') fail('EXPORT_STATE_CHANGED')
    this.put({ ...job, phase, reason: phase === 'saved' ? 'verified_after_restart' : 'user_closed_unknown_result' })
  }
  finish(id: string, phase: 'saved' | 'failed' | 'unknown', reason: string | null): void {
    const job = this.get(id); if (job.phase !== 'saving') fail('EXPORT_STATE_CHANGED')
    this.put({ ...job, phase, reason })
  }
  cancel(id: string): void {
    const job = this.get(id)
    if (terminal.has(job.phase)) return
    if (job.destination || job.phase === 'saving') fail('EXPORT_SAVE_UNRESOLVED')
    this.put({ ...job, phase: 'cancelled', reason: 'user_cancelled' })
  }
  cancelTask(task: string): void { for (const r of this.db.prepare("SELECT id FROM export_jobs WHERE task_id=? AND phase NOT IN ('saved','cancelled','failed')").all(task) as any[]) this.cancel(r.id) }
  busy(): boolean { return !!this.db.prepare("SELECT 1 FROM export_jobs WHERE phase NOT IN ('saved','cancelled','failed') LIMIT 1").get() }
  protects(key: string): boolean {
    for (const r of this.db.prepare("SELECT id FROM export_jobs WHERE phase NOT IN ('saved','cancelled','failed')").iterate() as Iterable<any>) if (this.get(r.id).resources.some(resource => resource.id === key || resource.storage_key === key)) return true
    return false
  }
  public(id: string): Record<string, unknown> { const j = this.get(id); return { id: j.id, task_id: j.task_id, phase: j.phase, created_at: j.created_at, resource_count: j.resources.length, issues: j.issues, reason: j.reason, pinned: !terminal.has(j.phase), bytes: j.html ? Buffer.byteLength(j.html) : 0 } }
  list(task: string): Record<string, unknown>[] { return (this.db.prepare('SELECT id FROM export_jobs WHERE task_id=? ORDER BY rowid DESC LIMIT 20').all(task) as any[]).map(r => this.public(r.id)) }
  close(): void { if (this.db.open) this.db.close() }
}
