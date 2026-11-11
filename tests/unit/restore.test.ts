import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RuntimeStore } from '../../src/runtime/store'
import type { Snapshot } from '../../src/shared/types'
let root: string, store: RuntimeStore, task: Snapshot
const state = (): any => store.handle({ type: 'maintenance.status' })
const begin = (): string => (store.handle({ type: 'maintenance.begin' }) as any).reservation.token
const point = async (): Promise<any> => store.handle({ type: 'maintenance.create', token: begin(), inputs_saved: true, replace_id: state().active?.id ?? null })
const restore = (p = state().active, token = begin()): Promise<any> => store.handle({ type: 'maintenance.restore', token, point_id: p.id, database_sha256: p.database_sha256, inputs_saved: true, confirm_replace_newer_data: true }) as Promise<any>
const journal = (): any => { const db = new Database(join(root, 'restore-control.sqlite')); try { return JSON.parse((db.prepare('SELECT manifest FROM restore_control').get() as any).manifest) } finally { db.close() } }
const current = (): Database.Database => new Database(join(root, journal().selected))
const restart = () => { store.close(); store = new RuntimeStore(root) }
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pliuna-restore-')); store = new RuntimeStore(root, undefined, { viewReplacement: true }); task = store.create('原任务') })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); try { store.close() } catch {} rmSync(root, { recursive: true, force: true }) })
function resource(text = 'original'): string {
  vi.useFakeTimers(); const run = store.start(task.task.id, 'held', 'fixture', [])
  const value = store.modelTool(task.task.id, run, { type: 'write', input: { type: 'resource.create', display_name: '材料', content: { type: 'text', text } } }) as any
  store.handle({ type: 'run.cancel', task_id: task.task.id, run_id: run }); vi.useRealTimers(); return value.data.id
}
it('restores only the selected effective point, retains newer files and persists the selection after restart', async () => {
  const oldResource = resource(), old = (await point()).active
  const newer = store.create('恢复后不应显示的新任务'), newResource = resource('newer')
  const epoch = store.epoch, result = await restore()
  expect(result).toMatchObject({ phase: 'idle', last: { outcome: 'restored' }, restore: { last: { phase: 'completed' } }, gc_enabled: false, migration_enabled: false })
  expect(store.epoch).not.toBe(epoch); expect(store.tasks().map(t => t.id)).toEqual([task.task.id])
  expect(() => store.snapshot(newer.task.id)).toThrow(/not found/)
  const db = current(); expect(db.prepare('SELECT id FROM resources').all()).toEqual([{ id: oldResource }]); db.close()
  expect(readFileSync(join(root, 'resources', newResource), 'utf8')).toBe('newer')
  expect(journal().operations[0].rollback.resources.some((r: any) => r.id === newResource)).toBe(true)
  expect(state().active.id).toBe(old.id); restart(); expect(store.tasks()).toHaveLength(1); expect(state().restore.last.phase).toBe('completed')
  expect(store.create('恢复后新建')).toBeTruthy()
})
it('switches only after candidate and rollback validation while denying every ordinary write', async () => {
  await point(); const original = Database.prototype.backup
  vi.spyOn(Database.prototype, 'backup').mockImplementation(function (this: Database.Database, ...args: Parameters<typeof original>) {
    expect(state().phase).toBe('restoring'); expect(() => store.create('late')).toThrow(/Maintenance/)
    expect(() => store.handle({ type: 'maintenance.cancel', token: state().reservation.token })).toThrow(/cannot be cancelled/)
    expect(journal().operations).toHaveLength(1)
    return original.apply(this, args)
  })
  await restore(); expect(journal().operations[0]).toMatchObject({ phase: 'completed', target: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }, rollback: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } })
})
it.each(['confirm_replace_newer_data', 'inputs_saved', 'token', 'database_sha256', 'point_id'])('rejects restore without explicit bound confirmation: %s', async missing => {
  const p = (await point()).active, token = begin(), request: Record<string, unknown> = { type: 'maintenance.restore', token, point_id: p.id, database_sha256: p.database_sha256, inputs_saved: true, confirm_replace_newer_data: true }
  delete request[missing]; expect(() => store.handle(request)).toThrow(); expect(journal().operations).toEqual([]); store.handle({ type: 'maintenance.cancel', token })
})
it('rejects retired point IDs and mismatched hashes without changing either database', async () => {
  const old = (await point()).active, next = (await point()).active, token = begin()
  expect(() => restore(old, token)).toThrow(/personally confirm/)
  expect(() => restore({ ...next, database_sha256: '0'.repeat(64) }, token)).toThrow(/personally confirm/)
  expect(journal().operations).toEqual([]); store.handle({ type: 'maintenance.cancel', token })
})
it('preserves saved data when preparation is cancelled', async () => { await point(); const newer = store.create('保留'); const token = begin(); store.handle({ type: 'maintenance.cancel', token }); expect(store.snapshot(newer.task.id)).toBeTruthy(); expect(journal().operations).toEqual([]) })
it.each(['ENOSPC', 'EIO'])('keeps current data after backup failure: %s', async code => {
  await point(); const newer = store.create('保留'); vi.spyOn(Database.prototype, 'backup').mockRejectedValueOnce(Object.assign(new Error('fault'), { code }))
  await expect(restore()).rejects.toThrow(/failed/); expect(journal().selected).toBe('pliuna.sqlite'); expect(state().phase).toBe('blocked'); expect(store.snapshot(newer.task.id)).toBeTruthy()
  vi.restoreAllMocks(); restart(); expect(state().phase).toBe('idle'); expect(store.snapshot(newer.task.id)).toBeTruthy(); expect(state().restore.last.phase).toBe('rolled_back')
})
it('keeps current data after a damaged or missing referenced resource', async () => { const r = resource(); await point(); store.create('保留'); writeFileSync(join(root, 'resources', r), 'damaged'); await expect(restore()).rejects.toThrow(/failed/); expect(journal().selected).toBe('pliuna.sqlite'); expect(journal().operations).toEqual([]) })
it('keeps the active backup immutable, does not rename or remove the old WAL database', async () => {
  const p = (await point()).active, file = join(root, 'recovery', p.id + '.sqlite'), before = readFileSync(file)
  await restore(); expect(readFileSync(file)).toEqual(before); expect(readdirSync(root)).toContain('pliuna.sqlite')
  // Native Windows DACL verification is part of protection; mode bits are POSIX only.
  if (process.platform !== 'win32') for (const image of [journal().operations[0].target, journal().operations[0].rollback]) expect(statSync(join(root, image.file)).mode & 0o777).toBe(0o600)
})
it('rolls back to the verified newer state after selected target reopen fails', async () => {
  await point(); const newer = store.create('保留当前'), original = Database.prototype.pragma
  vi.spyOn(Database.prototype, 'pragma').mockImplementation(function (this: Database.Database, source: string, options?: any) {
    if (this.name.endsWith('-target.sqlite') && source === 'foreign_keys=ON') throw new Error('reopen fault')
    return original.call(this, source, options)
  })
  await expect(restore()).rejects.toThrow(/failed/); expect(journal().selected).toMatch(/rollback.sqlite$/); expect(journal().operations[0].phase).toBe('rolled_back')
  vi.restoreAllMocks(); restart(); expect(store.snapshot(newer.task.id)).toBeTruthy(); expect(state().phase).toBe('idle')
})
it('fails closed if projection cannot be rebuilt after switch and rollback', async () => {
  await point(); const original = Database.prototype.prepare
  vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql: string) { if (sql === "UPDATE recovery_points SET state='invalid'") throw new Error('projection fault'); return original.call(this, sql) })
  await expect(restore()).rejects.toThrow(/failed/); expect(state().phase).toBe('blocked'); expect(() => store.create('unsafe')).toThrow(/closed/)
  vi.restoreAllMocks(); restart(); expect(state().phase).toBe('idle')
})
it('keeps protection for newer candidates whose resources do not exist in the restored database', async () => {
  const old = (await point()).active, newer = resource('newer'), backup = Database.prototype.backup
  vi.spyOn(Database.prototype, 'backup').mockRejectedValueOnce(new Error('candidate failed')); await expect(point()).rejects.toThrow(); vi.restoreAllMocks(); restart()
  expect(state().active.id).toBe(old.id); expect(state().retained_candidates).toBe(1)
  await restore(); expect(state().retained_candidates).toBe(1)
  const db = current(); expect(db.prepare('SELECT id FROM resources WHERE id=?').get(newer)).toBeUndefined(); db.close()
  expect(readFileSync(join(root, 'resources', newer), 'utf8')).toBe('newer'); expect(backup).toBeTruthy()
  restart(); expect(state().phase).toBe('idle')
})
it('invalidated point and deleted task cannot be resurrected after restoration or a newer point', async () => {
  resource(); await point(); await restore()
  store.handle({ type: 'task.delete', task_id: task.task.id, invalidate_recovery_id: state().active.id })
  expect(journal().deleted_tasks).toContain(task.task.id); expect(state().active).toBeNull()
  await point(); await restore(); expect(store.tasks()).toEqual([]); restart(); expect(store.tasks()).toEqual([])
})
it('blocks restored old approval and call qualification, never starts a model request', async () => {
  vi.useFakeTimers(); const run = store.start(task.task.id, 'held', 'fixture', []); store.handle({ type: 'run.cancel', task_id: task.task.id, run_id: run }); vi.useRealTimers()
  const db = current(); db.prepare("UPDATE runs SET commit_valid=1").run(); db.close()
  const before = store.snapshot(task.task.id).runs[0]!; await point(); await restore(); expect(store.snapshot(task.task.id).runs[0]!.state).toBe(before.state); const restored = current(); expect(restored.prepare('SELECT commit_valid FROM runs').all()).toEqual([{ commit_valid: 0 }]); restored.close()
  expect(() => store.modelTool(task.task.id, run, { type: 'write', input: { type: 'resource.create', display_name: 'late', content: { type: 'text', text: 'late' } } })).toThrow(/commit permission/)
})
it('does not overwrite current model config or credentials with snapshot metadata', async () => {
  const configure = (wire: string) => store.models.configureConnection({ type: 'model.configure', configuration: { id: 'current', base_url: 'http://127.0.0.1:1/v1', wire_model_id: wire, context_tokens: 100000, max_output_tokens: 4096, compatibility_profile: 'chat-max-tokens' }, api_key: 'current-private-sentinel', confirm_memory_only: true })
  await configure('old'); await point(); await configure('new'); await restore()
  expect(store.models.recoverySettings()[0]!.wire_model_id).toBe('new')
  for (const op of journal().operations) expect(JSON.stringify(op)).not.toContain('private-sentinel')
})
it('rejects missing selector with retained restore generations instead of reopening the old database', async () => { await point(); await restore(); store.close(); rmSync(join(root, 'restore-control.sqlite')); expect(() => { store = new RuntimeStore(root) }).toThrow(/journal/) })

