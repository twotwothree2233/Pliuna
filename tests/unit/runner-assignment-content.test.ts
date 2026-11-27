import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { afterEach, expect, it, vi } from 'vitest'
import { AssignmentContent, BoundContentReader, type MaterialInput, type PublishedInput } from '../../src/runtime/runner/assignment-content'
import { InitialWorkDraft, ROUTE_WORK } from '../../src/runtime/runner/orchestration-tool'
import { modelToolRequest } from '../../src/runtime/model/tool-input'
import { applyContentOperations, buildContentTree } from '../../src/runtime/runner/content-tree'
import { ContentTreeState } from '../../src/runtime/runner/content-tree-state'
import type { LogicalWork } from '../../src/shared/contracts.generated'
import { chapterBundle } from '../helpers/chapters'
import { RunnerWorkState } from '../../src/runtime/runner/work-state'
import { RunnerBudgetLedger } from '../../src/runtime/runner/budget'
import { RoutingInputCatalog, type CatalogOutput } from '../../src/runtime/runner/routing-input-catalog'

const databases: Database.Database[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })

function setup(html = '<h1>Policy</h1><p>Exact published content</p>') {
  const db = new Database(':memory:'); databases.push(db)
  db.exec(readFileSync(new URL('../../src/shared/contracts/001-core.sql', import.meta.url), 'utf8'))
  db.exec(readFileSync(new URL('../../src/shared/contracts/002-runner.sql', import.meta.url), 'utf8'))
  db.exec(`INSERT INTO tasks(id,title,state,revision) VALUES ('task','Task','active',1),('other','Other','active',1);
    INSERT INTO surfaces VALUES ('surface','task',1,'{}');
    INSERT INTO resources VALUES ('old','old','fixture',4,'text/plain','Notes','time'),('new','new','fixture',4,'text/plain','Notes','time'),('foreign','foreign','fixture',4,'text/plain','Notes','time'),('bundle','bundle','fixture',4,'application/json','Bundle','time');
    INSERT INTO task_resources VALUES ('task','old'),('task','new'),('other','foreign'),('task','bundle');
    INSERT INTO records VALUES ('old-import','task',1,'material.imported','{"resource_id":"old"}','time'),('new-import','task',3,'material.imported','{"resource_id":"new"}','time');
    INSERT INTO requests VALUES ('request','task','queued','{}','{"conversation":{"through_sequence":2}}','time');
    INSERT INTO views(id,surface_id,revision,bundle_resource_id,state_revision,draft_json,compatibility_version) VALUES ('view','surface',1,'bundle',1,'{}','v1');
    INSERT INTO view_history VALUES ('history','task','view',1,'bundle','{}');`)
  let serial = 0
  const tree = buildContentTree(html, { nextId: () => `node-${++serial}` })
  new ContentTreeState(db).install({ task_id: 'task', view_id: 'view', view_revision: 1, state_revision: 1, bundle_resource_id: 'bundle' }, tree, null)
  return { db, content: new AssignmentContent(db), html, tree, published: { kind: 'published', view_id: 'view', view_revision: 1, node_id: tree.nodes.find(node => node.kind === 'section')!.node_id, revision: 1, tree_revision: 1 } as const }
}

function assigned(inputs: (MaterialInput | PublishedInput)[]): LogicalWork {
  return { purpose: 'production', task_id: 'task', run_id: 'run', request_id: 'request', intent_revision: 1, work_id: 'worker', plan_revision: 1, role: 'producer', required: true, requirement_ids: [], state: 'planned', max_attempts: 2, dependencies: [], assignment: { instructions: 'Use exact input', inputs, outputs: [{ kind: 'answer', output_key: 'answer' }] } }
}

function republish(db: Database.Database, html: string, tree: ReturnType<typeof buildContentTree>, node_id: string) {
  const replacement = applyContentOperations({ html, tree, operations: [{ type: 'replace', node_ids: [node_id], html: '<p>Updated policy</p>' }] })
  const revision = replacement.tree.revision, resource = `bundle-${revision}`
  db.prepare("INSERT INTO resources VALUES (?,?,'fixture',4,'application/json','Bundle','time')").run(resource, resource)
  db.prepare("INSERT INTO task_resources VALUES ('task',?)").run(resource)
  db.prepare('UPDATE views SET revision=?,bundle_resource_id=?').run(revision, resource)
  db.prepare("INSERT INTO view_history VALUES (?,'task','view',?,?,'{}')").run(`history-${revision}`, revision, resource)
  new ContentTreeState(db).install({ task_id: 'task', view_id: 'view', view_revision: revision, state_revision: 1, bundle_resource_id: resource }, replacement.tree, tree.revision)
  return replacement
}

