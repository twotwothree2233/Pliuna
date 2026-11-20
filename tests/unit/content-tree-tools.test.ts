import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bundle, ChapterManifest, ContentTree, ModelRequest } from '../../src/shared/contracts.generated'
import { modelToolRequest } from '../../src/runtime/model/tool-input'
import { applyContentOperations, buildContentTree } from '../../src/runtime/runner/content-tree'
import { ContentTreeQueries } from '../../src/runtime/runner/content-tree-queries'
import { ContentTreeState } from '../../src/runtime/runner/content-tree-state'
import { RUNNER_LIMITS } from '../../src/runtime/runner/limits'
import { chapterBundle, chapterManifest } from '../helpers/chapters'

const core = readFileSync(new URL('../../src/shared/contracts/001-core.sql', import.meta.url), 'utf8')
const runner = readFileSync(new URL('../../src/shared/contracts/002-runner.sql', import.meta.url), 'utf8')
const databases: Database.Database[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
type Query = Extract<ModelRequest, { type: 'read' | 'list' }>

function setup(html = '<p>Original content</p>') {
  const db = new Database(':memory:'); databases.push(db)
  db.pragma('foreign_keys=ON'); db.exec(core); db.exec(runner)
  db.exec("INSERT INTO tasks(id,title,state,revision) VALUES ('task','Task','active',1); INSERT INTO tasks(id,title,state,revision) VALUES ('other','Other','active',1)")
  db.exec("INSERT INTO surfaces VALUES ('surface','task',1,'{}')")
  let state = new ContentTreeState(db), serial = 0, manifests: ChapterManifest[] = []
  const bundles = new Map<string, Bundle>(), dependency = vi.fn()
  const bundle = vi.fn((resource: string) => bundles.get(resource)!)
  const queries = () => new ContentTreeQueries(state, () => manifests, bundle, dependency)
  function publish(view: string, body: string, tree?: ContentTree) {
    const prior = state.snapshot('task', view), resource = `resource-${++serial}`
    let id = 0
    tree ??= buildContentTree(body, { nextId: () => `${view}-node-${++id}` })
    const revision = (prior?.view_revision ?? 0) + 1
    db.prepare("INSERT INTO resources VALUES (?,?,'fixture',0,'application/json','Body','time')").run(resource, resource)
    db.prepare("INSERT INTO task_resources VALUES ('task',?)").run(resource)
    if (prior) db.prepare('UPDATE views SET revision=?,bundle_resource_id=? WHERE id=?').run(revision, resource, view)
    else db.prepare("INSERT INTO views(id,surface_id,revision,bundle_resource_id,state_revision,draft_json,compatibility_version) VALUES (?,'surface',?,?,1,'{}','v1')").run(view, revision, resource)
    state.install({ task_id: 'task', view_id: view, view_revision: revision, state_revision: 1, bundle_resource_id: resource }, tree, prior?.tree.revision ?? null)
    const manifest: ChapterManifest = { ...chapterManifest(), view_id: view, view_revision: revision, bundle_resource_id: resource, content_tree: tree, chapters: [] }
    manifests = [...manifests.filter(item => item.view_id !== view), manifest]
    bundles.set(resource, { ...chapterBundle(), html: body })
    return manifest
  }
  const first = publish('view', html)
  function query(name: 'read' | 'list', raw: Record<string, unknown>, source = 'worker', task = 'task', bodyAllowed = true): any {
    return queries().query(task, source, modelToolRequest(name, raw) as Query, bodyAllowed)
  }
  return {
    db, first, publish, query, dependency, bundle,
    restart() { state = new ContentTreeState(db) },
    hideManifests() { manifests = [] },
    addManifest(manifest: ChapterManifest) { manifests.push(manifest) },
    cursor(payload: unknown) { return state.createCursor('task', 'view', payload) }
  }
}
const code = (action: () => unknown, value: string) => expect(action).toThrow(expect.objectContaining({ code: value }))
const paragraphs = (count: number) => Array.from({ length: count }, (_, index) => `<p>Secret paragraph ${index}</p>`).join('')

describe('content tree tools', () => {
  it('exposes structure without body excerpts, locators or unavailable operations', () => {
    const s = setup('<h1>Section</h1><p>Private body</p><ul><li>Private item</li></ul>')
    const result = s.query('read', { kind: 'content_tree', id: 'view' }, 'router', 'task', false)
    const section = result.data.items[0]
    const children = s.query('read', { kind: 'content_tree', id: section.node_id })
    const serialized = JSON.stringify([result, children])
    for (const forbidden of ['Private', 'selector', 'span', 'offset', 'html']) expect(serialized).not.toContain(`"${forbidden}"`)
    expect(serialized).not.toContain('Private')
    expect(result.data.node.operations).toEqual(['replace', 'insert'])
    expect(children.data.items[0].operations).toEqual(['replace', 'delete', 'move'])
    expect(children.data.items[1].operations).toContain('insert')
    expect(s.bundle).not.toHaveBeenCalled()
    expect(s.dependency).not.toHaveBeenCalled()
    code(() => s.query('read', { kind: 'content_node', id: section.node_id }, 'router', 'task', false), 'WORKER_CAPABILITY_DENIED')
    code(() => s.query('list', { kind: 'content_node' }, 'router', 'task', false), 'WORKER_CAPABILITY_DENIED')
  })

  it('rejects budgets too small to hold a progressing response', () => {
    const s = setup()
    const node = s.first.content_tree!.nodes.find(item => item.kind === 'paragraph')!
    for (const [kind, id] of [['content_tree', 'view'], ['content_node', node.node_id]]) code(() => s.query('read', { kind, id, max_chars: 1 }), 'TOOL_RESULT_LIMIT')
    expect(s.dependency).not.toHaveBeenCalled()
    expect(s.db.prepare('SELECT count(*) n FROM runner_content_tree_cursors').get()).toEqual({ n: 0 })
  })

  it('pages every structural child within the requested size and survives restart', () => {
    const s = setup(paragraphs(70)), expected = s.first.content_tree!.nodes[0]!.children
    const ids: string[] = []
    let result = s.query('read', { kind: 'content_tree', id: 'view', max_chars: 1800 })
    expect(result.truncated).toBe(true)
    s.hideManifests(); s.restart()
    for (;;) {
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(1800)
      expect(result.data.items.length).toBeLessThanOrEqual(RUNNER_LIMITS.index.page_items)
      ids.push(...result.data.items.map((item: { node_id: string }) => item.node_id))
      if (!result.next_cursor) break
      result = s.query('read', { kind: 'content_tree', id: 'view', cursor: result.next_cursor })
    }
    expect(ids).toEqual(expected)
  })

  it('binds read continuations to task, source, target, kind, revision and page size', () => {
    const s = setup(paragraphs(40)), first = s.query('read', { kind: 'content_tree', id: 'view', max_chars: 1500 })
    const raw = { kind: 'content_tree', id: 'view', cursor: first.next_cursor }
    expect(first.next_cursor).toEqual(expect.any(String))
    code(() => s.query('read', raw, 'worker', 'other'), 'CONTENT_CURSOR_INVALID')
    code(() => s.query('read', raw, 'another-worker'), 'CONTENT_CURSOR_INVALID')
    code(() => s.query('read', { ...raw, id: s.first.content_tree!.root_id }), 'CONTENT_CURSOR_INVALID')
    code(() => s.query('read', { ...raw, kind: 'content_node' }), 'CONTENT_CURSOR_INVALID')
    code(() => s.query('read', { ...raw, max_chars: 1600 }), 'CONTENT_CURSOR_INVALID')
    code(() => s.query('read', { ...raw, selection: { revision: 2 } }), 'READ_VERSION_CHANGED')
    expect(s.query('read', raw).data.tree_revision).toBe(1)
    for (const payload of [null, {}, { mode: 'list' }]) code(() => s.query('read', { ...raw, cursor: s.cursor(payload) }), 'CONTENT_CURSOR_INVALID')
  })

  it('searches headings only inside the selected subtree', () => {
    const s = setup('<h1>A</h1><h2>Shared A</h2><p>A private</p><h1>B</h1><h2>Shared B</h2><p>B private</p>')
    const section = s.first.content_tree!.nodes.find(item => item.title === 'A')!
    const result = s.query('read', { kind: 'content_tree', id: section.node_id, selection: { find: 'Shared' } })
    expect(result.data.items.map((item: { title: string }) => item.title)).toEqual(['Shared A'])
    expect(s.bundle).not.toHaveBeenCalled()
    code(() => s.query('read', { kind: 'content_tree', id: section.node_id, selection: { view: 'object', lines: [1, 2] } }), 'CONTENT_QUERY_INVALID')
  })

  it('restores an omitted heading query and rejects a changed continuation query', () => {
    const s = setup('<h1>Root</h1>' + Array.from({ length: 40 }, (_, i) => `<h2>Match ${i}</h2><p>Hidden ${i}</p>`).join(''))
    const first = s.query('read', { kind: 'content_tree', id: 'view', max_chars: 1700, selection: { find: 'Match' } })
    const raw = { kind: 'content_tree', id: 'view', cursor: first.next_cursor }
    expect(first.next_cursor).toEqual(expect.any(String))
    code(() => s.query('read', { ...raw, selection: { find: 'Other' } }), 'CONTENT_CURSOR_INVALID')
    const next = s.query('read', raw)
    expect(next.data.items.every((item: { title: string }) => item.title.startsWith('Match'))).toBe(true)
  })

  it('returns the complete node HTML through immutable Unicode-safe pages', () => {
    const body = '<p>' + '你好🙂 "quoted" \\'.repeat(150) + '</p>', s = setup(body)
    const tree = s.first.content_tree!, node = tree.nodes.find(item => item.kind === 'paragraph')!
    let result = s.query('read', { kind: 'content_node', id: node.node_id, max_chars: 900, selection: { revision: 1 } })
    const readRef = result.data.read_ref
    expect(readRef).toEqual(expect.any(String))
    expect(result.next_cursor).toEqual(expect.any(String))
    code(() => s.query('read', { kind: 'content_node', id: node.node_id, cursor: result.next_cursor }, 'another-worker'), 'CONTENT_CURSOR_INVALID')
    const updated = applyContentOperations({ html: body, tree, operations: [{ type: 'replace', node_ids: [node.node_id], html: '<p>New body</p>' }] })
    s.publish('view', updated.html, updated.tree); s.hideManifests(); s.restart()
    let html = ''
    for (;;) {
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(900)
      expect(Buffer.from(result.data.html).toString()).toBe(result.data.html)
      expect(result.data.revision).toBe(1)
      expect(result.data.read_ref).toBe(readRef)
      html += result.data.html
      if (!result.next_cursor) break
      code(() => s.query('read', { kind: 'content_node', id: node.node_id, cursor: result.next_cursor, selection: { revision: 2 } }), 'READ_VERSION_CHANGED')
      result = s.query('read', { kind: 'content_node', id: node.node_id, cursor: result.next_cursor })
    }
    expect(html).toBe(body)
    expect(s.dependency).toHaveBeenCalledWith(expect.objectContaining({ node_id: node.node_id, revision: 1, bundle_resource_id: s.first.bundle_resource_id, tree_revision: 1 }), undefined)
    expect(s.dependency).toHaveBeenCalledWith(expect.objectContaining({ node_id: node.node_id, revision: 1, bundle_resource_id: s.first.bundle_resource_id, tree_revision: 1 }), readRef)
  })

  it('pages direct retired successors without guessing a replacement', () => {
    const original = '<p>Old identity</p>', s = setup(original), tree = s.first.content_tree!
    const old = tree.nodes.find(item => item.kind === 'paragraph')!
    const split = applyContentOperations({ html: original, tree, operations: [{ type: 'replace', node_ids: [old.node_id], html: paragraphs(40) }] })
    s.publish('view', split.html, split.tree)
    const successors = split.tree.lineage.find(item => item.previous_node_id === old.node_id)!.successor_node_ids
    const again = applyContentOperations({ html: split.html, tree: split.tree, operations: [{ type: 'replace', node_ids: [successors[0]!], html: '<p>First</p><p>Second</p>' }] })
    s.publish('view', again.html, again.tree)
    let result = s.query('read', { kind: 'content_tree', id: old.node_id, max_chars: 800 })
    expect(result.data).toMatchObject({ state: 'retired', successor_kind: 'direct', successor_count: successors.length, lineage: { previous_node_id: old.node_id, reason: 'split', revision: 2 } })
    expect(result.next_cursor).toEqual(expect.any(String))
    code(() => s.query('read', { kind: 'content_tree', id: old.node_id, max_chars: 1 }), 'TOOL_RESULT_LIMIT')
    const ids: string[] = []
    s.hideManifests(); s.restart()
    for (;;) {
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(800)
      expect(result.data.successor_node_ids.length).toBeLessThanOrEqual(RUNNER_LIMITS.index.page_items)
      ids.push(...result.data.successor_node_ids)
      if (!result.next_cursor) break
      result = s.query('read', { kind: 'content_tree', id: old.node_id, cursor: result.next_cursor })
    }
    expect(ids).toEqual(successors)
    expect(ids).toContain(successors[0])
    expect(s.bundle).not.toHaveBeenCalled()
  })

  it('returns host evidence references for fresh node snapshots', () => {
    const s = setup(), tree = s.first.content_tree!, node = tree.nodes.find(item => item.kind === 'paragraph')!
    s.dependency.mockReturnValueOnce('read-original').mockReturnValueOnce('read-current')
    const before = s.query('read', { kind: 'content_node', id: node.node_id })
    expect(before.data).toMatchObject({ read_ref: 'read-original', revision: 1, bundle_resource_id: s.first.bundle_resource_id })
    const updated = applyContentOperations({ html: s.bundle(s.first.bundle_resource_id).html, tree, operations: [{ type: 'replace', node_ids: [node.node_id], html: '<p>Current content</p>' }] })
    const current = s.publish('view', updated.html, updated.tree)
    const after = s.query('read', { kind: 'content_node', id: node.node_id })
    expect(after.data).toMatchObject({ read_ref: 'read-current', revision: 2, bundle_resource_id: current.bundle_resource_id, html: '<p>Current content</p>' })
    expect(before.data.read_ref).toBe('read-original')
    expect(before.data.html).toBe('<p>Original content</p>')
  })

  it('reports a deleted node with an empty successor set', () => {
    const body = '<p>A</p><p>B</p>', s = setup(body), tree = s.first.content_tree!
    const old = tree.nodes[1]!
    const deleted = applyContentOperations({ html: body, tree, operations: [{ type: 'delete', node_ids: [old.node_id] }] })
    s.publish('view', deleted.html, deleted.tree)
    expect(s.query('read', { kind: 'content_node', id: old.node_id })).toMatchObject({ data: { state: 'retired', successor_count: 0, successor_node_ids: [], lineage: { reason: 'deleted' } }, next_cursor: null, truncated: false })
  })

  it('pins complete list continuations across edits, new Views and restart', () => {
    const s = setup()
    for (let i = 1; i < 70; i++) s.publish(`view-${i}`, '<p>Content</p>')
    let result = s.query('list', { kind: 'content_tree', limit: 7 })
    expect(result.items).toHaveLength(7)
    const firstCursor = result.next_cursor, ids: string[] = []
    const raw = { kind: 'content_tree', cursor: firstCursor }
    code(() => s.query('list', raw, 'worker', 'other'), 'CONTENT_CURSOR_INVALID')
    code(() => s.query('list', raw, 'other-worker'), 'CONTENT_CURSOR_INVALID')
    code(() => s.query('list', { ...raw, kind: 'content_node' }), 'CONTENT_CURSOR_INVALID')
    code(() => s.query('list', { ...raw, limit: 8 }), 'CONTENT_CURSOR_INVALID')
    code(() => s.query('list', { ...raw, filters: { name_query: 'Changed' } }), 'CONTENT_CURSOR_INVALID')
    s.publish('new-view', '<p>Later</p>'); s.hideManifests(); s.restart()
    for (;;) {
      expect(result.items.length).toBeLessThanOrEqual(7)
      expect(result.items.every((item: { kind: string; revision: number }) => item.kind === 'content_tree' && item.revision === 1)).toBe(true)
      ids.push(...result.items.map((item: { id: string }) => item.id))
      if (!result.next_cursor) break
      result = s.query('list', { kind: 'content_tree', cursor: result.next_cursor })
    }
    expect(ids).toHaveLength(70)
    expect(new Set(ids).size).toBe(70)
    expect(ids).not.toContain('new-view')
  })

  it('lists node roots and filters metadata without loading body resources', () => {
    const s = setup('<h1>Overview</h1><p>Secret</p>')
    s.publish('second-view', '<h1>Details</h1><p>Hidden</p>')
    const result = s.query('list', { kind: 'content_node', filters: { name_query: 'overview' } })
    expect(result.items).toEqual([{ kind: 'content_node', id: s.first.content_tree!.root_id, view_id: 'view', root_id: s.first.content_tree!.root_id, revision: 1 }])
    expect(s.bundle).not.toHaveBeenCalled()
    code(() => s.query('list', { kind: 'content_tree', filters: { status: 'active' } }), 'CONTENT_QUERY_INVALID')
  })

  it('distinguishes a missing baseline, unknown target and task boundary', () => {
    const s = setup()
    s.addManifest({ ...chapterManifest(), view_id: 'unmapped', content_tree: buildContentTree('<p>Unmapped</p>') })
    code(() => s.query('read', { kind: 'content_tree', id: 'unmapped' }), 'CONTENT_BASELINE_MISSING')
    code(() => s.query('read', { kind: 'content_tree', id: 'missing' }), 'CONTENT_NODE_NOT_FOUND')
    code(() => s.query('read', { kind: 'content_tree', id: 'view' }, 'worker', 'other'), 'CONTENT_NODE_NOT_FOUND')
    s.hideManifests()
    expect(s.query('read', { kind: 'content_tree', id: 'view', selection: { revision: 1 } }).data.tree_revision).toBe(1)
    code(() => s.query('read', { kind: 'content_tree', id: 'view', selection: { revision: 9 } }), 'READ_VERSION_CHANGED')
  })
})
