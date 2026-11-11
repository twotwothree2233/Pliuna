import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { RuntimeStore } from '../../src/runtime/store'
import type { Bundle } from '../../src/shared/contracts.generated'
import { imageUrl } from '../../src/runtime/view-resources'
let root: string, store: RuntimeStore, task: string, run: string, db: Database.Database
beforeEach(() => { vi.useFakeTimers(); root = mkdtempSync(join(tmpdir(), 'pliuna-export-runtime-')); store = new RuntimeStore(root); task = store.create('Synthetic export').task.id; run = store.start(task, 'held fixture', 'fixture', []); db = new Database(join(root, 'pliuna.sqlite')) })
afterEach(() => { db.close(); store.close(); rmSync(root, { recursive: true, force: true }); vi.useRealTimers() })
const call = (type: string, extra: any = {}): any => store.handle({ type, task_id: task, ...extra })
const body = (text = 'Published learning'): Bundle => ({ profile: 'managed-v1', html: `<section id="lesson"><p>${text}</p></section>`, css: '', state: { schema: { type: 'object', additionalProperties: false, properties: {} }, initial: {}, compatibility_version: 'v1' }, forms: [], behaviors: [], references: [], export: [{ id: 'lesson', category: 'learning', source: { type: 'element', element_id: 'lesson' } }] })
function publish(bundle = body()) { const surface = store.snapshot(task).surface; return store.modelTool(task, run, { type: 'write', input: { type: 'surface.update', surface_id: surface.id, expected_revision: surface.revision, operations: [{ type: 'view.create', client_ref: 'v', slot_id: 'main', bundle: { type: 'inline', bundle } }] } }) }
function image(body: Buffer, media_type = 'image/png') { const id = randomUUID(), r = { id, storage_key: id, sha256: createHash('sha256').update(body).digest('hex'), byte_length: body.length, media_type, display_name: 'synthetic.png' }; writeFileSync(join(root, 'resources', id), body); db.prepare('INSERT INTO resources VALUES (?,?,?,?,?,?,?)').run(id, id, r.sha256, r.byte_length, media_type, r.display_name, new Date().toISOString()); db.prepare('INSERT INTO task_resources VALUES (?,?)').run(task, id); return r }
const png = () => Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3foAAAAASUVORK5CYII=', 'base64')
it('pins an immutable preview while ordinary publication continues and blocks maintenance', () => {
 publish(); store.handle({ type: 'run.cancel', task_id: task, run_id: run }); const job = call('export.prepare', { answer_ids: [] })
 expect(job.phase).toBe('preview'); expect(job.html).toContain('Published learning'); expect(() => store.handle({ type: 'maintenance.begin' })).toThrow()
 run = store.start(task, 'new publication', 'fixture', []); publish(body('NEW_CONTENT'))
 const fixed = call('export.internal.begin', { operation_id: job.id, partial: false, target: '/synthetic/output', temporary: '/synthetic/temp' })
 expect(fixed.html).not.toContain('NEW_CONTENT'); call('export.internal.finish', { operation_id: job.id, phase: 'saved', reason: null })
 expect(call('export.status', { operation_id: job.id })).toMatchObject({ phase: 'saved', pinned: false })
})
it('task deletion cancels a preview first but refuses unresolved publication', () => {
 publish(); let job = call('export.prepare', { answer_ids: [] }); call('task.delete'); expect(store.tasks()).toEqual([])
 task = store.create('another').task.id; run = store.start(task, 'fixture held', 'fixture', []); publish(); job = call('export.prepare', { answer_ids: [] })
 call('export.internal.begin', { operation_id: job.id, partial: false, target: '/synthetic/output', temporary: '/synthetic/temp' })
 expect(() => call('task.delete')).toThrow(); expect(store.tasks()).toHaveLength(1)
})
it('refuses old snapshot save after restart and permits explicit cancellation without replay', () => {
 publish(); const job = call('export.prepare', { answer_ids: [] }); store.close(); store = new RuntimeStore(root)
 expect(call('export.status', { operation_id: job.id })).toMatchObject({ phase: 'interrupted', pinned: true })
 expect(() => call('export.internal.begin', { operation_id: job.id, partial: false, target: '/a', temporary: '/b' })).toThrow()
 expect(call('export.cancel', { operation_id: job.id })).toMatchObject({ phase: 'cancelled', pinned: false })
})
it('registers direct image identity in immutable history and rejects foreign or corrupt resources', () => {
 const resource = image(png()), b = body(); b.html = '<section id="lesson"><img src="pliuna-resource:diagram" alt="synthetic diagram"></section>'; b.references = [{ name: 'diagram', target: { kind: 'resource', id: resource.id } }]
 publish(b); expect(store.snapshot(task).views[0]!.presentation.html).toContain('data:image/png;base64,')
 const history = JSON.parse((db.prepare('SELECT evidence_snapshot_json value FROM view_history').get() as any).value)
 expect(history.resources[0]).toMatchObject(resource); expect(db.prepare('SELECT 1 FROM object_references WHERE target_id=?').get(resource.id)).toBeTruthy()
 const job = call('export.prepare', { answer_ids: [] }); expect(job.html).toContain('data:image/png;base64,'); call('export.cancel', { operation_id: job.id })
 writeFileSync(join(root, 'resources', resource.id), Buffer.alloc(resource.byte_length)); expect(() => store.snapshot(task)).toThrow('checksum')
})
it('rejects invalid image dimensions and JPEG files without a bounded SOF', () => {
 const bad = png(); bad.writeUInt32BE(10000, 16); expect(() => imageUrl(root, image(bad))).toThrow('dimensions')
 expect(() => imageUrl(root, image(Buffer.from([255,216,255,217,0]), 'image/jpeg'))).toThrow('dimensions')
})
it('keeps host paths out of public jobs and rejects malformed or cross-task selectors', () => {
 publish(); const job = call('export.prepare', { answer_ids: [] }); call('export.internal.begin', { operation_id: job.id, partial: false, target: '/private/synthetic/target', temporary: '/private/synthetic/temp' })
 expect(JSON.stringify(call('export.list'))).not.toContain('/private/'); const other = store.create('Other').task.id
 expect(() => store.handle({ type: 'export.status', task_id: other, operation_id: job.id })).toThrow()
 expect(() => call('export.status', { operation_id: job.id, extra: true })).toThrow()
})
it('loads only the requested View page and rejects stale page navigation', () => {
 for(let n=0;n<12;n++)publish(body('Lesson '+n))
 const first=store.snapshot(task);expect(first.views).toHaveLength(10);expect(first.view_page).toEqual({offset:0,limit:10,total:12})
 const page=call('host.views.page',{offset:10,expected_revision:first.surface.revision});expect(page.views).toHaveLength(2);expect(page.views[0].presentation.html).toContain('Lesson 10')
 const firstResource=(db.prepare('SELECT bundle_resource_id id FROM views ORDER BY rowid LIMIT 1').get() as any).id
 writeFileSync(join(root,'resources',firstResource),'corrupt off-page')
 expect(store.snapshot(task).views).toHaveLength(2)
 expect(()=>call('host.views.page',{offset:0,expected_revision:1})).toThrow('Surface changed')
 expect(()=>call('host.views.page',{offset:0,expected_revision:first.surface.revision})).toThrow(expect.objectContaining({code:'RESOURCE_CORRUPT'}))
})

