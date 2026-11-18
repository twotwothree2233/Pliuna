import { fileLstatSync, fileFstatSync, flushDirectorySync, managedFile, openRegularFileSync, type DirectoryDurability } from '../platform/files'
import { journalFileIdentity,sameJournalFileIdentity,validJournalFileIdentity,type IdentityEncoding,type JournalFileIdentity } from '../platform/file-identity'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { dirname,join } from 'node:path'
import defaults from '../shared/contracts/development-defaults.json'
import { ContractError } from '../shared/validation'
import { verifyPluginProtection } from './plugins/protection'
import type { RecoveryManager } from './recovery'
import { digest } from './resources'
import { verifyDatabase,type RestoreJournal } from './restore-journal'
import { isManagedDatabaseFile } from '../shared/branding'
import { readBusinessSchema } from './schema-upgrade'
import { runnerResourceReferences } from './runner/resource-references'

type Row = Record<string, any>
type Identity = JournalFileIdentity
type Member = { suffix: '' | '-wal' | '-shm' | '-journal'; identity: Identity; state: 'pending' | 'deleting' | 'deleted' | 'absent' }
type Reauthorization = { version: 1; id: string; token: string; selected: string; graph: string; created_at: string; expected_attempt: number; expected_phase: 'retired' | 'group_deleted'; members: Array<Member & { observed_present: boolean }> }
export type Retirement = { version: IdentityEncoding; id: string; token: string; file: string; selected: string; graph: string; created_at: string; phase: 'preview' | 'retired' | 'group_deleted' | 'released'; protection: { tasks: string[]; resources: Row[]; staging: Row[]; references: Row[]; keys: string[] }; members: Member[]; attempt: number; next_retry_at: string | null; reason: string; reauthorizations?: Reauthorization[]; reauthorization_confirmations?: Array<{ authorization_id: string; confirmed_at: string; attempt: number }> }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const generation = isManagedDatabaseFile
const managed = (f: unknown): f is string => generation(f) || (typeof f === 'string' && /^recovery\/[a-f0-9-]{36}\.sqlite$/.test(f))
const suffixes = ['', '-wal', '-shm', '-journal'] as const
const fail = (code: string): never => { throw new ContractError(code, 'Replica retained. Query the original retirement; no business or deletion is replayed') }
function present(file: string): boolean {
  try { fileLstatSync(file); return true } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e }
}
const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
const fields = (value: unknown, required: string[], optional: string[] = []): boolean => !!value && typeof value === 'object' && !Array.isArray(value) && required.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => required.includes(k) || optional.includes(k))
const terminal = (m: Member): boolean => m.state === 'deleted' || m.state === 'absent'
export function validateRetirement(r: any): asserts r is Retirement {
  if (!fields(r, ['version', 'id', 'token', 'file', 'selected', 'graph', 'created_at', 'phase', 'protection', 'members', 'attempt', 'next_retry_at', 'reason'], ['reauthorizations', 'reauthorization_confirmations']) || ![1, 2].includes(r.version) || !uuid.test(r.id) || !uuid.test(r.token) || !managed(r.file) || !generation(r.selected) || typeof r.graph !== 'string' || !/^[a-f0-9]{64}$/.test(r.graph) || !timestamp(r.created_at) || !['preview', 'retired', 'group_deleted', 'released'].includes(r.phase) || !Number.isInteger(r.attempt) || r.attempt < 0 || r.attempt > 4 || (r.next_retry_at !== null && !timestamp(r.next_retry_at)) || typeof r.reason !== 'string') fail('REPLICA_CONTROL_INVALID')
  const p = r.protection
  if (!p || !['tasks', 'resources', 'staging', 'references', 'keys'].every(k => Array.isArray(p[k])) || p.keys.some((k: unknown) => typeof k !== 'string') || p.tasks.some((k: unknown) => typeof k !== 'string') || !Array.isArray(r.members) || !r.members.length || r.members[0]?.suffix !== '' || r.members.length > 4 || new Set(r.members.map((m: Member | null) => m?.suffix)).size !== r.members.length) fail('REPLICA_CONTROL_INVALID')
  for (const resource of p.resources) if (!resource || !uuid.test(resource.id) || typeof resource.storage_key !== 'string' || !/^[A-Za-z0-9_-]+$/.test(resource.storage_key) || !/^[a-f0-9]{64}$/.test(resource.sha256) || !Number.isSafeInteger(resource.byte_length) || resource.byte_length < 0) fail('REPLICA_CONTROL_INVALID')
  for (const stage of p.staging) if (!stage || typeof stage.storage_key !== 'string' || !/^[A-Za-z0-9_-]+$/.test(stage.storage_key)) fail('REPLICA_CONTROL_INVALID')
  for (const ref of p.references) if (!ref || typeof ref.id !== 'string') fail('REPLICA_CONTROL_INVALID')
  const keys = [...new Set([...p.resources.flatMap((x: Row) => [x.id, x.storage_key]), ...p.staging.map((x: Row) => x.storage_key), ...p.references.map((x: Row) => x.id)])].sort()
  if (JSON.stringify(keys) !== JSON.stringify(p.keys)) fail('REPLICA_CONTROL_INVALID')
  for (const m of r.members) if (!fields(m, ['suffix', 'identity', 'state']) || !suffixes.includes(m.suffix) || !['pending', 'deleting', 'deleted', 'absent'].includes(m.state) || !validJournalFileIdentity(m.identity, r.version)) fail('REPLICA_CONTROL_INVALID')
  if (['group_deleted', 'released'].includes(r.phase) && r.members.some((m: Member) => !['deleted', 'absent'].includes(m.state))) fail('REPLICA_CONTROL_INVALID')
  if (('reauthorizations' in r && !Array.isArray(r.reauthorizations)) || ('reauthorization_confirmations' in r && !Array.isArray(r.reauthorization_confirmations))) fail('REPLICA_CONTROL_INVALID')
  const authorizations: Reauthorization[] = r.reauthorizations ?? [], confirmations: NonNullable<Retirement['reauthorization_confirmations']> = r.reauthorization_confirmations ?? []
  if (r.phase === 'preview' && (r.attempt !== 0 || authorizations.length || confirmations.length || r.members.some((m: Member) => m.state !== 'pending'))) fail('REPLICA_CONTROL_INVALID')
  for (const [index, a] of authorizations.entries()) {
    if (!fields(a, ['version', 'id', 'token', 'selected', 'graph', 'created_at', 'expected_attempt', 'expected_phase', 'members']) || a.version !== 1 || !uuid.test(a.id) || !uuid.test(a.token) || !generation(a.selected) || a.selected === r.file || typeof a.graph !== 'string' || !/^[a-f0-9]{64}$/.test(a.graph) || !timestamp(a.created_at) || !Number.isInteger(a.expected_attempt) || a.expected_attempt < 0 || a.expected_attempt >= 4 || a.expected_attempt > r.attempt || !['retired', 'group_deleted'].includes(a.expected_phase) || (a.expected_phase === 'group_deleted' && r.phase === 'retired') || !Array.isArray(a.members) || a.members.length !== r.members.length || (index > 0 && a.expected_attempt < authorizations[index - 1]!.expected_attempt)) fail('REPLICA_CONTROL_INVALID')
    for (const [i, m] of a.members.entries()) {
      const original = r.members[i]
      if (!fields(m, ['suffix', 'identity', 'state', 'observed_present']) || m.suffix !== original.suffix || !['pending', 'deleting', 'deleted', 'absent'].includes(m.state) || typeof m.observed_present !== 'boolean' || !validJournalFileIdentity(m.identity, r.version) || !sameJournalFileIdentity(m.identity, original.identity) || (terminal(m) && (m.observed_present || m.state !== original.state)) || (a.expected_phase === 'group_deleted' && !terminal(m))) fail('REPLICA_CONTROL_INVALID')
    }
  }
  if (new Set(authorizations.map(a => a.id)).size !== authorizations.length || new Set(confirmations.map(c => c?.authorization_id)).size !== confirmations.length) fail('REPLICA_CONTROL_INVALID')
  for (const [index, c] of confirmations.entries()) {
    const ai = authorizations.findIndex(a => a.id === c?.authorization_id), a = authorizations[ai]
    if (!fields(c, ['authorization_id', 'confirmed_at', 'attempt']) || !uuid.test(c.authorization_id) || !timestamp(c.confirmed_at) || !a || !Number.isInteger(c.attempt) || c.attempt !== a.expected_attempt + 1 || c.attempt > r.attempt || (index > 0 && c.attempt <= confirmations[index - 1]!.attempt) || authorizations.slice(ai + 1).some(later => later.expected_attempt < c.attempt)) fail('REPLICA_CONTROL_INVALID')
  }
}

