import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { RuntimeStore } from '../../src/runtime/store'
import { operationContract } from '../../src/runtime/model/operation-contracts'
import { modelToolRequest } from '../../src/runtime/model/tool-input'
import type { Bundle } from '../../src/shared/contracts.generated'
import { ObjectQueries } from '../../src/runtime/queries'

let root: string, store: RuntimeStore, task: string, run: string, db: Database.Database
beforeEach(() => {
  vi.useFakeTimers()
  root = mkdtempSync(join(tmpdir(), 'pliuna-export-check-'))
  store = new RuntimeStore(root, undefined, { viewReplacement: true })
  task = store.create('Isolated export check').task.id
  run = store.start(task, 'held fixture', 'fixture', [])
  db = new Database(join(root, 'pliuna.sqlite'))
})
afterEach(() => { db.close(); store.close(); vi.useRealTimers() })
const bundle = (): Bundle => JSON.parse((operationContract('surface.update')!.example as any).input_json).operations[0].bundle.bundle
function publish(b = bundle()) {
  const surface = store.snapshot(task).surface
  store.modelTool(task, run, modelToolRequest('write', { operation: 'surface.update', input_json: JSON.stringify({ surface_id: surface.id, expected_revision: surface.revision, operations: [{ type: 'view.create', client_ref: 'example', slot_id: 'main', bundle: { type: 'inline', bundle: b } }] }) }))
  return store.snapshot(task).views.at(-1)!
}
const read = async (id: string, extra: any = {}, owner = task, source = run): Promise<any> => store.modelTool(owner, source, modelToolRequest('read', { kind: 'view', id, selection: { view: 'export_check' }, ...extra }))
const exportJob = (view: string): any => store.handle({ type: 'export.prepare', task_id: task, view_ids: [view], answer_ids: [] })
const counts = () => Object.fromEntries(['records', 'actions', 'approvals', 'resources', 'views', 'view_history'].map(table => [table, (db.prepare('SELECT count(*) n FROM ' + table).get() as any).n]))

it('rejects cancelled diagnosis before reading or converting any View', () => {
  const view = publish(), before = counts(), controller = new AbortController(); controller.abort()
  const queries = new ObjectQueries(db, () => { throw Error('must not read') }, () => undefined, () => ({}), () => ({}))
  expect(() => queries.query(task, run, modelToolRequest('read', { kind: 'view', id: view.id, selection: { view: 'export_check' } }) as any, false, controller.signal)).toThrow(expect.objectContaining({ code: 'MODEL_CANCELLED' }))
  expect(counts()).toEqual(before)
})

it('matches actual default export, exposes discovery, and creates no business or control state', async () => {
  const view = publish(), before = counts()
  const listing: any = await store.modelTool(task, run, modelToolRequest('list', { kind: 'view' }))
  expect(listing.items[0].read_options.export_check.selection).toEqual({ view: 'export_check', revision: 1 })
  const result = await read(view.id)
  expect(result.data).toMatchObject({ id: view.id, revision: 1, complete: true, issues: [], excluded_personal_fragments: [] })
  expect(counts()).toEqual(before)
  expect(store.handle({ type: 'export.list', task_id: task })).toEqual([])
  const exported = exportJob(view.id)
  expect(exported.issues).toEqual(result.data.issue_codes)
  store.handle({ type: 'export.cancel', task_id: task, operation_id: exported.id })
})

it('identifies exact unclassified roots and uncovered text/graphics without copying their contents', async () => {
  const b = bundle(); b.export[0]!.category = 'unclassified'
  b.html += '<p id="outside">PRIVATE_TEXT_SENTINEL</p><svg id="graphic"><circle r="1"></circle></svg>'
  const view = publish(b), check = (await read(view.id)).data
  expect(check.complete).toBe(false)
  expect(check.issues).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'UNCLASSIFIED_FRAGMENT', element_id: 'lesson', fragment_id: 'lesson' }),
    expect.objectContaining({ code: 'UNCLASSIFIED_CONTENT', element_id: 'outside', tag: 'p' }),
    expect.objectContaining({ code: 'UNCLASSIFIED_CONTENT', element_id: 'graphic', tag: 'svg' })
  ]))
  expect(JSON.stringify(check)).not.toContain('PRIVATE_TEXT_SENTINEL')
  const job = exportJob(view.id)
  expect(job.issues).toEqual(check.issue_codes)
  expect(() => store.handle({ type: 'export.internal.begin', task_id: task, operation_id: job.id, partial: false, target: '/synthetic/file', temporary: '/synthetic/temp' })).toThrow()
  store.handle({ type: 'export.cancel', task_id: task, operation_id: job.id })
})

