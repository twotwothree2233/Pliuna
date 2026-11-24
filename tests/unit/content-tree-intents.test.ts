import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import coreSql from '../../src/shared/contracts/001-core.sql?raw'
import runnerSql from '../../src/shared/contracts/002-runner.sql?raw'
import type { ChapterManifest, ChapterUpdate, ContentOperationPlan } from '../../src/shared/contracts.generated'
import { ChapterState } from '../../src/runtime/runner/chapter-state'
import { applyContentOperations, buildContentTree } from '../../src/runtime/runner/content-tree'
import { assertContentAuthority, contentBaselineCurrent, contentUpdatesOverlap, reconcileRetainedContentScope, treeChapters } from '../../src/runtime/runner/content-tree-host'
import { chapterManifest, chapterUpdate } from '../helpers/chapters'

const databases: Database.Database[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })

function setup() {
  const db = new Database(':memory:'); databases.push(db)
  db.pragma('foreign_keys=ON'); db.exec(coreSql); db.exec(runnerSql)
  db.exec("INSERT INTO tasks(id,title,state,revision) VALUES ('task','Task','active',1); INSERT INTO requests VALUES ('goal','task','started','{}','{}','time'); INSERT INTO records VALUES ('record','task',1,'message.user','{}','time'); INSERT INTO runner_inputs VALUES ('input','task','record','request','{}','time')")
  const goal = { task_id: 'task', request_id: 'goal', intent_revision: 1, input_event_id: 'input', state: 'active', requirements: [] }
  db.prepare('INSERT INTO runner_content_plans VALUES (?,?,?,?,?)').run('task', 'goal', 1, 'input', JSON.stringify(goal))
  for (const resource of ['original', 'published']) {
    db.prepare("INSERT INTO resources VALUES (?,?,'fixture',0,'application/json','Body','time')").run(resource, resource)
    db.prepare("INSERT INTO task_resources VALUES ('task',?)").run(resource)
  }
  db.exec("INSERT INTO surfaces VALUES ('surface','task',1,'{}'); INSERT INTO views(id,surface_id,revision,bundle_resource_id,state_revision,draft_json,compatibility_version) VALUES ('view','surface',1,'original',1,'{}','v1')")
  const state = new ChapterState(db), html = '<h2>A</h2><p>A1</p><p>A2</p><h2>B</h2><p>B1</p><p>B2</p>'
  const tree = buildContentTree(html), manifest: ChapterManifest = { ...chapterManifest(), content_tree: tree, chapters: treeChapters(tree) }
  state.installManifest(manifest, null)
  const sections = tree.nodes.filter(node => node.kind === 'section'), paragraphs = tree.nodes.filter(node => node.kind === 'paragraph')
  function start(id: string, ids: string[], operations?: ContentOperationPlan[]): ChapterUpdate {
    return state.start({ ...chapterUpdate(id, ids, state.manifest('task', 'view')!), ...(operations ? { tree_operations: operations } : {}) })
  }
  function relation(update: ChapterUpdate, previous: ChapterUpdate): { retained_node_ids: string[]; retained_tree_operations?: ContentOperationPlan[] } {
    const row = db.prepare('SELECT payload_json FROM runner_content_intent_relations WHERE task_id=? AND update_id=? AND previous_update_id=?').get('task', update.update_id, previous.update_id) as { payload_json: string }
    return JSON.parse(row.payload_json)
  }
  return { db, state, tree, html, manifest, sections, paragraphs, start, relation }
}