// Authority lives in the selector journal, which is consulted before any business database opens.
export class ReplicaRetirement {
  constructor(private root: string, private journal: RestoreJournal, private recovery: RecoveryManager, private inspectDependencies: (exclude?: string) => void) {
    for (const r of journal.retirementRecords()) if (r.phase !== 'preview' && r.phase !== 'released') {
      let changed = false
      for (const m of r.members) if (m.state === 'deleting') {
        m.state = present(join(root, r.file + m.suffix)) ? 'pending' : 'absent'; changed = true
      }
      if (changed) { r.reason = 'INTERRUPTED_RECONFIRM'; this.journal.saveRetirement(r) }
    }
  }
  private graph(): string { return digest(Buffer.from(JSON.stringify([this.journal.retirementGraph(), this.recovery.replicaGraph()]))) }
  private allowed(file: string): boolean {
    return file.startsWith('recovery/') ? this.recovery.replicaPoints().some(p => p.file === file && p.allowed) : this.journal.retirementAllowed(file)
  }
  private identity(file: string, encoding: IdentityEncoding = this.journal.identityEncoding): Identity {
    const path = managedFile(this.root, ...file.split('/')), parent = dirname(path)
    if (!fileLstatSync(parent).isDirectory()) fail('REPLICA_UNSAFE_FILE')
    const stat = fileLstatSync(path)
    if (!stat.isFile() || stat.nlink !== 1) fail('REPLICA_UNSAFE_FILE')
    const fd = openRegularFileSync(path)
    try {
      const opened = fileFstatSync(fd)
      if (opened.dev !== stat.dev || opened.ino !== stat.ino) fail('REPLICA_FILE_CHANGED')
      const hash = digest(fs.readFileSync(fd)), end = fileFstatSync(fd)
      if (end.size !== stat.size || end.mtimeMs !== stat.mtimeMs || end.ctimeMs !== stat.ctimeMs) fail('REPLICA_FILE_CHANGED')
      return journalFileIdentity({ dev: stat.dev, ino: stat.ino, size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs, hash }, encoding)
    } finally { fs.closeSync(fd) }
  }
  private syncDirectory(file: string): DirectoryDurability {
    return flushDirectorySync(dirname(managedFile(this.root, ...file.split('/'))))
  }
  private inspect(file: string): Pick<Retirement, 'members' | 'protection'> {
    if (!managed(file) || !present(managedFile(this.root, ...file.split('/')))) fail('REPLICA_MANIFEST_UNAVAILABLE')
    this.identity(file)
    const sealed = this.journal.sealedReplica(file)
    if (sealed?.sha256 && digest(fs.readFileSync(managedFile(this.root, ...file.split('/')))) !== sealed.sha256) fail('REPLICA_SEAL_MISMATCH')
    const db = new Database(managedFile(this.root, ...file.split('/')), { readonly: true, fileMustExist: true })
    let protection: Retirement['protection']
    try {
      // One read transaction includes WAL contents; never infer protection from main-file bytes alone.
      protection = db.transaction(() => {
        verifyDatabase(db, this.root, [], sealed)
        if (sealed) verifyPluginProtection(this.root, sealed.plugins)
        if (file.startsWith('recovery/')) {
          const id = file.slice('recovery/'.length, -'.sqlite'.length), row = db.prepare('SELECT manifest_json FROM recovery_points WHERE id=?').get(id) as Row | undefined
          if (!row) fail('REPLICA_MANIFEST_UNAVAILABLE')
          const point = JSON.parse(row!.manifest_json)
          if ('plugins' in point) verifyPluginProtection(this.root, point.plugins)
          if (point.id !== id || point.schema_version !== readBusinessSchema(db) || point.app_version !== '0.1.0' || JSON.stringify(point.tasks) !== JSON.stringify((db.prepare('SELECT id FROM tasks ORDER BY id').all() as Row[]).map(r => r.id)) || JSON.stringify(point.resources) !== JSON.stringify(db.prepare('SELECT id,storage_key,sha256,byte_length FROM resources ORDER BY id').all())) fail('REPLICA_MANIFEST_MISMATCH')
        }
        const tasks = (db.prepare('SELECT id FROM tasks ORDER BY id').all() as Row[]).map(r => r.id)
        const resources = db.prepare('SELECT * FROM resources ORDER BY id').all() as Row[]
        const staging = db.prepare('SELECT * FROM staging ORDER BY id').all() as Row[]
        const references = db.prepare("SELECT resource_id AS id FROM task_resources UNION SELECT target_id FROM object_references WHERE target_kind='resource' AND protects_resource=1 UNION SELECT bundle_resource_id FROM views UNION SELECT bundle_resource_id FROM view_history UNION SELECT resource_id FROM recovery_resources").all() as Row[]
        for (const reference of runnerResourceReferences(db)) references.push({ id: reference.resource_id })
        const declared = (refs: unknown) => {
          if (!Array.isArray(refs)) fail('REPLICA_MANIFEST_UNAVAILABLE')
          for (const ref of refs as Row[]) {
            if (!ref?.target || !['resource', 'task_data'].includes(ref.target.kind) || typeof ref.target.id !== 'string') fail('REPLICA_MANIFEST_UNAVAILABLE')
            if (ref.target.kind === 'resource') references.push({ id: ref.target.id })
          }
        }
        for (const row of db.prepare('SELECT references_json FROM task_data').iterate() as Iterable<Row>) declared(JSON.parse(row.references_json))
        for (const row of db.prepare('SELECT evidence_snapshot_json FROM view_history').iterate() as Iterable<Row>) {
          const saved = JSON.parse(row.evidence_snapshot_json), sources = saved.evidence?.sources ?? []
          if (!Array.isArray(sources)) fail('REPLICA_MANIFEST_UNAVAILABLE')
          for (const source of sources) {
            if (!Array.isArray(source.resources)) fail('REPLICA_MANIFEST_UNAVAILABLE')
            for (const resource of source.resources) { if (typeof resource?.id !== 'string') fail('REPLICA_MANIFEST_UNAVAILABLE'); references.push({ id: resource.id }) }
            declared(source.references)
          }
        }
        return { tasks, resources, staging, references, keys: [...new Set([...resources.flatMap(r => [r.id, r.storage_key]), ...staging.map(r => r.storage_key), ...references.map(r => r.id)])].sort() }
      })()
    } finally { db.close() }
    const members: Member[] = []
    for (const suffix of suffixes) {
      try { members.push({ suffix, identity: this.identity(file + suffix), state: 'pending' }) }
      catch (e) { if (suffix === '' || (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    }
    return { protection, members }
  }
  list(summary = false, before = Number.MAX_SAFE_INTEGER): unknown {
    if (!summary) this.inspectDependencies()
    const files = [...this.journal.replicaFiles(), ...this.recovery.replicaPoints().map(p => p.file)]
    const end = Math.min(files.length, before - 1), start = summary ? Math.max(0, end - 20) : 0
    return { next_before: summary && start > 0 ? start + 1 : null, items: files.slice(start, end).map((file, index) => {
      const record = this.journal.retirementForFile(file)
      return { replica_id: digest(Buffer.from(file)), label: file.startsWith('recovery/') ? (this.recovery.replicaPoints().some(p => p.file === file && p.allowed) ? '失效恢复点副本' : '有效 / 候选恢复点（受保护）') : file === this.journal.selected() ? '当前代际（受保护）' : '历史代际 / 私有副本 ' + (index + 1), checked: !summary, can_request: !record && this.allowed(file), eligible: !summary && !record && this.allowed(file), operation: record ? this.public(record) : null }
    }), formal_resources_deleted: 0 }
  }
  preview(token: string, replicaId: string): unknown {
    this.inspectDependencies()
    const file = [...this.journal.replicaFiles(), ...this.recovery.replicaPoints().map(p => p.file)].find(f => digest(Buffer.from(f)) === replicaId)
    if (!file || !this.allowed(file) || this.journal.retired(file)) fail('REPLICA_PROTECTED')
    const material = this.inspect(file!)
    const r: Retirement = { version: this.journal.identityEncoding, id: randomUUID(), token, file: file!, selected: this.journal.selected(), graph: this.graph(), created_at: new Date().toISOString(), phase: 'preview', ...material, attempt: 0, next_retry_at: null, reason: 'VERIFIED_REPLICA' }
    this.journal.saveRetirement(r); return this.public(r)
  }
  private read(id: string): Retirement { const r = this.journal.retirementRecord(id); if (!r) fail('REPLICA_OPERATION_NOT_FOUND'); return r! }
  status(id: string, authorizationId?: string): unknown {
    const r = this.read(id)
    if (authorizationId && !r.reauthorizations?.some(a => a.id === authorizationId)) fail('REPLICA_CONFIRMATION_EXPIRED')
    return this.public(r, authorizationId)
  }
  private observedMembers(r: Retirement): Reauthorization['members'] {
    for (const suffix of suffixes) if (present(managedFile(this.root, ...(r.file + suffix).split('/'))) && !r.members.some(m => m.suffix === suffix)) fail('REPLICA_NEW_GROUP_MEMBER')
    return r.members.map(m => {
      const observed_present = present(managedFile(this.root, ...(r.file + m.suffix).split('/')))
      if (terminal(m) && observed_present) fail('REPLICA_FILE_REAPPEARED')
      if (observed_present && !sameJournalFileIdentity(this.identity(r.file + m.suffix, r.version), m.identity)) fail('REPLICA_FILE_CHANGED')
      return { ...structuredClone(m), observed_present }
    })
  }
  private assertCollection(token: string): void {
    const state = this.recovery.status() as { phase: string; reservation: { token: string } | null }
    if (state.phase !== 'collecting' || state.reservation?.token !== token) fail('REPLICA_CONFIRMATION_EXPIRED')
  }
  previewReauthorization(token: string, operationId: string): unknown {
    this.recovery.checkPreparation(token)
    const r = this.read(operationId)
    if (!['retired', 'group_deleted'].includes(r.phase) || r.selected === this.journal.selected() || r.attempt >= 4 || (r.next_retry_at && Date.parse(r.next_retry_at) > Date.now())) fail('REPLICA_CONFIRMATION_EXPIRED')
    this.inspectDependencies(r.file)
    if (!this.allowed(r.file)) fail('REPLICA_PROTECTED')
    const a: Reauthorization = { version: 1, id: randomUUID(), token, selected: this.journal.selected(), graph: this.graph(), created_at: new Date().toISOString(), expected_attempt: r.attempt, expected_phase: r.phase as Reauthorization['expected_phase'], members: this.observedMembers(r) }
    this.recovery.checkPreparation(token)
    if (a.selected !== this.journal.selected() || a.graph !== this.graph() || !this.allowed(r.file)) fail('REPLICA_FACTS_CHANGED')
    r.reauthorizations = [...(r.reauthorizations ?? []), a]
    this.journal.saveRetirement(r)
    return this.public(r)
  }
  reauthorizationConfirmed(operationId: string, authorizationId: string): boolean {
    const r = this.read(operationId)
    if (!r.reauthorizations?.some(a => a.id === authorizationId)) fail('REPLICA_CONFIRMATION_EXPIRED')
    return r.reauthorization_confirmations?.some(c => c.authorization_id === authorizationId) ?? false
  }
  confirmReauthorization(token: string, operationId: string, authorizationId: string): unknown {
    if (this.reauthorizationConfirmed(operationId, authorizationId)) return this.status(operationId, authorizationId)
    const r = this.read(operationId), a = r.reauthorizations!.at(-1)!
    if (a.id !== authorizationId || a.token !== token || r.phase !== a.expected_phase || r.attempt !== a.expected_attempt || r.attempt >= 4 || (r.next_retry_at && Date.parse(r.next_retry_at) > Date.now())) fail('REPLICA_CONFIRMATION_EXPIRED')
    this.assertCollection(token)
    this.inspectDependencies(r.file)
    if (a.selected !== this.journal.selected() || a.graph !== this.graph() || !this.allowed(r.file) || JSON.stringify(a.members) !== JSON.stringify(this.observedMembers(r))) fail('REPLICA_FACTS_CHANGED')
    this.assertCollection(token)
    // The confirmation and cumulative attempt are one durable single-use continuation intent.
    r.attempt++; r.next_retry_at = null; r.reason = 'REAUTHORIZATION_DURABLE'
    r.reauthorization_confirmations = [...(r.reauthorization_confirmations ?? []), { authorization_id: a.id, confirmed_at: new Date().toISOString(), attempt: r.attempt }]
    this.journal.saveRetirement(r)
    try {
      // Retired databases are never reopened. Every unlink uses the independent exact binding.
      for (const m of r.members) {
        this.observedMembers(r)
        if (terminal(m)) continue
        if (!present(managedFile(this.root, ...(r.file + m.suffix).split('/')))) { m.state = 'absent'; this.journal.saveRetirement(r); continue }
        m.state = 'deleting'; r.reason = 'FILE_DELETE_INTENT'; this.journal.saveRetirement(r)
        this.assertCollection(token)
        if (a.selected !== this.journal.selected() || a.graph !== this.graph() || !this.allowed(r.file) || !sameJournalFileIdentity(this.identity(r.file + m.suffix, r.version), m.identity)) fail('REPLICA_FACTS_CHANGED')
        this.observedMembers(r)
        fs.unlinkSync(managedFile(this.root, ...(r.file + m.suffix).split('/'))); this.syncDirectory(r.file)
        m.state = 'deleted'; this.journal.saveRetirement(r)
      }
      for (const suffix of suffixes) if (present(managedFile(this.root, ...(r.file + suffix).split('/')))) fail('REPLICA_GROUP_REMAINS')
      this.assertCollection(token)
      if (a.selected !== this.journal.selected() || a.graph !== this.graph() || !this.allowed(r.file)) fail('REPLICA_FACTS_CHANGED')
      const durability = this.syncDirectory(r.file)
      r.phase = 'group_deleted'; r.reason = durability === 'directory-synced' ? 'GROUP_DELETED_DURABLE' : 'GROUP_DELETED_CONFIRMED'; this.journal.saveRetirement(r)
      this.assertCollection(token)
      if (a.selected !== this.journal.selected() || a.graph !== this.graph() || !this.allowed(r.file)) fail('REPLICA_FACTS_CHANGED')
      this.observedMembers(r)
      r.phase = 'released'; r.reason = 'PROTECTION_RELEASED'; this.journal.saveRetirement(r)
    } catch (e) {
      const code = e instanceof ContractError ? e.code : (e as NodeJS.ErrnoException).code
      const durable = this.read(operationId), delay = defaults.cleanup.retry_delays_ms[r.attempt - 1]
      durable.reason = ['EACCES', 'EPERM', 'EBUSY', 'EIO', 'ENOSPC'].includes(code ?? '') ? code! : code?.startsWith('REPLICA_') ? code : 'REPLICA_RECORD_FAILED'
      durable.next_retry_at = delay === undefined ? null : new Date(Date.now() + delay).toISOString()
      this.journal.saveRetirement(durable)
    }
    return this.status(operationId, authorizationId)
  }
  execute(token: string, id: string, retry: boolean): unknown {
    const r = this.read(id)
    if (retry ? r.phase === 'preview' || r.phase === 'released' : r.phase !== 'preview' || r.token !== token) fail('REPLICA_CONFIRMATION_EXPIRED')
    if (r.attempt >= 4 || (r.next_retry_at && Date.parse(r.next_retry_at) > Date.now())) return this.public(r)
    this.inspectDependencies(r.file)
    if (r.selected !== this.journal.selected() || !this.allowed(r.file)) fail('REPLICA_PROTECTED')
    if (!retry) {
      if (r.graph !== this.graph()) fail('REPLICA_FACTS_CHANGED')
      for (const suffix of suffixes) {
        const member = r.members.find(m => m.suffix === suffix)
        if (present(join(this.root, r.file + suffix)) !== !!member || (member && !sameJournalFileIdentity(this.identity(r.file + suffix), member.identity))) fail('REPLICA_FACTS_CHANGED')
      }
      r.phase = 'retired'; r.reason = 'RETIREMENT_DURABLE'; this.journal.saveRetirement(r)
    }
    try {
      r.attempt++; r.next_retry_at = null; this.journal.saveRetirement(r)
      // No inspectors may reopen this database after retirement. Only the frozen file identities are used.
      for (const suffix of suffixes) if (present(join(this.root, r.file + suffix)) && !r.members.some(m => m.suffix === suffix)) fail('REPLICA_NEW_GROUP_MEMBER')
      for (const m of r.members) {
        if (['deleted', 'absent'].includes(m.state)) { if (present(managedFile(this.root, ...(r.file + m.suffix).split('/')))) fail('REPLICA_FILE_REAPPEARED'); continue }
        if (!present(managedFile(this.root, ...(r.file + m.suffix).split('/')))) { m.state = 'absent'; this.journal.saveRetirement(r); continue }
        if (!sameJournalFileIdentity(this.identity(r.file + m.suffix), m.identity)) fail('REPLICA_FILE_CHANGED')
        m.state = 'deleting'; r.reason = 'FILE_DELETE_INTENT'; this.journal.saveRetirement(r)
        if (r.selected !== this.journal.selected() || !this.allowed(r.file) || !sameJournalFileIdentity(this.identity(r.file + m.suffix), m.identity)) fail('REPLICA_FACTS_CHANGED')
        fs.unlinkSync(managedFile(this.root, ...(r.file + m.suffix).split('/'))); this.syncDirectory(r.file)
        m.state = 'deleted'; this.journal.saveRetirement(r)
      }
      for (const suffix of suffixes) if (present(join(this.root, r.file + suffix))) fail('REPLICA_GROUP_REMAINS')
      const durability = this.syncDirectory(r.file)
      r.phase = 'group_deleted'; r.reason = durability === 'directory-synced' ? 'GROUP_DELETED_DURABLE' : 'GROUP_DELETED_CONFIRMED'; this.journal.saveRetirement(r)
      r.phase = 'released'; r.reason = 'PROTECTION_RELEASED'; this.journal.saveRetirement(r)
    } catch (e) {
      const code = e instanceof ContractError ? e.code : (e as NodeJS.ErrnoException).code
      r.reason = ['EACCES', 'EPERM', 'EBUSY', 'EIO', 'ENOSPC'].includes(code ?? '') ? code! : code?.startsWith('REPLICA_') ? code : 'REPLICA_RECORD_FAILED'
      const delay = defaults.cleanup.retry_delays_ms[r.attempt - 1]
      r.next_retry_at = delay === undefined ? null : new Date(Date.now() + delay).toISOString()
      // Never persist an in-memory release if its durable write failed.
      const durable = this.read(id); durable.reason = r.reason; durable.attempt = Math.max(durable.attempt, r.attempt); durable.next_retry_at = r.next_retry_at
      this.journal.saveRetirement(durable)
    }
    return this.status(id)
  }
  private public(r: Retirement, authorizationId?: string): unknown {
    const a = authorizationId ? r.reauthorizations?.find(a => a.id === authorizationId) : r.reauthorizations?.at(-1), required = ['retired', 'group_deleted'].includes(r.phase) && r.selected !== this.journal.selected()
    let canReauthorize = false
    if (required && r.attempt < 4 && (!r.next_retry_at || Date.parse(r.next_retry_at) <= Date.now())) { try { canReauthorize = this.allowed(r.file) } catch { /* Dependency uncertainty disables the action, while the durable result stays queryable. */ } }
    return { id: r.id, replica_id: digest(Buffer.from(r.file)), phase: r.phase, created_at: r.created_at, files: r.members.map(m => ({ kind: m.suffix || 'database', bytes: m.identity.size, state: m.state })), protected_keys: r.protection.keys.length, protection_released: r.phase === 'released', attempt: r.attempt, next_retry_at: r.next_retry_at, reason: r.reason, reauthorization_required: required, can_reauthorize: canReauthorize, authorization_count: r.reauthorizations?.length ?? 0, reauthorization: a ? { id: a.id, state: r.reauthorization_confirmations?.some(c => c.authorization_id === a.id) ? 'confirmed' : 'preview', created_at: a.created_at, files: a.members.filter(m => m.observed_present && !terminal(m)).map(m => ({ kind: m.suffix || 'database', bytes: m.identity.size, state: m.state })) } : null, formal_resources_deleted: 0, business_replayed: false }
  }
}
