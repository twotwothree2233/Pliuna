import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { RuntimeStore } from '../../src/runtime/store'
import { captureCheck, generateCheck, ExportChecks, type CheckSnapshot, type CheckResult } from '../../src/runtime/export-check'
import { generateExport } from '../../src/runtime/export-generation'
import { operationContract } from '../../src/runtime/model/operation-contracts'
import type { Bundle } from '../../src/shared/contracts.generated'

let root: string, store: RuntimeStore, db: Database.Database, task: string, run: string
let pending: { snapshot: CheckSnapshot; resolve(result: CheckResult): void; reject(error: Error): void; exit(): void; stop: ReturnType<typeof vi.fn> }[]
beforeEach(() => {
  vi.useFakeTimers(); pending = []
  root = mkdtempSync(join(tmpdir(), 'pliuna-async-export-check-'))
  store = new RuntimeStore(root, undefined, { viewReplacement: true }, undefined, undefined, snapshot => {
    let resolve!: (result: CheckResult) => void, reject!: (error: Error) => void, exit!: () => void
    const result = new Promise<CheckResult>((yes, no) => { resolve = yes; reject = no })
    const stopped = new Promise<void>(yes => { exit = () => { reject(Error('stopped')); yes() } })
    const stop = vi.fn(() => stopped)
    pending.push({ snapshot, resolve, reject, exit, stop }); return { result, stop }
  })
  task = store.create('Async selection synthetic').task.id; run = store.start(task, 'held synthetic fixture', 'fixture', [])
  db = new Database(join(root, 'pliuna.sqlite'))
})
afterEach(async () => { for (const item of pending) item.exit(); await Promise.resolve(); await store.shutdown(); db.close(); vi.useRealTimers() })
function publish(extra = '') {
  const bundle: Bundle = JSON.parse((operationContract('surface.update')!.example as any).input_json).operations[0].bundle.bundle
  bundle.html += extra
  const surface = (store as any).one('SELECT * FROM surfaces WHERE task_id=?', task)
  store.modelTool(task, run, { type: 'write', input: { type: 'surface.update', surface_id: surface.id, expected_revision: surface.revision, operations: [{ type: 'view.create', client_ref: 'fixture', slot_id: 'main', bundle: { type: 'inline', bundle } }] } })
  return (db.prepare('SELECT id FROM views ORDER BY rowid DESC LIMIT 1').get() as any).id as string
}
function selection(view: string) { return { task_id: task, view_ids: [view], answer_ids: [], expected_revision: (store as any).one('SELECT revision FROM surfaces WHERE task_id=?', task).revision } }
const start = (view: string): any => store.handle({ type: 'export.check.start', ...selection(view) })
const status = (id: string, offset = 0): any => store.handle({ type: 'export.check.status', task_id: task, check_id: id, offset })
async function complete(index = 0) { pending[index]!.resolve(generateCheck(pending[index]!.snapshot)); await Promise.resolve(); await Promise.resolve() }
const counts = () => Object.fromEntries(['records', 'actions', 'resources', 'approvals', 'view_history', 'views'].map(t => [t, (db.prepare('SELECT count(*) n FROM ' + t).get() as any).n]))