it('paginates all diagnostics and invalidates a continuation after View revision changes', async () => {
  const b = bundle(); b.html += Array.from({ length: 75 }, (_, i) => `<p id="outside-${i}">Text ${i}</p>`).join('')
  const view = publish(b); let result = await read(view.id, { max_chars: 170 }), text = '', first = result.next_cursor, pages = 0
  while (true) {
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(32768)
    text += result.data.text; pages++
    if (!result.next_cursor) break
    result = await read(view.id, { cursor: result.next_cursor, selection: undefined })
  }
  expect(pages).toBeGreaterThan(1)
  expect(JSON.parse(text).issues).toHaveLength(75)
  expect(new Set(JSON.parse(text).issues.map((issue: any) => issue.element_id)).size).toBe(75)
  db.prepare('UPDATE views SET revision=revision+1 WHERE id=?').run(view.id)
  await expect(read(view.id, { selection: { view: 'export_check', revision: 1 } })).rejects.toMatchObject({ code: 'READ_VERSION_CHANGED' })
  await expect(read(view.id, { selection: undefined, cursor: first })).rejects.toBeDefined()
})

it('refuses foreign Views, changed historical resource identity, and corrupted bundles', async () => {
  const view = publish(), foreign = store.create('Foreign').task.id, foreignRun = store.start(foreign, 'held', 'fixture', [])
  await expect(read(view.id, {}, foreign, foreignRun)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  const resource = db.prepare('SELECT r.* FROM resources r JOIN views v ON v.bundle_resource_id=r.id WHERE v.id=?').get(view.id) as any
  const bytes = readFileSync(join(root, 'resources', resource.storage_key)); writeFileSync(join(root, 'resources', resource.storage_key), Buffer.alloc(bytes.length))
  await expect(read(view.id)).rejects.toMatchObject({ code: 'RESOURCE_CORRUPT' })
  expect(store.handle({ type: 'export.list', task_id: task })).toEqual([])
})

it('reports a damaged selected image with its exact location but rejects changed frozen metadata', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3foAAAAASUVORK5CYII=', 'base64')
  const id = randomUUID(), sha = createHash('sha256').update(png).digest('hex')
  writeFileSync(join(root, 'resources', id), png)
  db.prepare('INSERT INTO resources VALUES (?,?,?,?,?,?,?)').run(id, id, sha, png.length, 'image/png', 'Synthetic', '2026-11-03T00:00:00Z')
  db.prepare('INSERT INTO task_resources VALUES (?,?)').run(task, id)
  const b = bundle(); b.html = '<section id="lesson"><p>Table remains</p><img id="picture" src="pliuna-resource:picture" alt="Synthetic"></section>'
  b.references = [{ name: 'picture', target: { kind: 'resource', id } }]
  const view = publish(b)
  const selected = { type: 'export.check', task_id: task, view_ids: [view.id], answer_ids: [] }
  const intact: any = store.handle(selected)
  writeFileSync(join(root, 'resources', id), Buffer.alloc(png.length))
  const damaged: any = store.handle(selected)
  expect(damaged.selection_hash).not.toBe(intact.selection_hash)
  const check = (await read(view.id)).data
  expect(check).toMatchObject({ complete: false, issues: [expect.objectContaining({ code: 'IMAGE_OMITTED_RESOURCE_CORRUPT', element_id: 'picture' })] })
  const job = exportJob(view.id); expect(job.issues).toEqual(check.issue_codes)
  store.handle({ type: 'export.cancel', task_id: task, operation_id: job.id })
  db.prepare("UPDATE resources SET display_name='Changed' WHERE id=?").run(id)
  await expect(read(view.id)).rejects.toMatchObject({ code: 'EXPORT_RESOURCE_CHANGED' })
})

it('invalidates old export-check cursors on isolated restart without recreating jobs', async () => {
  const b = bundle(); b.html += '<p id="outside">Unclassified note</p>'
  const view = publish(b), first = await read(view.id, { max_chars: 20 })
  expect(first.next_cursor).toBeTruthy()
  store.close(); store = new RuntimeStore(root, undefined, { viewReplacement: true })
  run = store.start(task, 'new held fixture', 'fixture', [])
  await expect(read(view.id, { selection: undefined, cursor: first.next_cursor })).rejects.toMatchObject({ code: 'INVALID_CURSOR' })
  expect((await read(view.id)).data.complete).toBe(false)
  expect(store.handle({ type: 'export.list', task_id: task })).toEqual([])
})

