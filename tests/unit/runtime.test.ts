import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { RuntimeStore } from '../../src/runtime/store'
import type { Snapshot } from '../../src/shared/types'
const paths: string[] = [], stores: RuntimeStore[] = []
function open(path = mkdtempSync(join(tmpdir(), 'pliuna-test-'))) { if (!paths.includes(path)) paths.push(path); const store = new RuntimeStore(path); stores.push(store); return { path, store } }
function task(store: RuntimeStore) { return store.handle({ type: 'task.create', title: '核心链路' }) as Snapshot }
async function surface(store: RuntimeStore, taskId: string) {
  store.handle({ type: 'task.submit', task_id: taskId, text: '解释一个概念', model_config_id: 'fixture', attachments: [] })
  await vi.advanceTimersByTimeAsync(160)
  return store.snapshot(taskId)
}
afterEach(() => { for (const s of stores.splice(0)) { try { s.close() } catch {} }; for (const p of paths.splice(0)) rmSync(p, { recursive: true, force: true }); vi.useRealTimers() })
describe('runtime persistence and transaction invariants', () => {
  it('bounds desktop data metadata and reads omitted objects only by task and exact revision', () => {
    const { store, path } = open(), t = task(store), other = task(store)
    const db = new Database(join(path, 'pliuna.sqlite'))
    const insert = db.prepare('INSERT INTO task_data (id,task_id,revision,schema_json,value_json,references_json) VALUES (?,?,1,?,?,?)')
    for (let i = 0; i < 201; i++) insert.run(`data-${i}`, t.task.id, '{"type":"string"}', JSON.stringify(`value-${i}`), '[]')
    db.close()
    const data = store.snapshot(t.task.id).task_data
    expect(data.total).toBe(201); expect(data.items).toHaveLength(200)
    expect(data.items[0]!.id).toBe('data-200')
    expect(data.items.some(x => x.id === 'data-0')).toBe(false)
    expect(store.handle({ type: 'task.data.read', task_id: t.task.id, id: 'data-0', expected_revision: 1 })).toMatchObject({ value: 'value-0', revision: 1 })
    expect(store.snapshot(other.task.id).task_data).toEqual({ items: [], total: 0 })
    store.handle({ type: 'task.delete', task_id: t.task.id })
    expect(() => store.handle({ type: 'task.data.read', task_id: t.task.id, id: 'data-0', expected_revision: 1 })).toThrow('not found')
  })
  it('creates isolated tasks and rejects unknown IPC fields', () => {
    const { store } = open(); const t = task(store)
    expect(store.snapshot(t.task.id).views).toEqual([])
    expect(() => store.handle({ type: 'task.snapshot', task_id: t.task.id, sql: 'SELECT *' })).toThrow()
    expect(() => store.handle({ type: 'task.snapshot', task_id: 'unknown' })).toThrow()
  })
  it('enforces one unfinished Run and cancellation revokes old write permission', () => {
    vi.useFakeTimers(); const { store } = open(), t = task(store)
    const run = store.start(t.task.id, 'question', 'fixture', [])
    expect(() => store.start(t.task.id, 'question', 'fixture', [])).toThrow('unfinished Run')
    store.handle({ type: 'run.cancel', task_id: t.task.id, run_id: run })
    expect(() => store.modelTool(t.task.id, run, { type: 'read', input: { target: { kind: 'surface', id: t.surface.id } } })).toThrow('commit permission')
    expect(store.snapshot(t.task.id).views).toHaveLength(0)
  })
  it('publishes bundle, saves raw draft, and commits identical answers independently', async () => {
    vi.useFakeTimers(); const { store } = open(), t = task(store), s = await surface(store, t.task.id), v = s.views[0]!
    expect(s.runs[0]!.state).toBe('completed')
    expect(store.handle({ type: 'operation.list', task_id: t.task.id, limit: 10 })).toMatchObject([{ result: 'success', state: 'ended' }])
    const save = { type: 'draft.save', task_id: t.task.id, view_id: v.id, view_revision: 1, expected_state_revision: 1, fields: [{ path: '/response', value: '我的回答' }] }
    expect(store.handle(save)).toEqual({ state_revision: 2 })
    expect(() => store.handle(save)).toThrow('Content or draft changed')
    const submit = { type: 'answer.submit', task_id: t.task.id, view_id: v.id, view_revision: 1, expected_state_revision: 2, form_id: 'reflection' }
    const a = store.handle(submit), b = store.handle(submit)
    expect(a).not.toEqual(b)
    const snapshot = store.snapshot(t.task.id)
    expect(snapshot.answers).toHaveLength(2)
    expect(snapshot.records.filter(r => r.kind === 'answer.submitted')).toHaveLength(2)
    expect(snapshot.answers[0]!.value).toEqual({ response: '我的回答' })
  })
  it('rejects cross-task draft access and undeclared edits', async () => {
    vi.useFakeTimers(); const { store } = open(), t = task(store), other = task(store), s = await surface(store, t.task.id), v = s.views[0]!
    const save = { type: 'draft.save', task_id: other.task.id, view_id: v.id, view_revision: 1, expected_state_revision: 1, fields: [{ path: '/response', value: 'bad' }] }
    expect(() => store.handle(save)).toThrow('not found')
    expect(() => store.handle({ ...save, task_id: t.task.id, fields: [{ path: '/prompt', value: 'overwrite' }] })).toThrow('not user editable')
  })
  it('invalid formal answers do not create answers or events', async () => {
    vi.useFakeTimers(); const { store } = open(), t = task(store), s = await surface(store, t.task.id), v = s.views[0]!
    expect(() => store.handle({ type: 'answer.submit', task_id: t.task.id, view_id: v.id, view_revision: 1, expected_state_revision: 1, form_id: 'reflection' })).toThrow()
    expect(store.snapshot(t.task.id).answers).toHaveLength(0)
    expect(store.snapshot(t.task.id).records.some(r => r.kind === 'answer.submitted')).toBe(false)
  })
  it('allows input and answers while stopped but does not start inference', async () => {
    vi.useFakeTimers(); const { store } = open(), t = task(store), s = await surface(store, t.task.id), v = s.views[0]!
    store.handle({ type: 'task.stop', task_id: t.task.id })
    store.handle({ type: 'draft.save', task_id: t.task.id, view_id: v.id, view_revision: 1, expected_state_revision: 1, fields: [{ path: '/response', value: 'stopped answer' }] })
    store.handle({ type: 'answer.submit', task_id: t.task.id, view_id: v.id, view_revision: 1, expected_state_revision: 2, form_id: 'reflection' })
    expect(() => store.start(t.task.id, 'again', 'fixture', [])).toThrow('resume')
    store.handle({ type: 'task.resume', task_id: t.task.id })
    expect(store.snapshot(t.task.id).runs).toHaveLength(1)
  })
  it('restarts with data only and marks unfinished Runs interrupted', async () => {
    vi.useFakeTimers(); const { store, path } = open(), t = task(store)
    await surface(store, t.task.id)
    store.start(t.task.id, 'unfinished', 'fixture', [])
    const epoch = store.epoch; store.close(); stores.splice(stores.indexOf(store), 1)
    const next = open(path).store
    expect(next.epoch).not.toBe(epoch)
    expect(next.snapshot(t.task.id).runs[0]).toMatchObject({ state: 'interrupted', primary_reason: 'runtime_restart' })
    await vi.advanceTimersByTimeAsync(500)
    expect(next.snapshot(t.task.id).views).toHaveLength(1)
  })
  it('rolls back answer and event together on database failure', async () => {
    vi.useFakeTimers(); const { store, path } = open(), t = task(store), s = await surface(store, t.task.id), v = s.views[0]!
    store.handle({ type: 'draft.save', task_id: t.task.id, view_id: v.id, view_revision: 1, expected_state_revision: 1, fields: [{ path: '/response', value: 'answer' }] })
    const db = new Database(join(path, 'pliuna.sqlite'))
    db.exec("CREATE TRIGGER fail_answer BEFORE INSERT ON answers BEGIN SELECT RAISE(ABORT,'injected'); END")
    expect(() => store.handle({ type: 'answer.submit', task_id: t.task.id, view_id: v.id, view_revision: 1, expected_state_revision: 2, form_id: 'reflection' })).toThrow('injected')
    expect(store.snapshot(t.task.id).records.some(r => r.kind === 'answer.submitted')).toBe(false)
    db.close()
  })
  it('publication database failure keeps old surface and traces orphaned files', async () => {
    vi.useFakeTimers(); const { store, path } = open(), t = task(store)
    const db = new Database(join(path, 'pliuna.sqlite'))
    db.exec("CREATE TRIGGER fail_view BEFORE INSERT ON views BEGIN SELECT RAISE(ABORT,'injected view failure'); END")
    await surface(store, t.task.id)
    expect(store.snapshot(t.task.id).views).toHaveLength(0)
    expect(store.snapshot(t.task.id).surface.revision).toBe(1)
    expect(store.handle({ type: 'operation.list', task_id: t.task.id, limit: 10 })).toMatchObject([{ result: 'not_executed' }])
    expect(db.prepare('SELECT state FROM staging').all()).toEqual([{ state: 'invalid' }])
    expect(db.prepare('SELECT count(*) AS count FROM resources').get()).toEqual({ count: 0 })
    db.close()
  })
  it('detects corrupted immutable bundle instead of rendering altered content', async () => {
    vi.useFakeTimers(); const { store, path } = open(), t = task(store)
    await surface(store, t.task.id)
    const db = new Database(join(path, 'pliuna.sqlite'))
    const resource = db.prepare('SELECT storage_key FROM resources').get() as { storage_key: string }
    writeFileSync(join(path, 'resources', resource.storage_key), 'corrupted')
    expect(() => store.snapshot(t.task.id)).toThrow(expect.objectContaining({ code: 'RESOURCE_CORRUPT' }))
    db.close()
  })
  it('deletes a task and never restores it on restart', async () => {
    vi.useFakeTimers(); const { store, path } = open(), t = task(store); await surface(store, t.task.id)
    store.handle({ type: 'task.delete', task_id: t.task.id })
    expect(store.tasks()).toHaveLength(0)
    expect(() => store.snapshot(t.task.id)).toThrow()
    store.close(); stores.splice(stores.indexOf(store), 1)
    expect(open(path).store.tasks()).toHaveLength(0)
  })
})