it('starts without conversion, transfers no paths, and installs diagnostics identical to synchronous export', async () => {
  const view = publish(Array.from({ length: 75 }, (_, i) => `<p id="outside-${i}">PRIVATE_SENTINEL</p>`).join('')), before = counts(), files = readdirSync(root)
  const original: any = store.handle({ type: 'export.check', ...selection(view) }), check = start(view)
  expect(check).toMatchObject({ phase: 'checking', exited: false }); expect(status(check.id).issues).toBeUndefined()
  expect(JSON.stringify(pending[0]!.snapshot)).not.toContain(root)
  expect(check.metrics.snapshot_bytes).toBeGreaterThan(0)
  await complete()
  const first = status(check.id), second = status(check.id, first.next_offset)
  expect(first).toMatchObject({ phase: 'ready', exited: true, complete: false, issue_count: 75 })
  expect([...first.issues, ...second.issues]).toEqual(original.issues.concat((store.handle({ type: 'export.check', ...selection(view), offset: 50 }) as any).issues))
  expect(JSON.stringify(first)).not.toContain('PRIVATE_SENTINEL')
  expect(counts()).toEqual(before); expect(readdirSync(root)).toEqual(files); expect(store.handle({ type: 'export.list', task_id: task })).toEqual([])
})
it('acknowledges cancelling before exit and discards a late success', async () => {
  const check = start(publish())
  const cancelled: any = store.handle({ type: 'export.check.cancel', task_id: task, check_id: check.id })
  expect(cancelled).toMatchObject({ phase: 'cancelling', exited: false })
  expect(() => start('unused-while-busy')).toThrow(expect.objectContaining({ code: 'EXPORT_CHECK_BUSY' }))
  pending[0]!.resolve({ complete: true, issues: [], issue_codes: [] }); await Promise.resolve(); await Promise.resolve()
  expect(status(check.id)).toMatchObject({ phase: 'cancelled', exited: true }); expect(status(check.id).complete).toBeUndefined()
  pending[0]!.exit(); await Promise.resolve()
})
it('waits for stop confirmation and invokes stop only once', async () => {
  const check = start(publish())
  for (let i = 0; i < 2; i++) store.handle({ type: 'export.check.cancel', task_id: task, check_id: check.id })
  expect(pending[0]!.stop).toHaveBeenCalledTimes(1)
  expect(status(check.id).exited).toBe(false); pending[0]!.exit(); await Promise.resolve(); await Promise.resolve()
  expect(status(check.id)).toMatchObject({ phase: 'cancelled', exited: true })
})
it.each(['surface', 'metadata', 'association', 'bytes'])('invalidates changed %s before installing the result', async kind => {
  const view = publish(), check = start(view), resource: any = db.prepare('SELECT r.* FROM resources r JOIN views v ON v.bundle_resource_id=r.id WHERE v.id=?').get(view)
  if (kind === 'surface') db.prepare('UPDATE surfaces SET revision=revision+1 WHERE task_id=?').run(task)
  if (kind === 'metadata') db.prepare("UPDATE resources SET display_name='changed' WHERE id=?").run(resource.id)
  if (kind === 'association') db.prepare('DELETE FROM task_resources WHERE task_id=? AND resource_id=?').run(task, resource.id)
  if (kind === 'bytes') writeFileSync(join(root, 'resources', resource.storage_key), Buffer.alloc(resource.byte_length))
  await complete(); expect(status(check.id)).toMatchObject({ phase: 'invalidated', error: 'EXPORT_SOURCE_CHANGED', exited: true }); expect(status(check.id).issues).toBeUndefined()
})
it('revalidates every diagnostic page without rerunning conversion', async () => {
  const view = publish('<p id="uncovered">outside</p>'), check = start(view); await complete(); expect(status(check.id).phase).toBe('ready')
  const resource: any = db.prepare('SELECT r.* FROM resources r JOIN views v ON v.bundle_resource_id=r.id WHERE v.id=?').get(view)
  writeFileSync(join(root, 'resources', resource.storage_key), Buffer.alloc(resource.byte_length))
  expect(status(check.id)).toMatchObject({ phase: 'invalidated', error: 'EXPORT_SOURCE_CHANGED' }); expect(pending).toHaveLength(1)
})
it('rejects foreign lookup, invalid offset and extra fields', () => {
  const check = start(publish()), foreign = store.create('foreign').task.id
  expect(() => store.handle({ type: 'export.check.status', task_id: foreign, check_id: check.id })).toThrow(expect.objectContaining({ code: 'EXPORT_CHECK_NOT_FOUND' }))
  expect(() => status(check.id, -1)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
  expect(() => store.handle({ type: 'export.check.cancel', task_id: task, check_id: check.id, offset: 0 })).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
})
it('keeps verified bytes independent of later disk writes and preserves image omission parity', () => {
  const view = publish(), resolved = (store as any).resolveExportSelection({ type: 'export.check.start', ...selection(view) }), captured = captureCheck(resolved.input)
  const resource = resolved.input.resources[0], old = readFileSync(join(root, 'resources', resource.storage_key))
  writeFileSync(join(root, 'resources', resource.storage_key), Buffer.alloc(resource.byte_length))
  expect(generateCheck(captured.snapshot).complete).toBe(true)
  writeFileSync(join(root, 'resources', resource.storage_key), old)
  expect(generateCheck(captured.snapshot).issue_codes).toEqual(generateExport(resolved.input).issues)
})
it('does not recreate ephemeral checks after isolated restart', async () => {
  const check = start(publish()); pending[0]!.exit(); await store.shutdown()
  store = new RuntimeStore(root)
  expect(() => status(check.id)).toThrow(expect.objectContaining({ code: 'EXPORT_CHECK_NOT_FOUND' }))
  expect(store.handle({ type: 'export.list', task_id: task })).toEqual([])
})
it('classifies background failure without exposing an untrusted message', async () => {
  const check = start(publish()); pending[0]!.reject(Error('/private/sentinel')); await Promise.resolve(); await Promise.resolve()
  expect(status(check.id)).toMatchObject({ phase: 'failed', error: 'EXPORT_CHECK_FAILED', exited: true }); expect(JSON.stringify(status(check.id))).not.toContain('sentinel')
})
it('does not let completion of an old stop erase a replacement slot', async () => {
  let resolve!: (value: CheckResult) => void, stop!: () => void
  const checks = new ExportChecks(() => ({ result: new Promise(yes => { resolve = yes }), stop: () => new Promise(yes => { stop = yes }) }))
  const fixed: any = { snapshot: { input: {}, bodies: [] }, fingerprint: 'a', bytes: 0, capture_ms: 0, copy_ms: 0 }
  const first: any = checks.start('t', fixed, () => {}), stopping = checks.stop()
  resolve({ complete: true, issues: [], issue_codes: [] }); await Promise.resolve(); await Promise.resolve()
  const next: any = checks.start('t', fixed, () => {})
  stop(); await stopping
  expect(checks.status('t', next.id, 0)).toMatchObject({ id: next.id, phase: 'checking' }); expect(next.id).not.toBe(first.id)
})

it('keeps formal preparation independent after a successful check', async () => {
  const view = publish(), check = start(view); await complete(); expect(status(check.id).complete).toBe(true)
  const resource: any = db.prepare('SELECT r.* FROM resources r JOIN views v ON v.bundle_resource_id=r.id WHERE v.id=?').get(view)
  writeFileSync(join(root, 'resources', resource.storage_key), Buffer.alloc(resource.byte_length))
  expect(() => store.handle({ type: 'export.prepare', ...selection(view) })).toThrow(expect.objectContaining({ code: 'RESOURCE_CORRUPT' }))
  expect(store.handle({ type: 'export.list', task_id: task })).toEqual([])
})
it('clears checks on task deletion while the worker exits independently', async () => {
  const check = start(publish())
  await store.handle({ type: 'task.delete', task_id: task })
  expect(pending[0]!.stop).toHaveBeenCalledTimes(1)
  pending[0]!.exit(); await Promise.resolve(); await Promise.resolve()
  expect((store as any).exportChecks.busy()).toBe(false)
  expect(store.tasks()).toEqual([])
})
it('enforces personal selection and includes immutable original-question diagnostics', async () => {
  const b: Bundle = JSON.parse((operationContract('surface.update')!.example as any).input_json).operations[0].bundle.bundle
  b.html += '<label for="response">Original label</label><input id="response"><button id="send">Original submit</button>'
  b.state = { schema: { type: 'object', properties: { response: { type: 'string' } }, required: ['response'], additionalProperties: false }, initial: { response: 'PRIVATE_ANSWER' }, compatibility_version: 'answer' }
  b.forms = [{ id: 'form', fields: ['/response'] }]; b.behaviors = [{ type: 'input', element_id: 'response', field: '/response', control: 'text' }, { type: 'submit', element_id: 'send', form_id: 'form' }]
  const surface = (store as any).one('SELECT * FROM surfaces WHERE task_id=?', task)
  store.modelTool(task, run, { type: 'write', input: { type: 'surface.update', surface_id: surface.id, expected_revision: surface.revision, operations: [{ type: 'view.create', client_ref: 'q', slot_id: 'main', bundle: { type: 'inline', bundle: b } }] } })
  const question: any = db.prepare('SELECT * FROM views ORDER BY rowid DESC LIMIT 1').get()
  store.handle({ type: 'answer.submit', task_id: task, view_id: question.id, view_revision: 1, expected_state_revision: 1, form_id: 'form' })
  const answer: any = db.prepare('SELECT * FROM answers').get(), current = publish()
  const check: any = store.handle({ type: 'export.check.start', ...selection(current), answer_ids: [answer.id] })
  await complete()
  const result = status(check.id)
  expect(result).toMatchObject({ phase: 'ready', complete: false })
  expect(result.issues).toContainEqual(expect.objectContaining({ source: 'original_question', answer_id: answer.id, view_id: question.id, revision: 1, history_id: answer.view_history_id, element_id: 'send' }))
  expect(JSON.stringify(result)).not.toContain('PRIVATE_ANSWER')
  expect(store.handle({ type: 'export.list', task_id: task })).toEqual([])
})