it('checks exact personal bindings but normally excludes valid personal content', async () => {
  const b = bundle(); b.html += '<input id="response" type="text"><button id="send">Submit</button>'
  b.state = { schema: { type: 'object', properties: { response: { type: 'string' } }, required: ['response'], additionalProperties: false }, initial: { response: 'SAVED_PRIVATE' }, compatibility_version: 'answer' }
  b.forms = [{ id: 'form', fields: ['/response'] }]; b.behaviors = [{ type: 'input', element_id: 'response', field: '/response', control: 'text' }, { type: 'submit', element_id: 'send', form_id: 'form' }]
  const question = publish(b)
  store.handle({ type: 'answer.submit', task_id: task, view_id: question.id, view_revision: question.revision, expected_state_revision: question.state_revision, form_id: 'form' })
  const answer = db.prepare('SELECT id,view_history_id FROM answers').get() as any
  const feedback = bundle(); feedback.html += '<p id="feedback">PRIVATE_FEEDBACK</p>'
  feedback.export.push({ id: 'feedback', category: 'feedback', source: { type: 'element', element_id: 'feedback' }, personal_binding: { version: 1, answer_id: answer.id, view_history_id: answer.view_history_id } })
  const view = publish(feedback), check = (await read(view.id)).data
  expect(check).toMatchObject({ complete: true, excluded_personal_fragments: ['feedback'] })
  expect(JSON.stringify(check)).not.toMatch(/SAVED_PRIVATE|PRIVATE_FEEDBACK/)
  const resource = db.prepare('SELECT r.* FROM resources r JOIN views v ON v.bundle_resource_id=r.id WHERE v.id=?').get(view.id) as any
  feedback.export[1]!.personal_binding!.view_history_id = 'foreign-history'
  const bytes = Buffer.from(JSON.stringify(feedback)); writeFileSync(join(root, 'resources', resource.storage_key), bytes)
  db.prepare('UPDATE resources SET sha256=?,byte_length=? WHERE id=?').run(createHash('sha256').update(bytes).digest('hex'), bytes.length, resource.id)
  await expect(read(view.id)).rejects.toMatchObject({ code: 'PERSONAL_BINDING_INVALID' })
})

it('advertises only saved text/page representations and offers object reads for JSON errors', async () => {
  const surface = store.snapshot(task).surface
  const saved: any = store.modelTool(task, run, modelToolRequest('write', { operation: 'resource.create', input_json: JSON.stringify({ display_name: 'Result', content: { type: 'json', value: { value: 1.25 } } }) }))
  const listing: any = await store.modelTool(task, run, modelToolRequest('list', { kind: 'resource' }))
  const resource = listing.items.find((r: any) => r.display_name === 'Result')
  expect(resource.read_options).toMatchObject({ default_view: 'object', page_index_available: false, selections: ['object'] })
  try {
    await store.modelTool(task, run, modelToolRequest('read', { kind: 'resource', id: resource.id, selection: { lines: [1, 5] } }))
    throw Error('Expected type error')
  } catch (error) {
    expect(error).toMatchObject({ code: 'UNSUPPORTED_REPRESENTATION' })
    const correction = JSON.parse((error as any).suggestion)
    expect(correction.arguments.selection).toEqual({ view: 'object' })
    expect((await store.modelTool(task, run, modelToolRequest('read', correction.arguments)) as any).data.content).toEqual({ type: 'json', value: { value: 1.25 } })
  }
  expect(saved).toBeTruthy(); expect(surface.revision).toBe(1)
  store.modelTool(task, run, modelToolRequest('write', { operation: 'resource.create', input_json: JSON.stringify({ display_name: 'Plain text', content: { type: 'text', text: 'A中😀\nB' } }) }))
  const plain: any = (await store.modelTool(task, run, modelToolRequest('list', { kind: 'resource' })) as any).items.find((r: any) => r.display_name === 'Plain text')
  expect(plain.read_options).toMatchObject({ default_view: 'text', selections: ['lines', 'find'], page_index_available: false })
  try {
    await store.modelTool(task, run, modelToolRequest('read', { kind: 'resource', id: plain.id, selection: { pages: [1, 1] } }))
    throw Error('Expected no-index error')
  } catch (error) {
    expect(error).toMatchObject({ code: 'RESOURCE_RANGE_INVALID' })
    expect(JSON.parse((error as any).suggestion).arguments.selection).toEqual({ view: 'metadata' })
  }
})

