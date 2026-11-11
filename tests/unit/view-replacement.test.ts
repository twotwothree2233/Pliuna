import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { RuntimeStore } from '../../src/runtime/store'
import { ModelService } from '../../src/runtime/model/service'
import type { Bundle } from '../../src/shared/contracts.generated'
import type { Snapshot } from '../../src/shared/types'
import { replacementDraft } from '../../src/runtime/surface-transition'

const cleanups: (() => void)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); await Promise.resolve(); vi.useRealTimers() })
function bundle(title = '旧题目', compatibility = 'exercise-1', initial = ''): Bundle {
  return {
    profile: 'managed-v1', html: `<section><h2>${title}</h2><label for="answer">答案</label><textarea id="answer"></textarea><button id="submit" type="button">提交</button></section>`, css: '',
    state: { schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false }, initial: { answer: initial }, compatibility_version: compatibility },
    forms: [{ id: 'form', fields: ['/answer'] }], behaviors: [{ type: 'input', element_id: 'answer', field: '/answer', control: 'textarea' }, { type: 'submit', element_id: 'submit', form_id: 'form' }], references: [], export: []
  }
}
function setup(enabled: boolean | 'default' = true) {
  vi.useFakeTimers()
  const path = mkdtempSync(join(tmpdir(), 'pliuna-view-replace-')), store = new RuntimeStore(path, new ModelService(), enabled === 'default' ? undefined : { viewReplacement: enabled })
  cleanups.push(() => { try { store.close() } catch {} rmSync(path, { recursive: true, force: true }) })
  const task = store.create('替换验收'), run = store.start(task.task.id, 'fixture held for deterministic tools', 'fixture', [])
  store.modelTool(task.task.id, run, { type: 'write', input: { type: 'surface.update', surface_id: task.surface.id, expected_revision: 1, operations: [{ type: 'view.create', client_ref: 'first', slot_id: 'main', bundle: { type: 'inline', bundle: bundle() } }] } })
  return { store, path, task, run }
}
function request(store: RuntimeStore, task: Snapshot, reset = false) {
  const snapshot = store.snapshot(task.task.id), view = snapshot.views[0]!, next = bundle('新版题目', reset ? 'exercise-2' : 'exercise-1', '新初值')
  return { type: 'write', input: { type: 'surface.update', surface_id: snapshot.surface.id, expected_revision: snapshot.surface.revision, operations: [{ type: 'view.replace', view_id: view.id, expected_view_revision: view.revision, bundle: { type: 'inline', bundle: next }, state_transition: reset ? { type: 'reset', expected_state_revision: view.state_revision, initial: next.state.initial } : { type: 'preserve', expected_state_revision: view.state_revision, compatibility_version: 'exercise-1' } }] } }
}
function invoke(store: RuntimeStore, task: Snapshot, run: string, input: unknown = request(store, task)) {
  // Capture rejection immediately so failure-path assertions never leave unhandled promises.
  return store.agentTool(task.task.id, run, input, new AbortController().signal).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
}
async function tick() { for (let n = 0; n < 12; n++) await Promise.resolve() }
function approve(store: RuntimeStore, task: Snapshot) { const approval = store.snapshot(task.task.id).approvals.at(-1)!; store.handle({ type: 'approval.decide', task_id: task.task.id, approval_id: approval.id, decision: 'approve' }) }
async function respond(store: RuntimeStore, task: Snapshot, proceed = true, discard = false) {
  const pending = store.snapshot(task.task.id).surface_updates[0]!
  return store.handle({ type: 'surface.respond', task_id: task.task.id, action_id: pending.action_id, proceed, confirm_discard: discard })
}
function save(store: RuntimeStore, task: Snapshot, answer: string) {
  const view = store.snapshot(task.task.id).views[0]!
  return store.handle({ type: 'draft.save', task_id: task.task.id, view_id: view.id, view_revision: view.revision, expected_state_revision: view.state_revision, fields: [{ path: '/answer', value: answer }] })
}

