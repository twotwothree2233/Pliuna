import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { RuntimeStore } from '../../src/runtime/store'
import type { Snapshot } from '../../src/shared/types'

let store: RuntimeStore, db: Database.Database, directory: string, task: Snapshot, other: Snapshot, run: string
beforeEach(() => {
  vi.useFakeTimers(); directory = mkdtempSync(join(tmpdir(), 'pliuna-data-references-')); store = new RuntimeStore(directory)
  task = store.create('版本引用'); other = store.create('另一任务'); db = new Database(join(directory, 'pliuna.sqlite'))
  run = store.start(task.task.id, 'fixture', 'fixture', [])
})
afterEach(() => { db.close(); store.close(); rmSync(directory, { recursive: true, force: true }); vi.useRealTimers() })
const schema = { type: 'string' }
const reference = (id: string, revision = 1, name = 'source') => ({ name, target: { kind: 'task_data', id, expected_revision: revision } })
const write = (input: unknown): Promise<any> => store.agentTool(task.task.id, run, { type: 'write', input }, new AbortController().signal)
const create = (refs: unknown[] = [], value = 'initial') => write({ type: 'task_data.create', data: { schema, value, references: refs } })
const replace = (id: string, revision: number, references: unknown[] = [], value = 'updated') => write({ type: 'task_data.replace', id, expected_revision: revision, value, references })
const remove = (id: string, revision = 1) => write({ type: 'task_data.remove', id, expected_revision: revision })
const query = (kind: string, id: string, expected_revision?: number): any => store.handle({ type: 'task.query', task_id: task.task.id, query: { type: 'read', input: { target: { kind, id, ...(expected_revision === undefined ? {} : { expected_revision }) } } } })
const read = (id: string) => query('task_data', id).data
const rows = () => db.prepare('SELECT source_id,target_kind,target_id,expected_revision,protects_resource,blocks_remove FROM object_references ORDER BY name').all()
function nextRun() { store.handle({ type: 'run.cancel', task_id: task.task.id, run_id: run }); run = store.start(task.task.id, 'next', 'fixture', []) }
const decide = (decision: 'approve' | 'deny') => { const approval = store.snapshot(task.task.id).approvals[0]!; store.handle({ type: 'approval.decide', task_id: task.task.id, approval_id: approval.id, decision }); return approval }
const settled = (promise: Promise<any>) => promise.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))

