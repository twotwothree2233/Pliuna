import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { RuntimeStore } from '../../src/runtime/store'
import { digest } from '../../src/runtime/resources'
let root: string, store: RuntimeStore, db: Database.Database, taskId: string
const begin = (): string => (store.handle({ type: 'maintenance.begin' }) as any).reservation.token
const preview = (token = begin(), after = 0): any => store.handle({ type: 'maintenance.gc.preview', token, inputs_saved: true, after })
const execute = (p: any, token: string, retry = false): any => store.handle({ type: retry ? 'maintenance.gc.retry' : 'maintenance.gc.execute', token, operation_id: p.id, inputs_saved: true, confirm_delete_orphans: true })
const status = (id?: string): any => store.handle({ type: 'maintenance.gc.status', ...(id ? { operation_id: id } : {}) })
const cancel = (token: string) => store.handle({ type: 'maintenance.cancel', token })
const restart = () => { db.close(); store.close(); store = new RuntimeStore(root); const control = new Database(join(root, 'restore-control.sqlite')), selected = JSON.parse((control.prepare('SELECT manifest FROM restore_control').get() as any).manifest).selected; control.close(); db = new Database(join(root, selected)) }
beforeEach(() => { root = fs.mkdtempSync(join(tmpdir(), 'trellis-gc-')); store = new RuntimeStore(root); taskId = store.create('隔离回收').task.id; db = new Database(join(root, 'trellis.sqlite')) })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); db.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }) })
function seed(key = randomUUID(), temporary = true): any {
  const action = randomUUID(), stage = randomUUID()
  db.prepare("INSERT INTO actions (id,task_id,kind,state,result,source_json,request_json,commit_valid,created_at) VALUES (?,?,'mutation','ended','not_executed','{}','{}',0,?)").run(action, taskId, new Date().toISOString())
  db.prepare("INSERT INTO staging (id,task_id,owner_kind,owner_id,runtime_epoch,state,storage_key,expected_bytes,sha256,created_at) VALUES (?,?,'action',?,'old','invalid',?,8,?,?)").run(stage, taskId, action, key, digest(Buffer.from('original')), new Date().toISOString())
  fs.writeFileSync(join(root, 'resources', key), 'original'); if (temporary) fs.writeFileSync(join(root, 'resources', key + '.tmp'), 'part')
  return { key, stage, action }
}
const point = async (): Promise<any> => { const token = begin(); return store.handle({ type: 'maintenance.create', token, inputs_saved: true, replace_id: (store.handle({ type: 'maintenance.status' }) as any).active?.id ?? null }) }
it('deletes only explicitly confirmed registered orphan files, preserves business and independent result over restart', () => {
  const s = seed(), token = begin(), p = preview(token), before = db.prepare('SELECT * FROM actions').all()
  expect(p.items).toHaveLength(2); expect(fs.readdirSync(join(root, 'resources'))).toHaveLength(2)
  expect(execute(p, token)).toMatchObject({ phase: 'settled', files_deleted: 2, deleted_bytes: 12, database_files_deleted: 0, business_replayed: false })
  expect(db.prepare('SELECT * FROM actions').all()).toEqual(before); expect(db.prepare('SELECT state FROM staging').get()).toEqual({ state: 'invalid' })
  restart(); expect(status(p.id).last.files_deleted).toBe(2); expect(fs.existsSync(join(root, 'resources', s.key))).toBe(false)
  // Windows private DACLs are verified by protectPrivatePath, not POSIX mode bits.
  if (process.platform !== 'win32') expect(fs.statSync(join(root, 'gc-control.sqlite')).mode & 0o777).toBe(0o600)
})
it('cancels without deleting and rejects expired or rebound preview confirmations', () => {
  seed(); const token = begin(), p = preview(token); cancel(token)
  const next = begin(); expect(() => execute(p, next)).toThrow()
  vi.useFakeTimers(); const expired = begin(), q = preview(expired); vi.advanceTimersByTime(60001); expect(() => execute(q, expired)).toThrow(); expect(fs.readdirSync(join(root, 'resources'))).toHaveLength(2)
})
it.each(['inputs_saved', 'confirm_delete_orphans', 'token', 'operation_id'])('rejects missing confirmation %s before deletion', field => {
  seed(); const token = begin(), p = preview(token), request: any = { type: 'maintenance.gc.execute', token, operation_id: p.id, inputs_saved: true, confirm_delete_orphans: true }; delete request[field]
  expect(() => store.handle(request)).toThrow(); cancel(token); expect(fs.readdirSync(join(root, 'resources'))).toHaveLength(2)
})
it('rejects arbitrary paths and never scans unregistered resource files', () => {
  fs.writeFileSync(join(root, 'resources', 'unregistered'), 'keep'); seed(); const token = begin()
  expect(() => store.handle({ type: 'maintenance.gc.preview', token, inputs_saved: true, path: '../' })).toThrow()
  execute(preview(token), token); expect(fs.readdirSync(join(root, 'resources'))).toEqual(['unregistered'])
})
it.each(['success', 'unknown', 'live', 'missing', 'committed', 'duplicate', 'resource', 'history', 'reference', 'recovery-projection'])('keeps protected or uncertain staging: %s', mode => {
  const s = seed()
  if (['success', 'unknown'].includes(mode)) db.prepare('UPDATE actions SET result=?').run(mode)
  if (mode === 'live') db.prepare('UPDATE actions SET commit_valid=1').run()
  if (mode === 'missing') db.prepare("UPDATE staging SET owner_id='missing'").run()
  if (mode === 'committed') db.prepare("UPDATE staging SET state='committed'").run()
  if (mode === 'duplicate') { const row = db.prepare('SELECT * FROM staging').get() as any; row.id = randomUUID(); db.prepare('INSERT INTO staging VALUES (@id,@task_id,@owner_kind,@owner_id,@runtime_epoch,@state,@storage_key,@resource_id,@expected_bytes,@received_bytes,@sha256,@created_at)').run(row) }
  if (['resource', 'history', 'recovery-projection'].includes(mode)) db.prepare('INSERT INTO resources VALUES (?,?,?,?,?,?,?)').run(s.key, s.key, digest(Buffer.from('original')), 8, 'text/plain; charset=utf-8', 'keep', new Date().toISOString())
  if (mode === 'history') db.prepare("INSERT INTO view_history VALUES ('h',?,'v',1,?,'{}')").run(taskId, s.key)
  if (mode === 'reference') db.prepare("INSERT INTO object_references VALUES (?,?,'task_data','source','resource',?,NULL,1,0)").run(taskId, randomUUID(), s.key)
  if (mode === 'recovery-projection') { db.prepare("INSERT INTO recovery_points VALUES ('p','candidate','{}','now')").run(); db.prepare("INSERT INTO recovery_resources VALUES ('p',?)").run(s.key) }
  const token = begin(), p = preview(token); expect(p.items).toEqual([]); execute(p, token); expect(fs.existsSync(join(root, 'resources', s.key))).toBe(true)
})
it('rechecks new formal protection after preview and does not delete either file', () => {
  const s = seed(), token = begin(), p = preview(token)
  db.prepare('INSERT INTO resources VALUES (?,?,?,?,?,?,?)').run(s.key, s.key, digest(Buffer.from('original')), 8, 'text/plain', 'keep', new Date().toISOString())
  const result = execute(p, token); expect(result.files_deleted).toBe(0); expect(result.items.every((i: any) => i.state === 'skipped')).toBe(true)
})
it.each(['replace', 'symlink', 'hardlink', 'corrupt', 'directory'])('rejects changed or unsafe files: %s', mode => {
  const s = seed(undefined, false), file = join(root, 'resources', s.key), token = begin(), p = preview(token)
  if (['replace', 'symlink', 'directory'].includes(mode)) fs.unlinkSync(file)
  if (mode === 'replace') fs.writeFileSync(file, 'original')
  if (mode === 'symlink') { const outside = join(root, 'outside'); fs.writeFileSync(outside, 'original'); fs.symlinkSync(outside, file) }
  if (mode === 'hardlink') fs.linkSync(file, join(root, 'other'))
  if (mode === 'directory') fs.mkdirSync(file)
  if (mode === 'corrupt') fs.writeFileSync(file, 'modified')
  expect(execute(p, token).files_deleted).toBe(0); expect(fs.lstatSync(file)).toBeTruthy()
})
it('does not estimate partial or damaged final files as verified garbage', () => {
  const s = seed(); fs.writeFileSync(join(root, 'resources', s.key), 'broken'); const token = begin(), p = preview(token)
  expect(p.reviews).toBe(1); expect(p.items).toHaveLength(1); expect(p.items[0].temporary).toBe(true); execute(p, token); expect(fs.readFileSync(join(root, 'resources', s.key), 'utf8')).toBe('broken')
})
it('treats already missing files as absent, never counts them as newly deleted', () => {
  const s = seed(), token = begin(), p = preview(token); fs.unlinkSync(join(root, 'resources', s.key)); fs.unlinkSync(join(root, 'resources', s.key + '.tmp'))
  expect(execute(p, token)).toMatchObject({ files_deleted: 0, deleted_bytes: 0 }); expect(status(p.id).last.items.every((i: any) => i.state === 'absent')).toBe(true)
})
it.each(['EACCES', 'EBUSY', 'EIO'])('records bounded manual retry %s and does not silently resume on restart', code => {
  seed(undefined, false); vi.useFakeTimers(); const original = fs.unlinkSync, token = begin(), p = preview(token)
  vi.spyOn(fs, 'unlinkSync').mockImplementation(() => { throw Object.assign(new Error('private'), { code }) })
  expect(execute(p, token).items[0]).toMatchObject({ state: 'failed', attempt: 1, reason: code })
  vi.restoreAllMocks(); restart(); expect(fs.readdirSync(join(root, 'resources'))).toHaveLength(1)
  const early = begin(); expect(execute(p, early, true).files_deleted).toBe(0)
  vi.advanceTimersByTime(1001); const retry = begin(); expect(execute(p, retry, true).files_deleted).toBe(1); expect(original).toBeTruthy()
})
it('never renews exhausted retries or resets their deadline on restart', () => {
  seed(undefined, false); vi.useFakeTimers(); const token = begin(), p = preview(token)
  vi.spyOn(fs, 'unlinkSync').mockImplementation(() => { throw Object.assign(new Error('fault'), { code: 'EIO' }) })
  execute(p, token)
  for (const delay of [1001, 5001, 15001]) { vi.advanceTimersByTime(delay); execute(p, begin(), true) }
  expect(status(p.id).last.items[0]).toMatchObject({ state: 'failed', attempt: 4, next_retry_at: null }); vi.restoreAllMocks(); restart(); expect(execute(p, begin(), true).files_deleted).toBe(0)
})
it('does not unlink if delete-intent registration fails', () => {
  seed(); const token = begin(), p = preview(token), original = Database.prototype.prepare
  vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql: string) {
    if (this.name.endsWith('gc-control.sqlite') && sql.startsWith('INSERT INTO gc_operations')) throw new Error('EIO'); return original.call(this, sql)
  })
  expect(() => execute(p, token)).toThrow(); expect(fs.readdirSync(join(root, 'resources'))).toHaveLength(2); expect(status().enabled).toBe(false)
})
it('holds all ordinary writes and the maintenance lease until the bounded batch settles', () => {
  seed(undefined, false); const token = begin(), p = preview(token), unlink = fs.unlinkSync
  vi.spyOn(fs, 'unlinkSync').mockImplementation(file => { expect(() => store.create('late')).toThrow(/Maintenance/); expect(() => cancel(token)).toThrow(); expect((store.handle({ type: 'maintenance.status' }) as any).phase).toBe('collecting'); unlink(file) })
  execute(p, token); expect(store.create('after')).toBeTruthy()
})
it('bounds each preview to 50 staging and binds the next batch without directory sweeps', () => {
  for (let i = 0; i < 51; i++) seed(undefined, false)
  const token = begin(), p = preview(token); expect(p.items).toHaveLength(50); expect(p.next_after).not.toBeNull(); execute(p, token)
  const next = begin(), q = preview(next, p.next_after); expect(q.items).toHaveLength(1); expect(q.next_after).toBeNull(); execute(q, next)
})
it('keeps effective and retired recovery snapshots with their staging even when current staging appears orphaned', async () => {
  const s = seed(); const old = (await point()).active; await point(); const token = begin(), p = preview(token)
  expect(p.items).toEqual([]); execute(p, token); expect(fs.existsSync(join(root, 'resources', s.key))).toBe(true); expect(fs.existsSync(join(root, 'recovery', old.id + '.sqlite'))).toBe(true)
})
it('keeps pre-restore generation staging and every database and rollback image', async () => {
  await point(); const s = seed(); const state = store.handle({ type: 'maintenance.status' }) as any, token = begin()
  await store.handle({ type: 'maintenance.restore', token, point_id: state.active.id, database_sha256: state.active.database_sha256, inputs_saved: true, confirm_replace_newer_data: true })
  restart()
  // Recreate the old orphan declaration in the restored current database; old generation still protects it.
  const original = new Database(join(root, 'trellis.sqlite')), row = original.prepare('SELECT * FROM staging WHERE id=?').get(s.stage) as any, action = original.prepare('SELECT * FROM actions WHERE id=?').get(s.action) as any; original.close()
  db.prepare(`INSERT INTO actions (${Object.keys(action).join(',')}) VALUES (${Object.keys(action).map(k => '@' + k).join(',')})`).run(action)
  db.prepare('INSERT INTO staging VALUES (@id,@task_id,@owner_kind,@owner_id,@runtime_epoch,@state,@storage_key,@resource_id,@expected_bytes,@received_bytes,@sha256,@created_at)').run(row)
  const files = fs.readdirSync(root).filter(f => f.endsWith('.sqlite')).map(file => ({ file, hash: digest(fs.readFileSync(join(root, file))) })), prep = begin(), p = preview(prep); expect(p.items).toEqual([]); execute(p, prep); expect(fs.existsSync(join(root, 'resources', s.key))).toBe(true)
  for (const { file, hash } of files) { expect(fs.existsSync(join(root, file))).toBe(true); if (file.startsWith('restore-') && file !== 'restore-control.sqlite') expect(digest(fs.readFileSync(join(root, file)))).toBe(hash) }
})
it('fails closed for damaged retained backups and unrecognized generation databases', async () => {
  seed(); const p = (await point()).active; fs.writeFileSync(join(root, 'recovery', p.id + '.sqlite'), 'damaged'); const token = begin(); expect(() => preview(token)).toThrow(); cancel(token)
  fs.writeFileSync(join(root, 'restore-unrecognized-target.sqlite'), 'unknown'); const next = begin(); expect(() => preview(next)).toThrow(); cancel(next); expect(fs.readdirSync(join(root, 'resources'))).toHaveLength(2)
})
it.each(['corrupt', 'missing', 'version'])('closes GC on invalid independent control: %s', mode => {
  seed(); store.close(); db.close()
  if (mode === 'corrupt') fs.writeFileSync(join(root, 'gc-control.sqlite'), 'bad')
  if (mode === 'missing') fs.unlinkSync(join(root, 'gc-control.sqlite'))
  if (mode === 'version') { const control = new Database(join(root, 'gc-control.sqlite')); control.prepare('UPDATE gc_version SET version=97').run(); control.close() }
  store = new RuntimeStore(root); db = new Database(join(root, 'trellis.sqlite')); expect(status()).toMatchObject({ enabled: false, error: 'GC_CONTROL_INVALID' }); expect(store.create('safe business')).toBeTruthy(); expect(fs.readdirSync(join(root, 'resources'))).toHaveLength(2)
})
it('does not let a new preview reset the original failure budget and allows paged original-result lookup', () => {
  seed(undefined, false); const token = begin(), p = preview(token)
  vi.spyOn(fs, 'unlinkSync').mockImplementation(() => { throw Object.assign(new Error('fault'), { code: 'EIO' }) }); execute(p, token); vi.restoreAllMocks()
  for (let i = 0; i < 21; i++) { const next = begin(), q = preview(next); expect(q.items).toEqual([]); cancel(next) }
  const first = store.handle({ type: 'maintenance.gc.list' }) as any; expect(first.items).toHaveLength(20); expect(first.next_before).not.toBeNull()
  const rest = store.handle({ type: 'maintenance.gc.list', before: first.next_before }) as any; expect(rest.items.map((op: any) => op.id)).toContain(p.id); expect(status(p.id).last.items[0].attempt).toBe(1)
})
it('keeps independent GC results through old-data restoration and stale current cleanup projections', async () => {
  const old = (await point()).active, s = seed(), token = begin(), p = preview(token); execute(p, token)
  const restoreToken = begin(); await store.handle({ type: 'maintenance.restore', token: restoreToken, point_id: old.id, database_sha256: old.database_sha256, inputs_saved: true, confirm_replace_newer_data: true }); restart()
  expect(status(p.id).last).toMatchObject({ files_deleted: 2, phase: 'settled' }); expect(fs.existsSync(join(root, 'resources', s.key))).toBe(false)
  expect(store.snapshot(taskId).runs).toEqual([]); expect(db.prepare('SELECT * FROM staging').all()).toEqual([])
})
it.each(['target', 'rollback', 'point', 'distinct-key'])('keeps independent %s resource protection absent from current resources', mode => {
  const s = seed(), token = begin(), p = preview(token)
  // Add independent authority after preview without creating a formal current resource row.
  if (mode === 'point') {
    const control = new Database(join(root, 'recovery-control.sqlite')), state = JSON.parse((control.prepare('SELECT manifest FROM control').get() as any).manifest)
    state.candidates.push({ id: randomUUID(), created_at: new Date().toISOString(), app_version: '0.1.0', schema_version: 1, tasks: [taskId], resources: [{ id: s.key, storage_key: s.key, sha256: digest(Buffer.from('original')), byte_length: 8 }], plugins: [], settings: {} })
    control.prepare('UPDATE control SET manifest=?').run(JSON.stringify(state)); control.close(); cancel(token); restart()
    const next = begin(); expect(() => preview(next)).toThrow(); cancel(next); expect(fs.existsSync(join(root, 'resources', s.key))).toBe(true)
  } else {
    const control = new Database(join(root, 'restore-control.sqlite')), state = JSON.parse((control.prepare('SELECT manifest FROM restore_control').get() as any).manifest), id = randomUUID()
    const material = { id: mode === 'distinct-key' ? randomUUID() : s.key, storage_key: s.key, sha256: digest(Buffer.from('original')), byte_length: 8 }
    state.operations.push({ id, token: randomUUID(), point_id: randomUUID(), previous: 'trellis.sqlite', phase: 'rolled_back', created_at: new Date().toISOString(), target: { file: `restore-${id}-target.sqlite`, tasks: [taskId], resources: ['target', 'distinct-key'].includes(mode) ? [material] : [], plugins: [] }, rollback: { file: `restore-${id}-rollback.sqlite`, tasks: [taskId], resources: mode === 'rollback' ? [material] : [], plugins: [] } })
    control.prepare('UPDATE restore_control SET manifest=?').run(JSON.stringify(state)); control.close(); cancel(token); restart()
    const next = begin(), q = preview(next); expect(q.items).toEqual([]); execute(q, next); expect(fs.existsSync(join(root, 'resources', s.key))).toBe(true)
  }
})
it('releases no recovery protection when a retired snapshot has gone missing', async () => {
  seed(); const old = (await point()).active; await point(); fs.unlinkSync(join(root, 'recovery', old.id + '.sqlite'))
  const token = begin(); expect(() => preview(token)).toThrow(); cancel(token); expect(fs.readdirSync(join(root, 'resources'))).toHaveLength(2)
})
it('keeps stage content and no deletion authority when preview registration runs out of space', () => {
  seed(); const token = begin(), original = Database.prototype.prepare
  vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql: string) { if (this.name.endsWith('gc-control.sqlite') && sql.startsWith('INSERT INTO gc_operations')) throw Object.assign(new Error('fault'), { code: 'ENOSPC' }); return original.call(this, sql) })
  expect(() => preview(token)).toThrow(); cancel(token); expect(fs.readdirSync(join(root, 'resources'))).toHaveLength(2)
})
it('reconciles deletion with lost result registration as absence rather than claiming reclaimed bytes', () => {
  seed(undefined, false); const token = begin(), p = preview(token), original = Database.prototype.prepare
  vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql: string) {
    const statement = original.call(this, sql)
    if (this.name.endsWith('gc-control.sqlite') && sql.startsWith('INSERT INTO gc_operations')) return new Proxy(statement, { get(target, key) {
      if (key === 'run') return (...args: any[]) => { if (JSON.parse(args[1]).items[0]?.state === 'deleted') throw new Error('result write fault'); return (target.run as (...args: any[]) => any)(...args) }
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
    } })
    return statement
  } as typeof Database.prototype.prepare)
  expect(() => execute(p, token)).toThrow(); expect(status().enabled).toBe(false); expect(fs.readdirSync(join(root, 'resources'))).toEqual([])
  vi.restoreAllMocks(); restart(); expect(status(p.id).last).toMatchObject({ phase: 'settled', files_deleted: 0, deleted_bytes: 0 }); expect(status(p.id).last.items[0].state).toBe('absent')
})
it('blocks GC while an execution, model operation or necessary cleanup is active', () => {
  seed(); vi.useFakeTimers(); const run = store.start(taskId, 'held', 'fixture', []); expect(() => begin()).toThrow(); store.handle({ type: 'run.cancel', task_id: taskId, run_id: run }); vi.useRealTimers()
  const busy = vi.spyOn(store.models, 'busy').mockReturnValue(true); expect(() => begin()).toThrow(); busy.mockRestore()
  db.prepare("INSERT INTO cleanup_jobs VALUES ('necessary',?,'call','unknown',1,'failed',0,NULL,'{}')").run(taskId); expect(() => begin()).toThrow(); expect(fs.readdirSync(join(root, 'resources'))).toHaveLength(2)
})
it('rejects overlapping old previews rather than renewing the confirmed original failure budget', () => {
  seed(undefined, false); const token = begin(), p = preview(token), q = preview(token)
  vi.spyOn(fs, 'unlinkSync').mockImplementation(() => { throw Object.assign(new Error('fault'), { code: 'EIO' }) }); execute(p, token); vi.restoreAllMocks()
  // Bind the second pre-existing preview to a new valid preparation for the overlap boundary test.
  const next = begin(), control = new Database(join(root, 'gc-control.sqlite')), op = JSON.parse((control.prepare('SELECT manifest FROM gc_operations WHERE id=?').get(q.id) as any).manifest); op.token = next; control.prepare('UPDATE gc_operations SET manifest=? WHERE id=?').run(JSON.stringify(op), q.id); control.close()
  const result = execute(q, next); expect(result.files_deleted).toBe(0); expect(result.items[0]).toMatchObject({ state: 'skipped', reason: 'ORIGINAL_OPERATION_OWNS_FILE', attempt: 0 }); expect(status(p.id).last.items[0].attempt).toBe(1)
  vi.useFakeTimers(); vi.advanceTimersByTime(1001); expect(execute(p, begin(), true).files_deleted).toBe(1)
})
it('reports nonexistent original IDs without disabling valid GC or creating an operation', () => {
  expect(() => status(randomUUID())).toThrow(); expect(status()).toMatchObject({ enabled: true, last: null })
  expect((store.handle({ type: 'maintenance.gc.list' }) as any).items).toEqual([])
})