describe('View replacement (written while behavioral testing is paused)', () => {
  it('keeps unverified replacement disabled by default', async () => {
    const { store, task, run } = setup('default')
    expect((await invoke(store, task, run)).error).toMatchObject({ code: 'CAPABILITY_DISABLED' })
    expect(store.snapshot(task.task.id).views[0]!.revision).toBe(1)
  })
  it('preserves same-Run compatible state, View ID and history without permission approval', async () => {
    const { store, task, run, path } = setup(), before = store.snapshot(task.task.id).views[0]!
    const result = invoke(store, task, run)
    await tick()
    expect(store.snapshot(task.task.id).approvals).toHaveLength(0)
    await respond(store, task)
    expect((await result).error).toBeUndefined()
    const next = store.snapshot(task.task.id).views[0]!
    expect(next).toMatchObject({ id: before.id, revision: 2, state_revision: 2, draft: { answer: '' } })
    const db = new Database(join(path, 'pliuna.sqlite'))
    expect(db.prepare('SELECT view_revision FROM view_history ORDER BY view_revision').all()).toEqual([{ view_revision: 1 }, { view_revision: 2 }]); db.close()
  })
  it('preserves saved user draft rather than new initial after explicit permission', async () => {
    const { store, task, run } = setup(); save(store, task, '我的已保存答案')
    const result = invoke(store, task, run); await tick()
    expect(store.snapshot(task.task.id).surface_updates).toHaveLength(0)
    approve(store, task); await tick(); await respond(store, task)
    expect((await result).error).toBeUndefined()
    expect(store.snapshot(task.task.id).views[0]!.draft).toEqual({ answer: '我的已保存答案' })
  })
  it('requires permission for a View created in an earlier Run', async () => {
    const { store, task, run } = setup()
    store.handle({ type: 'run.cancel', task_id: task.task.id, run_id: run })
    const nextRun = store.start(task.task.id, 'replace explicitly', 'fixture', []), result = invoke(store, task, nextRun)
    await tick(); expect(store.snapshot(task.task.id).approvals).toHaveLength(1)
    approve(store, task); await tick(); await respond(store, task)
    expect((await result).error).toBeUndefined()
  })
  it('reset permission is not input-discard confirmation and cancellation keeps old draft', async () => {
    const { store, task, run } = setup(); save(store, task, '不能自动清除')
    const result = invoke(store, task, run, request(store, task, true)); await tick(); approve(store, task); await tick()
    await expect(respond(store, task, true, false)).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' })
    expect(store.snapshot(task.task.id).views[0]!.draft).toEqual({ answer: '不能自动清除' })
    await respond(store, task, false)
    expect((await result).error).toMatchObject({ code: 'SURFACE_NOT_CONFIRMED' })
    expect(store.snapshot(task.task.id).views[0]!.revision).toBe(1)
  })
  it('explicit reset installs initial but does not change old immutable answers', async () => {
    const { store, task, run, path } = setup(); save(store, task, '旧题作答')
    const view = store.snapshot(task.task.id).views[0]!
    const submit = { type: 'answer.submit', task_id: task.task.id, view_id: view.id, view_revision: 1, expected_state_revision: view.state_revision, form_id: 'form' }
    store.handle(submit); store.handle(submit)
    const result = invoke(store, task, run, request(store, task, true)); await tick(); approve(store, task); await tick(); await respond(store, task, true, true)
    expect((await result).error).toBeUndefined()
    expect(store.snapshot(task.task.id).views[0]!.draft).toEqual({ answer: '新初值' })
    expect(store.snapshot(task.task.id).answers.map(a => a.value)).toEqual([{ answer: '旧题作答' }, { answer: '旧题作答' }])
    expect(() => store.handle(submit)).toThrow('Content or draft changed')
    const db = new Database(join(path, 'pliuna.sqlite'))
    expect(db.prepare('SELECT DISTINCT h.view_revision FROM answers a JOIN view_history h ON h.id=a.view_history_id').all()).toEqual([{ view_revision: 1 }]); db.close()
  })
  it('rejects schema and compatibility changes under preserve, and ambiguous reset initials', () => {
    const previous = bundle(), next = bundle('another', 'exercise-2')
    expect(() => replacementDraft(previous, next, { answer: '' }, { type: 'preserve', compatibility_version: 'exercise-1' })).toThrow('same schema')
    next.state.compatibility_version = 'exercise-1'; next.state.schema.description = 'changed'
    expect(() => replacementDraft(previous, next, { answer: '' }, { type: 'preserve', compatibility_version: 'exercise-1' })).toThrow('same schema')
    expect(() => replacementDraft(previous, bundle(), { answer: '' }, { type: 'reset', initial: { answer: 'different' } })).toThrow('exactly match')
  })
  it('preserves incomplete numeric draft text without applying formal answer validation', () => {
    const previous = bundle(); previous.state.schema.properties!.answer = { type: 'number' }
    const next = structuredClone(previous)
    expect(replacementDraft(previous, next, { answer: '-' }, { type: 'preserve', compatibility_version: 'exercise-1' })).toEqual({ answer: '-' })
  })
  it('keeps input edits during permission wait and rejects the stale replacement', async () => {
    const { store, task, run } = setup(); save(store, task, 'before')
    const result = invoke(store, task, run); await tick(); save(store, task, 'during approval'); approve(store, task)
    expect((await result).error).toMatchObject({ code: 'VERSION_CONFLICT' })
    expect(store.snapshot(task.task.id).views[0]!).toMatchObject({ revision: 1, draft: { answer: 'during approval' } })
    expect(store.snapshot(task.task.id).surface_updates).toHaveLength(0)
  })
  it('ends a host-check conflict rather than leaving a reusable confirmation', async () => {
    const { store, task, run } = setup(), result = invoke(store, task, run); await tick()
    save(store, task, 'late draft')
    await expect(respond(store, task)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    expect((await result).error).toMatchObject({ code: 'VERSION_CONFLICT' })
    expect(store.snapshot(task.task.id).surface_updates).toHaveLength(0)
    expect(store.snapshot(task.task.id).views[0]!.draft).toEqual({ answer: 'late draft' })
  })
  it('new formal submission while waiting invalidates the inspected replacement', async () => {
    const { store, task, run } = setup(), result = invoke(store, task, run); await tick()
    const view = store.snapshot(task.task.id).views[0]!
    store.handle({ type: 'answer.submit', task_id: task.task.id, view_id: view.id, view_revision: 1, expected_state_revision: 1, form_id: 'form' })
    await expect(respond(store, task)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    expect((await result).error).toMatchObject({ code: 'VERSION_CONFLICT' })
    expect(store.snapshot(task.task.id).views[0]!.revision).toBe(1)
  })
  it('rejects cross-task targets and repeated View targets before registering an action', async () => {
    const { store, task, run } = setup(), other = store.create('other'), input = request(store, task)
    const count = (store.handle({ type: 'operation.list', task_id: task.task.id, limit: 50 }) as unknown[]).length
    input.input.operations.push(structuredClone(input.input.operations[0]!))
    expect((await invoke(store, task, run, input)).error).toMatchObject({ code: 'INVALID_REQUEST' })
    expect((store.handle({ type: 'operation.list', task_id: task.task.id, limit: 50 }) as unknown[])).toHaveLength(count)
    const otherRun = store.start(other.task.id, 'cross task', 'fixture', [])
    expect((await invoke(store, other, otherRun, request(store, task))).error).toMatchObject({ code: 'NOT_FOUND' })
  })
  it('denial ends the action and cannot be reopened for that View in the same Run', async () => {
    const { store, task, run } = setup(); save(store, task, 'draft')
    const input = request(store, task), result = invoke(store, task, run, input); await tick()
    const approval = store.snapshot(task.task.id).approvals[0]!
    store.handle({ type: 'approval.decide', task_id: task.task.id, approval_id: approval.id, decision: 'deny' })
    expect((await result).error).toMatchObject({ code: 'APPROVAL_INVALID' })
    expect((await invoke(store, task, run, input)).error).toMatchObject({ code: 'APPROVAL_DENIED' })
    expect(store.snapshot(task.task.id).surface_updates).toHaveLength(0)
  })
  it('does not renew original permission when the later host check outlives it', async () => {
    const { store, task, run } = setup(); save(store, task, 'draft')
    // Cancel the fixture timer while keeping this deterministic source Run active.
    vi.clearAllTimers()
    const result = invoke(store, task, run); await tick(); approve(store, task); await tick()
    vi.setSystemTime(Date.now() + 900001)
    await expect(respond(store, task)).rejects.toMatchObject({ code: 'SOURCE_INVALID' })
    expect((await result).error).toBeDefined()
    expect(store.snapshot(task.task.id).views[0]!.revision).toBe(1)
  })
  it('rolls back replacement, history and mixed creation together after DB failure', async () => {
    const { store, task, run, path } = setup(), input = request(store, task)
    const mixed = { ...input, input: { ...input.input, operations: [{ type: 'view.create', client_ref: 'second', slot_id: 'main', bundle: { type: 'inline', bundle: bundle('second') } }, ...input.input.operations] } }
    const before = store.snapshot(task.task.id), result = invoke(store, task, run, mixed); await tick()
    const db = new Database(join(path, 'pliuna.sqlite'))
    db.exec("CREATE TRIGGER fail_replacement BEFORE UPDATE ON views BEGIN SELECT RAISE(ABORT,'injected replacement failure'); END")
    await expect(respond(store, task)).rejects.toMatchObject({ code: 'SURFACE_NOT_COMMITTED' })
    expect((await result).error).toBeDefined()
    expect(store.snapshot(task.task.id).views).toEqual(before.views)
    expect(store.snapshot(task.task.id).surface).toEqual(before.surface)
    expect(db.prepare('SELECT count(*) AS count FROM view_history').get()).toEqual({ count: 1 })
    expect(db.prepare("SELECT count(*) AS count FROM staging WHERE state='invalid'").get()).toEqual({ count: 2 }); db.close()
  })
  it.each(['cancel', 'stop', 'delete', 'restart'] as const)('invalidates pending host confirmation on %s without replay', async mode => {
    const { store, task, run, path } = setup(), result = invoke(store, task, run); await tick()
    const pending = store.snapshot(task.task.id).surface_updates[0]!
    if (mode === 'restart') store.close()
    else if (mode === 'cancel') store.handle({ type: 'run.cancel', task_id: task.task.id, run_id: run })
    else store.handle({ type: mode === 'stop' ? 'task.stop' : 'task.delete', task_id: task.task.id })
    expect((await result).error).toBeDefined()
    if (mode !== 'delete' && mode !== 'restart') {
      expect(store.snapshot(task.task.id).views[0]!.revision).toBe(1)
      await expect(store.handle({ type: 'surface.respond', task_id: task.task.id, action_id: pending.action_id, proceed: true, confirm_discard: true })).rejects.toBeDefined()
    }
    if (mode === 'restart') {
      const next = new RuntimeStore(path); cleanups.push(() => next.close())
      expect(next.snapshot(task.task.id).surface_updates).toHaveLength(0)
      expect(next.snapshot(task.task.id).views[0]!.revision).toBe(1)
      await expect(next.handle({ type: 'surface.respond', task_id: task.task.id, action_id: pending.action_id, proceed: true, confirm_discard: true })).rejects.toBeDefined()
    }
  })
})

describe('Surface removal and layout', () => {
  const removeRequest = (store: RuntimeStore, task: Snapshot) => {
    const current = store.snapshot(task.task.id), view = current.views[0]!
    return { type: 'write', input: { type: 'surface.update', surface_id: current.surface.id, expected_revision: current.surface.revision, operations: [{ type: 'view.remove', view_id: view.id, expected_view_revision: view.revision, expected_state_revision: view.state_revision }] } }
  }
  it('requires independent approval and discard confirmation; retains answers and history', async () => {
    const { store, task, run, path } = setup(); save(store, task, 'retained answer')
    let view = store.snapshot(task.task.id).views[0]!
    store.handle({ type: 'answer.submit', task_id: task.task.id, view_id: view.id, view_revision: view.revision, expected_state_revision: view.state_revision, form_id: 'form' })
    const result = invoke(store, task, run, removeRequest(store, task)); await tick()
    expect(store.snapshot(task.task.id).surface_updates).toHaveLength(0); approve(store, task); await tick()
    await expect(respond(store, task, true, false)).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' })
    await respond(store, task, true, true); expect((await result).error).toBeUndefined()
    expect(store.snapshot(task.task.id).views).toHaveLength(0); expect(store.snapshot(task.task.id).answers[0]!.value).toEqual({ answer: 'retained answer' })
    const db = new Database(join(path, 'pliuna.sqlite')); expect(db.prepare('SELECT count(*) n FROM view_history').get()).toEqual({ n: 1 }); expect(db.prepare('SELECT count(*) n FROM object_references').get()).toMatchObject({ n: 1 }); db.close()
  })
  it('cancelled removal retains the current draft and View', async () => {
    const { store, task, run } = setup(); save(store, task, 'keep draft')
    const result = invoke(store, task, run, removeRequest(store, task)); await tick(); approve(store, task); await tick(); await respond(store, task, false)
    expect((await result).error).toMatchObject({ code: 'SURFACE_NOT_CONFIRMED' }); expect(store.snapshot(task.task.id).views[0]!.draft).toEqual({ answer: 'keep draft' })
  })
  it('rejects stale removal after input changes during approval', async () => {
    const { store, task, run } = setup(), result = invoke(store, task, run, removeRequest(store, task)); await tick(); save(store, task, 'newer draft'); approve(store, task)
    expect((await result).error).toMatchObject({ code: 'VERSION_CONFLICT' }); expect(store.snapshot(task.task.id).views).toHaveLength(1)
  })
  it('publishes layout with current and newly-created references atomically', async () => {
    const { store, task, run } = setup(), current = store.snapshot(task.task.id)
    const result = invoke(store, task, run, { type: 'write', input: { type: 'surface.update', surface_id: current.surface.id, expected_revision: current.surface.revision, operations: [
      { type: 'view.create', client_ref: 'second', slot_id: 'main', bundle: { type: 'inline', bundle: bundle('second') } },
      { type: 'layout.set', layout: { slots: [{ slot_id: 'main', groups: [{ id: 'two-columns', mode: 'responsive_columns', views: [{ type: 'created', client_ref: 'second' }, { type: 'existing', view_id: current.views[0]!.id }], gap: 'large', align: 'start', column_weights: [1, 2] }] }] } }
    ] } }); await tick(); approve(store, task); await tick(); await respond(store, task)
    expect((await result).error).toBeUndefined(); const next = store.snapshot(task.task.id)
    expect(next.surface.layout!.slots[0]!.groups[0]).toMatchObject({ type: 'responsive_columns', views: [next.views[0]!.id, current.views[0]!.id] })
  })
  it('rejects omitted, cross-task, duplicate and removed layout references before registration', async () => {
    for (const mode of ['omitted', 'foreign', 'duplicate', 'removed']) {
      const { store, task, run } = setup(), current = store.snapshot(task.task.id), target = current.views[0]!
      const locators = mode === 'omitted' ? [] : [{ type: 'existing', view_id: mode === 'foreign' ? crypto.randomUUID() : target.id }]
      if (mode === 'duplicate') locators.push(locators[0]!)
      const operations: any[] = [{ type: 'layout.set', layout: { slots: [{ slot_id: 'main', groups: [{ id: 'g', mode: 'column', views: locators, gap: 'medium', align: 'stretch' }] }] } }]
      if (mode === 'removed') operations.unshift(removeRequest(store, task).input.operations[0])
      const result = await invoke(store, task, run, { type: 'write', input: { type: 'surface.update', surface_id: current.surface.id, expected_revision: current.surface.revision, operations } })
      expect(result.error).toBeDefined(); expect(store.snapshot(task.task.id).surface.revision).toBe(current.surface.revision)
    }
  })
  it('keeps the usable View page when another page is corrupt and filters column weights with its Views', () => {
    const {store,task,run,path}=setup(),before=store.snapshot(task.task.id)
    store.modelTool(task.task.id,run,{type:'write',input:{type:'surface.update',surface_id:before.surface.id,expected_revision:before.surface.revision,operations:Array.from({length:11},(_,i)=>({type:'view.create',client_ref:'page-'+i,slot_id:'main',bundle:{type:'inline',bundle:bundle('page-'+i)}}))}})
    const db=new Database(join(path,'pliuna.sqlite')),views=db.prepare('SELECT id,bundle_resource_id FROM views ORDER BY rowid').all() as any[]
    const layout={slots:[{id:'main',groups:[{id:'others',type:'column',views:views.slice(0,8).map(v=>v.id)},{id:'weighted',type:'responsive_columns',views:views.slice(8).map(v=>v.id),column_weights:[1,2,3,4]}]}]}
    db.prepare('UPDATE surfaces SET layout_json=? WHERE id=?').run(JSON.stringify(layout),before.surface.id)
    const current=store.snapshot(task.task.id);expect(current.surface.layout!.slots[0]!.groups[1]!.column_weights).toEqual([1,2])
    const broken=views[10]!.bundle_resource_id
    db.prepare('UPDATE resources SET sha256=? WHERE id=?').run('0'.repeat(64),broken);db.close()
    expect(()=>store.handle({type:'host.views.page',task_id:task.task.id,offset:10,expected_revision:current.surface.revision})).toThrow()
    expect(store.snapshot(task.task.id).view_page!.offset).toBe(0)
  })
})


describe('resource-backed bundle approval', () => {
  function source(store: RuntimeStore, task: Snapshot, run: string, next = bundle('Resource question')) {
    const result = store.modelTool(task.task.id, run, { type: 'write', input: { type: 'resource.create', display_name: 'synthetic-bundle.json', content: { type: 'json', value: next } } }) as any
    return { type: 'resource', resource: { kind: 'resource', id: result.data.id } }
  }
  it.each(['inline', 'resource'] as const)('rejects overlapping %s publications before approval and preserves existing input', async type => {
    const { store, task, run } = setup(); save(store, task, 'keep')
    const next = bundle('Invalid export'); next.html = '<section id="lesson">' + next.html + '</section>'
    next.export = [{ id: 'lesson', category: 'learning', source: { type: 'element', element_id: 'lesson' } }, { id: 'nested', category: 'learning', source: { type: 'element', element_id: 'answer' } }]
    const ref = type === 'inline' ? { type, bundle: next } : source(store, task, run, next)
    const before = store.snapshot(task.task.id), input: any = request(store, task); input.input.operations[0].bundle = ref
    const result = invoke(store, task, run, input); await tick()
    expect(store.snapshot(task.task.id).approvals).toHaveLength(0)
    expect((await result).error).toMatchObject({ code: 'EXPORT_FRAGMENT_OVERLAP' })
    expect(() => store.modelTool(task.task.id, run, { type: 'write', input: { type: 'surface.update', surface_id: before.surface.id, expected_revision: before.surface.revision, operations: [{ type: 'view.create', client_ref: 'bad', slot_id: 'main', bundle: ref }] } })).toThrow('overlap')
    const after = store.snapshot(task.task.id)
    expect(after.views).toEqual(before.views); expect(after.surface).toEqual(before.surface)
    expect(after.approvals).toHaveLength(0); expect(after.surface_updates).toHaveLength(0)
  })
  it('copies a same-task resource into independent immutable publication', () => {
    const { store, task, run, path } = setup(), current = store.snapshot(task.task.id), ref = source(store, task, run)
    store.modelTool(task.task.id, run, { type: 'write', input: { type: 'surface.update', surface_id: current.surface.id, expected_revision: current.surface.revision, operations: [{ type: 'view.create', client_ref: 'resource', slot_id: 'main', bundle: ref }] } })
    const db = new Database(join(path, 'pliuna.sqlite')), saved = db.prepare('SELECT bundle_resource_id FROM views ORDER BY rowid DESC LIMIT 1').get() as any
    expect(saved.bundle_resource_id).not.toBe(ref.resource.id)
    writeFileSync(join(path, 'resources', ref.resource.id), 'broken source after publication')
    expect(store.snapshot(task.task.id).views[1]!.presentation.html).toContain('Resource question'); db.close()
  })
  it('preserves original request and binds resolved content and source fingerprint to approval', async () => {
    const { store, task, run, path } = setup(), input: any = request(store, task)
    input.input.operations[0].bundle = source(store, task, run)
    save(store, task, 'saved')
    // The draft mutation requires fresh state preconditions.
    input.input.operations[0].state_transition.expected_state_revision = store.snapshot(task.task.id).views[0]!.state_revision
    const result = invoke(store, task, run, input); await tick()
    const db = new Database(join(path, 'pliuna.sqlite')), approval = db.prepare('SELECT binding_json,action_id FROM approvals').get() as any, binding = JSON.parse(approval.binding_json)
    expect(JSON.parse((db.prepare('SELECT request_json FROM actions WHERE id=?').get(approval.action_id) as any).request_json)).toEqual(input.input)
    expect(binding).toMatchObject({ version: 2, resolved: { version: 1, sources: [{ id: input.input.operations[0].bundle.resource.id }], effective_request: { operations: [{ bundle: { type: 'inline', bundle: { html: expect.stringContaining('Resource question') } } }] } } })
    expect(store.snapshot(task.task.id).approvals[0]!.request).toEqual(binding.resolved)
    approve(store, task); await tick(); await respond(store, task)
    expect((await result).error).toBeUndefined(); expect(store.snapshot(task.task.id).views[0]!.draft).toEqual({ answer: 'saved' }); db.close()
  })
  it.each(['source', 'binding'] as const)('refuses altered %s after inspection without changing the View', async change => {
    const { store, task, run, path } = setup(); save(store, task, 'keep')
    const input: any = request(store, task); input.input.operations[0].bundle = source(store, task, run)
    const result = invoke(store, task, run, input); await tick()
    const db = new Database(join(path, 'pliuna.sqlite'))
    if (change === 'source') writeFileSync(join(path, 'resources', input.input.operations[0].bundle.resource.id), 'corrupt')
    else { const row = db.prepare('SELECT id,binding_json FROM approvals').get() as any, binding = JSON.parse(row.binding_json); binding.resolved.sources[0].sha256 = '0'.repeat(64); db.prepare('UPDATE approvals SET binding_json=? WHERE id=?').run(JSON.stringify(binding), row.id) }
    approve(store, task); await tick()
    expect((await result).error).toMatchObject({ code: change === 'source' ? 'RESOURCE_CORRUPT' : 'APPROVAL_BINDING_CHANGED' })
    expect(store.snapshot(task.task.id).views[0]!).toMatchObject({ revision: 1, draft: { answer: 'keep' } }); expect(store.snapshot(task.task.id).surface_updates).toHaveLength(0); db.close()
  })
  it('rejects foreign resources and malformed JSON before approval', async () => {
    const { store, task, run, path } = setup(), ref = source(store, task, run), other = store.create('foreign'), otherRun = store.start(other.task.id, 'fixture', 'fixture', [])
    const input: any = request(store, task); input.input.operations[0].bundle = ref
    const db = new Database(join(path, 'pliuna.sqlite')); db.prepare('DELETE FROM task_resources WHERE task_id=? AND resource_id=?').run(task.task.id, ref.resource.id); db.prepare('INSERT INTO task_resources VALUES (?,?)').run(other.task.id, ref.resource.id)
    expect((await invoke(store, task, run, input)).error).toMatchObject({ code: 'RESOURCE_MISSING' }); expect(store.snapshot(task.task.id).approvals).toHaveLength(0)
    store.handle({ type: 'run.cancel', task_id: other.task.id, run_id: otherRun }); db.close()
  })
})