it('stores exact-version data references with registry protection, without recursive expansion or interpreting strings', async () => {
  const target = await create(), source = await create([reference(target.data.id)], target.data.id)
  expect(read(source.data.id)).toMatchObject({ value: target.data.id, references: [reference(target.data.id)] })
  expect(rows()).toEqual([{ source_id: source.data.id, target_kind: 'task_data', target_id: target.data.id, expected_revision: 1, protects_resource: 0, blocks_remove: 1 }])
  expect(query('task_data', source.data.id).data).not.toHaveProperty('expanded')
  expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 1 })
  await create([], target.data.id); expect(rows()).toHaveLength(1)
})
it.each(['missing revision', 'wrong revision', 'missing target', 'cross task', 'duplicate name', 'unsupported type'] as const)('rejects invalid references before action registration: %s', async fault => {
  const target = await create(), before = db.prepare('SELECT count(*) n FROM actions').get()
  let references: unknown[] = [reference(target.data.id)]
  if (fault === 'missing revision') references = [{ name: 'x', target: { kind: 'task_data', id: target.data.id } }]
  if (fault === 'wrong revision') references = [reference(target.data.id, 2)]
  if (fault === 'missing target') references = [reference('missing')]
  if (fault === 'cross task') { const otherRun = store.start(other.task.id, 'other', 'fixture', []); const item: any = await store.agentTool(other.task.id, otherRun, { type: 'write', input: { type: 'task_data.create', data: { schema, value: 'other', references: [] } } }, new AbortController().signal); references = [reference(item.data.id)] }
  if (fault === 'duplicate name') references = [reference(target.data.id), reference(target.data.id)]
  if (fault === 'unsupported type') references = [{ name: 'x', target: { kind: 'view', id: 'any', expected_revision: 1 } }]
  const count = db.prepare('SELECT count(*) n FROM actions').get()
  await expect(create(references)).rejects.toThrow()
  expect(db.prepare('SELECT count(*) n FROM actions').get()).toEqual(fault === 'cross task' ? count : before)
  expect(rows()).toEqual([])
})
it('allows target updates, preserves stale references, rejects old reads and still blocks removal', async () => {
  const target = await create(), source = await create([reference(target.data.id)])
  await replace(target.data.id, 1)
  expect(read(source.data.id).references).toEqual([reference(target.data.id)])
  expect(() => query('task_data', target.data.id, 1)).toThrow('current revision 2')
  await expect(remove(target.data.id, 2)).rejects.toThrow('including stale versions')
  expect(store.snapshot(task.task.id).approvals).toEqual([])
  await replace(source.data.id, 1, [reference(target.data.id, 2)])
  expect(read(source.data.id).references).toEqual([reference(target.data.id, 2)])
})
it('supports cycles, requires explicit unlinking, then removes independently without cascade', async () => {
  const a = await create(), b = await create([reference(a.data.id)])
  await replace(a.data.id, 1, [reference(b.data.id)])
  await expect(remove(a.data.id, 2)).rejects.toThrow('references')
  await expect(remove(b.data.id)).rejects.toThrow('references')
  await replace(a.data.id, 2, []); const pending = settled(remove(b.data.id)); decide('approve')
  expect((await pending).value).toMatchObject({ data: { id: b.data.id, removed: true, removed_revision: 1 } })
  expect(read(a.data.id).revision).toBe(3); expect(rows()).toEqual([])
})
it('self references block removal until explicitly unlinked, without recursive reads', async () => {
  const a = await create(); await replace(a.data.id, 1, [reference(a.data.id)])
  expect(read(a.data.id).references[0].target.expected_revision).toBe(1)
  await expect(remove(a.data.id, 2)).rejects.toThrow('references')
  await replace(a.data.id, 2, []); const pending = settled(remove(a.data.id, 3)); decide('approve'); expect((await pending).value.execution).toBe('success')
})
it.each(['approve', 'deny', 'cancel', 'expire'] as const)('always requires separate removal approval, even within creator Run: %s', async decision => {
  const object = await create(), pending = settled(remove(object.data.id))
  expect(read(object.data.id).revision).toBe(1)
  const approval = store.snapshot(task.task.id).approvals[0]!
  expect(JSON.parse((db.prepare('SELECT binding_json FROM approvals WHERE id=?').get(approval.id) as any).binding_json).policy).toBe('task-data-remove-v1')
  if (decision === 'cancel') store.handle({ type: 'run.cancel', task_id: task.task.id, run_id: run })
  else if (decision === 'expire') { db.prepare('UPDATE approvals SET expires_at=? WHERE id=?').run(new Date(Date.now() - 1).toISOString(), approval.id); expect(() => decide('approve')).toThrow('expired') }
  else decide(decision)
  const outcome = await pending
  if (decision === 'approve') { expect(outcome.value.data.removed).toBe(true); expect(() => read(object.data.id)).toThrow('unavailable') }
  else { expect(outcome.error).toBeDefined(); expect(read(object.data.id).revision).toBe(1) }
  expect(() => store.handle({ type: 'approval.decide', task_id: task.task.id, approval_id: approval.id, decision: 'approve' })).toThrow()
})
it.each(['version', 'incoming', 'payload', 'policy'] as const)('rechecks removal bindings and protection after approval: %s', async change => {
  const object = await create(), source = await create(), pending = settled(remove(object.data.id))
  if (change === 'version') db.prepare('UPDATE task_data SET revision=2 WHERE id=?').run(object.data.id)
  if (change === 'incoming') db.prepare("INSERT INTO object_references VALUES (?,'task_data',?,'new','task_data',?,1,0,1)").run(task.task.id, source.data.id, object.data.id)
  if (change === 'payload') db.prepare("UPDATE actions SET request_json='{}' WHERE id=(SELECT action_id FROM approvals LIMIT 1)").run()
  if (change === 'policy') { const row = db.prepare('SELECT id,binding_json FROM approvals LIMIT 1').get() as any; db.prepare('UPDATE approvals SET binding_json=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(row.binding_json), policy: 'task-data-v1' }), row.id) }
  decide('approve'); expect((await pending).error).toBeDefined(); expect(read(object.data.id)).toBeDefined()
  expect(store.snapshot(task.task.id).records.filter(x => x.kind === 'task_data.removed')).toEqual([])
})
it.each(['changed', 'removed'] as const)('revalidates outgoing task_data reference after replacement approval: %s target', async change => {
  const target = await create(), source = await create(); nextRun()
  const pending = settled(replace(source.data.id, 1, [reference(target.data.id)]))
  if (change === 'changed') db.prepare('UPDATE task_data SET revision=2 WHERE id=?').run(target.data.id)
  else db.prepare('DELETE FROM task_data WHERE id=?').run(target.data.id)
  decide('approve'); expect((await pending).error).toBeDefined(); expect(read(source.data.id)).toMatchObject({ revision: 1, value: 'initial', references: [] }); expect(rows()).toEqual([])
})
it('rolls removal, outgoing references, records and success result back on database failure', async () => {
  const target = await create(), source = await create([reference(target.data.id)])
  db.exec("CREATE TRIGGER fail_removal BEFORE INSERT ON records WHEN NEW.kind='task_data.removed' BEGIN SELECT RAISE(ABORT,'removal failure'); END")
  const prior = rows(), pending = settled(remove(source.data.id)); decide('approve'); expect((await pending).error).toBeDefined()
  expect(read(source.data.id).revision).toBe(1); expect(rows()).toEqual(prior)
  expect(db.prepare("SELECT count(*) n FROM actions WHERE result='success' AND json_extract(request_json,'$.type')='task_data.remove'").get()).toEqual({ n: 0 })
})
it('rolls reference replacement and business changes back together', async () => {
  const target = await create(), source = await create()
  db.exec("CREATE TRIGGER fail_ref BEFORE INSERT ON object_references BEGIN SELECT RAISE(ABORT,'ref failure'); END")
  await expect(replace(source.data.id, 1, [reference(target.data.id)])).rejects.toThrow('ref failure')
  expect(read(source.data.id)).toMatchObject({ revision: 1, value: 'initial', references: [] }); expect(rows()).toEqual([])
})
it('rejects cross-task, stale-version and cancelled-source removal before authorization', async () => {
  const object = await create(), otherRun = store.start(other.task.id, 'other', 'fixture', [])
  await expect(store.agentTool(other.task.id, otherRun, { type: 'write', input: { type: 'task_data.remove', id: object.data.id, expected_revision: 1 } }, new AbortController().signal)).rejects.toThrow('not found')
  await expect(remove(object.data.id, 2)).rejects.toThrow('revision')
  const controller = new AbortController(); controller.abort()
  await expect(store.agentTool(task.task.id, run, { type: 'write', input: { type: 'task_data.remove', id: object.data.id, expected_revision: 1 } }, controller.signal)).rejects.toThrow('cancelled')
  expect(store.snapshot(task.task.id).approvals).toEqual([])
})
it('does not reuse a replacement approval or re-open a denied removal in the same Run', async () => {
  const object = await create(); nextRun()
  const edit = settled(replace(object.data.id, 1)); decide('approve'); expect((await edit).value.data.revision).toBe(2)
  const deletion = settled(remove(object.data.id, 2)); expect(store.snapshot(task.task.id).approvals).toHaveLength(2); decide('deny'); await deletion
  await expect(remove(object.data.id, 2)).rejects.toThrow('denied in the current Run')
  expect(store.snapshot(task.task.id).approvals).toHaveLength(2)
})
it('keeps removed original Action queryable across restart and never replays deletion or removes resource files', async () => {
  const resource: any = store.modelTool(task.task.id, run, { type: 'write', input: { type: 'resource.create', display_name: 'material', content: { type: 'text', text: 'saved' } } })
  const source = await create([{ name: 'r', target: { kind: 'resource', id: resource.data.id } }])
  const pending = settled(remove(source.data.id)); decide('approve'); const result = (await pending).value
  const before = db.prepare('SELECT count(*) n FROM actions').get()
  expect(rows()).toEqual([]); expect(existsSync(join(directory, 'resources', resource.data.id))).toBe(true)
  store.close(); store = new RuntimeStore(directory)
  expect(() => read(source.data.id)).toThrow('unavailable')
  for (let i = 0; i < 2; i++) expect(query('action', result.operation_id).data.result_data.data).toMatchObject({ removed: true, removed_revision: 1 })
  expect(db.prepare('SELECT count(*) n FROM actions').get()).toEqual(before)
  expect(query('resource', resource.data.id).data.content.text).toBe('saved')
})
it('removes a whole task with cyclic references without requiring manual unlinking or touching other tasks', async () => {
  const a = await create(), b = await create([reference(a.data.id)]); await replace(a.data.id, 1, [reference(b.data.id)])
  store.handle({ type: 'task.delete', task_id: task.task.id })
  expect(rows()).toEqual([]); expect(store.snapshot(other.task.id).task.title).toBe('另一任务')
})
it('fences new writes by the waiting Run instead of allowing it to mutate while awaiting removal', async () => {
  const target = await create(), pending = settled(remove(target.data.id))
  await expect(create([reference(target.data.id)])).rejects.toThrow('Awaiting approval')
  decide('deny'); expect((await pending).error).toBeDefined()
  expect(read(target.data.id).revision).toBe(1); expect(rows()).toEqual([])
})
it('keeps mixed immutable-resource and versioned-data protections distinct', async () => {
  const target = await create()
  const resource: any = store.modelTool(task.task.id, run, { type: 'write', input: { type: 'resource.create', display_name: 'r', content: { type: 'text', text: 'r' } } })
  const source = await create([reference(target.data.id), { name: 'resource', target: { kind: 'resource', id: resource.data.id } }])
  expect(rows()).toEqual(expect.arrayContaining([
    expect.objectContaining({ target_kind: 'resource', expected_revision: null, protects_resource: 1, blocks_remove: 0 }),
    expect.objectContaining({ target_kind: 'task_data', expected_revision: 1, protects_resource: 0, blocks_remove: 1 })
  ]))
  const pending = settled(remove(source.data.id)); decide('approve'); await pending
  expect(rows()).toEqual([]); expect(read(target.data.id).revision).toBe(1)
  expect(query('resource', resource.data.id).data.content.text).toBe('r')
})
it('revokes pending deletion on restart without replay and retains object plus original action', async () => {
  const object = await create(), pending = settled(remove(object.data.id)), approval = store.snapshot(task.task.id).approvals[0]!
  store.close(); await pending; store = new RuntimeStore(directory)
  expect(read(object.data.id).revision).toBe(1)
  expect(query('action', approval.action_id).data).toMatchObject({ state: 'ended', result: 'not_executed' })
  expect(() => store.handle({ type: 'approval.decide', task_id: task.task.id, approval_id: approval.id, decision: 'approve' })).toThrow()
})
