import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { RuntimeStore } from '../../src/runtime/store'
import type { Snapshot } from '../../src/shared/types'
let store: RuntimeStore, db: Database.Database, directory: string, task: Snapshot, other: Snapshot
beforeEach(() => {
  vi.useFakeTimers(); directory = mkdtempSync(join(tmpdir(), 'pliuna-query-')); store = new RuntimeStore(directory)
  task = store.create('查询测试'); other = store.create('另一个任务'); db = new Database(join(directory, 'pliuna.sqlite'))
})
afterEach(() => { db.close(); store.close(); rmSync(directory, { recursive: true, force: true }); vi.useRealTimers() })
const query = (q: unknown, taskId = task.task.id): any => store.handle({ type: 'task.query', task_id: taskId, query: q })
const list = (kind: string, extra = {}): any => query({ type: 'list', input: { kind, ...extra } })
const read = (kind: string, id: string, extra = {}): any => query({ type: 'read', input: { target: { kind, id }, ...extra } })
function data(id: string, value: unknown) { db.prepare('INSERT INTO task_data (id,task_id,revision,schema_json,value_json,references_json) VALUES (?,?,1,?,?,?)').run(id, task.task.id, '{"type":"string"}', JSON.stringify(value), '[]') }

it('pages 501 objects without gaps, with bounded signed cursors and no full snapshot', () => {
  for (let i = 0; i < 501; i++) data('data-' + i, 'x'.repeat(10000))
  vi.spyOn(store, 'snapshot').mockImplementation(() => { throw Error('must not snapshot') })
  const ids: string[] = []; let cursor: string | null = null
  do { const page = list('task_data', cursor ? { cursor } : {}); expect(page.items.length).toBeLessThanOrEqual(50); ids.push(...page.items.map((x: any) => x.id)); cursor = page.next_cursor; if (cursor) expect(cursor.length).toBeLessThanOrEqual(200) } while (cursor)
  expect(ids).toHaveLength(501); expect(new Set(ids).size).toBe(501); expect(ids.at(-1)).toBe('data-500')
})
it('rejects cross-task, changed filter, forged and old-runtime cursors', () => {
  data('one', 'a'); data('two', 'b'); const cursor = list('task_data', { limit: 1 }).next_cursor
  expect(() => query({ type: 'list', input: { kind: 'task_data', cursor } }, other.task.id)).toThrow('Cursor')
  expect(() => list('task_data', { cursor: cursor.slice(0, -2) + 'xx' })).toThrow('Cursor')
  const tasks = store.handle({ type: 'host.tasks.page', input: { kind: 'task', limit: 1 } }) as any
  expect(() => store.handle({ type: 'host.tasks.page', input: { kind: 'task', cursor: tasks.next_cursor, filters: { name_query: '查询' } } })).toThrow('Cursor')
  store.close(); store = new RuntimeStore(directory)
  expect(() => list('task_data', { cursor })).toThrow('Cursor')
})
it('binds model cursors to their Run and separates host cursors', () => {
  data('one', 'a'); data('two', 'b'); const first = store.start(task.task.id, 'first', 'fixture', [])
  const page = store.modelTool(task.task.id, first, { type: 'list', input: { kind: 'task_data', limit: 1 } }) as any
  expect(() => list('task_data', { cursor: page.next_cursor })).toThrow('Cursor')
  store.handle({ type: 'run.cancel', task_id: task.task.id, run_id: first })
  const second = store.start(task.task.id, 'second', 'fixture', [])
  expect(() => store.modelTool(task.task.id, second, { type: 'list', input: { kind: 'task_data', cursor: page.next_cursor } })).toThrow('Cursor')
})
it('reads historical records outside the former 200 window and applies message filtering', () => {
  const insert = db.prepare('INSERT INTO records VALUES (?,?,?,?,?,?)')
  for (let i = 0; i < 501; i++) insert.run('event-' + i, task.task.id, i + 1, i % 2 ? 'message.user' : 'test.event', JSON.stringify({ text: '正文 ' + i }), '2026-01-01T00:00:00.000Z')
  expect(list('event', { limit: 200 }).items).toHaveLength(200)
  expect(list('message').items.every((x: any) => x.kind === 'message.user')).toBe(true)
  expect(read('event', 'event-0').data.payload.text).toBe('正文 0')
  expect(() => read('message', 'event-0')).toThrow('unavailable')
  expect(() => query({ type: 'read', input: { target: { kind: 'event', id: 'event-0' } } }, other.task.id)).toThrow('unavailable')
})
it('round trips long Unicode and escaped single-line JSON without splitting characters', () => {
  const value = '中文😀\\\n"'.repeat(12000); data('long', value)
  let result = read('task_data', 'long'), text = ''; let count = 0
  do {
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(32768)
    expect(result.representation).toContain('application/json'); text += result.data.text; count++
    if (!result.next_cursor) break
    expect(result.next_cursor.length).toBeLessThanOrEqual(200)
    result = read('task_data', 'long', { cursor: result.next_cursor })
  } while (count < 100)
  expect(count).toBeGreaterThan(1); expect(JSON.parse(text).value).toBe(value)
})
it('rejects changed versions and changed mutable content during continuation', () => {
  data('long', '中'.repeat(30000)); const result = read('task_data', 'long')
  db.prepare('UPDATE task_data SET value_json=?,revision=2 WHERE id=?').run('"changed"', 'long')
  expect(() => read('task_data', 'long', { cursor: result.next_cursor })).toThrow('Content changed')
  expect(() => query({ type: 'read', input: { target: { kind: 'task_data', id: 'long', expected_revision: 1 } } })).toThrow('revision changed')
  expect(read('task_data', 'long').data.value).toBe('changed')
})
it('supports inclusive line ranges, rejects invalid bounds and never mixes range with cursor', () => {
  data('lines', 'text'); const whole = read('task_data', 'lines').data
  const expected = JSON.stringify(whole, null, 2).split('\n').slice(1, 3).join('\n') + '\n'
  expect(read('task_data', 'lines', { range: { start_line: 2, end_line: 3 } }).data.text).toBe(expected)
  expect(() => read('task_data', 'lines', { range: { start_line: 3, end_line: 2 } })).toThrow('Start line')
  expect(() => read('task_data', 'lines', { range: { start_line: 100, end_line: 101 } })).toThrow('Start line')
  expect(() => read('task_data', 'lines', { range: { start_line: 1, end_line: 2 }, cursor: 'bad' })).toThrow()
})
it('filters only documented metadata and enforces limits', () => {
  expect(list('task', { filters: { name_query: '查询', status: 'active' } }).items).toHaveLength(1)
  expect(list('task', { filters: { name_query: '不存在' } }).items).toHaveLength(0)
  expect(() => list('task_data', { filters: { status: 'active' } })).toThrow('Filter')
  expect(() => list('event', { filters: { since: 'invalid' } })).toThrow('Filter')
  expect(() => list('event', { limit: 201 })).toThrow()
  expect(list('resource').items).toEqual([])
})
it('queries original successful, rejected and interrupted operations without replay or private bindings', async () => {
  const run = store.start(task.task.id, 'publish', 'fixture', []); await vi.advanceTimersByTimeAsync(160)
  const actions = list('action').items; expect(actions).toHaveLength(1)
  const action = read('action', actions[0].id).data
  expect(action.result).toBe('success'); expect(action.source.id).toBe(run)
  const insert = db.prepare("INSERT INTO actions (id,task_id,run_id,kind,state,source_json,request_json,commit_valid,result,result_json,created_at) VALUES (?,?,?,'mutation','ended','{}','{}',0,?,?,?)")
  insert.run('denied', task.task.id, run, 'not_executed', '{"code":"APPROVAL_DENIED"}', '2026-01-02T00:00:00Z')
  insert.run('interrupted', task.task.id, run, 'cancelled', '{"code":"CANCELLED"}', '2026-01-03T00:00:00Z')
  db.prepare("INSERT INTO approvals VALUES ('approval','denied','deny','revoked','manual','resolved',?,'{}',?)").run('2026-01-04', '{"private":"PRIVATE_BINDING_SENTINEL"}')
  const before = db.prepare('SELECT count(*) n FROM actions').get()
  for (let i = 0; i < 3; i++) expect(read('action', 'denied').data.result_data.code).toBe('APPROVAL_DENIED')
  expect(read('action', 'interrupted').data.result).toBe('cancelled')
  expect(JSON.stringify(read('approval', 'approval'))).not.toContain('PRIVATE_BINDING')
  expect(read('approval', 'approval').data).toMatchObject({ action_state: 'ended', action_result: 'not_executed', result_data: { code: 'APPROVAL_DENIED' } })
  expect(db.prepare('SELECT count(*) n FROM actions').get()).toEqual(before)
  expect(() => query({ type: 'read', input: { target: { kind: 'action', id: 'denied' } } }, other.task.id)).toThrow('unavailable')
})
it('keeps fixed-page results live after insertion without claiming a long-lived snapshot', () => {
  data('one', 'a'); data('two', 'b'); const first = list('task_data', { limit: 1 }); data('three', 'c')
  const next = list('task_data', { cursor: first.next_cursor }); expect(next.consistency).toBe('live'); expect(next.items.map((x: any) => x.id)).toEqual(['two', 'three'])
})
it('pages runs, actions and approvals and detects state changes without a numeric revision', () => {
  const run = db.prepare("INSERT INTO runs (id,task_id,state,runtime_epoch,limits_json,budget_json,created_at) VALUES (?,?,'completed','test','{}','{}',?)")
  const action = db.prepare("INSERT INTO actions (id,task_id,run_id,kind,state,source_json,request_json,result_json,commit_valid,created_at) VALUES (?,?,?,'mutation','ended','{}',?,?,0,?)")
  const approval = db.prepare("INSERT INTO approvals VALUES (?,?, 'deny','revoked','manual','resolved','2026-01-04',NULL,'{}')")
  for (let i = 0; i < 201; i++) {
    const time = '2026-01-01T00:00:00.000Z'
    run.run('run-' + i, task.task.id, time)
    action.run('action-' + i, task.task.id, 'run-' + i, JSON.stringify({ text: '中'.repeat(20000) }), '{}', time)
    approval.run('approval-' + i, 'action-' + i)
  }
  for (const kind of ['run', 'action', 'approval']) {
    const ids = new Set<string>(); let cursor: string | null = null
    do { const page = list(kind, cursor ? { cursor } : {}); for (const item of page.items) ids.add(item.id); cursor = page.next_cursor } while (cursor)
    expect(ids.size).toBe(201)
  }
  const prior = read('action', 'action-0')
  expect(prior.metadata.state).toBe('ended'); expect(prior.next_cursor).toBeTruthy()
  db.prepare("UPDATE actions SET result='failure' WHERE id='action-0'").run()
  expect(() => read('action', 'action-0', { cursor: prior.next_cursor })).toThrow('Content changed')
})
it('pages the object directory stably and rechecks task visibility after deletion', () => {
  const ids: string[] = []; let cursor: string | null = null
  do { const page = list('object_type', { limit: 2, ...(cursor ? { cursor } : {}) }); ids.push(...page.items.map((x: any) => x.id)); cursor = page.next_cursor } while (cursor)
  expect(ids).toEqual([...new Set(ids)].sort()); expect(ids).toContain('approval')
  data('one', 'a'); data('two', 'b'); const prior = list('task_data', { limit: 1 })
  store.handle({ type: 'task.delete', task_id: task.task.id })
  expect(() => list('task_data', { cursor: prior.next_cursor })).toThrow('not found')
})
it('discovers exact per-operation contracts without returning unrelated write branches', () => {
  const items = list('object_type').items
  const entry = items.find((item: any) => item.id === 'task_data.replace')
  expect(entry.contract_target).toEqual({ kind: 'object_type', id: 'task_data.replace' })
  expect(entry).not.toHaveProperty('input_schema')
  const contract = read(entry.contract_target.kind, entry.contract_target.id).data
  expect(contract.operation).toBe('task_data.replace')
  expect(contract.input_schema.required).toEqual(['id', 'expected_revision', 'value', 'references'])
  expect(JSON.stringify(contract)).not.toMatch(/surface.update|view_op|forms/)
})
it('pages all answers while the snapshot keeps a recent window and true total', async () => {
  store.start(task.task.id, 'form', 'fixture', []); await vi.advanceTimersByTimeAsync(160)
  const view = store.snapshot(task.task.id).views[0]!
  store.handle({ type: 'draft.save', task_id: task.task.id, view_id: view.id, view_revision: 1, expected_state_revision: 1, fields: [{ path: '/response', value: '正式答案' }] })
  for (let i = 0; i < 201; i++) store.handle({ type: 'answer.submit', task_id: task.task.id, view_id: view.id, view_revision: 1, expected_state_revision: 2, form_id: 'reflection' })
  const snapshot = store.snapshot(task.task.id)
  expect(snapshot.answer_total).toBe(201); expect(snapshot.answers).toHaveLength(200)
  const ids: string[] = []; let cursor: string | null = null
  do { const page = list('answer', cursor ? { cursor } : {}); ids.push(...page.items.map((x: any) => x.id)); cursor = page.next_cursor } while (cursor)
  expect(new Set(ids).size).toBe(201); expect(read('answer', ids[0]!).data.value.response).toBe('正式答案')
})
it('keeps cursors within the wire limit for long IDs and refuses deleted anchors', () => {
  data('中'.repeat(190), 'first'); data('second', 'second')
  const page = list('task_data', { limit: 1 })
  expect(page.next_cursor.length).toBeLessThanOrEqual(200)
  expect(list('task_data', { cursor: page.next_cursor }).items[0].id).toBe('second')
  db.prepare('DELETE FROM task_data WHERE id=?').run('中'.repeat(190))
  expect(() => list('task_data', { cursor: page.next_cursor })).toThrow('anchor changed')
})

