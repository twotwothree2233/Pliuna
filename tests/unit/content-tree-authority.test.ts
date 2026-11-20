import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'
import coreSql from '../../src/shared/contracts/001-core.sql?raw'
import runnerSql from '../../src/shared/contracts/002-runner.sql?raw'
import type { Bundle, ChapterManifest, ContentOperation, ContentOperationPlan } from '../../src/shared/contracts.generated'
import { ContractError } from '../../src/shared/validation'
import { modelToolRequest } from '../../src/runtime/model/tool-input'
import { ChapterState } from '../../src/runtime/runner/chapter-state'
import { applyContentOperations, buildContentTree } from '../../src/runtime/runner/content-tree'
import { assembleContentUpdate, assertContentAuthority, contentBaselineCurrent, contentUpdatesOverlap, remainingContentScope, treeChapters } from '../../src/runtime/runner/content-tree-host'
import { ContentTreeQueries } from '../../src/runtime/runner/content-tree-queries'
import { ContentTreeState } from '../../src/runtime/runner/content-tree-state'
import { chapterBundle, chapterManifest, chapterUpdate } from '../helpers/chapters'

const databases: Database.Database[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })

function setup(html = '<h2>A</h2><p>First</p><p>Second</p><h2>B</h2><p>Outside</p>') {
  const db = new Database(':memory:'); databases.push(db)
  db.pragma('foreign_keys=ON'); db.exec(coreSql); db.exec(runnerSql)
  db.exec("INSERT INTO tasks(id,title,state,revision) VALUES ('task','Task','active',1); INSERT INTO requests VALUES ('goal','task','started','{}','{}','time'); INSERT INTO records VALUES ('record','task',1,'message.user','{}','time'); INSERT INTO runner_inputs VALUES ('input','task','record','request','{}','time')")
  const goal = { task_id: 'task', request_id: 'goal', intent_revision: 1, input_event_id: 'input', state: 'active', requirements: [] }
  db.prepare('INSERT INTO runner_goal_revisions VALUES (?,?,?,?,?)').run('task', 'goal', 1, 'input', JSON.stringify(goal))
  db.exec("INSERT INTO runner_goal_heads VALUES ('task','goal',1)")
  for (const id of ['original', 'candidate', 'assembled', 'published-2']) {
    db.prepare("INSERT INTO resources VALUES (?,?,'fixture',0,'application/json','Body','time')").run(id, id)
    db.prepare("INSERT INTO task_resources VALUES ('task',?)").run(id)
  }
  db.exec("INSERT INTO surfaces VALUES ('surface','task',1,'{}'); INSERT INTO views(id,surface_id,revision,bundle_resource_id,state_revision,draft_json,compatibility_version) VALUES ('view','surface',1,'original',1,'{}','v1')")
  const state = new ChapterState(db), tree = buildContentTree(html), bundle = { ...chapterBundle(), html }
  const manifest: ChapterManifest = { ...chapterManifest(), content_tree: tree, chapters: treeChapters(tree) }
  state.installManifest(manifest, null)
  const sections = tree.nodes.filter(node => node.kind === 'section'), paragraphs = tree.nodes.filter(node => node.kind === 'paragraph')
  const update = (id: string, scope: string[], operations?: ContentOperationPlan[]) => ({ ...chapterUpdate(id, scope, state.manifest('task', 'view')!), ...(operations ? { tree_operations: operations } : {}) })
  const install = (value: { tree: ChapterManifest['content_tree']; bundle: Bundle; chapters: ChapterManifest['chapters'] }, resource = 'published-2') => {
    const current = state.manifest('task', 'view')!
    const next: ChapterManifest = { ...current, view_revision: current.view_revision + 1, manifest_revision: current.manifest_revision + 1, bundle_resource_id: resource, content_tree: value.tree, chapters: value.chapters }
    db.prepare('UPDATE views SET revision=?,bundle_resource_id=? WHERE id=?').run(next.view_revision, resource, 'view')
    state.installManifest(next, current.manifest_revision)
    return next
  }
  return { db, state, tree, bundle, manifest, sections, paragraphs, update, install }
}