function question(covered: boolean) {
  const b = bundle()
  b.html = '<section id="lesson"><p>Original question</p>' + (covered ? '' : '</section>') + '<label for="response">QUESTION_LABEL</label><input id="response" type="text"><button id="send">QUESTION_SUBMIT</button>' + (covered ? '</section>' : '')
  b.state = { schema: { type: 'object', properties: { response: { type: 'number' } }, required: ['response'], additionalProperties: false }, initial: { response: '12.5' }, compatibility_version: 'answer' }
  b.forms = [{ id: 'form', fields: ['/response'] }]
  b.behaviors = [{ type: 'input', element_id: 'response', field: '/response', control: 'number' }, { type: 'submit', element_id: 'send', form_id: 'form' }]
  return b
}
function submit(view: any) {
  store.handle({ type: 'answer.submit', task_id: task, view_id: view.id, view_revision: view.revision, expected_state_revision: view.state_revision, form_id: 'form' })
  return db.prepare('SELECT * FROM answers ORDER BY rowid DESC LIMIT 1').get() as any
}
function selection(view: any, answers: string[] = [], fragments?: string[]) {
  return { task_id: task, view_ids: [view.id], answer_ids: answers, expected_revision: store.snapshot(task).surface.revision, ...(fragments ? { fragment_selection: [{ view_id: view.id, fragment_ids: fragments }] } : {}) }
}

it('checks immutable original questions after current View changes, without jobs or pins', async () => {
  const original = publish(question(false)), answer = submit(original)
  const history = db.prepare('SELECT * FROM view_history WHERE id=?').get(answer.view_history_id) as any
  // Simulate a newer current revision without rewriting the frozen old version.
  db.prepare('UPDATE views SET revision=revision+1 WHERE id=?').run(original.id)
  const before = counts()
  const historical: any = await store.modelTool(task, run, modelToolRequest('read', { kind: 'view_history', id: history.id, selection: { view: 'export_check', revision: 1 } }))
  expect(historical.data).toMatchObject({ id: history.id, view_id: original.id, revision: 1, complete: false })
  expect(historical.data.issues).toEqual(expect.arrayContaining([expect.objectContaining({ element_id: 'send' })]))
  const listing: any = await store.modelTool(task, run, modelToolRequest('list', { kind: 'view_history' }))
  expect(listing.items[0].read_options.export_check).toMatchObject({ kind: 'view_history', id: history.id, selection: { revision: 1 } })
  const foreign = store.create('Foreign history').task.id, foreignRun = store.start(foreign, 'held', 'fixture', [])
  await expect(store.modelTool(foreign, foreignRun, modelToolRequest('read', { kind: 'view_history', id: history.id, selection: { view: 'export_check' } }))).rejects.toMatchObject({ code: 'NOT_FOUND' })
  // Ignore records from explicitly creating the unrelated fixture.
  expect(counts().resources).toBe(before.resources)
  expect(store.handle({ type: 'export.list', task_id: task })).toEqual([])
  await expect(store.modelTool(task, run, modelToolRequest('read', { kind: 'view_history', id: history.id, selection: { view: 'export_check', revision: 2 } }))).rejects.toMatchObject({ code: 'READ_VERSION_CHANGED' })
})

it('selection preflight locates frozen question blockers and matches actual export', () => {
  const original = publish(question(false)), answer = submit(original), current = publish()
  const request = selection(current, [answer.id]), before = counts()
  const check: any = store.handle({ type: 'export.check', ...request })
  expect(check.complete).toBe(false)
  expect(check.issues).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'original_question', answer_id: answer.id, view_id: original.id, revision: 1, history_id: answer.view_history_id, element_id: 'send' })]))
  expect(JSON.stringify(check)).not.toContain('QUESTION_SUBMIT')
  expect(counts()).toEqual(before)
  expect(store.handle({ type: 'export.list', task_id: task })).toEqual([])
  const job: any = store.handle({ type: 'export.prepare', ...request })
  expect(job.issues.length).toBeGreaterThan(0)
  expect(() => store.handle({ type: 'export.internal.begin', task_id: task, operation_id: job.id, partial: false, target: '/synthetic/file', temporary: '/synthetic/temp' })).toThrow()
  store.handle({ type: 'export.cancel', task_id: task, operation_id: job.id })
})