it('locates recent saved messages outside mixed-event windows without reading their payload', () => {
  const insert = db.prepare('INSERT INTO records VALUES (?,?,?,?,?,?)')
  const time = '2026-01-01T00:00:00.000Z'
  insert.run('user-latest', task.task.id, 1, 'message.user', JSON.stringify({ text: 'latest request' }), time)
  insert.run('reply-latest', task.task.id, 2, 'message.assistant', JSON.stringify({ text: '中文'.repeat(30000) }), time)
  for (let i = 3; i < 250; i++) insert.run('event-latest-' + i, task.task.id, i, 'test.event', '{}', time)
  expect(store.snapshot(task.task.id).records.some(row => row.id === 'reply-latest')).toBe(false)
  const latest = () => store.handle({ type: 'host.messages.latest', task_id: task.task.id }) as any
  expect(latest()).toEqual({ request: { id: 'user-latest', kind: 'message.user', created_at: time }, reply: { id: 'reply-latest', kind: 'message.assistant', created_at: time } })
  expect(JSON.stringify(latest())).not.toContain('latest request')
  expect(store.handle({ type: 'host.messages.latest', task_id: other.task.id })).toEqual({ request: null, reply: null })
  insert.run('partial-latest', task.task.id, 250, 'message.assistant.partial', '{"text":"partial"}', time)
  expect(latest().reply.id).toBe('partial-latest')
  expect(() => store.handle({ type: 'host.messages.latest', task_id: task.task.id, extra: true })).toThrow()
  expect(() => store.handle({ type: 'host.messages.latest', task_id: 'missing-task' })).toThrow()
})