describe('content tree host authority', () => {
  test('guides an out-of-plan submission back to its authorized operations and readable baseline', () => {
    const s = setup(), [first, second] = s.paragraphs
    const baseline = assembleContentUpdate({ bundle: s.bundle, manifest: s.manifest }, s.update('outside', [s.paragraphs[2]!.node_id]), [{ type: 'replace', node_ids: [s.paragraphs[2]!.node_id], html: '<p>Outside revised</p>' }])
    const manifest = s.install(baseline), current = { bundle: baseline.bundle, manifest }
    const plans: ContentOperationPlan[] = [
      { type: 'replace', node_ids: [first!.node_id] },
      { type: 'delete', node_ids: [second!.node_id] }
    ]
    const update = s.state.start(s.update('combine', [first!.node_id, second!.node_id], plans))
    let failure: unknown
    try {
      assembleContentUpdate(current, update, [{ type: 'replace', node_ids: [s.sections[0]!.node_id], html: '<h2>A</h2><p>Combined</p>' }])
    } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(ContractError)
    if (!(failure instanceof ContractError)) throw new Error('Expected the operation group to be rejected')
    expect(failure.code).toBe('WORKER_CAPABILITY_DENIED')
    expect(failure.message).toContain(JSON.stringify(plans))
    expect(failure.message).not.toContain('<p>Combined</p>')
    expect(s.state.assertCurrent('task', update.update_id).state).toBe('queued')
    expect(s.state.manifest('task', 'view')!.content_tree).toEqual(baseline.tree)

    const suggestion = JSON.parse(failure.suggestion!)
    expect(baseline.tree.revision).not.toBe(first!.revision)
    expect(suggestion).toEqual({ name: 'read', arguments: { kind: 'content_tree', id: first!.node_id, selection: { revision: baseline.tree.revision } } })
    const request = modelToolRequest(suggestion.name, suggestion.arguments)
    if (request.type !== 'read') throw new Error('Expected a structural read suggestion')
    const queries = new ContentTreeQueries(new ContentTreeState(s.db), () => [manifest], () => { throw new Error('Structural recovery must not read body content') })
    expect(queries.query('task', 'worker', request, false)).toMatchObject({ data: { node_id: first!.node_id, tree_revision: baseline.tree.revision }, truncated: false })

    const corrected = plans.map((operation): ContentOperation => operation.type === 'replace' || operation.type === 'insert' ? { ...operation, html: '<p>Combined</p>' } : operation)
    const completed = assembleContentUpdate(current, update, corrected)
    expect(completed.bundle.html).toBe('<h2>A</h2><p>Combined</p><h2>B</h2><p>Outside revised</p>')
    expect(completed.tree.nodes.find(node => node.node_id === first!.node_id)?.kind).toBe('paragraph')
    expect(completed.tree.lineage.find(lineage => lineage.previous_node_id === second!.node_id)?.reason).toBe('deleted')
  })

  test('reports the complete ordered plan and navigates to the parent of an insertion', () => {
    const s = setup(), section = s.sections[0]!, [first, second] = s.paragraphs
    const insert: Extract<ContentOperationPlan, { type: 'insert' }> = { type: 'insert', parent_id: section.node_id, position: 'after', anchor_id: first!.node_id }
    const move: Extract<ContentOperationPlan, { type: 'move' }> = { type: 'move', node_ids: [second!.node_id], parent_id: section.node_id, position: 'start' }
    const plans: ContentOperationPlan[] = [insert, move]
    const update = s.update('rearrange', [section.node_id], plans)
    let failure: unknown
    try {
      assertContentAuthority(update, [move, { ...insert, html: '<p>Inserted</p>' }])
    } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(ContractError)
    if (!(failure instanceof ContractError)) throw new Error('Expected the reordered operation group to be rejected')
    expect(failure.message).toContain(JSON.stringify(plans))
    expect(JSON.parse(failure.suggestion!)).toEqual({ name: 'read', arguments: { kind: 'content_tree', id: section.node_id, selection: { revision: s.tree.revision } } })
  })

  test('merges two nodes of one chapter in reverse completion order', () => {
    const s = setup(), [first, second] = s.paragraphs
    const a = s.state.start(s.update('first', [first!.node_id])), b = s.state.start(s.update('second', [second!.node_id]))
    expect(contentUpdatesOverlap(a, b)).toBe(false)
    const completedB = assembleContentUpdate({ bundle: s.bundle, manifest: s.manifest }, b, [{ type: 'replace', node_ids: [second!.node_id], html: '<p>Second revised</p>' }])
    const latest = s.install(completedB)
    s.state.stage('task', b.update_id, 'succeeded')
    expect(s.state.assertCurrent('task', a.update_id).state).toBe('queued')
    expect(contentBaselineCurrent(a, latest)).toBe(true)
    const completedA = assembleContentUpdate({ bundle: completedB.bundle, manifest: latest }, a, [{ type: 'replace', node_ids: [first!.node_id], html: '<p>First revised</p>' }])
    expect(completedA.bundle.html).toBe('<h2>A</h2><p>First revised</p><p>Second revised</p><h2>B</h2><p>Outside</p>')
    expect(completedA.bundle.state).toBe(s.bundle.state)
    expect(completedA.tree.nodes.find(node => node.node_id === s.paragraphs[2]!.node_id)?.revision).toBe(1)
  })

  test('supersedes ancestor work and persists the earlier request scope that remains', () => {
    const s = setup(), section = s.sections[0]!, [first, second] = s.paragraphs
    const parent = s.state.start(s.update('whole-section', [section.node_id]))
    const child = s.state.start(s.update('first-only', [first!.node_id]))
    expect(child.previous_update_ids).toEqual([parent.update_id])
    expect(s.state.update('task', parent.update_id)?.state).toBe('superseded')
    expect(() => s.state.assertCurrent('task', parent.update_id)).toThrow(expect.objectContaining({ code: 'RUNNER_OWNERSHIP_INVALID' }))
    expect(() => s.state.stage('task', parent.update_id, 'succeeded')).toThrow()
    const relation = s.db.prepare('SELECT payload_json FROM runner_content_intent_relations WHERE update_id=? AND previous_update_id=?').get(child.update_id, parent.update_id) as { payload_json: string }
    expect(JSON.parse(relation.payload_json)).toMatchObject({ retained_node_ids: [second!.node_id], source_record_id: 'record', original_request_id: parent.request_id, original_intent_revision: parent.intent_revision })
    expect(s.state.assertCurrent('task', child.update_id).state).toBe('queued')
  })

  test('a broad replacement revokes a pending descendant without touching another section', () => {
    const s = setup(), first = s.state.start(s.update('first-only', [s.paragraphs[0]!.node_id])), outside = s.state.start(s.update('outside', [s.paragraphs[2]!.node_id]))
    const broad = s.state.start(s.update('whole-section', [s.sections[0]!.node_id]))
    expect(broad.previous_update_ids).toEqual([first.update_id])
    expect(s.state.assertCurrent('task', outside.update_id).state).toBe('queued')
    expect(s.state.update('task', first.update_id)?.state).toBe('superseded')
  })

  test('refuses to bypass an unknown overlapping operation but admits another node', () => {
    const s = setup(), pending = s.state.start(s.update('uncertain', [s.paragraphs[0]!.node_id]))
    s.state.stage('task', pending.update_id, 'unknown')
    expect(() => s.state.start(s.update('bypass', [s.sections[0]!.node_id]))).toThrow(expect.objectContaining({ code: 'CHAPTER_OUTCOME_UNKNOWN' }))
    expect(s.state.update('task', pending.update_id)?.state).toBe('unknown')
    expect(s.state.update('task', 'bypass')).toBeNull()
    expect(s.state.start(s.update('independent', [s.paragraphs[1]!.node_id])).state).toBe('queued')
    expect(new ChapterState(s.db).update('task', pending.update_id)?.state).toBe('unknown')
  })

  test('identifies one physical gap from either adjacent anchor', () => {
    const s = setup(), section = s.sections[0]!, [first, second] = s.paragraphs
    const before = s.update('before', [section.node_id], [{ type: 'insert', parent_id: section.node_id, position: 'before', anchor_id: second!.node_id }])
    const after = s.update('after', [section.node_id], [{ type: 'insert', parent_id: section.node_id, position: 'after', anchor_id: first!.node_id }])
    const separate = s.update('separate', [section.node_id], [{ type: 'insert', parent_id: section.node_id, position: 'after', anchor_id: second!.node_id }])
    expect(contentUpdatesOverlap(before, after)).toBe(true)
    expect(contentUpdatesOverlap(before, separate)).toBe(false)
    const old = s.state.start(before), next = s.state.start(after)
    expect(next.previous_update_ids).toEqual([old.update_id])
    expect(s.state.start(separate).previous_update_ids).toEqual([])
  })

  test('invalidates an insertion baseline when its destination container moves', () => {
    const s = setup(), section = s.sections[0]!
    const pending = s.update('insert', [section.node_id], [{ type: 'insert', parent_id: section.node_id, position: 'end' }])
    const moved = applyContentOperations({ html: s.bundle.html, tree: s.tree, operations: [{ type: 'move', node_ids: [section.node_id], parent_id: s.tree.root_id, position: 'end' }] })
    const latest = { ...s.manifest, content_tree: moved.tree, chapters: treeChapters(moved.tree) }
    expect(contentBaselineCurrent(pending, latest)).toBe(false)
  })

  test('retains maximal unaffected subtrees after a partial takeover', () => {
    const s = setup('<h1>Guide</h1><h2>A</h2><p>A1</p><p>A2</p><h2>B</h2><p>B1</p>'), [guide, a, b] = s.sections, [a1, a2] = s.paragraphs
    expect(remainingContentScope(s.tree, [guide!.node_id], [a1!.node_id])).toEqual([a2!.node_id, b!.node_id])
    expect(remainingContentScope(s.tree, [guide!.node_id], [a!.node_id])).toEqual([b!.node_id])
    expect(remainingContentScope(s.tree, [a!.node_id], [guide!.node_id])).toEqual([])
  })

  test('enforces bound nodes and the exact router-approved external destination gap', () => {
    const s = setup(), first = s.paragraphs[0]!, outside = s.paragraphs[2]!, destination = s.sections[1]!
    const update = s.update('local', [first.node_id], [{ type: 'move', node_ids: [first.node_id], parent_id: destination.node_id, position: 'before', anchor_id: outside.node_id }])
    expect(() => assertContentAuthority(update, [{ type: 'replace', node_ids: [outside.node_id], html: '<p>Denied</p>' }])).toThrow(expect.objectContaining({ code: 'WORKER_CAPABILITY_DENIED' }))
    expect(() => assertContentAuthority(update, [{ type: 'move', node_ids: [first.node_id], parent_id: destination.node_id, position: 'before', anchor_id: outside.node_id }])).not.toThrow()
    expect(() => assertContentAuthority(update, [{ type: 'move', node_ids: [first.node_id], parent_id: destination.node_id, position: 'after', anchor_id: outside.node_id }])).toThrow(expect.objectContaining({ code: 'WORKER_CAPABILITY_DENIED' }))
  })
})
