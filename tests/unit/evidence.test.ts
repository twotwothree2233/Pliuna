import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { RuntimeStore } from '../../src/runtime/store'
import { ModelService } from '../../src/runtime/model/service'
import * as evidence from '../../src/runtime/evidence'
import type { Bundle } from '../../src/shared/contracts.generated'
import type { Snapshot } from '../../src/shared/types'

let store: RuntimeStore, db: Database.Database, root: string, task: Snapshot, run: string
const schema = { type: 'object' as const, properties: { text: { type: 'string' as const } }, required: ['text'], additionalProperties: false as const }
const bundle: Bundle = { profile: 'managed-v1', html: '<textarea id="a"></textarea><button id="s">提交</button>', css: '', state: { schema, initial: { text: '' }, compatibility_version: 'e1' }, forms: [{ id: 'f', fields: ['/text'] }], behaviors: [{ type: 'input', element_id: 'a', field: '/text', control: 'textarea' }, { type: 'submit', element_id: 's', form_id: 'f' }], references: [], export: [] }
beforeEach(() => {
  vi.useFakeTimers(); root = mkdtempSync(join(tmpdir(), 'pliuna-evidence-'))
  store = new RuntimeStore(root, new ModelService(), { viewReplacement: true }); task = store.create('证据验收')
  db = new Database(join(root, 'pliuna.sqlite')); run = store.start(task.task.id, 'held', 'fixture', [])
})
afterEach(() => { vi.restoreAllMocks(); db.close(); store.close(); rmSync(root, { recursive: true, force: true }); vi.useRealTimers() })
async function data(text = '原始依据', references: unknown[] = []) {
  const result = await store.agentTool(task.task.id, run, { type: 'write', input: { type: 'task_data.create', data: { schema, value: { text }, references } } }, new AbortController().signal) as any
  return result.data.id as string
}
const source = (id: string, revision = 1) => ({ kind: 'task_data', id, expected_revision: revision })
function publish(sources: unknown[] = [], count = 1): any {
  const surface = store.snapshot(task.task.id).surface
  return store.modelTool(task.task.id, run, { type: 'write', input: { type: 'surface.update', surface_id: surface.id, expected_revision: surface.revision, snapshot_sources: sources, operations: Array.from({ length: count }, (_, n) => ({ type: 'view.create', client_ref: 'v' + n, slot_id: 'main', bundle: { type: 'inline', bundle } })) } })
}
function query(kind: string, id?: string, extra = {}, taskId = task.task.id): any {
  return store.handle({ type: 'task.query', task_id: taskId, query: id ? { type: 'read', input: { target: { kind, id }, ...extra } } : { type: 'list', input: { kind, ...extra } } })
}
function history(): any { return query('view_history', query('view_history').items[0].id).data }
function change(id: string, text = '新依据') { db.prepare('UPDATE task_data SET revision=revision+1,value_json=? WHERE id=?').run(JSON.stringify({ text }), id) }
async function tick() { for (let i = 0; i < 12; i++) await Promise.resolve() }
function replace(sources: unknown[]) {
  const snapshot = store.snapshot(task.task.id), view = snapshot.views[0]!
  return store.agentTool(task.task.id, run, { type: 'write', input: { type: 'surface.update', surface_id: snapshot.surface.id, expected_revision: snapshot.surface.revision, snapshot_sources: sources, operations: [{ type: 'view.replace', view_id: view.id, expected_view_revision: view.revision, bundle: { type: 'inline', bundle }, state_transition: { type: 'preserve', expected_state_revision: view.state_revision, compatibility_version: 'e1' } }] } }, new AbortController().signal).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
}
function approve() { store.handle({ type: 'approval.decide', task_id: task.task.id, approval_id: store.snapshot(task.task.id).approvals.at(-1)!.id, decision: 'approve' }) }
function respond(proceed = true): any { return store.handle({ type: 'surface.respond', task_id: task.task.id, action_id: store.snapshot(task.task.id).surface_updates[0]!.action_id, proceed, confirm_discard: false }) }