function personalFixture() {
 const question=body('ORIGINAL_QUESTION');question.html += '<input id="response" type="text"><button id="send" type="button">Submit</button>';question.state.schema={type:'object',properties:{response:{type:'string'}},required:['response'],additionalProperties:false};question.state.initial={response:'SAVED_ANSWER'};question.forms=[{id:'response',fields:['/response']}];question.behaviors=[{type:'input',element_id:'response',field:'/response',control:'text'},{type:'submit',element_id:'send',form_id:'response'}]
 publish(question);const view=store.snapshot(task).views[0]!;call('answer.submit',{view_id:view.id,view_revision:view.revision,expected_state_revision:view.state_revision,form_id:'response'})
 const answer=db.prepare('SELECT id,view_history_id FROM answers').get() as any
 const feedback=body('CURRENT_LESSON');feedback.html += '<p id="feedback">PERSONAL_FEEDBACK</p>';feedback.export.push({id:'feedback',category:'feedback',source:{type:'element',element_id:'feedback'},personal_binding:{version:1,answer_id:answer.id,view_history_id:answer.view_history_id}})
 publish(feedback);return {answer,view:store.snapshot(task).views[1]!,feedback}
}
it('requires exact personal bindings for new publication while legacy personal bundles remain readable',()=>{
 const b=body();b.html += '<p id="feedback">LEGACY_PRIVATE</p>';b.export.push({id:'feedback',category:'feedback',source:{type:'element',element_id:'feedback'}})
 expect(()=>publish(b)).toThrow(expect.objectContaining({code:'PERSONAL_BINDING_REQUIRED'}))
 publish();const saved=db.prepare('SELECT bundle_resource_id id FROM views').get() as any,bytes=Buffer.from(JSON.stringify(b));writeFileSync(join(root,'resources',saved.id),bytes);db.prepare('UPDATE resources SET sha256=?,byte_length=? WHERE id=?').run(createHash('sha256').update(bytes).digest('hex'),bytes.length,saved.id)
 expect(store.snapshot(task).views[0]!.presentation.html).toContain('LEGACY_PRIVATE')
 const job=call('export.prepare',{answer_ids:[]});expect(job.html).not.toContain('LEGACY_PRIVATE');call('export.cancel',{operation_id:job.id})
 const view=store.snapshot(task).views[0]!,revision=store.snapshot(task).surface.revision
 expect(()=>call('export.prepare',{answer_ids:[],view_ids:[view.id],expected_revision:revision,fragment_selection:[{view_id:view.id,fragment_ids:['feedback']}]})).toThrow(expect.objectContaining({code:'EXPORT_PERSONAL_SELECTION_REQUIRED'}))
})
it('exports personal feedback only by explicit fragment and exact answer selection, beside original question',()=>{
 const {answer,view}=personalFixture(),revision=store.snapshot(task).surface.revision
 let job=call('export.prepare',{answer_ids:[],view_ids:[view.id],expected_revision:revision});expect(job.html).toContain('CURRENT_LESSON');expect(job.html).not.toContain('PERSONAL_FEEDBACK');call('export.cancel',{operation_id:job.id})
 const selection={view_ids:[view.id],expected_revision:revision,fragment_selection:[{view_id:view.id,fragment_ids:['feedback']}]}
 expect(()=>call('export.prepare',{...selection,answer_ids:[]})).toThrow(expect.objectContaining({code:'EXPORT_PERSONAL_SELECTION_REQUIRED'}))
 job=call('export.prepare',{...selection,answer_ids:[answer.id]});expect(job.html).toContain('PERSONAL_FEEDBACK');expect(job.html).toContain('ORIGINAL_QUESTION');expect(job.html).toContain('SAVED_ANSWER');expect(job.html).not.toContain('CURRENT_LESSON');expect(job.html).not.toContain(answer.id);expect(job.html).not.toContain(answer.view_history_id)
 const control=new Database(join(root,'export-control.sqlite'));const snapshot=JSON.parse((control.prepare('SELECT manifest FROM export_jobs WHERE id=?').get(job.id) as any).manifest).snapshot;control.close()
 expect(snapshot).toMatchObject({version:1,answer_ids:[answer.id],views:[{view_id:view.id,fragments:[{id:'feedback',category:'feedback',personal_binding:{version:1,answer_id:answer.id,view_history_id:answer.view_history_id}}]}]})
 store.close();store=new RuntimeStore(root);expect(call('export.status',{operation_id:job.id})).toMatchObject({phase:'interrupted',pinned:true});call('export.cancel',{operation_id:job.id});expect(store.snapshot(task).answers[0]!.value).toEqual({response:'SAVED_ANSWER'})
})
it('rejects wrong answer history, foreign binding and malformed selectors without creating a snapshot',()=>{
 const {answer,view,feedback}=personalFixture();const revision=store.snapshot(task).surface.revision
 feedback.export[1]!.personal_binding!.view_history_id=(db.prepare('SELECT id FROM view_history WHERE id!=? LIMIT 1').get(answer.view_history_id) as any).id
 expect(()=>publish(feedback)).toThrow(expect.objectContaining({code:'PERSONAL_BINDING_INVALID'}))
 const other=store.create('foreign'),otherRun=store.start(other.task.id,'fixture','fixture',[]),surface=store.snapshot(other.task.id).surface
 feedback.export[1]!.personal_binding!.view_history_id=answer.view_history_id
 expect(()=>store.modelTool(other.task.id,otherRun,{type:'write',input:{type:'surface.update',surface_id:surface.id,expected_revision:surface.revision,operations:[{type:'view.create',slot_id:'main',client_ref:'foreign',bundle:{type:'inline',bundle:feedback}}]}})).toThrow(expect.objectContaining({code:'PERSONAL_BINDING_INVALID'}))
 for(const fragment_selection of [[{view_id:view.id,fragment_ids:['missing']}],[{view_id:view.id,fragment_ids:['feedback','feedback']}],[{view_id:'foreign',fragment_ids:[]}]])expect(()=>call('export.prepare',{answer_ids:[answer.id],view_ids:[view.id],expected_revision:revision,fragment_selection})).toThrow()
 expect(call('export.list')).toEqual([])
})
