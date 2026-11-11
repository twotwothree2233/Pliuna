import { isManagedDatabaseFile } from '../shared/branding'
import { fileFstatSync as fstatSync, fileLstatSync as lstatSync, atomicWriteFileSync, entryExistsSync as existsSync, flushDirectorySync, managedFile, managedRegularFile, openRegularFileSync, readRegularFileSync } from '../platform/files'
import { journalFileIdentity,sameJournalFileIdentity,validJournalFileIdentity,type IdentityEncoding,type JournalFileIdentity } from '../platform/file-identity'
import { newTestIdentityEncoding } from './file-format'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import fs,{ closeSync,openSync,readFileSync,readdirSync } from 'node:fs'
import { join } from 'node:path'
import { protectPrivatePath } from '../platform/permissions'
import defaults from '../shared/contracts/development-defaults.json'
import { ContractError } from '../shared/validation'
import { digest } from './resources'
import { flushFile } from './restore-journal'

type Row = Record<string, any>
type Identity = JournalFileIdentity
type Item = { stage: Row; temporary: boolean; identity: Identity; state: 'pending' | 'deleting' | 'deleted' | 'absent' | 'skipped' | 'failed'; attempt: number; next_retry_at: string | null; reason: string }
type Operation = { version: IdentityEncoding; id: string; token: string; selected: string; created_at: string; phase: 'preview' | 'running' | 'settled'; authorized: boolean; items: Item[]; protected: number; reviews: number; next_after: number | null }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const managed = isManagedDatabaseFile
const fail = (code: string): never => { throw new ContractError(code, 'GC requires inspection; files are retained. Query the original operation, do not resubmit') }