it('completes numeric raw draft, formal answer, bound feedback and both full exports', () => {
  const original = publish(question(true)), answer = submit(original)
  expect(JSON.parse(answer.raw_json)).toEqual({ response: '12.5' })
  expect(JSON.parse(answer.value_json)).toEqual({ response: 12.5 })
  const b = bundle(); b.html += '<p id="feedback">BOUND_PRIVATE_FEEDBACK</p>'
  b.export.push({ id: 'feedback', category: 'feedback', source: { type: 'element', element_id: 'feedback' }, personal_binding: { version: 1, answer_id: answer.id, view_history_id: answer.view_history_id } })
  const current = publish(b)
  for (const personal of [false, true]) {
    const request = selection(current, personal ? [answer.id] : [], personal ? ['lesson', 'feedback'] : ['lesson'])
    const check: any = store.handle({ type: 'export.check', ...request }); expect(check).toMatchObject({ complete: true, issues: [] })
    const job: any = store.handle({ type: 'export.prepare', ...request })
    expect(job.issues).toEqual([]); expect(job.html.includes('BOUND_PRIVATE_FEEDBACK')).toBe(personal)
    if (personal) { expect(job.html).toContain('QUESTION_LABEL'); expect(job.html).toContain('12.5') }
    store.handle({ type: 'export.cancel', task_id: task, operation_id: job.id })
  }
  expect(() => store.handle({ type: 'export.check', ...selection(current, [], ['feedback']) })).toThrow(expect.objectContaining({ code: 'EXPORT_PERSONAL_SELECTION_REQUIRED' }))
})

it('bounds selection diagnostics, checks version/association/corruption and revalidates after preflight', () => {
  const b = bundle(); b.html += Array.from({ length: 75 }, (_, i) => `<p id="uncovered-${i}">Not exported</p>`).join('')
  const current = publish(b), request = selection(current), before = counts()
  const first: any = store.handle({ type: 'export.check', ...request }), second: any = store.handle({ type: 'export.check', ...request, offset: first.next_offset })
  expect(first.issues).toHaveLength(50); expect(second.issues).toHaveLength(25)
  expect(second.selection_hash).toBe(first.selection_hash); expect(second.next_offset).toBeNull()
  expect(new Set([...first.issues, ...second.issues].map(i => i.element_id)).size).toBe(75)
  expect(counts()).toEqual(before)
  expect(() => store.handle({ type: 'export.check', ...request, expected_revision: 0 })).toThrow(expect.objectContaining({ code: 'VERSION_CONFLICT' }))
  expect(() => store.handle({ type: 'export.check', ...request, extra: true })).toThrow()
  expect(() => store.handle({ type: 'export.check', ...request, offset: -1 })).toThrow()
  const resource = db.prepare('SELECT r.* FROM resources r JOIN views v ON v.bundle_resource_id=r.id WHERE v.id=?').get(current.id) as any
  writeFileSync(join(root, 'resources', resource.storage_key), Buffer.alloc(resource.byte_length))
  for (const type of ['export.check', 'export.prepare']) expect(() => store.handle({ type, ...request })).toThrow(expect.objectContaining({ code: 'RESOURCE_CORRUPT' }))
  expect(store.handle({ type: 'export.list', task_id: task })).toEqual([])
})

it('detects source drift between check pages and refuses foreign selections without control writes', () => {
  const current = publish(), request = selection(current), before = counts()
  const control = new Database(join(root, 'export-control.sqlite'), { readonly: true })
  const jobs = () => control.prepare('SELECT * FROM export_jobs').all()
  try {
    const first: any = store.handle({ type: 'export.check', ...request })
    expect(first.complete).toBe(true); expect(jobs()).toEqual([])
    db.prepare("UPDATE tasks SET title='New synthetic title' WHERE id=?").run(task)
    const second: any = store.handle({ type: 'export.check', ...request })
    expect(second.selection_hash).not.toBe(first.selection_hash)
    expect(counts()).toEqual(before); expect(jobs()).toEqual([])
    const foreign = store.create('Foreign selection').task.id
    for (const type of ['export.check', 'export.prepare']) expect(() => store.handle({ type, task_id: foreign, view_ids: [current.id], answer_ids: [] })).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
    expect(jobs()).toEqual([])
  } finally { control.close() }
})
