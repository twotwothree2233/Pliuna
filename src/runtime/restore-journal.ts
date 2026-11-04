import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ContractError } from '../shared/validation'
import { digest, resourceBody } from './resources'
import { PluginDerivations } from './plugins/derivations'
import { validateRetirement, type Retirement } from './replicas'
import { validateResourceCleanup, type ResourceCleanup, type TaskDeletion } from './resource-cleanup'
import { validatePluginProtection, verifyPluginProtection } from './plugins/protection'
import { ExportControl } from './export-control'
import type { PluginCopy } from './plugins/package'

type Row = Record<string, any>
export type RestoreImage = { file: string; tasks: string[]; resources: Row[]; plugins: PluginCopy[]; sha256?: string }
type Operation = { id: string; token: string; point_id: string; phase: 'preparing' | 'switched' | 'completed' | 'rolled_back'; previous: string; target: RestoreImage; rollback: RestoreImage; created_at: string }
type Journal = { version: 5; export_control: 1; selected: string; deleted_tasks: string[]; operations: Operation[]; verified_head: string | null; retirements: Retirement[]; task_deletions: TaskDeletion[]; resource_cleanups: ResourceCleanup[] }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const managed = (file: unknown): file is string => typeof file === 'string' && (file === 'trellis.sqlite' || /^restore-[0-9a-f-]{36}-(target|rollback)\.sqlite$/.test(file))
const fail = (): never => { throw new ContractError('RESTORE_JOURNAL_INVALID', 'Restore journal requires inspection; business access is closed') }

export function flushFile(root: string, file: string): void {
  const fd = openSync(join(root, file), 'r'); try { fsyncSync(fd) } finally { closeSync(fd) }
  if (process.platform !== 'win32') { const dir = openSync(root, 'r'); try { fsyncSync(dir) } finally { closeSync(dir) } }
}
export function describeDatabase(db: Database.Database, file: string): RestoreImage {
  return { file, tasks: (db.prepare('SELECT id FROM tasks ORDER BY id').all() as Row[]).map(row => row.id), resources: db.prepare('SELECT * FROM resources ORDER BY id').all() as Row[], plugins: [] }
}
export function verifyDatabase(db: Database.Database, root: string, deleted: string[], image?: RestoreImage): void {
  if (db.pragma('quick_check', { simple: true }) !== 'ok' || (db.pragma('foreign_key_check') as unknown[]).length || JSON.stringify(db.prepare('SELECT version FROM schema_version').all()) !== '[{"version":1}]') fail()
  const actual = describeDatabase(db, image?.file ?? 'trellis.sqlite')
  if (actual.tasks.some(task => deleted.includes(task))) fail()
  if (image && (JSON.stringify(actual.tasks) !== JSON.stringify(image.tasks) || JSON.stringify(actual.resources) !== JSON.stringify(image.resources))) fail()
  for (const resource of actual.resources) resourceBody(root, resource as Parameters<typeof resourceBody>[1])
  new PluginDerivations(db, root).validateStored()
}

