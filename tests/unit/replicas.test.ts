import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { RuntimeStore } from '../../src/runtime/store'
import { digest } from '../../src/runtime/resources'
let root: string, store: RuntimeStore, task: string
const state = (): any => store.handle({ type: 'maintenance.status' })
const begin = (): string => (store.handle({ type: 'maintenance.begin' }) as any).reservation.token
const cancel = (token: string) => { if (state().reservation?.token === token) store.handle({ type: 'maintenance.cancel', token }) }
const list = (): any[] => (store.handle({ type: 'maintenance.replica.list' }) as any).items
const preview = (replica_id: string, token: string): any => store.handle({ type: 'maintenance.replica.preview', token, replica_id, inputs_saved: true })
const execute = (p: any, token: string, retry = false): any => store.handle({ type: retry ? 'maintenance.replica.retry' : 'maintenance.replica.execute', token, operation_id: p.id, inputs_saved: true, confirm_retire_replica: true })
const result = (id: string): any => store.handle({ type: 'maintenance.replica.status', operation_id: id })
const point = async (): Promise<any> => store.handle({ type: 'maintenance.create', token: begin(), inputs_saved: true, replace_id: state().active?.id ?? null })
const restore = async (): Promise<any> => store.handle({ type: 'maintenance.restore', token: begin(), point_id: state().active.id, database_sha256: state().active.database_sha256, inputs_saved: true, confirm_replace_newer_data: true })
const control = (): any => { const db = new Database(join(root, 'restore-control.sqlite')); try { return JSON.parse((db.prepare('SELECT manifest FROM restore_control').get() as any).manifest) } finally { db.close() } }
const restart = () => { store.close(); store = new RuntimeStore(root, undefined, { viewReplacement: true }) }
beforeEach(context => { if (context.task.name === 'new control format is rejected by the old strict version gate; v1 upgrades preserve selector and outcomes') vi.stubEnv('TRELLIS_TEST_FILE_IDENTITIES', ''); root = fs.mkdtempSync(join(tmpdir(), 'trellis-replicas-')); store = new RuntimeStore(root, undefined, { viewReplacement: true }); task = store.create('副本隔离验收').task.id })
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); store.close(); fs.rmSync(root, { recursive: true, force: true }) })
async function obsolete(): Promise<string> { const old = (await point()).active; await point(); return 'recovery/' + old.id + '.sqlite' }
function resource(text = 'unchanged'): string {
  vi.useFakeTimers(); const run = store.start(task, 'held', 'fixture', [])
  const value = store.modelTool(task, run, { type: 'write', input: { type: 'resource.create', display_name: '材料', content: { type: 'text', text } } }) as any
  store.handle({ type: 'run.cancel', task_id: task, run_id: run }); vi.useRealTimers(); return value.data.id
}
function prepare(file: string): { token: string; p: any } { const token = begin(); return { token, p: preview(digest(Buffer.from(file)), token) } }
it('protects current generation and active point without invalidation and does not expose internal names', async () => {
  await point(); const items = list(); expect(items.every(i => !i.eligible)).toBe(true)
  const token = begin(); expect(() => preview(digest(Buffer.from('trellis.sqlite')), token)).toThrow(); expect(() => preview(digest(Buffer.from('recovery/' + state().active.id + '.sqlite')), token)).toThrow(); cancel(token)
  expect(JSON.stringify(items)).not.toMatch(/trellis\.sqlite|recovery\/|storage_key|\/Users\//); expect(state().active).not.toBeNull()
})
it('retires only one obsolete point; keeps effective point, formal resources, data and independent outcome over restart', async () => {
  const key = resource(), file = await obsolete(), active = state().active, bytes = fs.readFileSync(join(root, 'resources', key)), { token, p } = prepare(file)
  const r = execute(p, token); expect(r).toMatchObject({ phase: 'released', protection_released: true, formal_resources_deleted: 0, business_replayed: false, attempt: 1 })
  expect(fs.existsSync(join(root, file))).toBe(false); expect(fs.readFileSync(join(root, 'resources', key))).toEqual(bytes); expect(state().active).toEqual(active)
  restart(); expect(result(p.id)).toEqual(r); expect(state().active).toEqual(active); expect(store.snapshot(task)).toBeTruthy(); await point(); await restore()
})
it('requires successful startup after restore before retiring prior generation or fallback, regardless terminal phase', async () => {
  await point(); await restore(); expect(control().operations[0].phase).toBe('completed'); expect(list().filter(i => i.eligible)).toEqual([])
  const token = begin(); expect(() => preview(digest(Buffer.from('trellis.sqlite')), token)).toThrow(); cancel(token)
  restart(); expect(list().filter(i => i.eligible)).toHaveLength(2)
  const { token: next, p } = prepare('trellis.sqlite'); expect(execute(p, next).phase).toBe('released'); expect(control().selected).toMatch(/target/)
  restart(); expect(store.snapshot(task)).toBeTruthy(); const t = begin(); expect(store.handle({ type: 'maintenance.gc.preview', token: t, inputs_saved: true })).toBeTruthy(); cancel(t)
})
it('retires private rollback only after restart and never retires selected target', async () => {
  await point(); await restore(); restart(); const journal = control(), selected = journal.selected, file = journal.operations[0].rollback.file, { token, p } = prepare(file)
  expect(execute(p, token).phase).toBe('released'); expect(fs.existsSync(join(root, selected))).toBe(true); expect(fs.existsSync(join(root, file))).toBe(false)
  const t = begin(); expect(() => preview(digest(Buffer.from(selected)), t)).toThrow(); cancel(t); restart(); expect(store.snapshot(task)).toBeTruthy()
})
it('protects selected rollback after target reopen failure and only opens retirement after successful startup', async () => {
  await point(); const original = Database.prototype.pragma
  vi.spyOn(Database.prototype, 'pragma').mockImplementation(function (this: Database.Database, sql: string, options?: any) { if (this.name.endsWith('-target.sqlite') && sql === 'foreign_keys=ON') throw new Error('fault'); return original.call(this, sql, options) })
  await expect(restore()).rejects.toThrow(); vi.restoreAllMocks(); expect(state().phase).toBe('blocked'); restart()
  const selected = control().selected; expect(selected).toMatch(/rollback/); const t = begin(); expect(() => preview(digest(Buffer.from(selected)), t)).toThrow(); cancel(t)
  const { token, p } = prepare(control().operations[0].target.file); expect(execute(p, token).phase).toBe('released'); restart(); expect(store.snapshot(task)).toBeTruthy()
})
it('cancel, stale reservation and missing explicit confirmation delete nothing', async () => {
  const file = await obsolete(), { token, p } = prepare(file); cancel(token); const next = begin(); expect(() => execute(p, next)).toThrow(); cancel(next)
  for (const missing of ['confirm_retire_replica', 'inputs_saved', 'operation_id', 'token']) {
    const q = prepare(file), request: any = { type: 'maintenance.replica.execute', token: q.token, operation_id: q.p.id, inputs_saved: true, confirm_retire_replica: true }; delete request[missing]; expect(() => store.handle(request)).toThrow(); cancel(q.token)
  }
  expect(fs.existsSync(join(root, file))).toBe(true); expect(control().retirements.every((r: any) => r.phase === 'preview')).toBe(true)
})
it.each(['EACCES', 'EBUSY', 'EIO', 'ENOSPC'])('retains authority and pins on %s; bounded original retry survives restart', async code => {
  const file = await obsolete(), { token, p } = prepare(file); vi.useFakeTimers()
  vi.spyOn(fs, 'unlinkSync').mockImplementation(() => { throw Object.assign(new Error('private'), { code }) })
  expect(execute(p, token)).toMatchObject({ phase: 'retired', attempt: 1, reason: code, protection_released: false }); vi.restoreAllMocks(); restart()
  expect(fs.existsSync(join(root, file))).toBe(true); expect(execute(p, begin(), true).attempt).toBe(1)
  vi.advanceTimersByTime(1001); expect(execute(p, begin(), true).phase).toBe('released'); expect(fs.existsSync(join(root, file))).toBe(false)
})
it('rejects overlapping previews and cannot reset original attempt budget', async () => {
  const file = await obsolete(), token = begin(), id = digest(Buffer.from(file)), p = preview(id, token), q = preview(id, token)
  vi.spyOn(fs, 'unlinkSync').mockImplementation(() => { throw Object.assign(new Error('fault'), { code: 'EBUSY' }) }); execute(q, token); vi.restoreAllMocks()
  const t = begin(); expect(() => preview(id, t)).toThrow(); expect(() => execute(p, t)).toThrow(); cancel(t); expect(result(q.id).attempt).toBe(1)
})
it.each(['changed', 'symlink', 'broken-symlink', 'hardlink', 'corrupt', 'new-aux'])('refuses changed or unsafe replica before retirement: %s', async mode => {
  const file = await obsolete(), { token, p } = prepare(file), path = join(root, file)
  if (mode === 'changed') fs.utimesSync(path, new Date(), new Date(Date.now() + 5000))
  if (mode === 'symlink') { fs.renameSync(path, path + '.save'); fs.symlinkSync(path + '.save', path) }
  if (mode === 'broken-symlink') { fs.renameSync(path, path + '.save'); fs.symlinkSync(path + '.missing', path) }
  if (mode === 'hardlink') fs.linkSync(path, path + '.save')
  if (mode === 'corrupt') fs.writeFileSync(path, 'broken')
  if (mode === 'new-aux') fs.writeFileSync(path + '-journal', 'new')
  expect(() => execute(p, token)).toThrow(); expect(control().retirements.find((r: any) => r.id === p.id).phase).toBe('preview'); expect(fs.lstatSync(path)).toBeTruthy()
})
it('keeps full protection until main and actual auxiliary members are absent and durable', async () => {
  const file = await obsolete(); fs.writeFileSync(join(root, file + '-journal'), Buffer.alloc(512))
  const { token, p } = prepare(file), original = fs.unlinkSync, seen: string[] = []
  vi.spyOn(fs, 'unlinkSync').mockImplementation(path => {
    const r = control().retirements.find((r: any) => r.id === p.id); expect(r.phase).toBe('retired'); expect(r.members.some((m: any) => m.state === 'deleting')).toBe(true)
    seen.push(String(path)); if (String(path).endsWith('-journal')) throw Object.assign(new Error('fault'), { code: 'EBUSY' }); original(path)
  })
  expect(execute(p, token)).toMatchObject({ phase: 'retired', protection_released: false }); expect(seen).toEqual(p.files.map((f: any) => join(root, file + (f.kind === 'database' ? '' : f.kind)))); vi.restoreAllMocks(); restart()
  expect(result(p.id).protection_released).toBe(false); expect(fs.existsSync(join(root, file))).toBe(false); expect(fs.existsSync(join(root, file + '-journal'))).toBe(true)
  vi.useFakeTimers(); vi.advanceTimersByTime(1100); expect(execute(p, begin(), true).phase).toBe('released')
})
it('new member after retirement is retained, not wildcard-deleted or reopened as SQLite', async () => {
  const file = await obsolete(), { token, p } = prepare(file)
  vi.spyOn(fs, 'unlinkSync').mockImplementation(() => { throw Object.assign(new Error('fault'), { code: 'EBUSY' }) }); execute(p, token); vi.restoreAllMocks()
  fs.writeFileSync(join(root, file + '-journal'), 'unexpected'); vi.useFakeTimers(); vi.advanceTimersByTime(1100)
  expect(execute(p, begin(), true)).toMatchObject({ phase: 'retired', reason: 'REPLICA_NEW_GROUP_MEMBER', protection_released: false }); expect(fs.existsSync(join(root, file))).toBe(true)
})
it('a failed replacement keeps old effective point ineligible; terminal incomplete candidate is not forced', async () => {
  const active = (await point()).active; vi.spyOn(Database.prototype, 'backup').mockRejectedValueOnce(new Error('fault')); await expect(point()).rejects.toThrow(); vi.restoreAllMocks(); restart()
  expect(state().active.id).toBe(active.id); const t = begin(); expect(() => preview(digest(Buffer.from('recovery/' + active.id + '.sqlite')), t)).toThrow(); cancel(t)
  expect(() => list()).toThrow()
})
it('task deletion invalidation is not revived by reclaiming invalid backup, and resources remain protected by replica until removal', async () => {
  const key = resource(), p = (await point()).active
  store.handle({ type: 'task.delete', task_id: task, invalidate_recovery_id: p.id }); expect(state().active).toBeNull()
  expect(fs.existsSync(join(root, 'resources', key))).toBe(true)
  const { token, p: op } = prepare('recovery/' + p.id + '.sqlite'); expect(execute(op, token).phase).toBe('released')
  expect(fs.existsSync(join(root, 'resources', key))).toBe(true); restart(); expect(store.tasks()).toEqual([]); expect(state().active).toBeNull(); expect(control().deleted_tasks).toContain(task)
})
it('freezes complete WAL-consistent staging, resources and historical protection before first unlink', async () => {
  const key = resource(), file = await obsolete(), db = new Database(join(root, file)), stagekey = randomUUID()
  db.pragma('journal_mode=WAL'); db.prepare("INSERT INTO staging (id,task_id,owner_kind,owner_id,runtime_epoch,state,storage_key,expected_bytes,sha256,created_at) VALUES ('s',?,'action','ended','old','invalid',?,1,?,'now')").run(task, stagekey, digest(Buffer.from('x')))
  // Keep the external test connection open only to demonstrate that manifest reads include WAL.
  const { token, p } = prepare(file), r = control().retirements.find((r: any) => r.id === p.id)
  expect(r.protection.keys).toEqual(expect.arrayContaining([key, stagekey])); expect(r.protection.staging.some((s: any) => s.storage_key === stagekey)).toBe(true); cancel(token); db.close()
})
it('dependency graph changes expire preview even if replica itself stayed identical', async () => {
  const file = await obsolete(), { token, p } = prepare(file); cancel(token); await point()
  const next = begin(); expect(() => execute(p, next)).toThrow(); cancel(next); expect(fs.existsSync(join(root, file))).toBe(true)
})
it('does not delete on preview registration failure and retains pins on release record failure', async () => {
  const key = resource(), file = await obsolete(), original = Database.prototype.prepare
  let phase = 'preview'
  vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql: string) {
    const statement = original.call(this, sql)
    if (this.name.endsWith('restore-control.sqlite') && sql.startsWith('UPDATE restore_control SET manifest=')) return new Proxy(statement, { get(target, k) {
      if (k === 'run') return (manifest: string) => { const r = JSON.parse(manifest).retirements.at(-1); if (r?.phase === phase) throw Object.assign(new Error('fault'), { code: 'ENOSPC' }); return target.run(manifest) }
      const v = Reflect.get(target, k); return typeof v === 'function' ? v.bind(target) : v
    } })
    return statement
  } as typeof Database.prototype.prepare)
  const t = begin(); expect(() => preview(digest(Buffer.from(file)), t)).toThrow(); cancel(t); expect(fs.existsSync(join(root, file))).toBe(true)
  vi.restoreAllMocks(); const q = prepare(file); phase = 'released'
  vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql: string) {
    const statement = original.call(this, sql)
    if (this.name.endsWith('restore-control.sqlite') && sql.startsWith('UPDATE restore_control SET manifest=')) return new Proxy(statement, { get(target, k) {
      if (k === 'run') return (manifest: string) => { if (JSON.parse(manifest).retirements.at(-1)?.phase === phase) throw Object.assign(new Error('fault'), { code: 'EIO' }); return target.run(manifest) }
      const v = Reflect.get(target, k); return typeof v === 'function' ? v.bind(target) : v
    } }); return statement
  } as typeof Database.prototype.prepare)
  expect(execute(q.p, q.token)).toMatchObject({ phase: 'group_deleted', protection_released: false }); expect(fs.readFileSync(join(root, 'resources', key), 'utf8')).toBe('unchanged')
  vi.restoreAllMocks(); restart(); vi.useFakeTimers(); vi.advanceTimersByTime(1100); expect(execute(q.p, begin(), true).phase).toBe('released')
})
it('rejects arbitrary selectors, unknown operation and paths without exposing private material', () => {
  expect(() => store.handle({ type: 'maintenance.replica.preview', token: randomUUID(), inputs_saved: true, replica_id: '../trellis.sqlite' })).toThrow()
  expect(() => result(randomUUID())).toThrow(); expect(control().version).toBe(process.platform === 'win32' && process.env.TRELLIS_TEST_FILE_IDENTITIES === 'decimal-v2' ? 6 : 5); expect(control().retirements).toEqual([])
})
it('new control format is rejected by the old strict version gate; v1 upgrades preserve selector and outcomes', () => {
  store.close(); const db = new Database(join(root, 'restore-control.sqlite')); db.prepare('UPDATE restore_control SET manifest=?').run(JSON.stringify({ version: 1, selected: 'trellis.sqlite', deleted_tasks: [], operations: [] })); db.close(); fs.writeFileSync(join(root, 'restore-established'), 'restore-v2\n'); restart()
  expect(control()).toMatchObject({ version: 5, selected: 'trellis.sqlite', operations: [], deleted_tasks: [], retirements: [] }); expect([1, 2, 3].includes(control().version)).toBe(false)
})
it('keeps other replica staging protection, releases only deleted replica, and requires a fresh staging confirmation', async () => {
  const db = new Database(join(root, 'trellis.sqlite')), key = randomUUID(), owner = randomUUID(), stage = randomUUID()
  db.prepare("INSERT INTO actions (id,task_id,kind,state,result,source_json,request_json,commit_valid,created_at) VALUES (?,?,'mutation','ended','not_executed','{}','{}',0,'now')").run(owner, task)
  db.prepare("INSERT INTO staging (id,task_id,owner_kind,owner_id,runtime_epoch,state,storage_key,expected_bytes,sha256,created_at) VALUES (?,?,'action',?,'old','invalid',?,8,?,'now')").run(stage, task, owner, key, digest(Buffer.from('original')))
  fs.writeFileSync(join(root, 'resources', key), 'original'); db.close()
  const first = (await point()).active, second = (await point()).active
  const current = new Database(join(root, 'trellis.sqlite')); current.prepare('DELETE FROM staging WHERE id=?').run(stage); await point()
  current.prepare("INSERT INTO staging (id,task_id,owner_kind,owner_id,runtime_epoch,state,storage_key,expected_bytes,sha256,created_at) VALUES (?,?,'action',?,'old','invalid',?,8,?,'now')").run(stage, task, owner, key, digest(Buffer.from('original'))); current.close()
  let t = begin(), old = store.handle({ type: 'maintenance.gc.preview', token: t, inputs_saved: true }) as any; expect(old.items).toEqual([]); cancel(t)
  for (const [i, p] of [first, second].entries()) {
    const q = prepare('recovery/' + p.id + '.sqlite'); expect(execute(q.p, q.token).phase).toBe('released'); expect(fs.existsSync(join(root, 'resources', key))).toBe(true)
    t = begin(); old = store.handle({ type: 'maintenance.gc.preview', token: t, inputs_saved: true }) as any; expect(old.items).toHaveLength(i === 0 ? 0 : 1); cancel(t)
  }
  t = begin(); expect(() => store.handle({ type: 'maintenance.gc.execute', token: t, operation_id: old.id, inputs_saved: true, confirm_delete_orphans: true })).toThrow()
  const fresh = begin(), p = store.handle({ type: 'maintenance.gc.preview', token: fresh, inputs_saved: true }) as any
  store.handle({ type: 'maintenance.gc.execute', token: fresh, operation_id: p.id, inputs_saved: true, confirm_delete_orphans: true }); expect(fs.existsSync(join(root, 'resources', key))).toBe(false)
})
it.each(['intent', 'deleted', 'group_deleted'])('keeps pins on durable record failure at %s and retries only original group', async phase => {
  resource(); const file = await obsolete(), q = prepare(file), original = Database.prototype.prepare
  vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql: string) {
    const statement = original.call(this, sql)
    if (this.name.endsWith('restore-control.sqlite') && sql.startsWith('UPDATE restore_control SET manifest=')) return new Proxy(statement, { get(target, k) {
      if (k === 'run') return (manifest: string) => { const r = JSON.parse(manifest).retirements.find((r: any) => r.id === q.p.id); if (r && (phase === 'intent' ? r.members[0].state === 'deleting' : phase === 'deleted' ? r.members[0].state === 'deleted' : r.phase === 'group_deleted')) throw Object.assign(new Error('fault'), { code: 'EIO' }); return target.run(manifest) }
      const v = Reflect.get(target, k); return typeof v === 'function' ? v.bind(target) : v
    } }); return statement
  } as typeof Database.prototype.prepare)
  expect(execute(q.p, q.token)).toMatchObject({ phase: 'retired', protection_released: false }); vi.restoreAllMocks(); restart()
  vi.useFakeTimers(); vi.advanceTimersByTime(1100); expect(execute(q.p, begin(), true).phase).toBe('released')
})
it('keeps protection if directory flush fails after unlink and does not silently resume on startup', async () => {
  const file = await obsolete(), q = prepare(file), original = fs.fsyncSync; let unlinked = false
  const unlink = fs.unlinkSync; vi.spyOn(fs, 'unlinkSync').mockImplementation(path => { unlink(path); unlinked = true })
  vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => { if (unlinked) throw Object.assign(new Error('fault'), { code: 'EIO' }); original(fd) })
  expect(execute(q.p, q.token)).toMatchObject({ phase: 'retired', protection_released: false }); vi.restoreAllMocks(); const files = fs.readdirSync(join(root, 'recovery')); restart(); expect(fs.readdirSync(join(root, 'recovery'))).toEqual(files)
  vi.useFakeTimers(); vi.advanceTimersByTime(1100); expect(execute(q.p, begin(), true).phase).toBe('released')
})
it('preserves original four-attempt budget and never replaces it with a fresh retirement', async () => {
  const file = await obsolete(), q = prepare(file); vi.useFakeTimers()
  vi.spyOn(fs, 'unlinkSync').mockImplementation(() => { throw Object.assign(new Error('fault'), { code: 'EBUSY' }) })
  expect(execute(q.p, q.token).attempt).toBe(1)
  for (const [i, ms] of [1001, 5001, 15001].entries()) { vi.advanceTimersByTime(ms); expect(execute(q.p, begin(), true).attempt).toBe(i + 2) }
  vi.restoreAllMocks(); restart(); expect(execute(q.p, begin(), true)).toMatchObject({ phase: 'retired', attempt: 4, protection_released: false })
  const t = begin(); expect(() => preview(digest(Buffer.from(file)), t)).toThrow(); cancel(t); expect(fs.existsSync(join(root, file))).toBe(true)
})
it('rejects missing established control without creating replacement or resetting retirement', async () => {
  const file = await obsolete(), q = prepare(file); execute(q.p, q.token); store.close(); fs.unlinkSync(join(root, 'restore-control.sqlite'))
  expect(() => new RuntimeStore(root)).toThrow(); expect(fs.existsSync(join(root, 'restore-control.sqlite'))).toBe(false)
})
it('blocks GC on a file that reappears after fully released group instead of silently accepting it', async () => {
  const file = await obsolete(), q = prepare(file), bytes = fs.readFileSync(join(root, file)); expect(execute(q.p, q.token).phase).toBe('released')
  fs.writeFileSync(join(root, file), bytes); const t = begin(); expect(() => store.handle({ type: 'maintenance.gc.preview', token: t, inputs_saved: true })).toThrow(); cancel(t); expect(fs.readFileSync(join(root, file))).toEqual(bytes)
})
it('does not retire a readable private fallback with changed sealed content', async () => {
  await point(); await restore(); restart(); const file = control().operations[0].rollback.file, db = new Database(join(root, file)); db.prepare("UPDATE tasks SET title='changed sealed copy'").run(); db.close()
  const t = begin(); expect(() => preview(digest(Buffer.from(file)), t)).toThrow(); cancel(t); expect(fs.existsSync(join(root, file))).toBe(true)
})
it('refuses obsolete backup with missing embedded complete manifest even though SQLite remains readable', async () => {
  const file = await obsolete(), db = new Database(join(root, file)); db.prepare("UPDATE recovery_points SET manifest_json='{}'").run(); db.close()
  const t = begin(); expect(() => preview(digest(Buffer.from(file)), t)).toThrow(); cancel(t); expect(fs.existsSync(join(root, file))).toBe(true)
})

it('retains protection for a dangling auxiliary link after retirement instead of treating it as absence', async () => {
  const file = await obsolete(), q = prepare(file)
  vi.spyOn(fs, 'unlinkSync').mockImplementation(() => { throw Object.assign(new Error('fault'), { code: 'EBUSY' }) }); execute(q.p, q.token); vi.restoreAllMocks()
  fs.symlinkSync(join(root, 'missing'), join(root, file + '-journal')); vi.useFakeTimers(); vi.advanceTimersByTime(1100)
  expect(execute(q.p, begin(), true)).toMatchObject({ phase: 'retired', protection_released: false, reason: 'REPLICA_NEW_GROUP_MEMBER' }); expect(fs.lstatSync(join(root, file + '-journal')).isSymbolicLink()).toBe(true)
})
