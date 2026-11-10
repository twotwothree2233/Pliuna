import { afterEach,beforeEach,expect,it,vi } from 'vitest'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { newTestIdentityEncoding } from '../../src/runtime/file-format'
import { ExportControl } from '../../src/runtime/export-control'
import { RuntimeStore } from '../../src/runtime/store'
import { inspectStorage } from '../../src/runtime/storage-inspection'
import { digest } from '../../src/runtime/resources'
import * as permissions from '../../src/platform/permissions'

// Exercise Windows creation policy on every CI host without changing OS I/O.
vi.mock('../../src/runtime/file-format', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/runtime/file-format')>()
  return { newTestIdentityEncoding: (root: string, env = process.env, platform = 'win32') => original.newTestIdentityEncoding(root, env, platform) }
})
const roots: string[] = [], opened: { close(): void }[] = []
const root = () => { const r = fs.mkdtempSync(join(tmpdir(), 'trellis-format-')); roots.push(r); return r }
const keep = <T extends { close(): void }>(value: T): T => { opened.push(value); return value }
function read(r: string): any { const db = new Database(join(r, 'restore-control.sqlite'), { readonly: true }); try { return JSON.parse((db.prepare('SELECT manifest FROM restore_control').get() as any).manifest) } finally { db.close() } }
function edit(r: string, update: (value: any) => void): void { const db = new Database(join(r, 'restore-control.sqlite')); try { const v = read(r); update(v); db.prepare('UPDATE restore_control SET manifest=?').run(JSON.stringify(v)) } finally { db.close() } }
beforeEach(() => { vi.stubEnv('TRELLIS_TEST_FILE_IDENTITIES', 'decimal-v2') })
afterEach(() => { opened.splice(0).reverse().forEach(c => c.close()); vi.restoreAllMocks(); vi.unstubAllEnvs(); roots.splice(0).forEach(r => fs.rmSync(r, { recursive: true, force: true })) })
function largeNativeIds(): void {
  // Business format fixtures use a virtual identity namespace. A real Win32
  // handle must still receive its real lstat identity, never the synthetic ID.
  let permissionBoundary = false
  const protect = permissions.protectPrivatePath
  vi.spyOn(permissions, 'protectPrivatePath').mockImplementation((...args) => {
    permissionBoundary = true
    try { return protect(...args) } finally { permissionBoundary = false }
  })
  for (const name of ['lstatSync', 'statSync', 'fstatSync'] as const) {
    const original = fs[name]
    vi.spyOn(fs, name).mockImplementation(((...args: unknown[]) => {
      const stat = Reflect.apply(original, fs, args) as fs.Stats | fs.BigIntStats
      return !permissionBoundary && typeof stat.ino === 'bigint' ? Object.assign(Object.create(stat), { ino: stat.ino + 9007199254740992n }) : stat
    }))
  }
}

