import { fileLstatSync as lstatSync, assertDirectorySync, entryExistsSync as existsSync, flushDirectorySync, flushFileSync, managedFile, managedRegularFile, regularFile } from '../platform/files'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { closeSync,mkdirSync,openSync,readdirSync,readFileSync } from 'node:fs'
import { join } from 'node:path'
import { protectPrivatePath } from '../platform/permissions'
import defaults from '../shared/contracts/development-defaults.json'
import { ContractError } from '../shared/validation'
import type { PluginCopy } from './plugins/package'
import { validatePluginProtection,verifyPluginProtection } from './plugins/protection'
import { digest,resourceBody } from './resources'
import { describeDatabase,flushFile,RestoreJournal,verifyDatabase } from './restore-journal'

type Row = Record<string, any>
type Material = { id: string; storage_key: string; sha256: string; byte_length: number }
type Point = { id: string; created_at: string; app_version: '0.1.0'; schema_version: 1; tasks: string[]; resources: Material[]; plugins: PluginCopy[]; settings: Record<string, unknown>; database_sha256?: string }
type Control = { version: 2; active: Point | null; candidates: Point[]; retired: string[]; invalidated: string[] }
const fail = (code: string, text: string): never => { throw new ContractError(code, text) }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
function privateFile(file: string): void {
  if (existsSync(file)) { try { regularFile(lstatSync(file)) } catch { fail('RECOVERY_CONTROL_INVALID', 'Unsafe managed file type') } }
}

// A separate SQLite transaction is an OS-released, same-directory writer lock.
export function ownDirectory(root: string): Database.Database {
  protectPrivatePath(root, 'directory')
  const file = managedFile(root, 'runtime-owner.sqlite'); privateFile(file)
  const owner = new Database(file)
  try {
    owner.pragma('busy_timeout=0')
    owner.exec('CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE')
    protectPrivatePath(file, 'file')
    return owner
  } catch { owner.close(); return fail('DIRECTORY_BUSY', 'Another runtime owns this data directory; it was not interrupted') }
}