// No deletion authority is stored in a restorable business database.
export class RestrictedGc {
  private control?: Database.Database
  private error: string | null = null
  private encoding: IdentityEncoding = 1
  constructor(private root: string, private database: () => Database.Database, private selected: () => string, private retained: () => string[], private protects: (key: string) => boolean, private points: () => string[], private retired: (file: string) => boolean = () => false, private released: (file: string) => boolean = () => false, expectedEncoding?: IdentityEncoding) {
    try {
      const createEncoding = expectedEncoding ?? newTestIdentityEncoding(root)
      const file = managedRegularFile(root, 'gc-control.sqlite'), marker = join(root, 'gc-established')
      const markerValue = existsSync(marker) ? readRegularFileSync(marker, 32).toString('utf8') : null
      if (markerValue !== null && (!['gc-v1\n', 'gc-v2\n'].includes(markerValue) || !existsSync(file))) fail('GC_CONTROL_INVALID')
      if (existsSync(file) && !lstatSync(file).isFile()) fail('GC_CONTROL_INVALID')
      const present = existsSync(file)
      if (!present) { const fd = openSync(file, 'wx', 0o600); closeSync(fd) }
      this.control = new Database(file)
      this.control.pragma('busy_timeout=0'); this.control.pragma('journal_mode=DELETE'); this.control.pragma('synchronous=FULL'); protectPrivatePath(file, 'file')
      if (!present) this.control.transaction(() => {
        this.control!.exec('CREATE TABLE gc_version (version INTEGER NOT NULL); CREATE TABLE gc_operations (id TEXT PRIMARY KEY, manifest TEXT NOT NULL)')
        this.control!.prepare('INSERT INTO gc_version VALUES (?)').run(createEncoding)
      })()
      const versions = this.control.prepare('SELECT version FROM gc_version').all() as { version: number }[]
      if (versions.length !== 1 || ![1, 2].includes(versions[0]!.version)) fail('GC_CONTROL_INVALID')
      this.encoding = versions[0]!.version as IdentityEncoding
      if ((expectedEncoding !== undefined && expectedEncoding !== this.encoding) || (markerValue !== null && markerValue !== `gc-v${this.encoding}\n`)) fail('GC_CONTROL_INVALID')
      let after = 0
      while (true) {
        const rows = this.control.prepare('SELECT rowid AS ordinal,manifest FROM gc_operations WHERE rowid>? ORDER BY rowid LIMIT 50').all(after) as Row[]
        if (!rows.length) break
        for (const row of rows) {
        const op = this.validate(JSON.parse(row.manifest))
        if (op.phase === 'running') {
          for (const item of op.items) if (item.state === 'deleting') {
            // Absence proves no remaining file, not who removed it or durable reclaimed bytes.
            try { this.identity(item); item.state = 'pending'; item.reason = 'INTERRUPTED_RECONFIRM' }
            catch (error) { item.state = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'skipped'; item.reason = 'INTERRUPTED_RECHECK' }
          }
          op.phase = 'settled'; this.save(op)
        }
        }
        after = rows.at(-1)!.ordinal
      }
      flushFile(root, 'gc-control.sqlite')
      if (!existsSync(marker)) { atomicWriteFileSync(marker, `gc-v${this.encoding}\n`) }
    } catch { this.error = 'GC_CONTROL_INVALID' }
  }
  private validate(value: any): Operation {
    if (!value || ![1, 2].includes(value.version) || (this.encoding === 1 && value.version !== 1) || !uuid.test(value.id) || !uuid.test(value.token) || !managed(value.selected) || !Number.isFinite(Date.parse(value.created_at)) || !['preview', 'running', 'settled'].includes(value.phase) || typeof value.authorized !== 'boolean' || (value.phase === 'running' && !value.authorized) || !Array.isArray(value.items) || value.items.length > 100 || !Number.isSafeInteger(value.protected) || value.protected < 0 || !Number.isSafeInteger(value.reviews) || value.reviews < 0 || (value.next_after !== null && (!Number.isSafeInteger(value.next_after) || value.next_after < 0))) fail('GC_CONTROL_INVALID')
    for (const item of value.items) {
      const s = item?.stage, i = item?.identity
      if (!s || typeof s.id !== 'string' || typeof s.storage_key !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s.storage_key) || typeof item.temporary !== 'boolean' || !validJournalFileIdentity(i, value.version) || !['pending', 'deleting', 'deleted', 'absent', 'skipped', 'failed'].includes(item.state) || !Number.isInteger(item.attempt) || item.attempt < 0 || item.attempt > 4 || (item.next_retry_at !== null && !Number.isFinite(Date.parse(item.next_retry_at))) || typeof item.reason !== 'string') fail('GC_CONTROL_INVALID')
    }
    if (new Set(value.items.map((item: Item) => this.name(item))).size !== value.items.length) fail('GC_CONTROL_INVALID')
    return value
  }
  private save(op: Operation): void {
    this.validate(op)
    try { this.control!.transaction(() => this.control!.prepare('INSERT INTO gc_operations VALUES (?,?) ON CONFLICT(id) DO UPDATE SET manifest=excluded.manifest').run(op.id, JSON.stringify(op)))() }
    catch { this.error = 'GC_REGISTRATION_FAILED'; fail(this.error) }
  }
  private read(id: string): Operation {
    if (this.error) fail(this.error)
    const row = this.control!.prepare('SELECT manifest FROM gc_operations WHERE id=?').get(id) as Row | undefined
    if (!row) fail('GC_OPERATION_NOT_FOUND')
    try { return this.validate(JSON.parse(row!.manifest)) }
    catch { this.error = 'GC_CONTROL_INVALID'; return fail(this.error) }
  }
  private claimed(stage: Row, temporary: boolean, identity: Identity, except?: string): boolean {
    for (const record of this.control!.prepare('SELECT manifest FROM gc_operations ORDER BY rowid').iterate() as Iterable<Row>) {
      let old: Operation
      try { old = this.validate(JSON.parse(record.manifest)) } catch { this.error = 'GC_CONTROL_INVALID'; return fail(this.error) }
      if (old.id !== except && old.authorized && old.items.some(item => item.reason !== 'ORIGINAL_OPERATION_OWNS_FILE' && this.name(item) === this.name({ stage, temporary }) && sameJournalFileIdentity(item.identity, identity))) return true
    }
    return false
  }
  private name(item: Pick<Item, 'stage' | 'temporary'>): string { return item.stage.storage_key + (item.temporary ? '.tmp' : '') }
  private identity(item: Pick<Item, 'stage' | 'temporary'>): Identity {
    const directory = join(this.root, 'resources')
    if (!lstatSync(directory).isDirectory()) fail('GC_UNSAFE_FILE')
    const file = join(directory, this.name(item)), stat = lstatSync(file)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > defaults.transport.resource_bytes) fail('GC_UNSAFE_FILE')
    const fd = openRegularFileSync(file)
    try {
      const opened = fstatSync(fd)
      if (opened.dev !== stat.dev || opened.ino !== stat.ino) fail('GC_FILE_CHANGED')
      const hash = digest(readFileSync(fd)), end = fstatSync(fd)
      if (end.size !== stat.size || end.mtimeMs !== stat.mtimeMs || end.ctimeMs !== stat.ctimeMs) fail('GC_FILE_CHANGED')
      return journalFileIdentity({ dev: stat.dev, ino: stat.ino, size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs, hash }, this.encoding)
    } finally { closeSync(fd) }
  }
  private formal(db: Database.Database, key: string): boolean {
    return !!db.prepare("SELECT 1 FROM resources WHERE id=? OR storage_key=? UNION ALL SELECT 1 FROM task_resources WHERE resource_id=? UNION ALL SELECT 1 FROM object_references WHERE target_kind='resource' AND target_id=? AND protects_resource=1 UNION ALL SELECT 1 FROM views WHERE bundle_resource_id=? UNION ALL SELECT 1 FROM view_history WHERE bundle_resource_id=? UNION ALL SELECT 1 FROM recovery_resources WHERE resource_id=? LIMIT 1").get(key, key, key, key, key, key, key)
  }
  private retainedProtection(exclude?: string): Set<string> {
    const keys = new Set<string>()
    // Enumerate database metadata only, never scan the resource directory for garbage.
    const known = new Set(this.retained()), files = [...known].filter(name => name !== this.selected() && name !== exclude).map(name => join(this.root, name))
    for (const name of readdirSync(this.root)) if (this.released(name.replace(/-(wal|shm|journal)$/, ''))) fail('GC_RETIRED_FILE_REAPPEARED')
    for (const name of readdirSync(this.root)) if (name !== 'restore-control.sqlite' && /^restore-.*\.sqlite$/.test(name) && !known.has(name) && !this.retired(name)) fail('GC_RETAINED_UNCERTAIN')
    const recovery = join(this.root, 'recovery')
    if (!lstatSync(recovery).isDirectory()) fail('GC_RETAINED_UNCERTAIN')
    for (const id of this.points()) if (!existsSync(join(recovery, id + '.sqlite'))) fail('GC_RETAINED_UNCERTAIN')
    const names = readdirSync(recovery)
    for (const name of names) {
      if (this.released('recovery/' + name.replace(/-(wal|shm|journal)$/, ''))) fail('GC_RETIRED_FILE_REAPPEARED')
      if (this.retired('recovery/' + name.replace(/-(wal|shm|journal)$/, '')) || 'recovery/' + name.replace(/-(wal|shm|journal)$/, '') === exclude) continue
      if (/^[a-f0-9-]{36}\.sqlite-(wal|shm|journal)$/.test(name) && names.includes(name.replace(/-(wal|shm|journal)$/, ''))) continue
      if (!/^[a-f0-9-]{36}\.sqlite$/.test(name)) fail('GC_RETAINED_UNCERTAIN')
      files.push(join(recovery, name))
    }
    for (const file of files) {
      if (!existsSync(file)) continue // A registered partial candidate may never have been created.
      if (!lstatSync(file).isFile()) fail('GC_RETAINED_UNCERTAIN')
      const db = new Database(file, { readonly: true, fileMustExist: true })
      try {
        if (db.pragma('quick_check', { simple: true }) !== 'ok' || JSON.stringify(db.prepare('SELECT version FROM schema_version').all()) !== '[{"version":1}]' || (db.pragma('foreign_key_check') as unknown[]).length) fail('GC_RETAINED_UNCERTAIN')
        for (const row of db.prepare('SELECT id,storage_key FROM resources').iterate() as Iterable<Row>) { keys.add(row.id); keys.add(row.storage_key) }
        for (const row of db.prepare('SELECT storage_key FROM staging').iterate() as Iterable<Row>) keys.add(row.storage_key)
        for (const row of db.prepare("SELECT resource_id AS id FROM task_resources UNION SELECT target_id FROM object_references WHERE target_kind='resource' AND protects_resource=1 UNION SELECT bundle_resource_id FROM views UNION SELECT bundle_resource_id FROM view_history UNION SELECT resource_id FROM recovery_resources").iterate() as Iterable<Row>) keys.add(row.id)
        for (const row of db.prepare('SELECT references_json FROM task_data').iterate() as Iterable<Row>) this.referenceKeys(JSON.parse(row.references_json), keys)
        for (const row of db.prepare('SELECT evidence_snapshot_json FROM view_history').iterate() as Iterable<Row>) {
          const saved = JSON.parse(row.evidence_snapshot_json), sources = saved.evidence?.sources ?? []
          if (saved.resources !== undefined && !Array.isArray(saved.resources)) fail('GC_RETAINED_UNCERTAIN')
          for (const r of saved.resources ?? []) { if (typeof r?.id !== 'string' || typeof r?.storage_key !== 'string') fail('GC_RETAINED_UNCERTAIN'); keys.add(r.id); keys.add(r.storage_key) }
          if (!Array.isArray(sources)) fail('GC_RETAINED_UNCERTAIN')
          for (const source of sources) {
            if (!Array.isArray(source.resources)) fail('GC_RETAINED_UNCERTAIN')
            for (const resource of source.resources) { if (typeof resource?.id !== 'string') fail('GC_RETAINED_UNCERTAIN'); keys.add(resource.id) }
            this.referenceKeys(source.references, keys)
          }
        }
      } finally { db.close() }
    }
    return keys
  }
  private referenceKeys(refs: unknown, keys: Set<string>): void {
    if (!Array.isArray(refs)) fail('GC_RETAINED_UNCERTAIN')
    for (const ref of refs as Row[]) {
      if (!ref?.target || !['resource', 'task_data'].includes(ref.target.kind) || typeof ref.target.id !== 'string') fail('GC_RETAINED_UNCERTAIN')
      if (ref.target.kind === 'resource') keys.add(ref.target.id)
    }
  }
  assertDependencies(exclude?: string): void { try { this.retainedProtection(exclude) } catch { fail('GC_RETAINED_UNCERTAIN') } }
  protectionKeys(): Set<string> { return this.retainedProtection() }
  protectsRetained(key: string): boolean { try { return this.retainedProtection().has(key) } catch { return true } }
  private eligible(stage: Row, retained: Set<string>): boolean {
    const db = this.database(), s = db.prepare('SELECT * FROM staging WHERE id=?').get(stage.id) as Row | undefined
    if (!s || JSON.stringify(s) !== JSON.stringify(stage) || !/^[A-Za-z0-9_-]+$/.test(s.storage_key) || s.state === 'committed' || this.formal(db, s.storage_key) || retained.has(s.storage_key) || this.protects(s.storage_key) || (s.resource_id && (this.formal(db, s.resource_id) || retained.has(s.resource_id) || this.protects(s.resource_id)))) return false
    if (db.prepare('SELECT 1 FROM staging WHERE storage_key=? AND id!=?').get(s.storage_key, s.id)) return false
    const owner = s.owner_kind === 'action' && db.prepare('SELECT state,result,commit_valid FROM actions WHERE id=? AND task_id=?').get(s.owner_id, s.task_id) as Row | undefined
    return !!owner && owner.state === 'ended' && owner.commit_valid === 0 && ['not_executed', 'failure', 'cancelled'].includes(owner.result)
  }
  preview(token: string, after = 0): unknown {
    if (this.error) fail(this.error)
    let retained: Set<string>
    try { retained = this.retainedProtection() } catch { fail('GC_RETAINED_UNCERTAIN') }
    const rows = this.database().prepare('SELECT rowid AS ordinal,* FROM staging WHERE rowid>? ORDER BY rowid LIMIT 51').all(after) as Row[]
    const op: Operation = { version: this.encoding, id: randomUUID(), token, selected: this.selected(), created_at: new Date().toISOString(), phase: 'preview', authorized: false, items: [], protected: 0, reviews: 0, next_after: rows.length > 50 ? rows[49]!.ordinal : null }
    for (const row of rows.slice(0, 50)) {
      const { ordinal: _, ...stage } = row
      if (!this.eligible(stage, retained!)) { op.protected++; continue }
      for (const temporary of [false, true]) {
        try {
          const identity = this.identity({ stage, temporary })
          if (this.claimed(stage, temporary, identity)) { op.protected++; continue }
          if (!Number.isSafeInteger(stage.expected_bytes) || stage.expected_bytes < 0 || identity.size > stage.expected_bytes || (!temporary && (identity.size !== stage.expected_bytes || identity.hash !== stage.sha256))) { op.reviews++; continue }
          op.items.push({ stage, temporary, identity, state: 'pending', attempt: 0, next_retry_at: null, reason: 'VERIFIED_ORPHAN' })
        } catch (error) { if (this.error) throw error; if ((error as NodeJS.ErrnoException).code !== 'ENOENT') op.reviews++ }
      }
    }
    this.save(op); return this.public(op)
  }
  execute(token: string, id: string, retry: boolean): unknown {
    const op = this.read(id)
    if (op.selected !== this.selected() || (retry ? !op.authorized || op.phase !== 'settled' : op.token !== token || op.phase !== 'preview')) fail('GC_CONFIRMATION_EXPIRED')
    op.token = token; op.authorized = true; op.phase = 'running'; this.save(op)
    try {
      for (const item of op.items) {
        if (!(retry ? ['pending', 'failed'].includes(item.state) : item.state === 'pending') || item.attempt >= 4 || (item.next_retry_at && Date.parse(item.next_retry_at) > Date.now())) continue
        try {
          if (this.claimed(item.stage, item.temporary, item.identity, op.id)) { item.state = 'skipped'; item.reason = 'ORIGINAL_OPERATION_OWNS_FILE'; this.save(op); continue }
          const retained = this.retainedProtection()
          if (!this.eligible(item.stage, retained)) { item.state = 'skipped'; item.reason = 'PROTECTION_OR_FACTS_CHANGED'; item.next_retry_at = null; this.save(op); continue }
          const identity = this.identity(item)
          if (!sameJournalFileIdentity(identity, item.identity)) { item.state = 'skipped'; item.reason = 'FILE_CHANGED'; item.next_retry_at = null; this.save(op); continue }
          item.attempt++; item.state = 'deleting'; item.next_retry_at = null; item.reason = 'DELETE_INTENT'; this.save(op)
          // Recheck after durable intent and immediately before unlink. The runtime writer is still frozen.
          if (!this.eligible(item.stage, this.retainedProtection()) || !sameJournalFileIdentity(this.identity(item), item.identity)) { item.state = 'skipped'; item.reason = 'FINAL_CHECK_CHANGED'; this.save(op); continue }
          fs.unlinkSync(managedFile(this.root, 'resources', this.name(item)))
          flushDirectorySync(managedFile(this.root, 'resources'))
          item.state = 'deleted'; item.reason = 'DELETED'; this.save(op)
        } catch (error) {
          if (this.error) throw error
          const code = error instanceof ContractError ? error.code : (error as NodeJS.ErrnoException).code
          if (code === 'ENOENT') { item.state = 'absent'; item.reason = 'NO_REMAINING_FILE'; item.next_retry_at = null }
          else if (['EACCES', 'EPERM', 'EBUSY', 'EIO'].includes(code ?? '')) {
            if (item.state !== 'deleting') item.attempt++
            const delay = defaults.cleanup.retry_delays_ms[item.attempt - 1]
            item.state = 'failed'; item.reason = code!; item.next_retry_at = delay === undefined ? null : new Date(Date.now() + delay).toISOString()
          } else { item.state = 'skipped'; item.reason = code?.startsWith('GC_') ? code : 'GC_RETAINED_UNCERTAIN'; item.next_retry_at = null }
          this.save(op)
        }
      }
      op.phase = 'settled'; this.save(op); return this.public(op)
    } catch { fail(this.error ?? 'GC_FAILED') }
  }
  private public(op: Operation): unknown {
    return { id: op.id, phase: op.phase, authorized: op.authorized, created_at: op.created_at, protected: op.protected, reviews: op.reviews, next_after: op.next_after, files_deleted: op.items.filter(i => i.state === 'deleted').length, deleted_bytes: op.items.filter(i => i.state === 'deleted').reduce((sum, i) => sum + i.identity.size, 0), items: op.items.map((i, index) => ({ index, temporary: i.temporary, bytes: i.identity.size, state: i.state, reason: i.reason, attempt: i.attempt, next_retry_at: i.next_retry_at })), business_replayed: false, database_files_deleted: 0 }
  }
  status(id?: string): unknown {
    if (this.error) return { enabled: false, error: this.error, last: null }
    try {
      const row = id ? undefined : this.control!.prepare('SELECT id FROM gc_operations ORDER BY rowid DESC LIMIT 1').get() as Row | undefined
      return { enabled: true, error: null, last: id || row ? this.public(this.read(id ?? row!.id)) : null }
    } catch (error) {
      if (error instanceof ContractError && error.code === 'GC_OPERATION_NOT_FOUND') throw error
      this.error = 'GC_CONTROL_INVALID'; return { enabled: false, error: this.error, last: null }
    }
  }
  list(before?: number): unknown {
    if (this.error) return { enabled: false, error: this.error, items: [], next_before: null }
    try {
      const rows = this.control!.prepare('SELECT rowid AS ordinal,manifest FROM gc_operations WHERE rowid<? ORDER BY rowid DESC LIMIT 21').all(before ?? Number.MAX_SAFE_INTEGER) as Row[]
      return { items: rows.slice(0, 20).map(row => this.public(this.validate(JSON.parse(row.manifest)))), next_before: rows.length > 20 ? rows[19]!.ordinal : null }
    } catch { this.error = 'GC_CONTROL_INVALID'; return { enabled: false, error: this.error, items: [], next_before: null } }
  }
  close(): void { if (this.control?.open) this.control.close() }
}