it.each([undefined, false, [], 0, '../outside.sqlite'])('rejects malformed database selector without initializing a new business database: %s', selected => {
  store.close(); const db = new Database(join(root, 'restore-control.sqlite')); db.prepare('UPDATE restore_control SET manifest=?').run(JSON.stringify({ version: 1, selected, deleted_tasks: [], operations: [] })); db.close()
  expect(() => new RuntimeStore(root)).toThrow(/journal/)
})
it('refuses a missing selected database rather than creating an empty replacement', () => {
  store.close(); rmSync(join(root, 'pliuna.sqlite')); expect(() => new RuntimeStore(root)).toThrow(/journal/); expect(readdirSync(root)).not.toContain('pliuna.sqlite')
})
it('keeps stopped tasks stopped and revokes old approval validity without changing the decision', async () => {
  const r = resource(); store.handle({ type: 'task.stop', task_id: task.task.id })
  const db = current(), action = db.prepare('SELECT id FROM actions LIMIT 1').get() as any
  db.prepare("INSERT INTO approvals VALUES ('historic',?,'approve','valid','manual','resolved','2099-01-01',NULL,'{}')").run(action.id); db.close()
  await point(); store.handle({ type: 'task.resume', task_id: task.task.id }); await restore()
  expect(store.snapshot(task.task.id).task.state).toBe('stopped')
  const restored = current(); expect(restored.prepare('SELECT decision,validity FROM approvals').get()).toEqual({ decision: 'approve', validity: 'revoked' }); restored.close()
  expect(readFileSync(join(root, 'resources', r), 'utf8')).toBe('original')
})
it('protects post-point resources after current task deletion rather than orphaning retained rollback images', async () => {
  await point(); const newer = resource('newer retained'); await restore()
  store.handle({ type: 'task.delete', task_id: task.task.id, invalidate_recovery_id: state().active.id })
  expect(readFileSync(join(root, 'resources', newer), 'utf8')).toBe('newer retained')
  expect(journal().operations[0].rollback.resources.some((r: any) => r.id === newer)).toBe(true)
})
it('restoration invalidates pre-restore query cursors', async () => {
  store.create('other'); const before = store.handle({ type: 'host.tasks.page', input: { kind: 'task', limit: 1 } }) as any
  await point(); await restore()
  expect(() => store.handle({ type: 'host.tasks.page', input: { kind: 'task', limit: 1, cursor: before.next_cursor } })).toThrow(/Cursor expired/)
})
it('does not create an operation or extend a token when approval for recovery expires', async () => {
  const p = (await point()).active; vi.useFakeTimers(); const token = begin(); vi.advanceTimersByTime(60001)
  expect(() => restore(p, token)).toThrow(/expired/); expect(journal().operations).toEqual([])
})
