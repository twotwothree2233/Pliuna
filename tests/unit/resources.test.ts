import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, readFileSync, symlinkSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import * as files from '../../src/runtime/resources'
import { RuntimeStore } from '../../src/runtime/store'
import type { Snapshot } from '../../src/shared/types'
let store: RuntimeStore, db: Database.Database, directory: string, task: Snapshot, other: Snapshot, run: string
beforeEach(() => {
  vi.useFakeTimers(); directory = mkdtempSync(join(tmpdir(), 'pliuna-resources-')); store = new RuntimeStore(directory)
  task = store.create('资源隔离'); other = store.create('另一个任务'); db = new Database(join(directory, 'pliuna.sqlite'))
  run = store.start(task.task.id, 'test', 'fixture', [])
})
afterEach(() => { vi.restoreAllMocks(); db.close(); store.close(); rmSync(directory, { recursive: true, force: true }); vi.useRealTimers() })
const create = (content: unknown, display_name = '资源'): any => store.modelTool(task.task.id, run, { type: 'write', input: { type: 'resource.create', display_name, content } })
const read = (id: string, extra = {}, taskId = task.task.id): any => store.handle({ type: 'task.query', task_id: taskId, query: { type: 'read', input: { target: { kind: 'resource', id }, ...extra } } })
const list = (extra = {}, taskId = task.task.id): any => store.handle({ type: 'task.query', task_id: taskId, query: { type: 'list', input: { kind: 'resource', ...extra } } })
const ref = (id: string, name = 'source') => ({ name, target: { kind: 'resource', id } })
const data = (references: unknown[], value = 'value'): Promise<any> => store.agentTool(task.task.id, run, { type: 'write', input: { type: 'task_data.create', data: { schema: { type: 'string' }, value, references } } }, new AbortController().signal)
function nextRun() { store.handle({ type: 'run.cancel', task_id: task.task.id, run_id: run }); run = store.start(task.task.id, 'next', 'fixture', []) }

