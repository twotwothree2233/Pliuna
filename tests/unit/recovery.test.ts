import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeStore } from '../../src/runtime/store'
import type { Snapshot } from '../../src/shared/types'
let root: string, store: RuntimeStore, db: Database.Database, task: Snapshot
const state = (): any => store.handle({ type: 'maintenance.status' })
const begin = (): string => (store.handle({ type: 'maintenance.begin' }) as any).reservation.token
const create = (token = begin(), replace_id = state().active?.id ?? null): Promise<any> => store.handle({ type: 'maintenance.create', token, inputs_saved: true, replace_id }) as Promise<any>
const control = (): any => { const d = new Database(join(root, 'recovery-control.sqlite')); try { return JSON.parse((d.prepare('SELECT manifest FROM control').get() as any).manifest) } finally { d.close() } }
const restart = () => { store.close(); store = new RuntimeStore(root) }
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'trellis-recovery-')); store = new RuntimeStore(root); task = store.create('恢复点验收'); db = new Database(join(root, 'trellis.sqlite')) })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); store.close(); db.close(); rmSync(root, { recursive: true, force: true }) })
function material(): string {
  vi.useFakeTimers()
  const run = store.start(task.task.id, 'held', 'fixture', [])
  const result = store.modelTool(task.task.id, run, { type: 'write', input: { type: 'resource.create', display_name: '材料', content: { type: 'text', text: 'original' } } }) as any
  store.handle({ type: 'run.cancel', task_id: task.task.id, run_id: run }); vi.useRealTimers()
  return result.data.id
}
it('creates a WAL-safe verified backup, persists status across restart and leaves all execution features closed', async () => {
  const resource = material(), value = await create()
  expect(value).toMatchObject({ phase: 'idle', restore_enabled: true, gc_enabled: false, migration_enabled: false, active: { resource_count: 1, task_ids: [task.task.id] }, last: { outcome: 'created' } })
  const backup = new Database(join(root, 'recovery', value.active.id + '.sqlite'), { readonly: true })
  expect(backup.prepare('SELECT title FROM tasks').get()).toEqual({ title: '恢复点验收' }); expect(backup.pragma('quick_check', { simple: true })).toBe('ok'); backup.close()
  expect(control().active.resources[0].id).toBe(resource)
  expect(readFileSync(join(root, 'recovery-control.sqlite')).includes(Buffer.from('api_key'))).toBe(false)
  restart(); expect(state().active).toEqual(value.active)
})
it('keeps both old and candidate resource pins throughout asynchronous backup, then safely replaces one valid point', async () => {
  material(); const old = (await create()).active.id
  const original = Database.prototype.backup
  vi.spyOn(Database.prototype, 'backup').mockImplementation(function (this: Database.Database, ...args: Parameters<typeof original>) {
    expect(control().active.id).toBe(old); expect(control().candidates).toHaveLength(1)
    expect(db.prepare('SELECT count(*) n FROM recovery_resources').get()).toEqual({ n: 2 })
    expect(() => store.create('late')).toThrow(/Maintenance/)
    return original.apply(this, args)
  })
  const next = await create(); expect(next.active.id).not.toBe(old)
  expect(db.prepare("SELECT count(*) n FROM recovery_points WHERE state='valid'").get()).toEqual({ n: 1 })
  expect(control().retired).toContain(old); expect(readdirSync(join(root, 'recovery')).filter(f => f.endsWith('.sqlite'))).toHaveLength(2)
})
it('cancels preparation without creating a point or sending a model request', () => { const token = begin(); store.handle({ type: 'maintenance.cancel', token }); expect(state()).toMatchObject({ phase: 'idle', active: null, last: { outcome: 'cancelled' } }); expect(readdirSync(join(root, 'recovery'))).toEqual([]) })
it('expires abandoned preparation without stealing an active backup', () => { vi.useFakeTimers(); begin(); vi.advanceTimersByTime(60001); expect(state()).toMatchObject({ phase: 'idle', last: { outcome: 'expired' } }); expect(store.create('after timeout')).toBeTruthy() })
it.each(['task.create', 'storage.retry', 'task.stop', 'task.resume', 'task.delete', 'task.submit', 'answer.submit', 'approval.decide', 'surface.respond'])('does not allow invalid ordinary mutation during preparation: %s', type => {
  begin(); expect(() => store.handle(type === 'task.create' ? { type, title: 'x' } : type === 'task.stop' || type === 'task.resume' || type === 'task.delete' ? { type, task_id: task.task.id } : { type })).toThrow()
})
it('guards direct execution entry and model changes while safe reads remain available', () => {
  begin(); expect(() => store.start(task.task.id, 'late', 'fixture', [])).toThrow(/Maintenance/)
  expect(() => store.handle({ type: 'model.cancel', operation_id: 'x' })).toThrow(/Maintenance/)
  expect(store.handle({ type: 'host.tasks' })).toHaveLength(1); expect(store.handle({ type: 'task.snapshot', task_id: task.task.id })).toBeTruthy(); expect(store.handle({ type: 'model.list' })).toBeTruthy()
})
it('blocks any active Run including a different task and does not cancel it', () => {
  vi.useFakeTimers(); const other = store.create('other'), run = store.start(other.task.id, 'held', 'fixture', [])
  expect(() => begin()).toThrow(/Wait for all executions/)
  expect(store.snapshot(other.task.id).runs[0]).toMatchObject({ id: run, state: 'running' }); expect(state().phase).toBe('idle')
})
it('blocks model config work and necessary cleanup', () => {
  const busy = vi.spyOn(store.models, 'busy').mockReturnValue(true); expect(() => begin()).toThrow(/Wait for all executions/); busy.mockRestore()
  db.prepare("INSERT INTO cleanup_jobs VALUES ('required',?,'call','unknown',1,'failed',0,NULL,'{}')").run(task.task.id)
  expect(() => begin()).toThrow(/Wait for all executions/)
})
it('requires the exact replacement point ID without changing the old point', async () => { const old = (await create()).active.id, token = begin(); expect(() => create(token, null)).toThrow(/changed/); expect(control().active.id).toBe(old); store.handle({ type: 'maintenance.cancel', token }) })
it.each(['ENOSPC', 'EIO'])('retains old point and candidate after backup failure: %s', async code => {
  material(); const old = (await create()).active.id
  vi.spyOn(Database.prototype, 'backup').mockRejectedValueOnce(Object.assign(new Error('injected'), { code }))
  await expect(create()).rejects.toThrow(/failed/); expect(control().active.id).toBe(old); expect(control().candidates).toHaveLength(1)
  expect(db.prepare('SELECT count(*) n FROM recovery_resources').get()).toEqual({ n: 2 })
  restart(); expect(state().active.id).toBe(old); expect(state().phase).toBe('idle'); expect(state().retained_candidates).toBe(1)
})
it('rejects a damaged formal resource before switching the old point', async () => {
  const id = material(); const old = (await create()).active.id; writeFileSync(join(root, 'resources', id), 'broken')
  await expect(create()).rejects.toThrow(/failed/); expect(control().active.id).toBe(old)
  restart(); expect(state().phase).toBe('blocked'); expect(() => store.create('unsafe')).toThrow(/closed/)
})
it('freezes writes after successful control switch but failed projection, reconciles on restart', async () => {
  const old = (await create()).active.id, original = Database.prototype.prepare
  vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql: string) {
    if (sql.startsWith('INSERT INTO recovery_points') && control().active?.id !== old) throw new Error('injected projection failure')
    return original.call(this, sql)
  })
  await expect(create()).rejects.toThrow(/failed/); expect(state()).toMatchObject({ phase: 'blocked', error: 'RECOVERY_PROJECTION_FAILED' })
  const next = control().active.id; expect(next).not.toBe(old); vi.restoreAllMocks(); restart()
  expect(state()).toMatchObject({ phase: 'idle', active: { id: next } }); expect(db.prepare("SELECT id FROM recovery_points WHERE state='valid'").get()).toEqual({ id: next })
})
it('requires explicit entire-point invalidation before task deletion and stale confirmations fail', async () => {
  material(); const p = (await create()).active.id
  expect(() => store.handle({ type: 'task.delete', task_id: task.task.id })).toThrow(/entire current/)
  expect(store.tasks()).toHaveLength(1)
  store.handle({ type: 'task.delete', task_id: task.task.id, invalidate_recovery_id: p })
  expect(control()).toMatchObject({ active: null, invalidated: [p] }); expect(store.tasks()).toEqual([])
  restart(); expect(state().active).toBeNull()
})
it('control tombstone overrides an old valid projection from an older database', async () => {
  const p = (await create()).active.id
  store.handle({ type: 'task.delete', task_id: task.task.id, invalidate_recovery_id: p })
  db.prepare("UPDATE recovery_points SET state='valid'").run(); restart()
  expect(db.prepare("SELECT id FROM recovery_points WHERE state='valid'").all()).toEqual([]); expect(control().invalidated).toContain(p)
})
it('does not begin task deletion when independent invalidation fails', async () => {
  const p = (await create()).active.id, d = new Database(join(root, 'recovery-control.sqlite'))
  d.exec('BEGIN IMMEDIATE')
  try { expect(() => store.handle({ type: 'task.delete', task_id: task.task.id, invalidate_recovery_id: p })).toThrow(/blocked/); expect(store.tasks()).toHaveLength(1); expect(control().active.id).toBe(p) } finally { d.exec('ROLLBACK'); d.close() }
})
it('rejects unknown independent control version rather than overwriting it', () => {
  store.close(); const d = new Database(join(root, 'recovery-control.sqlite')); d.prepare('UPDATE control SET manifest=?').run('{"version":99}'); d.close(); store = new RuntimeStore(root)
  expect(state().phase).toBe('blocked'); expect(() => store.create('unsafe')).toThrow(/closed/)
})
it('rejects missing control with existing recovery facts rather than reconstructing authority', async () => {
  await create(); store.close(); rmSync(join(root, 'recovery-control.sqlite')); store = new RuntimeStore(root); expect(state().phase).toBe('blocked')
})
it('enforces same-directory writer ownership and releases it on normal close', () => { expect(() => new RuntimeStore(root)).toThrow(/Another runtime/); restart(); expect(store.tasks()).toHaveLength(1) })
it('never exposes restore, migration or GC host commands', () => { for (const type of ['maintenance.restore', 'storage.gc', 'storage.migrate']) expect(() => store.handle({ type })).toThrow() })
it('permits one version-checked save only for a registered editor; ordinary and repeated saves are denied', async () => {
  vi.useFakeTimers(); const run = store.start(task.task.id, 'held', 'fixture', [])
  const bundle = { profile: 'managed-v1', html: '<label for="a">答案</label><textarea id="a"></textarea>', css: '', state: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, initial: { text: '' }, compatibility_version: 'v1' }, forms: [], behaviors: [{ type: 'input', element_id: 'a', field: '/text', control: 'textarea' }], references: [], export: [] }
  store.modelTool(task.task.id, run, { type: 'write', input: { type: 'surface.update', surface_id: task.surface.id, expected_revision: 1, operations: [{ type: 'view.create', client_ref: 'editor', slot_id: 'main', bundle: { type: 'inline', bundle } }] } })
  store.handle({ type: 'run.cancel', task_id: task.task.id, run_id: run }); vi.useRealTimers()
  const view = store.snapshot(task.task.id).views[0]!, token = (store.handle({ type: 'maintenance.begin', inputs: [{ task_id: task.task.id, view_id: view.id }] }) as any).reservation.token
  const save = { type: 'draft.save', task_id: task.task.id, view_id: view.id, view_revision: 1, expected_state_revision: 1, fields: [{ path: '/text', value: 'saved by barrier' }] }
  expect(() => store.handle(save)).toThrow(/Maintenance/)
  expect(() => store.handle({ ...save, maintenance_token: token, view_id: 'other' })).toThrow(/registered/)
  store.handle({ ...save, maintenance_token: token })
  expect(() => store.handle({ ...save, expected_state_revision: 2, maintenance_token: token })).toThrow(/registered/)
  const result = await create(token)
  const backup = new Database(join(root, 'recovery', result.active.id + '.sqlite'), { readonly: true })
  expect(backup.prepare('SELECT draft_json FROM views').get()).toEqual({ draft_json: '{"text":"saved by barrier"}' }); backup.close()
})
it('denies token-bearing draft save after reservation expiry', () => { vi.useFakeTimers(); const token = begin(); vi.advanceTimersByTime(60001); expect(() => store.handle({ type: 'draft.save', task_id: task.task.id, view_id: 'old', view_revision: 1, expected_state_revision: 1, fields: [{ path: '/text', value: 'late' }], maintenance_token: token })).toThrow(/expired/) })
it('blocks late tool commits at the runtime qualification boundary', () => { vi.useFakeTimers(); const run = store.start(task.task.id, 'held', 'fixture', []); store.handle({ type: 'run.cancel', task_id: task.task.id, run_id: run }); begin(); expect(() => store.modelTool(task.task.id, run, { type: 'write', input: { type: 'resource.create', display_name: 'late', content: { type: 'text', text: 'late' } } })).toThrow(/Maintenance/); expect(db.prepare('SELECT count(*) n FROM resources').get()).toEqual({ n: 0 }) })
it('blocks active Calls and unknown necessary cleanup even without a Run', () => { db.prepare("INSERT INTO calls (id,task_id,capability_id,state,dispatch,delivery,input_json,limits_json,commit_valid,created_at) VALUES ('external',?,'closed','finalizing','unknown','pending','{}','{}',0,'now')").run(task.task.id); expect(() => begin()).toThrow(/Wait for all executions/) })
it('refuses deletion confirmed against a replaced old point', async () => { const old = (await create()).active.id, next = (await create()).active.id; expect(() => store.handle({ type: 'task.delete', task_id: task.task.id, invalidate_recovery_id: old })).toThrow(/entire current/); expect(control().active.id).toBe(next); expect(store.tasks()).toHaveLength(1) })
it('includes only non-sensitive model settings, never credentials or role qualification', async () => {
  await store.models.configureConnection({ type: 'model.configure', configuration: { id: 'safe-config', base_url: 'http://127.0.0.1:1/v1', wire_model_id: 'wire', context_tokens: 100000, max_output_tokens: 4096, compatibility_profile: 'chat-max-tokens' }, api_key: 'secret-recovery-sentinel', confirm_memory_only: true })
  await create(); const metadata = JSON.stringify(control().active)
  expect(metadata).toContain('safe-config'); expect(metadata).not.toContain('secret-recovery-sentinel'); expect(metadata).not.toContain('roles'); expect(metadata).not.toContain('api_key')
})

it.each([undefined, false, [], 0])('fails closed on malformed active control instead of treating it as no point: %s', active => {
  store.close(); const d = new Database(join(root, 'recovery-control.sqlite')); d.prepare('UPDATE control SET manifest=?').run(JSON.stringify({ version: 1, active, candidates: [], retired: [], invalidated: [] })); d.close(); store = new RuntimeStore(root)
  expect(state().phase).toBe('blocked'); expect(() => store.create('unsafe')).toThrow(/closed/)
})
it('fails closed when preparing backup metadata itself fails, without leaving creating forever', async () => {
  const original = Database.prototype.prepare, token = begin()
  vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql: string) { if (sql === 'SELECT id FROM tasks ORDER BY id') throw new Error('injected metadata read failure'); return original.call(this, sql) })
  await expect(create(token)).rejects.toThrow(/failed/); expect(state()).toMatchObject({ phase: 'blocked', last: { outcome: 'failed' } })
})