it('resolves exact references within original request scope and rechecks authority at installation', () => {
  const { db, content, published } = setup(), scope = content.scope('task', 'request')
  const material = { kind: 'material', resource_id: 'old' } as const
  expect(() => content.checkNew(scope, material, 'writer')).not.toThrow()
  expect(() => content.checkNew(scope, published, 'writer')).not.toThrow()
  expect(() => content.checkNew(scope, { ...material, resource_id: 'foreign' }, 'writer')).toThrow('Assignment writer: material foreign: source is no longer readable in this Task')
  expect(() => content.checkNew(scope, { ...material, resource_id: 'new' }, 'writer')).toThrow('outside the original request material scope')
  expect(() => content.checkNew(scope, { ...published, revision: 2 }, 'writer')).toThrow('exact published node is unavailable')
  db.exec("UPDATE views SET revision=2 WHERE id='view'; DELETE FROM task_resources WHERE task_id='task' AND resource_id='old'")
  expect(() => content.checkNew(scope, material, 'writer')).toThrow('source is no longer readable')
  expect(() => content.checkNew(scope, published, 'writer')).toThrow('published version changed before binding')
})

it('rejects a draft with one invalid reference without keeping its valid assignment', () => {
  const { db, content, published } = setup(), scope = content.scope('task', 'request')
  const draft = new InitialWorkDraft(undefined, undefined, (input, assignment) => content.checkNew(scope, input, assignment))
  const make = (assignment_key: string, inputs: unknown[]) => ({ assignment_key, instructions: 'Use the selected input', required: false, requirement_ids: [], outputs: [{ kind: 'answer', output_key: 'text' }], inputs })
  const good = make('reader', [published]), bad = make('writer', [{ kind: 'material', resource_id: 'foreign' }])
  const propose = (assignments: unknown[]) => {
    const call = modelToolRequest('call', { capability: ROUTE_WORK, input_json: JSON.stringify({ action: 'dispatch', base_revision: 0, assignments }) })
    if (call.type !== 'call') throw Error('Expected a call')
    return draft.propose(call.input)
  }
  expect(() => propose([good, bad])).toThrow('Assignment writer')
  expect(draft.decision()).toBeUndefined()
  expect(db.prepare('SELECT COUNT(*) AS count FROM runner_work').get()).toEqual({ count: 0 })
  expect(db.prepare('SELECT COUNT(*) AS count FROM task_resources').get()).toEqual({ count: 4 })
  expect(propose([good])).toEqual({ revision: 1, assignment_keys: ['reader'] })
})

it('reads exact same-name materials and fixed chapter pages only with the consuming attempt entry', async () => {
  const { db, content, html, tree, published } = setup(`<h1>Policy</h1><p>${'Original policy. '.repeat(450)}</p><h1>Unselected</h1><p>Other body</p>`)
  const reader = new BoundContentReader(), inputs = [{ kind: 'material', resource_id: 'old' }, { kind: 'material', resource_id: 'new' }, published] satisfies (PublishedInput | MaterialInput)[]
  const work = assigned(inputs), bundle = vi.fn(() => ({ ...chapterBundle(), html })), material = vi.fn(read => read.input.target.id)
  const entries = reader.entries(content, work, 'attempt')
  expect(entries.slice(0, 2).map(item => item.display_name)).toEqual(['Notes', 'Notes'])
  expect(await reader.read(db, work, 'attempt', { input_ref: entries[0]!.input_ref }, bundle, material)).toBe('old')
  expect(await reader.read(db, work, 'attempt', { input_ref: entries[1]!.input_ref }, bundle, material)).toBe('new')
  const section = { input_ref: entries[2]!.input_ref }, first = await reader.read(db, work, 'attempt', section, bundle, material) as { data: { html: string }; next_cursor: string }
  expect(first.data.html).toContain('Original policy')
  expect(first.next_cursor).toBeTruthy()
  republish(db, html, tree, tree.nodes.filter(node => node.kind === 'paragraph').at(-1)!.node_id)
  const next = await reader.read(db, work, 'attempt', { ...section, cursor: first.next_cursor }, bundle, material)
  expect(JSON.stringify(next)).not.toMatch(/Updated policy|Other body/)
  expect(bundle.mock.calls).toEqual([['bundle'], ['bundle']])
  await expect(reader.read(db, work, 'other-attempt', section, bundle, material)).rejects.toMatchObject({ code: 'WORKER_CAPABILITY_DENIED' })
  await expect(reader.read(db, work, 'other-attempt', { input_ref: 'other-attempt:2', cursor: first.next_cursor }, bundle, material)).rejects.toMatchObject({ code: 'CONTENT_CURSOR_INVALID' })
})