it('requires explicit Windows test opt-in and a fresh managed directory', () => {
  const r = root()
  expect(newTestIdentityEncoding(r, {}, 'win32')).toBe(1)
  expect(newTestIdentityEncoding(r, process.env, 'darwin')).toBe(1)
  expect(newTestIdentityEncoding(r, process.env, 'linux')).toBe(1)
  expect(newTestIdentityEncoding(r)).toBe(2)
  fs.mkdirSync(join(r, 'browser-state')); fs.writeFileSync(join(r, 'browser-state', 'electron-cache'), 'fixture')
  expect(newTestIdentityEncoding(r)).toBe(2)
  fs.mkdirSync(join(r, 'cache')); fs.writeFileSync(join(r, 'cache', 'model-directory.json'), '{}')
  expect(newTestIdentityEncoding(r)).toBe(1)
})
it.each(['trellis.sqlite', 'restore-control.sqlite-wal', 'restore-established', 'gc-established', 'settings.json', 'auth.json', 'unknown-profile'])('does not opt an existing %s directory into the new format', file => {
  const r = root(); fs.writeFileSync(join(r, file), 'retained')
  expect(newTestIdentityEncoding(r)).toBe(1)
})
it('creates v6/v2 controls only for a fresh test root, and restarts without an opt-in', async () => {
  const r = root(), store = keep(new RuntimeStore(r)), task = store.create('fresh exact test').task.id
  expect(read(r)).toMatchObject({ version: 6, export_control: 2 })
  expect(fs.readFileSync(join(r, 'restore-established'), 'utf8')).toBe('restore-v6\n')
  expect(fs.readFileSync(join(r, 'gc-established'), 'utf8')).toBe('gc-v2\n')
  const result = await inspectStorage(r, { scope: 'growth' }, () => {})
  expect(result).toMatchObject({ complete: true, controls: { format: 6, exports: { format: 2 } } })
  store.close(); vi.stubEnv('TRELLIS_TEST_FILE_IDENTITIES', '')
  const restarted = keep(new RuntimeStore(r)); expect(restarted.snapshot(task).task.title).toBe('fresh exact test')
  expect(read(r).version).toBe(6)
})
it('retains an existing v5/v1 profile when Windows test opt-in is added', () => {
  const r = root(); vi.stubEnv('TRELLIS_TEST_FILE_IDENTITIES', '')
  const first = keep(new RuntimeStore(r)); first.create('legacy'); first.close()
  const before = read(r); vi.stubEnv('TRELLIS_TEST_FILE_IDENTITIES', 'decimal-v2')
  const restarted = keep(new RuntimeStore(r)); expect(restarted.tasks()).toHaveLength(1)
  expect(read(r)).toEqual(before)
  expect(fs.readFileSync(join(r, 'restore-established'), 'utf8')).toBe('restore-v5\n')
  expect(fs.readFileSync(join(r, 'gc-established'), 'utf8')).toBe('gc-v1\n')
})
it('round trips exact export identity, while a safe legacy job keeps its own version', () => {
  const r = root(), control = keep(new ExportControl(r, false, false, 2))
  const job = control.create(randomUUID(), randomUUID(), 'trellis.sqlite', [], {})
  control.preview(job.id, '<p>fixture</p>', []); control.beginSave(job.id, join(r, 'result.html'), join(r, 'output.tmp'), false)
  control.created(job.id, { dev: 2695480082n, ino: 9007199256376705n }); control.close()
  const reopened = keep(new ExportControl(r, true))
  expect(reopened.get(job.id)).toMatchObject({ version: 2, phase: 'unknown', destination: { identity: { dev: '2695480082', ino: '9007199256376705' } } })
  reopened.close()
  const db = new Database(join(r, 'export-control.sqlite')), legacy = { ...job, version: 1, phase: 'saved', destination: { target: join(r, 'legacy.html'), temporary: join(r, 'legacy.tmp'), identity: { dev: 1, ino: 2 } } }
  db.prepare('UPDATE export_jobs SET phase=?,manifest=? WHERE id=?').run('saved', JSON.stringify(legacy), job.id); db.close()
  const mixed = keep(new ExportControl(r, true)); expect(mixed.get(job.id)).toEqual(legacy)
})
it.each(['marker', 'export', 'gc', 'unknown'])('rejects %s version mismatch without rewriting retained controls', async mode => {
  const r = root(), store = keep(new RuntimeStore(r)); store.close()
  if (mode === 'marker') fs.writeFileSync(join(r, 'restore-established'), 'restore-v5\n')
  if (mode === 'unknown') edit(r, v => { v.version = 97 })
  if (mode === 'export' || mode === 'gc') {
    const name = mode === 'export' ? 'export' : 'gc', db = new Database(join(r, name + '-control.sqlite'))
    db.prepare(`UPDATE ${name}_version SET version=1`).run(); db.close()
  }
  const before = fs.readFileSync(join(r, 'restore-control.sqlite'))
  if (mode === 'gc') { const reopened = keep(new RuntimeStore(r)); expect((reopened.handle({ type: 'maintenance.status' }) as any).gc).toMatchObject({ enabled: false, error: 'GC_CONTROL_INVALID' }) }
  else expect(() => new RuntimeStore(r)).toThrow()
  expect(fs.readFileSync(join(r, 'restore-control.sqlite'))).toEqual(before)
  expect((await inspectStorage(r, { scope: 'growth' }, () => {})).complete).toBe(mode === 'marker')
})
it('rejects lossy legacy export identity and retains the stored record', () => {
  const r = root(), c = keep(new ExportControl(r, false, false, 1)), job = c.create(randomUUID(), randomUUID(), 'trellis.sqlite', [], {})
  c.cancel(job.id); c.close()
  const db = new Database(join(r, 'export-control.sqlite')), invalid = { ...job, phase: 'saved', destination: { target: join(r, 'retained.html'), temporary: join(r, 'retained.tmp'), identity: { dev: 2695480082, ino: 9007199256376704 } } }
  db.prepare('UPDATE export_jobs SET phase=?,manifest=? WHERE id=?').run('saved', JSON.stringify(invalid), job.id); db.close()
  const before = fs.readFileSync(join(r, 'export-control.sqlite'))
  expect(() => new ExportControl(r, true)).toThrow('Export state')
  expect(fs.readFileSync(join(r, 'export-control.sqlite'))).toEqual(before)
})
it('uses an exact v2 GC operation for real deletion and persists its result across restart', () => {
  largeNativeIds()
  const r = root(), store = keep(new RuntimeStore(r)), task = store.create('v2 GC').task.id, key = randomUUID(), action = randomUUID(), stage = randomUUID()
  const db = new Database(join(r, 'trellis.sqlite'))
  db.prepare("INSERT INTO actions (id,task_id,kind,state,result,source_json,request_json,commit_valid,created_at) VALUES (?,?,'mutation','ended','not_executed','{}','{}',0,'now')").run(action, task)
  db.prepare("INSERT INTO staging (id,task_id,owner_kind,owner_id,runtime_epoch,state,storage_key,expected_bytes,sha256,created_at) VALUES (?,?,'action',?,'old','invalid',?,8,?,'now')").run(stage, task, action, key, digest(Buffer.from('original'))); db.close()
  fs.writeFileSync(join(r, 'resources', key), 'original')
  const token = (store.handle({ type: 'maintenance.begin' }) as any).reservation.token
  const preview = store.handle({ type: 'maintenance.gc.preview', token, inputs_saved: true }) as any
  expect(preview.items).toHaveLength(1)
  const control = new Database(join(r, 'gc-control.sqlite'))
  const operation = JSON.parse((control.prepare('SELECT manifest FROM gc_operations').get() as any).manifest); control.close()
  expect(operation.version).toBe(2); expect(typeof operation.items[0].identity.ino).toBe('string')
  expect(BigInt(operation.items[0].identity.ino)).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER))
  expect(store.handle({ type: 'maintenance.gc.execute', token, operation_id: preview.id, inputs_saved: true, confirm_delete_orphans: true })).toMatchObject({ files_deleted: 1 })
  store.close(); const restarted = keep(new RuntimeStore(r))
  expect(restarted.handle({ type: 'maintenance.gc.status', operation_id: preview.id })).toMatchObject({ enabled: true, last: { files_deleted: 1 } })
  expect(fs.existsSync(join(r, 'resources', key))).toBe(false)
})
it('uses exact v2 cleanup authority and retains the completed record across restart', () => {
  largeNativeIds()
  const r = root(), store = keep(new RuntimeStore(r)), task = store.create('v2 cleanup').task.id, key = randomUUID()
  const db = new Database(join(r, 'trellis.sqlite'))
  db.prepare('INSERT INTO resources VALUES (?,?,?,?,?,?,?)').run(key, key, digest(Buffer.from('original')), 8, 'text/plain', 'fixture', 'now')
  db.prepare('INSERT INTO task_resources VALUES (?,?)').run(task, key); db.close(); fs.writeFileSync(join(r, 'resources', key), 'original')
  store.handle({ type: 'task.delete', task_id: task })
  const record = read(r).resource_cleanups[0], token = (store.handle({ type: 'maintenance.begin' }) as any).reservation.token
  store.handle({ type: 'maintenance.resource.preview', token, operation_id: record.id, inputs_saved: true })
  const saved = read(r).resource_cleanups[0]
  expect(saved.version).toBe(2); expect(BigInt(saved.preview.identity.ino)).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER))
  expect(store.handle({ type: 'maintenance.resource.execute', token, operation_id: record.id, inputs_saved: true, confirm_retire_resource: true })).toMatchObject({ phase: 'complete', files_deleted: 1 })
  store.close(); keep(new RuntimeStore(r))
  expect(read(r).resource_cleanups[0]).toMatchObject({ version: 2, phase: 'complete', identity: saved.preview.identity })
  expect(fs.existsSync(join(r, 'resources', key))).toBe(false)
})