it.each([null, true, 42, 'JSON-looking {"a":1}', [1, '中😀'], { a: [true, null], text: '中文😀' }])('preserves actual JSON resource value %j', value => {
  const result = create({ type: 'json', value }); expect(result.execution).toBe('success')
  expect(read(result.data.id).data.content).toEqual({ type: 'json', value })
  expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 1 })
})
it('stores plain text without executing markup or interpreting display names as paths', () => {
  const text = '<script>globalThis.SHOULD_NOT_RUN=1</script>\n中文😀'
  const result = create({ type: 'text', text }, '../../not-a-path.html')
  expect(read(result.data.id).data.content.text).toBe(text)
  expect(read(result.data.id).data.storage_key).toBeUndefined()
  expect(readdirSync(join(directory, 'resources'))).toEqual([result.data.id])
})
it('enforces byte boundary before action registration and never converts malformed text', () => {
  const before = db.prepare('SELECT count(*) n FROM actions').get()
  expect(() => create({ type: 'text', text: '中'.repeat(87382) })).toThrow('limit')
  expect(() => create({ type: 'text', text: '\ud800' })).toThrow('Unicode')
  expect(db.prepare('SELECT count(*) n FROM actions').get()).toEqual(before)
  expect(create({ type: 'text', text: 'a'.repeat(262144) }).data.byte_length).toBe(262144)
  expect(create({ type: 'text', text: '' }).data.byte_length).toBe(0)
})
it('treats duplicate valid submissions as independent immutable resources and read-only original actions', () => {
  const a = create({ type: 'text', text: 'same' }), b = create({ type: 'text', text: 'same' })
  expect(a.data.id).not.toBe(b.data.id); expect(a.operation_id).not.toBe(b.operation_id)
  expect(a.data.sha256).toBe(b.data.sha256)
  const original = store.handle({ type: 'task.query', task_id: task.task.id, query: { type: 'read', input: { target: { kind: 'action', id: a.operation_id } } } }) as any
  expect(original.data.result_data.data.id).toBe(a.data.id)
  expect(() => create({ type: 'text', text: 'changed' }, '').data).toThrow()
  expect(() => store.modelTool(task.task.id, run, { type: 'write', input: { type: 'resource.replace', id: a.data.id, value: 'changed' } })).toThrow()
  expect(read(a.data.id).data.content.text).toBe('same')
  expect(list().items).toHaveLength(2)
})
it('pages 201 resources using metadata only, supports display-name filtering, and denies cross-task access', () => {
  for (let i = 0; i < 201; i++) create({ type: 'text', text: 'x' }, 'resource-' + i)
  vi.spyOn(store, 'snapshot').mockImplementation(() => { throw Error('snapshot forbidden') })
  vi.spyOn(files, 'resourceValue').mockImplementation(() => { throw Error('body forbidden during list') })
  let cursor: string | null = null; const ids = new Set<string>()
  do { const page = list(cursor ? { cursor } : {}); for (const item of page.items) { expect(item.storage_key).toBeUndefined(); ids.add(item.id) }; cursor = page.next_cursor } while (cursor)
  expect(ids.size).toBe(201); expect(list({ filters: { name_query: 'resource-200' } }).items).toHaveLength(1)
  expect(list({}, other.task.id).items).toEqual([])
  expect(() => read([...ids][0]!, {}, other.task.id)).toThrow('unavailable')
}, 30000)
it('continues escaped Unicode resource representations without loss and rejects damage mid-read', () => {
  const text = '中文😀\n\\"'.repeat(8000) + '末尾'
  const result = create({ type: 'text', text }); let chunk = read(result.data.id), whole = ''
  const firstCursor = chunk.next_cursor
  do { expect(Buffer.byteLength(JSON.stringify(chunk))).toBeLessThan(32768); whole += chunk.data.text; if (!chunk.next_cursor) break; chunk = read(result.data.id, { cursor: chunk.next_cursor }) } while (true)
  expect(JSON.parse(whole).content.text).toBe(text)
  writeFileSync(join(directory, 'resources', result.data.id), Buffer.alloc(result.data.byte_length))
  expect(() => read(result.data.id, { cursor: firstCursor })).toThrow('checksum')
})
it('atomically registers explicit resource references but never interprets ID-like business text', async () => {
  const resource = create({ type: 'json', value: { source: 1 } })
  const implicit = await data([], resource.data.id)
  expect(db.prepare('SELECT count(*) n FROM object_references').get()).toEqual({ n: 0 })
  const explicit = await data([ref(resource.data.id)])
  expect(db.prepare('SELECT source_id,target_id,protects_resource FROM object_references').all()).toEqual([{ source_id: explicit.data.id, target_id: resource.data.id, protects_resource: 1 }])
  expect(db.prepare('SELECT references_json FROM task_data WHERE id=?').get(implicit.data.id)).toEqual({ references_json: '[]' })
  expect(JSON.parse((db.prepare('SELECT references_json FROM task_data WHERE id=?').get(explicit.data.id) as any).references_json)).toEqual([ref(resource.data.id)])
})
it('rejects duplicate names, missing/cross-task targets, resource revisions and excess references', async () => {
  const resource = create({ type: 'text', text: 'good' }), before = db.prepare('SELECT count(*) n FROM actions').get()
  for (const refs of [[ref(resource.data.id), ref(resource.data.id)], [ref('missing')], [{ name: 'mutable', target: { kind: 'task_data', id: 'any', expected_revision: 1 } }], [{ name: 'r', target: { kind: 'resource', id: resource.data.id, expected_revision: 1 } }], Array.from({ length: 257 }, (_, i) => ref(resource.data.id, String(i)))]) await expect(data(refs)).rejects.toThrow()
  const otherRun = store.start(other.task.id, 'other', 'fixture', [])
  await expect(store.agentTool(other.task.id, otherRun, { type: 'write', input: { type: 'task_data.create', data: { schema: { type: 'string' }, value: 'x', references: [ref(resource.data.id)] } } }, new AbortController().signal)).rejects.toThrow('within this task')
  expect(db.prepare('SELECT count(*) n FROM actions').get()).toEqual(before)
})
it('rolls back data, reference registry and events together if reference persistence fails', async () => {
  const resource = create({ type: 'text', text: 'source' })
  db.exec("CREATE TRIGGER fail_reference BEFORE INSERT ON object_references BEGIN SELECT RAISE(ABORT,'reference failure'); END")
  const before = db.prepare('SELECT count(*) n FROM records').get()
  await expect(data([ref(resource.data.id)])).rejects.toThrow('reference failure')
  expect(db.prepare('SELECT count(*) n FROM task_data').get()).toEqual({ n: 0 })
  expect(db.prepare('SELECT count(*) n FROM object_references').get()).toEqual({ n: 0 })
  expect(db.prepare('SELECT count(*) n FROM records').get()).toEqual(before)
})
it.each(['approve', 'deny', 'cancel', 'damage'] as const)('keeps reference replacement bound to original approval: %s', async decision => {
  const first = create({ type: 'text', text: 'old' }), second = create({ type: 'text', text: 'new' }), object = await data([ref(first.data.id)])
  nextRun()
  const pending = store.agentTool(task.task.id, run, { type: 'write', input: { type: 'task_data.replace', id: object.data.id, expected_revision: 1, value: 'updated', references: [ref(second.data.id)] } }, new AbortController().signal)
  const settled = pending.then(value => ({ value }), error => ({ error }))
  const approval = store.snapshot(task.task.id).approvals[0]!
  expect(JSON.parse((db.prepare('SELECT references_json FROM task_data').get() as any).references_json)[0].target.id).toBe(first.data.id)
  if (decision === 'damage') unlinkSync(join(directory, 'resources', second.data.id))
  if (decision === 'cancel') store.handle({ type: 'run.cancel', task_id: task.task.id, run_id: run })
  else store.handle({ type: 'approval.decide', task_id: task.task.id, approval_id: approval.id, decision: decision === 'deny' ? 'deny' : 'approve' })
  const outcome = await settled
  expect('value' in outcome).toBe(decision === 'approve')
  const row = db.prepare('SELECT revision,references_json FROM task_data').get() as any
  expect(row.revision).toBe(decision === 'approve' ? 2 : 1)
  expect(JSON.parse(row.references_json)[0].target.id).toBe(decision === 'approve' ? second.data.id : first.data.id)
  expect((db.prepare('SELECT target_id FROM object_references').get() as any).target_id).toBe(decision === 'approve' ? second.data.id : first.data.id)
})
it('traces unpublished orphan after DB failure, refuses a valid reference and restarts without replay', () => {
  db.exec("CREATE TRIGGER fail_resource BEFORE INSERT ON resources BEGIN SELECT RAISE(ABORT,'resource failure'); END")
  expect(() => create({ type: 'text', text: 'not committed' })).toThrow('publication failed')
  expect(db.prepare('SELECT count(*) n FROM resources').get()).toEqual({ n: 0 })
  expect(db.prepare('SELECT state FROM staging').get()).toEqual({ state: 'invalid' })
  const key = (db.prepare('SELECT storage_key FROM staging').get() as any).storage_key
  expect(() => read(key)).toThrow('unavailable')
  expect((db.prepare('SELECT result FROM actions').get() as any).result).toBe('not_executed')
  store.close(); store = new RuntimeStore(directory)
  expect(list().items).toEqual([]); expect(readdirSync(join(directory, 'resources'))).toContain(key)
})
it('preserves committed resources/references on restart and retains deleted-task files for explicit cleanup', async () => {
  const resource = create({ type: 'text', text: 'persisted' }); await data([ref(resource.data.id)])
  store.close(); store = new RuntimeStore(directory)
  expect(read(resource.data.id).data.content.text).toBe('persisted')
  expect(db.prepare('SELECT count(*) n FROM object_references').get()).toEqual({ n: 1 })
  expect(store.snapshot(task.task.id).runs[0]!.state).toBe('interrupted')
  store.handle({ type: 'task.delete', task_id: other.task.id }); expect(read(resource.data.id).data.content.text).toBe('persisted')
  store.handle({ type: 'task.delete', task_id: task.task.id }); expect(readdirSync(join(directory, 'resources'))).toEqual([resource.data.id]); expect((store.handle({ type: 'maintenance.resource.list' }) as any).items).toHaveLength(1)
})
it('reports missing, checksum-damaged, symlink and invalid representation without exposing managed paths', () => {
  const resource = create({ type: 'text', text: 'abc' }), path = join(directory, 'resources', resource.data.id)
  unlinkSync(path); expect(() => read(resource.data.id)).toThrow('unavailable')
  const external = join(directory, 'external'); writeFileSync(external, 'abc'); symlinkSync(external, path)
  expect(() => read(resource.data.id)).toThrow('file type')
  unlinkSync(path); writeFileSync(path, 'xyz'); expect(() => read(resource.data.id)).toThrow('checksum')
  writeFileSync(path, Buffer.from([0xff, 0xff, 0xff])); db.prepare('UPDATE resources SET sha256=? WHERE id=?').run(files.digest(readFileSync(path)), resource.data.id)
  expect(() => read(resource.data.id)).toThrow('representation')
})
it('marks file write failure as not executed without exposing a resource', () => {
  vi.spyOn(files, 'publishResourceFile').mockImplementation(() => { throw Error('ENOSPC injected') })
  expect(() => create({ type: 'text', text: 'fail' })).toThrow('publication failed')
  expect(list().items).toHaveLength(0)
  expect(db.prepare('SELECT state FROM staging').get()).toEqual({ state: 'invalid' })
  expect(db.prepare('SELECT result FROM actions').get()).toEqual({ result: 'not_executed' })
})
it('does not commit a resource if the published file fails its pre-commit integrity check', () => {
  const publish = files.publishResourceFile
  vi.spyOn(files, 'publishResourceFile').mockImplementation((root, key, body) => { publish(root, key, body); writeFileSync(join(root, 'resources', key), 'corrupted') })
  expect(() => create({ type: 'text', text: 'original' })).toThrow('mismatch')
  expect(list().items).toEqual([])
  expect(db.prepare('SELECT state FROM staging').get()).toEqual({ state: 'invalid' })
  expect(db.prepare('SELECT result FROM actions').get()).toEqual({ result: 'not_executed' })
})
it('reads existing managed bundle resources only as JSON data', () => {
  const value = { profile: 'managed-v1', html: '<script>not executed</script>' }
  const resource = create({ type: 'json', value })
  db.prepare('UPDATE resources SET media_type=? WHERE id=?').run('application/vnd.pliuna.bundle+json', resource.data.id)
  expect(read(resource.data.id).data.content).toEqual({ type: 'json', value })
})
it('explicitly reports metadata-only representations without claiming verified content', () => {
  const resource = create({ type: 'text', text: 'a' })
  db.prepare('UPDATE resources SET media_type=? WHERE id=?').run('image/png', resource.data.id)
  expect(read(resource.data.id).data).toMatchObject({ content_available: false, reason: 'UNSUPPORTED_REPRESENTATION' })
  expect(read(resource.data.id).data.integrity).toBeUndefined()
  db.prepare('UPDATE resources SET media_type=?,byte_length=? WHERE id=?').run('text/plain; charset=utf-8', 262145, resource.data.id)
  expect(read(resource.data.id).data).toMatchObject({ content_available: false, reason: 'REPRESENTATION_LIMIT' })
  expect(read(resource.data.id).data.content).toBeUndefined()
})
it('accepts the existing 256-reference contract boundary without a smaller hidden cap', async () => {
  const resource = create({ type: 'text', text: 'source' })
  const result = await data(Array.from({ length: 256 }, (_, i) => ref(resource.data.id, 'source-' + i)))
  expect(result.execution).toBe('success')
  expect(db.prepare('SELECT count(*) n FROM object_references').get()).toEqual({ n: 256 })
})