describe('content intent remainder scopes', () => {
  it('binds a retained planned operation only to its remaining nodes', () => {
    const s = setup(), [first, second] = s.paragraphs
    const previous = s.start('old', [first!.node_id, second!.node_id], [
      { type: 'replace', node_ids: [first!.node_id] },
      { type: 'replace', node_ids: [second!.node_id] }
    ])
    const next = s.start('new', [first!.node_id], [{ type: 'replace', node_ids: [first!.node_id] }])
    expect(s.relation(next, previous)).toMatchObject({
      retained_node_ids: [second!.node_id],
      retained_tree_operations: [{ type: 'replace', node_ids: [second!.node_id] }]
    })
    expect(s.state.assertCurrent('task', next.update_id).state).toBe('queued')
  })

  it('keeps unaffected requirements when one member of a planned replacement group is taken over', () => {
    const s = setup(), [first, second] = s.paragraphs
    const previous = s.start('old-group', [first!.node_id, second!.node_id], [{ type: 'replace', node_ids: [first!.node_id, second!.node_id] }])
    const next = s.start('new-member', [first!.node_id], [{ type: 'replace', node_ids: [first!.node_id] }])
    expect(s.relation(next, previous).retained_node_ids).toEqual([second!.node_id])
    expect(s.state.update('task', previous.update_id)?.state).toBe('superseded')
    expect(s.state.assertCurrent('task', next.update_id).state).toBe('queued')
  })

  it('keeps existing branches when a new request only inserts into their parent gap', () => {
    const s = setup(), section = s.sections[0]!, [first, second] = s.paragraphs
    const previous = s.start('old-section', [section.node_id])
    const next = s.start('new-insertion', [section.node_id], [{ type: 'insert', parent_id: section.node_id, position: 'after', anchor_id: first!.node_id }])
    expect(s.relation(next, previous).retained_node_ids).toEqual([first!.node_id, second!.node_id])
    expect(s.state.assertCurrent('task', next.update_id).state).toBe('queued')
  })

  it('keeps retained destination gaps without also rebinding a replaced source node', () => {
    const s = setup(), first = s.paragraphs[0]!, destination = s.sections[1]!
    const insert: ContentOperationPlan = { type: 'insert', parent_id: destination.node_id, position: 'end' }
    const previous = s.start('old-mixed', [first.node_id, destination.node_id], [{ type: 'replace', node_ids: [first.node_id] }, insert])
    const next = s.start('new-source', [first.node_id], [{ type: 'replace', node_ids: [first.node_id] }])
    expect(s.relation(next, previous)).toMatchObject({ retained_node_ids: [destination.node_id], retained_tree_operations: [insert] })
  })

  it('does not let an already retired pending target block a current independent update', () => {
    const s = setup(), first = s.paragraphs[0]!, outside = s.paragraphs[2]!
    const previous = s.start('stale', [first.node_id])
    const changed = applyContentOperations({ html: s.html, tree: s.tree, operations: [{ type: 'replace', node_ids: [first.node_id], html: '<p>Split one</p><p>Split two</p>' }] })
    const current: ChapterManifest = { ...s.manifest, view_revision: 2, manifest_revision: 2, bundle_resource_id: 'published', content_tree: changed.tree, chapters: treeChapters(changed.tree) }
    s.db.exec("UPDATE views SET revision=2,bundle_resource_id='published' WHERE id='view'")
    s.state.installManifest(current, 1)
    expect(() => s.start('independent', [outside.node_id])).not.toThrow()
    expect(s.state.assertCurrent('task', 'independent').region_ids).toEqual([outside.node_id])
    expect(() => s.state.assertCurrent('task', previous.update_id)).toThrow(expect.objectContaining({ code: 'RUNNER_OWNERSHIP_INVALID' }))
  })

  it('retains a complete move when a descendant request takes over its source', () => {
    const s = setup(), source = s.sections[0]!, destination = s.sections[1]!, anchor = s.paragraphs[2]!
    const move: ContentOperationPlan = { type: 'move', node_ids: [source.node_id], parent_id: destination.node_id, position: 'after', anchor_id: anchor.node_id }
    const previous = s.start('old-move', [source.node_id], [move])
    const next = s.start('rewrite-child', [s.paragraphs[0]!.node_id])
    const retained = s.relation(next, previous)
    expect(retained).toMatchObject({ retained_node_ids: [source.node_id], retained_tree_operations: [move] })
    const durable = new ChapterState(s.db).update('task', previous.update_id)!
    expect(durable.base_manifest).toEqual(previous.base_manifest)
    expect(durable.tree_operations).toEqual([move])
    expect(contentUpdatesOverlap({ ...previous, region_ids: retained.retained_node_ids, tree_operations: retained.retained_tree_operations }, next)).toBe(true)
    expect(() => assertContentAuthority(previous, [{ type: 'move', node_ids: [s.paragraphs[1]!.node_id], parent_id: destination.node_id, position: 'after', anchor_id: anchor.node_id }])).toThrow(expect.objectContaining({ code: 'WORKER_CAPABILITY_DENIED' }))
  })

  it('retains the original move destination when another request occupies its exact gap', () => {
    const s = setup(), source = s.paragraphs[0]!, destination = s.sections[1]!, anchor = s.paragraphs[2]!
    const move: ContentOperationPlan = { type: 'move', node_ids: [source.node_id], parent_id: destination.node_id, position: 'after', anchor_id: anchor.node_id }
    const previous = s.start('old-position', [source.node_id], [move])
    const next = s.start('new-position', [destination.node_id], [{ type: 'insert', parent_id: destination.node_id, position: 'after', anchor_id: anchor.node_id }])
    expect(s.relation(next, previous)).toMatchObject({ retained_node_ids: [source.node_id], retained_tree_operations: [move] })
    expect(s.state.assertCurrent('task', next.update_id).state).toBe('queued')
  })

  it('invalidates a retained move when its destination anchor is retired', () => {
    const s = setup(), source = s.paragraphs[0]!, destination = s.sections[1]!, anchor = s.paragraphs[2]!
    const move: ContentOperationPlan = { type: 'move', node_ids: [source.node_id], parent_id: destination.node_id, position: 'after', anchor_id: anchor.node_id }
    const previous = s.start('old-anchor', [source.node_id], [move])
    const next = s.start('split-anchor', [anchor.node_id], [{ type: 'replace', node_ids: [anchor.node_id] }])
    expect(s.relation(next, previous).retained_tree_operations).toEqual([move])
    const changed = applyContentOperations({ html: s.html, tree: s.tree, operations: [{ type: 'replace', node_ids: [anchor.node_id], html: '<p>New anchor one</p><p>New anchor two</p>' }] })
    const latest = { ...s.manifest, content_tree: changed.tree, chapters: treeChapters(changed.tree) }
    expect(contentBaselineCurrent(previous, latest)).toBe(false)
    expect(() => applyContentOperations({ html: changed.html, tree: changed.tree, baseline: s.tree, operations: [move] })).toThrow(expect.objectContaining({ code: 'CONTENT_NODE_RETIRED' }))
    expect(changed.tree.nodes.some(node => node.node_id === source.node_id)).toBe(true)
    expect(changed.tree.lineage.find(item => item.previous_node_id === anchor.node_id)?.successor_node_ids).toHaveLength(2)
  })

  it('removes a deferred replacement taken over by a later request', () => {
    const s = setup(), source = s.paragraphs[0]!
    const previous = s.start('deferred-replace', [source.node_id], [{ type: 'replace', node_ids: [source.node_id] }])
    const later = s.start('latest-replace', [source.node_id], [{ type: 'replace', node_ids: [source.node_id] }])
    expect(reconcileRetainedContentScope(previous, later)).toEqual({ retained_node_ids: [], retained_tree_operations: [] })
  })

  it.each(['same-source-move', 'ancestor-move', 'ancestor-delete'] as const)('cancels a deferred move after %s', kind => {
    const s = setup(), source = s.paragraphs[0]!, ancestor = s.sections[0]!, destination = s.sections[1]!
    const move: ContentOperationPlan = { type: 'move', node_ids: [source.node_id], parent_id: destination.node_id, position: 'end' }
    const previous = s.start(`deferred-${kind}`, [source.node_id], [move])
    const operation: ContentOperationPlan = kind === 'same-source-move'
      ? { type: 'move', node_ids: [source.node_id], parent_id: destination.node_id, position: 'start' }
      : kind === 'ancestor-move'
        ? { type: 'move', node_ids: [ancestor.node_id], parent_id: s.tree.root_id, position: 'end' }
        : { type: 'delete', node_ids: [ancestor.node_id] }
    const later = s.start(`later-${kind}`, operation.node_ids, [operation])
    expect(s.relation(later, previous)).toMatchObject({ retained_node_ids: [], retained_tree_operations: [] })
    expect(reconcileRetainedContentScope(previous, later)).toEqual({ retained_node_ids: [], retained_tree_operations: [] })
  })

  it('keeps a deferred move on its original identity after content rewriting', () => {
    const s = setup(), source = s.paragraphs[0]!, destination = s.sections[1]!
    const move: ContentOperationPlan = { type: 'move', node_ids: [source.node_id], parent_id: destination.node_id, position: 'end' }
    const previous = s.start('deferred-content-move', [source.node_id], [move])
    const changed = applyContentOperations({ html: s.html, tree: s.tree, operations: [{ type: 'replace', node_ids: [source.node_id], html: '<p>New content</p>' }] })
    const later = { ...chapterUpdate('later-content', [source.node_id], { ...s.manifest, content_tree: changed.tree }), tree_operations: [{ type: 'replace', node_ids: [source.node_id] } satisfies ContentOperationPlan] }
    expect(reconcileRetainedContentScope(previous, later)).toEqual({ retained_node_ids: [source.node_id], retained_tree_operations: [move] })
    expect(previous.base_manifest.content_tree).toEqual(s.tree)
  })

  it.each(['source', 'anchor'] as const)('does not rebind a deferred move after its %s retires', target => {
    const s = setup(), source = s.paragraphs[0]!, destination = s.sections[1]!, anchor = s.paragraphs[2]!
    const move: ContentOperationPlan = { type: 'move', node_ids: [source.node_id], parent_id: destination.node_id, position: 'after', anchor_id: anchor.node_id }
    const previous = s.start(`retired-${target}`, [source.node_id], [move])
    const selected = target === 'source' ? source : anchor
    const changed = applyContentOperations({ html: s.html, tree: s.tree, operations: [{ type: 'replace', node_ids: [selected.node_id], html: '<p>Split one</p><p>Split two</p>' }] })
    const later = chapterUpdate(`after-${target}`, [s.paragraphs[3]!.node_id], { ...s.manifest, content_tree: changed.tree })
    expect(() => reconcileRetainedContentScope(previous, later)).toThrow(expect.objectContaining({ code: 'CONTENT_NODE_RETIRED' }))
    expect(changed.tree.lineage.find(item => item.previous_node_id === selected.node_id)?.successor_node_ids).toHaveLength(2)
  })
})