it('retains installed authority after library removal and restart but rejects a changed chapter at commit', () => {
  const { db, content, html, tree, published } = setup('<h1>Policy</h1><p>Original policy</p><h1>Other</h1><p>Other body</p>')
  const state = new RunnerWorkState(db, 'epoch'), old = { kind: 'material', resource_id: 'old' } as const
  db.exec(`UPDATE requests SET state='started'; INSERT INTO records VALUES ('message','task',4,'message.user','{}','time');
    INSERT INTO runs(id,task_id,request_id,state,runtime_epoch,limits_json,budget_json,created_at) VALUES ('run','task','request','running','epoch','{}','{}','time')`)
  state.receive({ input_event_id: 'event', task_id: 'task', request_id: 'request', record_id: 'message', kind: 'request', stage: 'received' })
  state.installGoal({ task_id: 'task', request_id: 'request', intent_revision: 1, input_event_id: 'event', requirements: [], state: 'active' })
  new RunnerBudgetLedger(db).create({ task_id: 'task', request_id: 'request', budget_id: 'budget', purpose: 'production' })
  state.registerRun({ task_id: 'task', request_id: 'request', intent_revision: 1, run_id: 'run', runtime_epoch: 'epoch', purpose: 'production', state: 'running', commit_valid: true, budget_id: 'budget' })
  state.installPlan([assigned([old, published]), { ...assigned([]), work_id: 'independent' }])
  state.createAttempt({ attempt_id: 'attempt', task_id: 'task', run_id: 'run', request_id: 'request', work_id: 'worker', intent_revision: 1, purpose: 'production', runtime_epoch: 'epoch', profile_id: 'producer', model_config_id: 'model', model_config_revision: 1, attempt_number: 1, dispatch_state: 'not_dispatched', state: 'registered', input_versions: [], content_inputs: [old, published], usage_refs: [] })
  db.exec(`INSERT INTO records VALUES ('remove','task',5,'material.removed','{"resource_id":"old"}','time')`)
  expect(() => content.checkNew(content.scope('task', 'request'), old, 'other')).toThrow('removed from active materials')
  const unrelated = republish(db, html, tree, tree.nodes.filter(node => node.kind === 'paragraph').at(-1)!.node_id)
  const restored = new RunnerWorkState(db, 'epoch')
  expect(restored.qualify('attempt').attempt).toMatchObject({ content_inputs: [old, published] })
  expect(new AssignmentContent(db).published('task', published).resource).toBe('bundle')
  republish(db, unrelated.html, unrelated.tree, tree.nodes.find(node => node.kind === 'paragraph')!.node_id)
  expect(() => restored.qualify('attempt', 'commit')).toThrow('the selected chapter changed')
  expect(restored.reconcileDependencies('task')).toMatchObject([{ work_id: 'worker', root_cause: { input: published } }])
  expect(restored.work('independent').state).toBe('planned')
})

it('lists bounded metadata for current materials, published sections and old outputs without exposing bodies', () => {
  const { db, content, published } = setup()
  db.exec("UPDATE requests SET input_json=json_set(input_json,'$.bound_materials',json('[{\"id\":\"new\"}]'))")
  const scope = content.scope('task', 'request')
  const outputs: CatalogOutput[] = Array.from({ length: 42 }, (_, ordinal) => ({ kind: 'output', name: ordinal === 0 ? 'Historical result' : '数据'.repeat(45), status: ordinal === 0 ? 'accepted' : 'expected', reference: { work_id: `work-${ordinal}`, plan_revision: 1, output_key: 'counts', ...(ordinal === 0 ? { result_revision: 2 } : {}) }, source: { work_id: `work-${ordinal}`, request_id: 'earlier' } }))
  const catalog = new RoutingInputCatalog(db, scope, () => outputs)
  const first = catalog.page({ kind: 'material', name_query: 'notes', limit: 1 })
  for (const alternate of [scope, { ...scope, request: 'other-request' }]) {
    expect(() => new RoutingInputCatalog(db, alternate, () => outputs).page({ cursor: first.next_cursor })).toThrow(expect.objectContaining({ code: 'RUNNER_CATALOG_CURSOR_INVALID' }))
  }
  expect(() => catalog.page({ cursor: first.next_cursor, kind: 'published' })).toThrow(expect.objectContaining({ code: 'RUNNER_CATALOG_CURSOR_INVALID' }))
  expect(first.items).toMatchObject([{ reference: { resource_id: 'new' }, source: { kind: 'attachment', request_id: 'request' } }])
  expect(catalog.page({ cursor: first.next_cursor }).items).toMatchObject([{ reference: { resource_id: 'old' }, source: { kind: 'import', import_id: 'old-import' } }])
  expect(catalog.page({ kind: 'published', name_query: 'policy' }).items).toMatchObject([{ reference: published, status: 'published', name: 'Policy' }])
  expect(catalog.page({ kind: 'output', name_query: 'historical' }).items).toMatchObject([{ reference: { result_revision: 2, work_id: 'work-0' }, status: 'accepted' }])
  const page = catalog.page({ kind: 'output', limit: 32 })
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(8192)
  expect(page.items.length).toBeLessThan(32)
  expect(catalog.page({ cursor: page.next_cursor }).items[0]?.reference).toEqual(outputs[page.items.length]?.reference)
  expect(JSON.stringify(catalog.page({}))).not.toMatch(/Exact published content|storage_key|foreign|sha256/)
  db.exec(`INSERT INTO records VALUES ('removal','task',4,'material.removed','{"resource_id":"new"}','time')`)
  expect(() => catalog.page({ cursor: first.next_cursor })).toThrow(expect.objectContaining({ code: 'RUNNER_CATALOG_CURSOR_INVALID' }))
  expect(catalog.page({ kind: 'material' }).items).toMatchObject([{ reference: { resource_id: 'old' } }])
})