export class RecoveryManager {
  private control?: Database.Database
  private state: Control = { version: 2, active: null, candidates: [], retired: [], invalidated: [] }
  private reservation: { token: string; expires: number; phase: 'preparing' | 'creating' | 'restoring' | 'collecting'; inputs: Set<string> } | null = null
  private timer?: ReturnType<typeof setTimeout>
  private error: string | null = null
  private last: { token: string; outcome: string; point_id?: string } | null = null
  private operation?: Promise<unknown>
  private folder: string
  constructor(private db: Database.Database, private root: string, private busy: () => boolean, private pause: (held: boolean) => void, private settings: () => Record<string, unknown>, private journal: RestoreJournal, private rebind: (file: string) => Database.Database, private pluginCopies: () => PluginCopy[] = () => [], private beforeRebind: () => Promise<void> = async () => {}) {
    this.folder = join(root, 'recovery')
    try {
      if (existsSync(this.folder) && !lstatSync(this.folder).isDirectory()) throw new Error()
      mkdirSync(this.folder, { recursive: true, mode: 0o700 }); assertDirectorySync(this.folder)
      const path = managedRegularFile(root, 'recovery-control.sqlite'); privateFile(path)
      const present = existsSync(path)
      if (!present && ((this.db.prepare('SELECT id FROM recovery_points LIMIT 1').get()) || readdirSync(this.folder).length)) throw new Error()
      this.control = new Database(path)
      this.control.pragma('busy_timeout=0'); this.control.pragma('journal_mode=DELETE'); this.control.pragma('synchronous=FULL'); protectPrivatePath(path, 'file')
      if (!present) {
        this.control.exec('CREATE TABLE control (id INTEGER PRIMARY KEY CHECK(id=1), manifest TEXT NOT NULL)')
        this.control.prepare('INSERT INTO control VALUES (1,?)').run(JSON.stringify(this.state))
      }
      flushDirectorySync(root)
      const row = this.control.prepare('SELECT manifest FROM control WHERE id=1').get() as Row | undefined
      const state = row && JSON.parse(row.manifest)
      RecoveryManager.validateControl(state)
      if (state.version === 1) this.write({ ...state, version: 2, active: state.active ? { ...state.active, plugins: [] } : null, candidates: state.candidates.map((p: Point) => ({ ...p, plugins: [] })) })
      else this.state = state
      // Interrupted candidates are never promoted, but retain their pins until a later safe publication.
      this.verifyActive(); this.project()
    } catch { this.error = 'RECOVERY_CONTROL_INVALID'; this.pause(true) }
  }
  static validateControl(value: any): void {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'active,candidates,invalidated,retired,version' || (value.active !== null && (typeof value.active !== 'object' || Array.isArray(value.active))) || ![1, 2].includes(value.version) || !Array.isArray(value.candidates) || !Array.isArray(value.retired) || !Array.isArray(value.invalidated)) throw new Error()
    const points = [...value.candidates, ...(value.active ? [value.active] : [])]
    for (const p of points) {
      const keys = Object.keys(p ?? {}).sort().join(',')
      const expected = ['id', 'created_at', 'app_version', 'schema_version', 'tasks', 'resources', 'settings', ...(p?.database_sha256 !== undefined ? ['database_sha256'] : []), ...(value.version === 2 ? ['plugins'] : [])].sort().join(',')
      if (keys !== expected) throw new Error()
      if (value.version === 2) validatePluginProtection(p.plugins)
      if (!p || !p.settings || typeof p.settings !== 'object' || Array.isArray(p.settings) || !uuid.test(p.id) || p.schema_version !== 1 || p.app_version !== '0.1.0' || typeof p.created_at !== 'string' || !Number.isFinite(Date.parse(p.created_at)) || !Array.isArray(p.tasks) || p.tasks.some((id: unknown) => typeof id !== 'string' || !uuid.test(id)) || !Array.isArray(p.resources)) throw new Error()
      for (const r of p.resources) if (!r || typeof r.id !== 'string' || !uuid.test(r.id) || typeof r.storage_key !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(r.storage_key) || !/^[a-f0-9]{64}$/.test(r.sha256) || !Number.isSafeInteger(r.byte_length) || r.byte_length < 0) throw new Error()
    }
    if ([...value.retired, ...value.invalidated].some((id: unknown) => typeof id !== 'string' || !uuid.test(id))) throw new Error()
    if (value.active && (value.invalidated.includes(value.active.id) || value.retired.includes(value.active.id) || !/^[a-f0-9]{64}$/.test(value.active.database_sha256))) throw new Error()
    if (new Set(points.map(p => p.id)).size !== points.length || points.some(p => value.retired.includes(p.id) || value.invalidated.includes(p.id))) throw new Error()
  }
  private write(next: Control): void {
    RecoveryManager.validateControl(next)
    this.control!.transaction(() => { this.control!.prepare('UPDATE control SET manifest=? WHERE id=1').run(JSON.stringify(next)) })()
    this.state = next
  }
  private verifyActive(): void { if (this.state.active) this.verify(this.state.active) }
  private verify(point: Point): void {
    verifyPluginProtection(this.root, point.plugins)
    this.journal.assertMaterials(point.resources)
    if (this.journal.retired('recovery/' + point.id + '.sqlite')) fail('RECOVERY_RETIRED', 'This replica is permanently retired')
    const path = managedRegularFile(this.root, 'recovery', point.id + '.sqlite'); privateFile(path)
    if (point.database_sha256 && digest(readFileSync(path)) !== point.database_sha256) fail('RECOVERY_CORRUPT', 'Recovery database checksum mismatch')
    const copy = new Database(path, { readonly: true, fileMustExist: true })
    try {
      if (copy.pragma('quick_check', { simple: true }) !== 'ok' || (copy.pragma('foreign_key_check') as unknown[]).length || JSON.stringify(copy.prepare('SELECT version FROM schema_version').all()) !== '[{"version":1}]') throw new Error()
      const tasks = (copy.prepare('SELECT id FROM tasks ORDER BY id').all() as Row[]).map(r => r.id)
      const materials = copy.prepare('SELECT id,storage_key,sha256,byte_length FROM resources ORDER BY id').all()
      if (JSON.stringify(tasks) !== JSON.stringify(point.tasks) || JSON.stringify(materials) !== JSON.stringify(point.resources)) throw new Error()
      for (const material of point.resources) resourceBody(this.root, material as Parameters<typeof resourceBody>[1])
    } finally { copy.close() }
  }
  private project(): void {
    this.db.transaction(() => {
      this.db.prepare("UPDATE recovery_points SET state='invalid'").run()
      this.db.prepare('DELETE FROM recovery_resources').run(); this.db.prepare('DELETE FROM recovery_tasks').run()
      for (const point of [...this.state.candidates, ...(this.state.active ? [this.state.active] : [])]) {
        this.db.prepare("INSERT INTO recovery_points VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,manifest_json=excluded.manifest_json").run(point.id, this.state.active?.id === point.id ? 'valid' : 'candidate', JSON.stringify(point), point.created_at)
        for (const task of point.tasks) this.db.prepare('INSERT INTO recovery_tasks VALUES (?,?)').run(point.id, task)
        for (const resource of point.resources) if (this.db.prepare('SELECT id FROM resources WHERE id=?').get(resource.id)) this.db.prepare('INSERT INTO recovery_resources VALUES (?,?)').run(point.id, resource.id)
      }
    })()
  }
  assertWrite(token?: string): void {
    if (this.error) fail('MAINTENANCE_BLOCKED', 'Recovery control requires inspection; unsafe writes are closed')
    if (this.reservation && !(this.reservation.phase === 'preparing' && token === this.reservation.token && Date.now() < this.reservation.expires)) fail('MAINTENANCE_BUSY', 'Maintenance holds all business writes')
    if (token && (!this.reservation || token !== this.reservation.token)) fail('MAINTENANCE_EXPIRED', 'Input-save reservation expired; retain local input')
  }
  consumeInput(token: string, taskId: string, viewId: string): void {
    this.assertWrite(token)
    if (!this.reservation?.inputs.delete(taskId + ':' + viewId)) fail('MAINTENANCE_INPUT_INVALID', 'Only one save per registered mounted editor is allowed; retain input')
  }
  status(): unknown {
    return { phase: this.error ? 'blocked' : this.reservation?.phase ?? 'idle', error: this.error, reservation: this.reservation ? { token: this.reservation.token, expires_at: new Date(this.reservation.expires).toISOString() } : null, active: this.state.active ? { id: this.state.active.id, created_at: this.state.active.created_at, task_ids: this.state.active.tasks, resource_count: this.state.active.resources.length, database_sha256: this.state.active.database_sha256, app_version: this.state.active.app_version, schema_version: this.state.active.schema_version } : null, last: this.last, retained_candidates: this.state.candidates.length, restore_enabled: !this.error && !!this.state.active, restore: this.journal.status(), gc_enabled: false, migration_enabled: false }
  }
  begin(inputs: { task_id: string; view_id: string }[] = []): unknown {
    this.assertWrite()
    if (this.busy()) fail('MAINTENANCE_EXECUTION_ACTIVE', 'Wait for all executions, approvals, model operations and necessary cleanup to finish')
    for (const input of inputs) if (!this.db.prepare('SELECT 1 FROM views v JOIN surfaces s ON s.id=v.surface_id WHERE v.id=? AND s.task_id=?').get(input.view_id, input.task_id)) fail('MAINTENANCE_INPUT_INVALID', 'Mounted editor changed; retain local input and refresh')
    this.pause(true)
    const token = randomUUID(); this.reservation = { token, expires: Date.now() + defaults.maintenance.reservation_ms, phase: 'preparing', inputs: new Set(inputs.map(i => i.task_id + ':' + i.view_id)) }
    this.timer = setTimeout(() => { if (this.reservation?.phase === 'preparing') this.release('expired') }, defaults.maintenance.reservation_ms); this.timer.unref?.()
    return this.status()
  }
  cancel(token: string): unknown {
    if (!this.reservation || token !== this.reservation.token) return fail('MAINTENANCE_EXPIRED', 'Reservation no longer exists; query status')
    if (this.reservation.phase !== 'preparing') fail('MAINTENANCE_BUSY', 'Backup publication cannot be cancelled; query its original result')
    this.release('cancelled'); return this.status()
  }
  private release(outcome: string, point_id?: string): void {
    if (this.reservation) this.last = { token: this.reservation.token, outcome, ...(point_id ? { point_id } : {}) }
    this.reservation = null; clearTimeout(this.timer); if (!this.error) this.pause(false)
  }
  create(token: string, replace: string | null): Promise<unknown> {
    this.assertWrite(token)
    this.journal.assertRecoverySafe(this.db)
    if (!this.reservation || this.reservation.phase !== 'preparing') fail('MAINTENANCE_EXPIRED', 'A saved-input reservation is required')
    if ((this.state.active?.id ?? null) !== replace) fail('RECOVERY_CHANGED', 'Recovery point changed; refresh and explicitly confirm replacement')
    if (this.busy()) fail('MAINTENANCE_EXECUTION_ACTIVE', 'Execution became active; no recovery point was created')
    this.reservation!.phase = 'creating'; clearTimeout(this.timer)
    this.operation = this.publish()
    return this.operation
  }
  private async publish(): Promise<unknown> {
    let switched = false
    try {
      const point: Point = { id: randomUUID(), created_at: new Date().toISOString(), app_version: '0.1.0', schema_version: 1, tasks: (this.db.prepare('SELECT id FROM tasks ORDER BY id').all() as Row[]).map(r => r.id), resources: this.db.prepare('SELECT id,storage_key,sha256,byte_length FROM resources ORDER BY id').all() as Material[], plugins: this.pluginCopies(), settings: this.settings() }
      // Both the candidate and the old active point protect resources before asynchronous backup starts.
      this.write({ ...this.state, candidates: [...this.state.candidates, point] }); this.project()
      for (const r of point.resources) resourceBody(this.root, r as Parameters<typeof resourceBody>[1])
      verifyPluginProtection(this.root, point.plugins)
      const path = managedRegularFile(this.root, 'recovery', point.id + '.sqlite')
      const placeholder = openSync(path, 'wx', 0o600); closeSync(placeholder)
      await this.db.backup(path)
      protectPrivatePath(path, 'file')
      flushFileSync(path)
      flushDirectorySync(this.folder)
      point.database_sha256 = digest(readFileSync(path)); this.verify(point)
      this.write({ ...this.state, active: point, candidates: [], retired: [...this.state.retired, ...this.state.candidates.filter(p => p.id !== point.id).map(p => p.id), ...(this.state.active ? [this.state.active.id] : [])] })
      switched = true; this.project(); this.release('created', point.id)
      return this.status()
    } catch {
      // Any control/projection ambiguity closes writes. Restart reconciles from the independent control, never from the backup.
      this.error = switched ? 'RECOVERY_PROJECTION_FAILED' : 'RECOVERY_CREATE_FAILED'
      this.release('failed'); this.pause(true)
      return fail(this.error, 'Recovery creation failed; old files retained, writes paused. Query status; do not replay')
    } finally { this.operation = undefined }
  }
  invalidateForDelete(taskId: string, confirmation?: string): void {
    this.assertWrite()
    const affected = this.state.active?.tasks.includes(taskId) ? this.state.active : null
    if (affected && confirmation !== affected.id) fail('RECOVERY_CONFIRMATION_REQUIRED', 'Deleting this task invalidates the entire current recovery point; confirm its exact ID')
    if (confirmation && confirmation !== affected?.id) fail('RECOVERY_CHANGED', 'Recovery point changed; refresh deletion scope')
    try {
      const candidates = this.state.candidates.filter(p => p.tasks.includes(taskId))
      if (affected || candidates.length) {
        this.write({ ...this.state, active: affected ? null : this.state.active, candidates: this.state.candidates.filter(p => !candidates.includes(p)), invalidated: [...this.state.invalidated, ...(affected ? [affected.id] : []), ...candidates.map(p => p.id)] })
        this.project()
      }
      this.journal.beforeDelete(taskId, this.db)
    } catch { this.error = 'RECOVERY_INVALIDATION_FAILED'; this.pause(true); fail(this.error, 'Recovery invalidation failed; task deletion blocked') }
  }
  protects(resourceId: string): boolean {
    return this.journal.protects(resourceId) || [...this.state.candidates, ...(this.state.active ? [this.state.active] : [])].some(p => p.resources.some(r => r.id === resourceId || r.storage_key === resourceId))
  }
  retainedPointIds(): string[] {
    if (this.error) fail('GC_RETAINED_UNCERTAIN', 'Recovery protection cannot be verified')
    return [...new Set([...this.state.candidates.map(p => p.id), ...(this.state.active ? [this.state.active.id] : []), ...this.state.retired, ...this.state.invalidated])].filter(id => !this.journal.retired('recovery/' + id + '.sqlite'))
  }
  replicaPoints(): { file: string; allowed: boolean }[] {
    if (this.error) fail('REPLICA_DEPENDENCY_UNCERTAIN', 'Recovery control requires inspection')
    return [...new Set([...this.state.retired, ...this.state.invalidated, ...this.state.candidates.map(p => p.id), ...(this.state.active ? [this.state.active.id] : [])])].map(id => ({ file: 'recovery/' + id + '.sqlite', allowed: [...this.state.retired, ...this.state.invalidated].includes(id) && this.state.active?.id !== id && !this.state.candidates.some(p => p.id === id) }))
  }
  replicaGraph(): unknown { return this.state }
  collect<T>(token: string, execute: () => T): T {
    this.assertWrite(token)
    if (!this.reservation || this.reservation.phase !== 'preparing') fail('MAINTENANCE_EXPIRED', 'A saved-input reservation is required')
    if (this.busy()) fail('MAINTENANCE_EXECUTION_ACTIVE', 'Execution became active; no collection started')
    this.reservation!.phase = 'collecting'; clearTimeout(this.timer)
    try { const result = execute(); this.release('gc_settled'); return result }
    catch (error) { this.release('gc_failed'); throw error }
  }
  checkPreparation(token: string): void {
    this.assertWrite(token)
    if (!this.reservation || this.reservation.phase !== 'preparing') fail('MAINTENANCE_EXPIRED', 'A saved-input reservation is required')
    if (this.busy()) fail('MAINTENANCE_EXECUTION_ACTIVE', 'Execution became active; collection is blocked')
  }
  restore(token: string, pointId: string, sha256: string): Promise<unknown> {
    this.assertWrite(token)
    this.journal.assertRecoverySafe(this.db)
    if (!this.reservation || this.reservation.phase !== 'preparing') fail('MAINTENANCE_EXPIRED', 'A saved-input reservation is required')
    if (!this.state.active || this.state.active.id !== pointId || this.state.active.database_sha256 !== sha256) fail('RECOVERY_CHANGED', 'Refresh and personally confirm the current recovery point')
    if (this.busy()) fail('MAINTENANCE_EXECUTION_ACTIVE', 'Wait for all executions before restoration')
    this.reservation!.phase = 'restoring'; clearTimeout(this.timer)
    this.operation = this.restorePoint(token)
    return this.operation
  }
  private async restorePoint(token: string): Promise<unknown> {
    let switched = false, prepared = false
    const point = this.state.active!
    try {
      await this.beforeRebind()
      this.verify(point)
      const source = new Database(managedRegularFile(this.root, 'recovery', point.id + '.sqlite'), { readonly: true, fileMustExist: true })
      let op: ReturnType<RestoreJournal['prepare']>
      try {
        const target = describeDatabase(source, '')
        op = this.journal.prepare(token, point.id, { ...describeDatabase(this.db, this.journal.selected()), plugins: this.pluginCopies() }, { tasks: target.tasks, resources: target.resources, plugins: point.plugins }); prepared = true
        for (const file of [op.target.file, op.rollback.file]) { const fd = openSync(join(this.root, file), 'wx', 0o600); closeSync(fd) }
        await this.db.backup(join(this.root, op.rollback.file))
        await source.backup(join(this.root, op.target.file))
      } finally { source.close() }
      // Normalize executable history before publishing; credentials and configuration remain outside this database.
      const candidate = new Database(managedRegularFile(this.root, op!.target.file), { fileMustExist: true })
      try {
        candidate.pragma('synchronous=FULL')
        candidate.transaction(() => {
          candidate.prepare("UPDATE runs SET state=COALESCE(intended_terminal,'interrupted'),primary_reason=COALESCE(primary_reason,'data_restored'),commit_valid=0,ended_at=? WHERE state IN ('running','waiting')").run(new Date().toISOString())
          candidate.prepare('UPDATE runs SET commit_valid=0').run()
          candidate.prepare("UPDATE actions SET state='ended',result=COALESCE(result,'not_executed'),commit_valid=0 WHERE state!='ended'").run()
          candidate.prepare("UPDATE calls SET state='ended',commit_valid=0,execution=COALESCE(execution,CASE WHEN dispatch='not_sent' THEN 'not_executed' ELSE 'unknown' END) WHERE state!='ended'").run()
          candidate.prepare('UPDATE actions SET commit_valid=0').run()
          candidate.prepare('UPDATE calls SET commit_valid=0').run()
          candidate.prepare("UPDATE approvals SET validity='revoked' WHERE validity='valid'").run()
          candidate.prepare("UPDATE requests SET state='cancelled' WHERE state IN ('queued','confirmation_required')").run()
          candidate.prepare("UPDATE tasks SET state='stopped' WHERE state='stopping'").run()
        })()
        verifyDatabase(candidate, this.root, this.journal.deleted(), op!.target)
      } finally { candidate.close() }
      flushFile(this.root, op!.target.file); flushFile(this.root, op!.rollback.file)
      this.journal.seal()
      // Close the old connection before committing the selector; old WAL/SHM are never renamed over another database.
      this.pause(true); this.db.close()
      this.journal.switch(); switched = true
      this.db = this.rebind(op!.target.file)
      verifyDatabase(this.db, this.root, this.journal.deleted(), op!.target)
      this.project()
      this.journal.finish('completed')
      this.release('restored', point.id)
      return this.status()
    } catch {
      try {
        if (switched || this.journal.phase() === 'switched') { const file = this.journal.rollback(); this.db = this.rebind(file); this.project() }
        else { if (prepared && this.journal.phase() === 'preparing') this.journal.finish('rolled_back'); if (!this.db.open) this.db = this.rebind(this.journal.selected()) }
      } catch { this.error = 'RESTORE_ROLLBACK_FAILED' }
      this.error ??= 'RESTORE_FAILED'; this.release('failed'); this.pause(true)
      return fail(this.error, 'Restoration failed; retained files and original operation require inspection. Do not replay')
    } finally { this.operation = undefined }
  }
  async settled(): Promise<void> { await this.operation?.catch(() => {}) }
  close(): void { clearTimeout(this.timer); this.control?.close() }
}