function activityRecord(run: string, kind: string, payload: Record<string, unknown>) {
  const sequence = (db.prepare('SELECT next_sequence n FROM tasks WHERE id=?').get(task.task.id) as { n: number }).n
  db.prepare('INSERT INTO records VALUES (?,?,?,?,?,?)').run('activity-' + sequence, task.task.id, sequence, kind, JSON.stringify({ ...payload, run_id: run }), '2026-11-06T00:00:00.000Z')
  db.prepare('UPDATE tasks SET next_sequence=next_sequence+1 WHERE id=?').run(task.task.id)
}
const activity = (run: string, taskId = task.task.id): any => store.handle({ type: 'host.run.activity', task_id: taskId, run_id: run })
function toolRecord(run: string, name: string, args: unknown, result?: unknown) {
  activityRecord(run, 'model.response', { message: { tool_calls: [{ id: 'reused-wire-id', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } }] } })
  if (result) activityRecord(run, 'model.tool_result', { message: { tool_call_id: 'reused-wire-id', content: JSON.stringify(result) } })
}
it('derives bounded run-specific activity beyond the mixed-event window without returning bodies or arguments', () => {
  const run = store.start(task.task.id, '创建学习进度', 'fixture', [])
  store.handle({ type: 'run.cancel', task_id: task.task.id, run_id: run })
  toolRecord(run, 'write', { operation: 'task_data.create', input_json: JSON.stringify({ value: 'PRIVATE_ARGUMENT' }) }, { execution: 'success', delivery: 'delivered', data: { id: 'learning-progress', value: 'PRIVATE_RESULT' } })
  toolRecord(run, 'read', { kind: 'task_data', id: 'learning-progress' }, { execution: 'not_executed', delivery: 'delivered', error: { code: 'NOT_FOUND', message: 'PRIVATE_ERROR' } })
  activityRecord(run, 'message.assistant', { text: 'PRIVATE_REPLY'.repeat(20000) })
  for (let i = 0; i < 210; i++) activityRecord(run, 'test.event', {})
  const next = store.start(task.task.id, '下一个任务请求', 'fixture', [])
  store.handle({ type: 'run.cancel', task_id: task.task.id, run_id: next })
  const value = activity(run)
  expect(value.request).toBe('创建学习进度')
  expect(value.items).toHaveLength(3)
  expect(value.items[0]).toMatchObject({ name: 'write', operation: 'task_data.create', target_id: 'learning-progress', execution: 'success' })
  expect(value.items[1]).toMatchObject({ name: 'read', target_kind: 'task_data', execution: 'not_executed', error: 'NOT_FOUND' })
  expect(value.items[2]).toMatchObject({ type: 'reply', execution: 'success' })
  expect(JSON.stringify(value)).not.toContain('PRIVATE_')
  expect(activity(next)).toMatchObject({ request: '下一个任务请求', items: [] })
  expect(() => activity(run, other.task.id)).toThrow()
  expect(() => activity('missing')).toThrow()
  expect(() => store.handle({ type: 'host.run.activity', task_id: task.task.id, run_id: run, extra: true })).toThrow()
})
it('keeps unreturned tools, partial replies and failed delivery distinct and retains only recent activity', () => {
  const run = store.start(task.task.id, '😀'.repeat(130), 'fixture', [])
  store.handle({ type: 'run.cancel', task_id: task.task.id, run_id: run })
  for (let i = 0; i < 5; i++) toolRecord(run, 'list', { kind: 'resource' }, { execution: 'success', delivery: 'delivered' })
  toolRecord(run, 'call', { capability: 'builtin:monty:v1' }, { execution: 'success', delivery: 'failed' })
  toolRecord(run, 'write', '{invalid')
  activityRecord(run, 'message.assistant.partial', { text: 'PARTIAL_BODY' })
  const before = db.prepare('SELECT count(*) n FROM records').get()
  const value = activity(run)
  expect(Array.from(value.request)).toHaveLength(121)
  expect(value.request.endsWith('…')).toBe(true)
  expect(value.items).toHaveLength(3)
  expect(value.items[0]).toMatchObject({ name: 'call', target_id: 'builtin:monty:v1', execution: 'success', delivery: 'failed' })
  expect(value.items[1]).toMatchObject({ name: 'write', operation: null, execution: null })
  expect(value.items[2]).toMatchObject({ type: 'reply', execution: 'partial' })
  activity(run)
  expect(db.prepare('SELECT count(*) n FROM records').get()).toEqual(before)
})
it('shows actual fixture actions without requiring model-wire records', async () => {
  const run = store.start(task.task.id, '练习单', 'fixture', [])
  await vi.advanceTimersByTimeAsync(160)
  expect(activity(run).items).toEqual([
    expect.objectContaining({ type: 'tool', name: 'write', operation: 'surface.update', execution: 'success' }),
    expect.objectContaining({ type: 'reply', execution: 'success' })
  ])
})