it('freezes exactly the declared schema/value/references for every affected View', async () => {
  const a = await data(), b = await data('not declared'); publish([source(a)], 2)
  const rows = query('view_history').items
  expect(rows).toHaveLength(2); expect(rows[0].evidence).toBeUndefined()
  for (const row of rows) expect(query('view_history', row.id).data.evidence.sources).toEqual([{ kind: 'task_data', id: a, revision: 1, schema, value: { text: '原始依据' }, references: [], resources: [] }])
  expect(JSON.stringify(history())).not.toContain(b); expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 1 })
})
it.each([
  { kind: 'resource', id: 'x' }, { kind: 'view', id: 'x', expected_revision: 1 }, { kind: 'task_data', id: 'x' },
  { kind: 'task_data', id: 'x', expected_revision: 1 }
])('rejects unsupported/missing evidence before registering an action: %j', target => {
  const before = db.prepare('SELECT count(*) n FROM actions').get()
  expect(() => publish([target])).toThrow(); expect(db.prepare('SELECT count(*) n FROM actions').get()).toEqual(before)
})
it('rejects duplicate, stale and cross-task sources', async () => {
  const id = await data(); expect(() => publish([source(id), source(id)])).toThrow('Duplicate')
  change(id); expect(() => publish([source(id)])).toThrow('revision changed')
  const other = store.create('other'); task = other
  expect(() => evidence.captureEvidence(db, root, other.task.id, [source(id, 2)])).toThrow('unavailable')
})
it('enforces source count and aggregate byte limits without truncation', async () => {
  const a = await data('a'.repeat(150000)), b = await data('b'.repeat(150000))
  expect(() => publish([source(a), source(b)])).toThrow('byte limit')
  expect(() => evidence.captureEvidence(db, root, task.task.id, Array.from({ length: 33 }, () => source(a)))).toThrow('Too many')
  expect(query('view_history').items).toEqual([])
})
it('does not recursively resolve stale, cyclic or implicit mutable references', async () => {
  const a = await data(), b = await data('referencer', [{ name: 'mutable', target: source(a) }]); change(a)
  db.prepare('UPDATE task_data SET references_json=? WHERE id=?').run(JSON.stringify([{ name: 'self', target: source(b) }, { name: 'stale', target: source(a) }]), b)
  publish([source(b)]); expect(history().evidence.sources).toHaveLength(1)
  expect(history().evidence.sources[0].references).toHaveLength(2)
})
it('keeps frozen evidence after source update and manually approved removal', async () => {
  const id = await data(); publish([source(id)]); const before = history().evidence; change(id)
  const pending = store.agentTool(task.task.id, run, { type: 'write', input: { type: 'task_data.remove', id, expected_revision: 2 } }, new AbortController().signal)
  await tick(); approve(); await pending
  expect(query('task_data').items).toEqual([]); expect(history().evidence).toEqual(before)
  expect(db.prepare("SELECT * FROM object_references WHERE target_kind='task_data'").all()).toEqual([])
})
it('protects direct immutable resources and original bundle without source deletion blockers', async () => {
  const r: any = store.modelTool(task.task.id, run, { type: 'write', input: { type: 'resource.create', display_name: '材料', content: { type: 'text', text: 'saved' } } })
  const id = await data('evidence', [{ name: 'material', target: { kind: 'resource', id: r.data.id } }]); publish([source(id)])
  const refs: any[] = db.prepare("SELECT * FROM object_references WHERE source_kind='view_history'").all()
  expect(refs).toHaveLength(2); expect(refs.every(ref => ref.protects_resource === 1 && ref.blocks_remove === 0)).toBe(true)
  writeFileSync(join(root, 'resources', r.data.id), 'broken')
  expect(history().evidence.sources[0].value).toEqual({ text: 'evidence' })
  expect(history().resource_status).toContainEqual({ id: r.data.id, integrity: 'unavailable', reason: 'RESOURCE_CORRUPT' })
  expect(() => publish([source(id)])).toThrow('mismatch')
})
it('binds answers to original View history, not current sources or replacement', async () => {
  const id = await data(); publish([source(id)]); change(id)
  const view = store.snapshot(task.task.id).views[0]!
  const answer: any = store.handle({ type: 'answer.submit', task_id: task.task.id, view_id: view.id, view_revision: 1, expected_state_revision: 1, form_id: 'f' })
  const pending = replace([source(id, 2)]); await tick(); approve(); await tick(); await respond(); expect((await pending).error).toBeUndefined()
  expect(query('answer', answer.answer_id).data.view_history.evidence.sources[0]).toMatchObject({ revision: 1, value: { text: '原始依据' } })
  const second = query('view_history').items[1]; expect(query('view_history', second.id).data.evidence.sources[0].revision).toBe(2)
})
it.each(['approval', 'host', 'deleted', 'same_revision'])('rejects evidence races during %s without changing View history', async phase => {
  const id = await data(); publish()
  if (phase === 'approval') {
    const v = store.snapshot(task.task.id).views[0]!
    store.handle({ type: 'draft.save', task_id: task.task.id, view_id: v.id, view_revision: 1, expected_state_revision: 1, fields: [{ path: '/text', value: 'saved' }] })
  }
  const pending = replace([source(id)]); await tick()
  if (phase === 'deleted') db.prepare('DELETE FROM task_data WHERE id=?').run(id)
  else if (phase === 'same_revision') db.prepare('UPDATE task_data SET value_json=? WHERE id=?').run('{"text":"tampered"}', id)
  else change(id)
  if (phase === 'approval') approve()
  else await expect(respond()).rejects.toBeDefined()
  expect((await pending).error).toBeDefined(); expect(query('view_history').items).toHaveLength(1)
  expect(store.snapshot(task.task.id).views[0]!.revision).toBe(1)
})
it('rechecks evidence in the final publication transaction', async () => {
  const id = await data(), original = evidence.checkEvidence
  let calls = 0
  vi.spyOn(evidence, 'checkEvidence').mockImplementation((...args) => { if (++calls === 2) args[0].prepare('UPDATE task_data SET revision=revision+1 WHERE id=?').run(id); original(...args) })
  expect(() => publish([source(id)])).toThrow('revision changed'); expect(query('view_history').items).toEqual([])
  expect(store.snapshot(task.task.id).surface.revision).toBe(1)
})
it('rolls back history/resource protection/Views on transaction failure', async () => {
  const id = await data()
  db.exec("CREATE TRIGGER fail_history BEFORE INSERT ON object_references WHEN NEW.source_kind='view_history' BEGIN SELECT RAISE(ABORT,'injected'); END")
  expect(() => publish([source(id)])).toThrow('injected')
  expect(query('view_history').items).toEqual([]); expect(store.snapshot(task.task.id).views).toEqual([])
  expect(db.prepare("SELECT * FROM object_references WHERE source_kind='view_history'").all()).toEqual([])
  expect(db.prepare("SELECT result FROM actions ORDER BY rowid DESC LIMIT 1").get()).toEqual({ result: 'not_executed' })
})
it('continues long historical evidence, preserves restart and scopes access', async () => {
  const text = '中文😀\\\"\n'.repeat(3000), id = await data(text); publish([source(id)])
  const hid = query('view_history').items[0].id; let result = query('view_history', hid), whole = ''
  do { expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(32768); whole += result.data.text; if (!result.next_cursor) break; result = query('view_history', hid, { cursor: result.next_cursor }) } while (true)
  expect(JSON.parse(whole).evidence.sources[0].value.text).toBe(text)
  const other = store.create('other'); expect(() => query('view_history', hid, {}, other.task.id)).toThrow('unavailable')
  const actionCount = db.prepare('SELECT count(*) n FROM actions').get(); store.close(); store = new RuntimeStore(root)
  expect(query('view_history').items).toHaveLength(1); expect(db.prepare('SELECT count(*) n FROM actions').get()).toEqual(actionCount)
})
it('represents legacy histories as explicitly empty evidence without inventing sources', () => {
  publish(); const row: any = db.prepare('SELECT * FROM view_history').get()
  db.prepare('UPDATE view_history SET evidence_snapshot_json=? WHERE id=?').run('{"initial":{"text":"legacy"}}', row.id)
  expect(history()).toMatchObject({ initial: { text: 'legacy' }, evidence: { version: 1, sources: [] } })
})
it('does not accept altered resource metadata as original historical integrity', async () => {
  const resource: any = store.modelTool(task.task.id, run, { type: 'write', input: { type: 'resource.create', display_name: '材料', content: { type: 'text', text: 'original' } } })
  const id = await data('evidence', [{ name: 'r', target: { kind: 'resource', id: resource.data.id } }]); publish([source(id)])
  db.prepare('UPDATE resources SET media_type=? WHERE id=?').run('application/json', resource.data.id)
  expect(history().resource_status).toContainEqual({ id: resource.data.id, integrity: 'unavailable', reason: 'RESOURCE_CORRUPT' })
})
it('rechecks frozen values inside replacement commit without reading files in the transaction', async () => {
  const id = await data(); publish(); const original = evidence.checkEvidence
  vi.spyOn(evidence, 'checkEvidence').mockImplementation((...args) => {
    if (args[4] === false) args[0].prepare('UPDATE task_data SET revision=revision+1 WHERE id=?').run(id)
    original(...args)
  })
  const pending = replace([source(id)]); await tick(); await expect(respond()).rejects.toMatchObject({ code: 'SURFACE_NOT_COMMITTED' })
  expect((await pending).error).toMatchObject({ code: 'VERSION_CONFLICT' })
  expect(query('view_history').items).toHaveLength(1)
})
it.each(['deny', 'host_cancel', 'run_cancel'])('keeps existing evidence on %s', async mode => {
  const id = await data(); publish([source(id)]); const before = history()
  if (mode === 'deny') {
    const view = store.snapshot(task.task.id).views[0]!
    store.handle({ type: 'draft.save', task_id: task.task.id, view_id: view.id, view_revision: 1, expected_state_revision: 1, fields: [{ path: '/text', value: 'saved' }] })
  }
  const pending = replace([source(id)]); await tick()
  if (mode === 'deny') store.handle({ type: 'approval.decide', task_id: task.task.id, approval_id: store.snapshot(task.task.id).approvals.at(-1)!.id, decision: 'deny' })
  else if (mode === 'host_cancel') await respond(false)
  else store.handle({ type: 'run.cancel', task_id: task.task.id, run_id: run })
  expect((await pending).error).toBeDefined(); expect(history()).toEqual(before)
  expect(query('view_history').items).toHaveLength(1)
})
it('publishes a new explicitly empty evidence set without carrying old sources forward', async () => {
  const id = await data(); publish([source(id)])
  const pending = replace([]); await tick(); await respond(); expect((await pending).error).toBeUndefined()
  const rows = query('view_history').items
  expect(query('view_history', rows[0].id).data.evidence.sources).toHaveLength(1)
  expect(query('view_history', rows[1].id).data.evidence.sources).toEqual([])
})