// The selected database and restore outcome commit together, outside every business database.
export class RestoreJournal {
  private db?: Database.Database
  private value: Journal = { version: 5, export_control: 1, selected: 'trellis.sqlite', deleted_tasks: [], operations: [], verified_head: null, retirements: [], task_deletions: [], resource_cleanups: [] }
  readonly error: string | null
  constructor(private root: string) {
    let error: string | null = null
    try {
      mkdirSync(root, { recursive: true, mode: 0o700 })
      const file = join(root, 'restore-control.sqlite'), present = existsSync(file), marker = join(root, 'restore-established')
      if (existsSync(marker) && (!lstatSync(marker).isFile() || !['restore-v2\n', 'restore-v3\n', 'restore-v4\n', 'restore-v5\n'].includes(readFileSync(marker, 'utf8')) || !present)) fail()
      if (present && !lstatSync(file).isFile()) fail()
      if (!present && readdirSync(root).some(name => /^restore-.*-(target|rollback)\.sqlite/.test(name))) fail()
      this.db = new Database(file)
      this.db.pragma('busy_timeout=0'); this.db.pragma('journal_mode=DELETE'); this.db.pragma('synchronous=FULL'); chmodSync(file, 0o600)
      if (!present) {
        // A missing selector must never silently reopen the pre-restore database.
        const count = this.db.prepare('SELECT count(*) n FROM sqlite_master').get() as Row
        if (count.n) fail()
        this.db.exec('CREATE TABLE restore_control (id INTEGER PRIMARY KEY CHECK(id=1), manifest TEXT NOT NULL)')
        const exports = new ExportControl(root, false, false); exports.close()
        this.db.prepare('INSERT INTO restore_control VALUES (1,?)').run(JSON.stringify(this.value))
      }
      const row = this.db.prepare('SELECT manifest FROM restore_control WHERE id=1').get() as Row
      const parsed = JSON.parse(row.manifest)
      if (existsSync(marker) && readFileSync(marker, 'utf8') === 'restore-v5\n' && parsed.version !== 5) fail()
      const normalized = RestoreJournal.normalizeControl(parsed)
      const exports = new ExportControl(root, present && parsed.version === 5, false); exports.close()
      if (parsed.version !== 5) this.save(normalized)
      else this.value = normalized
      flushFile(root, 'restore-control.sqlite')
      if (!existsSync(marker) || readFileSync(marker, 'utf8') !== 'restore-v5\n') { writeFileSync(marker, 'restore-v5\n', { mode: 0o600 }); flushFile(root, 'restore-established') }
      const pending = this.pending()
      if (pending?.phase === 'preparing') this.finish('rolled_back')
      else if (pending?.phase === 'switched') {
        try { this.verifyEffectivePoint(pending.point_id); this.verifyImage(pending.target); this.finish('completed') }
        catch { this.verifyImage(pending.rollback); this.save({ ...this.value, selected: pending.rollback.file, operations: this.value.operations.map(op => op.id === pending.id ? { ...op, phase: 'rolled_back' } : op) }) }
      }
      if ((present || this.value.selected !== 'trellis.sqlite') && (!existsSync(join(root, this.value.selected)) || !lstatSync(join(root, this.value.selected)).isFile())) fail()
    } catch { error = 'RESTORE_JOURNAL_INVALID' }
    this.error = error
  }
  private verifyEffectivePoint(pointId: string): void {
    const path = join(this.root, 'recovery-control.sqlite')
    if (!existsSync(path) || !lstatSync(path).isFile()) fail()
    const control = new Database(path, { readonly: true, fileMustExist: true })
    try {
      const row = control.prepare('SELECT manifest FROM control WHERE id=1').get() as Row, value = JSON.parse(row.manifest)
      if (![1, 2].includes(value.version) || !value.active || value.active.id !== pointId || !Array.isArray(value.invalidated) || value.invalidated.includes(pointId) || !Array.isArray(value.retired) || value.retired.includes(pointId)) fail()
      if (value.version === 2) verifyPluginProtection(this.root, value.active.plugins)
      else if ('plugins' in value.active) fail()
    } finally { control.close() }
  }
  static validateControl(v: Journal): void {
    if (!v || Object.keys(v).sort().join(',') !== 'deleted_tasks,export_control,operations,resource_cleanups,retirements,selected,task_deletions,verified_head,version' || v.version !== 5 || v.export_control !== 1 || !managed(v.selected) || !Array.isArray(v.deleted_tasks) || v.deleted_tasks.some(id => typeof id !== 'string' || !uuid.test(id)) || !Array.isArray(v.operations)) fail()
    if ((v.verified_head !== null && typeof v.verified_head !== 'string') || !Array.isArray(v.retirements)) fail()
    for (const r of v.retirements) validateRetirement(r)
    if (new Set(v.retirements.map(r => r.id)).size !== v.retirements.length || v.retirements.some(r => r.phase !== 'preview' && r.file === v.selected)) fail()
    if (!Array.isArray(v.task_deletions) || !Array.isArray(v.resource_cleanups)) fail()
    const deleted = new Set(v.deleted_tasks)
    for (const d of v.task_deletions) if (!d || !uuid.test(d.task_id) || !deleted.has(d.task_id) || !Array.isArray(d.resources) || !Array.isArray(d.stages)) fail()
    for (const r of v.resource_cleanups) { validateResourceCleanup(r); if (r.source_tasks.some(id => !deleted.has(id))) fail() }
    if (new Set(v.task_deletions.map(d => d.task_id)).size !== v.task_deletions.length || new Set(v.resource_cleanups.map(r => r.id)).size !== v.resource_cleanups.length || new Set(v.resource_cleanups.map(r => r.resource.id)).size !== v.resource_cleanups.length) fail()
    const byTask = new Map(v.task_deletions.map(d => [d.task_id, d]))
    const byResource = new Map(v.resource_cleanups.map(r => [r.resource.id, r]))
    const taskMaterials = new Map(v.task_deletions.map(d => [d.task_id, new Map(d.resources.map(r => [r.id, JSON.stringify(r)]))]))
    for (const d of v.task_deletions) {
      if (new Set(d.resources.map(r => r.id)).size !== d.resources.length || d.stages.some(s => s.task_id !== d.task_id || typeof s.id !== 'string' || typeof s.storage_key !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s.storage_key))) fail()
      for (const material of d.resources) { const r = byResource.get(material.id); if (!r || !r.source_tasks.includes(d.task_id) || JSON.stringify(r.resource) !== JSON.stringify(material)) fail() }
    }
    for (const r of v.resource_cleanups) {
      const origins = r.source_tasks.map(id => byTask.get(id))
      if (new Set(r.source_tasks).size !== r.source_tasks.length || origins.some(d => !d || taskMaterials.get(d.task_id)?.get(r.resource.id) !== JSON.stringify(r.resource))) fail()
      const stages = origins.flatMap(d => d!.stages.filter(s => s.resource_id === r.resource.id || s.storage_key === r.resource.storage_key))
      if (JSON.stringify(stages) !== JSON.stringify(r.stages)) fail()
    }
    let pending = 0
    for (const op of v.operations) {
      if (!op || !uuid.test(op.id) || !uuid.test(op.token) || !uuid.test(op.point_id) || !managed(op.previous) || !['preparing', 'switched', 'completed', 'rolled_back'].includes(op.phase) || !Number.isFinite(Date.parse(op.created_at))) fail()
      for (const [image, suffix] of [[op.target, 'target'], [op.rollback, 'rollback']] as const) {
        validatePluginProtection(image?.plugins)
        if (!image || (image.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(image.sha256)) || image.file !== `restore-${op.id}-${suffix}.sqlite` || !Array.isArray(image.tasks) || image.tasks.some(id => typeof id !== 'string' || !uuid.test(id)) || !Array.isArray(image.resources)) fail()
        for (const r of image.resources) if (!r || !uuid.test(r.id) || typeof r.storage_key !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(r.storage_key) || !/^[a-f0-9]{64}$/.test(r.sha256) || !Number.isSafeInteger(r.byte_length) || r.byte_length < 0) fail()
      }
      if (['switched', 'completed'].includes(op.phase) && (!op.target.sha256 || !op.rollback.sha256)) fail()
      if (['preparing', 'switched'].includes(op.phase)) { pending++; if (v.selected !== (op.phase === 'preparing' ? op.previous : op.target.file)) fail() }
    }
    if (pending > 1 || new Set(v.operations.map(op => op.id)).size !== v.operations.length) fail()
    if (v.selected !== 'trellis.sqlite' && !v.operations.some(op => op.target.file === v.selected || op.rollback.file === v.selected)) fail()
  }
  static normalizeControl(value: any): Journal {
    if (value?.version === 5) { RestoreJournal.validateControl(value); return value }
    if (value?.version === 4) {
      if (Object.keys(value).sort().join(',') !== 'deleted_tasks,operations,resource_cleanups,retirements,selected,task_deletions,verified_head,version') fail()
      const next = { ...value, version: 5, export_control: 1 }; RestoreJournal.validateControl(next); return next
    }
    const keys: Record<number, string> = { 1: 'deleted_tasks,operations,selected,version', 2: 'deleted_tasks,operations,retirements,selected,verified_head,version', 3: 'deleted_tasks,operations,resource_cleanups,retirements,selected,task_deletions,verified_head,version' }
    if (!value || !keys[value.version] || Object.keys(value).sort().join(',') !== keys[value.version] || !Array.isArray(value.operations)) fail()
    for (const op of value.operations) for (const image of [op?.target, op?.rollback]) if (!image || 'plugins' in image) fail()
    const next: Journal = { verified_head: null, retirements: [], task_deletions: [], resource_cleanups: [], ...value, version: 5, export_control: 1, operations: value.operations.map((op: Operation) => ({ ...op, target: { ...op.target, plugins: [] }, rollback: { ...op.rollback, plugins: [] } })) }
    RestoreJournal.validateControl(next)
    return next
  }
  private save(next: Journal): void {
    RestoreJournal.validateControl(next)
    this.db!.transaction(() => this.db!.prepare('UPDATE restore_control SET manifest=? WHERE id=1').run(JSON.stringify(next)))()
    this.value = next
  }
  private pending(): Operation | undefined { return this.value.operations.find(op => op.phase === 'preparing' || op.phase === 'switched') }
  private verifyImage(image: RestoreImage): void {
    verifyPluginProtection(this.root, image.plugins)
    const path = join(this.root, image.file)
    if (this.retired(image.file) || !existsSync(path) || !lstatSync(path).isFile()) fail()
    if (image.sha256 && digest(readFileSync(path)) !== image.sha256) fail()
    const db = new Database(path, { readonly: true, fileMustExist: true })
    try { this.assertMaterials(image.resources); verifyDatabase(db, this.root, this.value.deleted_tasks, image) } finally { db.close() }
  }
  selected(): string { if (this.error) fail(); return this.value.selected }
  deleted(): string[] { return [...this.value.deleted_tasks] }
  status(): unknown {
    const last = this.value.operations.at(-1)
    return { error: this.error, last: last ? { id: last.id, token: last.token, point_id: last.point_id, phase: last.phase, created_at: last.created_at } : null, retained_operations: this.value.operations.length }
  }
  prepare(token: string, pointId: string, current: RestoreImage, target: Omit<RestoreImage, 'file'>): Operation {
    if (this.error || this.pending()) fail()
    const id = randomUUID()
    const op: Operation = { id, token, point_id: pointId, phase: 'preparing', previous: this.value.selected, target: { ...target, file: `restore-${id}-target.sqlite` }, rollback: { ...current, file: `restore-${id}-rollback.sqlite` }, created_at: new Date().toISOString() }
    this.assertMaterials([...target.resources, ...current.resources])
    verifyPluginProtection(this.root, target.plugins); verifyPluginProtection(this.root, current.plugins)
    if ([...target.tasks, ...current.tasks].some(task => this.value.deleted_tasks.includes(task))) fail()
    this.save({ ...this.value, operations: [...this.value.operations, op] }); return op
  }
  seal(): void {
    const op = this.pending(); if (!op || op.phase !== 'preparing') fail()
    this.verifyImage(op!.target); this.verifyImage(op!.rollback)
    this.save({ ...this.value, operations: this.value.operations.map(o => o.id === op!.id ? { ...o, target: { ...o.target, sha256: digest(readFileSync(join(this.root, o.target.file))) }, rollback: { ...o.rollback, sha256: digest(readFileSync(join(this.root, o.rollback.file))) } } : o) })
  }
  phase(): string | null { return this.pending()?.phase ?? null }
  switch(): void {
    const op = this.pending(); if (!op || op.phase !== 'preparing') fail()
    this.verifyEffectivePoint(op!.point_id); this.verifyImage(op!.target); this.verifyImage(op!.rollback)
    this.save({ ...this.value, selected: op!.target.file, operations: this.value.operations.map(o => o.id === op!.id ? { ...o, phase: 'switched' } : o) })
  }
  finish(phase: 'completed' | 'rolled_back'): void {
    const op = this.pending(); if (!op) fail()
    this.save({ ...this.value, operations: this.value.operations.map(o => o.id === op!.id ? { ...o, phase } : o) })
  }
  rollback(): string {
    const op = this.pending(); if (!op) fail()
    this.verifyImage(op!.rollback)
    this.save({ ...this.value, selected: op!.rollback.file, operations: this.value.operations.map(o => o.id === op!.id ? { ...o, phase: 'rolled_back' } : o) })
    return this.value.selected
  }
  beforeDelete(taskId: string, db?: Database.Database): void {
    if (this.error || this.pending()) fail()
    const deleted_tasks = [...new Set([...this.value.deleted_tasks, taskId])]
    if (!db || this.value.task_deletions.some(d => d.task_id === taskId)) {
      if (!this.value.deleted_tasks.includes(taskId)) this.save({ ...this.value, deleted_tasks })
      return
    }
    const resources = db.prepare('SELECT r.* FROM resources r JOIN task_resources t ON t.resource_id=r.id WHERE t.task_id=? ORDER BY r.id').all(taskId) as Row[]
    const stages = db.prepare('SELECT s.*,a.state AS owner_state,a.result AS owner_result,a.commit_valid AS owner_commit_valid FROM staging s LEFT JOIN actions a ON a.id=s.owner_id AND a.task_id=s.task_id WHERE s.task_id=? ORDER BY s.id').all(taskId) as Row[]
    const task_deletions = [...this.value.task_deletions, { task_id: taskId, resources, stages }]
    const resource_cleanups = structuredClone(this.value.resource_cleanups)
    for (const resource of resources) {
      const prior = resource_cleanups.find(r => r.resource.id === resource.id)
      if (prior) {
        if (JSON.stringify(prior.resource) !== JSON.stringify(resource) || prior.phase !== 'candidate') fail()
        prior.source_tasks = [...new Set([...prior.source_tasks, taskId])]
        prior.stages.push(...stages.filter(s => s.resource_id === resource.id || s.storage_key === resource.storage_key))
        prior.preview = null
      } else resource_cleanups.push({ version: 1, id: randomUUID(), resource, source_tasks: [taskId], stages: stages.filter(s => s.resource_id === resource.id || s.storage_key === resource.storage_key), phase: 'candidate', preview: null, identity: null, selected: null, attempt: 0, next_retry_at: null, reason: 'TASK_DELETION_REGISTERED', file_result: null, created_at: new Date().toISOString() })
    }
    this.save({ ...this.value, deleted_tasks, task_deletions, resource_cleanups })
  }
  resourcePage(before = Number.MAX_SAFE_INTEGER): { records: ResourceCleanup[]; next_before: number | null } {
    const end = Math.min(this.value.resource_cleanups.length, before - 1), start = Math.max(0, end - 20)
    return { records: structuredClone(this.value.resource_cleanups.slice(start, end).reverse()), next_before: start > 0 ? start + 1 : null }
  }
  resourceRecord(id: string): ResourceCleanup | undefined { const r = this.value.resource_cleanups.find(r => r.id === id); return r && structuredClone(r) }
  resourceRecords(): ResourceCleanup[] { return structuredClone(this.value.resource_cleanups) }
  saveResourceCleanup(record: ResourceCleanup): void {
    if (this.error) fail()
    validateResourceCleanup(record)
    const prior = this.value.resource_cleanups.find(r => r.id === record.id)
    if (!prior || JSON.stringify(prior.resource) !== JSON.stringify(record.resource) || JSON.stringify(prior.source_tasks) !== JSON.stringify(record.source_tasks) || JSON.stringify(prior.stages) !== JSON.stringify(record.stages) || ['candidate', 'retired', 'deleting', 'file_deleted', 'complete'].indexOf(record.phase) < ['candidate', 'retired', 'deleting', 'file_deleted', 'complete'].indexOf(prior.phase) || (prior.phase !== 'candidate' && (JSON.stringify(prior.identity) !== JSON.stringify(record.identity) || prior.selected !== record.selected))) fail()
    this.save({ ...this.value, resource_cleanups: this.value.resource_cleanups.map(r => r.id === record.id ? structuredClone(record) : r) })
  }
  resourceRetired(key: string): boolean { return this.value.resource_cleanups.some(r => r.phase !== 'candidate' && (r.resource.id === key || r.resource.storage_key === key)) }
  assertResource(resource: Row): void { if (this.resourceRetired(resource.id) || this.resourceRetired(resource.storage_key)) throw new ContractError('RESOURCE_RETIRED', 'Resource retirement is durable; query its original cleanup') }
  assertMaterials(resources: Row[]): void { for (const r of resources) this.assertResource(r) }
  assertRecoverySafe(db: Database.Database): void {
    if (this.value.resource_cleanups.some(r => r.phase !== 'candidate' && r.phase !== 'complete')) throw new ContractError('RESOURCE_CLEANUP_INCOMPLETE', 'Complete the original resource cleanup before recovery publication or generation changes')
    this.assertMaterials(db.prepare('SELECT id,storage_key FROM resources').all() as Row[])
  }
  retired(file: string): boolean { return this.value.retirements.some(r => r.file === file && r.phase !== 'preview') }
  released(file: string): boolean { return this.value.retirements.some(r => r.file === file && r.phase === 'released') }
  retirementForFile(file: string): Retirement | undefined { const r = this.value.retirements.find(r => r.file === file && r.phase !== 'preview'); return r && structuredClone(r) }
  retirementRecord(id: string): Retirement | undefined { const r = this.value.retirements.find(r => r.id === id); return r && structuredClone(r) }
  retirementRecords(): Retirement[] { return structuredClone(this.value.retirements) }
  saveRetirement(record: Retirement): void {
    if (this.error) fail()
    const prior = this.value.retirements.find(r => r.id === record.id)
    if (prior && (prior.file !== record.file || JSON.stringify(prior.protection) !== JSON.stringify(record.protection) || (prior.phase !== 'preview' && record.phase === 'preview'))) fail()
    if (record.phase !== 'preview' && this.value.retirements.some(r => r.id !== record.id && r.file === record.file && r.phase !== 'preview')) fail()
    if (prior && ['preview', 'retired', 'group_deleted', 'released'].indexOf(record.phase) < ['preview', 'retired', 'group_deleted', 'released'].indexOf(prior.phase)) fail()
    this.save({ ...this.value, retirements: [...this.value.retirements.filter(r => r.id !== record.id), structuredClone(record)] })
  }
  private head(): string { return this.value.selected + ':' + (this.value.operations.at(-1)?.id ?? 'initial') }
  markStartupVerified(db: Database.Database): void {
    if (this.error || this.pending()) fail()
    if (this.value.operations.length) {
      if (db.pragma('quick_check', { simple: true }) !== 'ok' || (db.pragma('foreign_key_check') as unknown[]).length || JSON.stringify(db.prepare('SELECT version FROM schema_version').all()) !== '[{"version":1}]') fail()
      const current = describeDatabase(db, this.value.selected)
      if (current.tasks.some(t => this.value.deleted_tasks.includes(t))) fail()
      for (const material of current.resources) if (!this.resourceRetired(material.id) && !this.resourceRetired(material.storage_key)) resourceBody(this.root, material as Parameters<typeof resourceBody>[1])
    }
    if (this.value.verified_head !== this.head()) this.save({ ...this.value, verified_head: this.head() })
  }
  retirementGraph(): unknown { return { selected: this.value.selected, operations: this.value.operations, verified_head: this.value.verified_head, deleted_tasks: this.value.deleted_tasks } }
  replicaFiles(): string[] { return [...new Set(['trellis.sqlite', this.value.selected, ...this.value.operations.flatMap(o => [o.previous, o.target.file, o.rollback.file])])] }
  sealedReplica(file: string): RestoreImage | undefined {
    const wasSelected = file === 'trellis.sqlite' || file === this.value.selected || this.value.operations.some(o => o.previous === file || (o.phase === 'completed' && o.target.file === file) || (o.phase === 'rolled_back' && o.rollback.file === file))
    return wasSelected ? undefined : this.value.operations.flatMap(o => [o.target, o.rollback]).find(image => image.file === file)
  }
  retirementAllowed(file: string): boolean {
    if (this.error || this.pending() || file === this.value.selected || this.value.verified_head !== this.head()) return false
    return this.replicaFiles().includes(file) && !this.value.operations.some(op => [op.target, op.rollback].some(i => i.file === file && !i.sha256))
  }
  protects(resourceId: string): boolean {
    return this.value.retirements.some(r => r.phase !== 'preview' && r.phase !== 'released' && r.protection.keys.includes(resourceId)) || this.value.operations.some(op => [op.target, op.rollback].some(image => !this.released(image.file) && image.resources.some(resource => resource.id === resourceId || resource.storage_key === resourceId)))
  }
  retainedDatabases(): string[] {
    if (this.error || this.pending()) fail()
    const files = new Set(['trellis.sqlite', this.value.selected])
    for (const op of this.value.operations) {
      files.add(op.previous)
      for (const image of [op.target, op.rollback]) {
        if (!this.retired(image.file) && image.sha256 && !existsSync(join(this.root, image.file))) fail()
        files.add(image.file)
      }
    }
    for (const file of files) if (!this.retired(file) && (file === 'trellis.sqlite' || file === this.value.selected || this.value.operations.some(op => op.previous === file)) && !existsSync(join(this.root, file))) fail()
    return [...files].filter(file => !this.retired(file))
  }
  close(): void { this.db?.close() }
}
