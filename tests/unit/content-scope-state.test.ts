import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import coreSql from '../../src/shared/contracts/001-core.sql?raw'
import runnerSql from '../../src/shared/contracts/002-runner.sql?raw'
import type { ChapterManifest, ChapterProposal, ChapterUpdate, ContentOperation, ContentOperationPlan } from '../../src/shared/contracts.generated'
import { ChapterState, installChapterSchema } from '../../src/runtime/runner/chapter-state'
import { ChapterHost } from '../../src/runtime/runner/chapter-host'
import { applyContentOperations, buildContentTree } from '../../src/runtime/runner/content-tree'
import { treeChapters } from '../../src/runtime/runner/content-tree-host'
import { chapterBundle, chapterManifest, chapterProposal, chapterPublication, chapterSource, chapterUpdate } from '../helpers/chapters'

const databases: Database.Database[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
function setup() {
  const db = new Database(':memory:'); databases.push(db)
  db.pragma('foreign_keys=ON'); db.exec(coreSql); db.exec(runnerSql)
  db.exec("INSERT INTO tasks(id,title,state,revision) VALUES ('task','Task','active',1); INSERT INTO requests VALUES ('goal','task','started','{}','{}','time'); INSERT INTO records VALUES ('record','task',1,'message.user','{}','time'); INSERT INTO runner_inputs VALUES ('input','task','record','request','{}','time')")
  const goal = { task_id: 'task', request_id: 'goal', intent_revision: 1, input_event_id: 'input', state: 'active', requirements: [] }
  db.prepare('INSERT INTO runner_goal_revisions VALUES (?,?,?,?,?)').run('task', 'goal', 1, 'input', JSON.stringify(goal)); db.exec("INSERT INTO runner_goal_heads VALUES ('task','goal',1)")
  for (const resource of ['original', 'candidate', 'assembled', 'published']) {
    db.prepare("INSERT INTO resources VALUES (?,?,'fixture',0,'application/json','Body','time')").run(resource, resource)
    db.prepare("INSERT INTO task_resources VALUES ('task',?)").run(resource)
  }
  db.exec("INSERT INTO surfaces VALUES ('surface','task',1,'{}'); INSERT INTO views(id,surface_id,revision,bundle_resource_id,state_revision,draft_json,compatibility_version) VALUES ('view','surface',1,'original',1,'{}','v1')")
  const state = new ChapterState(db), tree = buildContentTree('<h2>A</h2><p>A1</p><p>A2</p><h2>B</h2><p>B1</p>')
  const manifest: ChapterManifest = { ...chapterManifest(), content_tree: tree, chapters: treeChapters(tree) }
  state.installManifest(manifest, null)
  const sections = tree.nodes.filter(node => node.kind === 'section'), paragraphs = tree.nodes.filter(node => node.kind === 'paragraph')
  let sequence = 1
  function start(id: string, boundary = [tree.root_id]): ChapterUpdate {
    const record = `record-${id}`
    db.prepare("INSERT INTO records VALUES (?,'task',?,'message.user','{}','time')").run(record, ++sequence)
    return state.start({ ...chapterUpdate(id, [], state.manifest('task', 'view')!), record_id: record, scope_revision: 0, authorization: { record_id: record, input_event_id: `input-${id}`, region_ids: boundary }, candidate_region_ids: [paragraphs[0]!.node_id] })
  }
  function revise(update: ChapterUpdate, operations: ContentOperationPlan[], read_refs: string[] = []) {
    return state.reviseScope('task', update.update_id, { operations, read_refs, source: chapterSource(update) })
  }
  function read(update: ChapterUpdate, nodeId: string, ref: string) {
    const node = state.manifest('task', 'view')!.content_tree!.nodes.find(node => node.node_id === nodeId)!
    db.prepare("INSERT INTO records VALUES (?,'task',?,'content.node.read',?,'time')").run(ref, ++sequence, JSON.stringify({ owner: chapterSource(update), view_id: 'view', node_id: nodeId, revision: node.revision, position_revision: node.position_revision }))
  }
  function proposal(update: ChapterUpdate): ChapterProposal {
    return { task_id: 'task', update_id: update.update_id, proposal_id: `proposal-${update.scope_revision}`, intent_revision: 1, bundle_resource_id: 'candidate', replacements: [], dependencies: update.dependencies, source: chapterSource(update), scope_revision: update.scope_revision, read_refs: state.scope('task', update.update_id)!.read_refs, tree_operations: [{ type: 'replace', node_ids: [paragraphs[0]!.node_id], html: '<p>Updated</p>' }] }
  }
  return { db, state, tree, manifest, sections, paragraphs, start, revise, read, proposal }
}

describe('revisable content eligibility', () => {
  it('keeps candidates readable without granting a write scope', () => {
    const { state, start } = setup(), update = start('a')
    expect(state.assertLive('task', update.update_id).scope_revision).toBe(0)
    expect(update.region_ids).toEqual([])
    expect(() => state.assertCurrent('task', update.update_id)).toThrow(expect.objectContaining({ code: 'CONTENT_SCOPE_REQUIRED' }))
  })
  it('installs immutable revisions, keeps original priority and repeats registration idempotently', () => {
    const { state, start, revise, paragraphs } = setup(), update = start('a')
    const first = revise(update, [{ type: 'replace', node_ids: [paragraphs[0]!.node_id] }])
    expect(revise(first, first.tree_operations!)).toEqual(first)
    const second = revise(first, [{ type: 'delete', node_ids: [paragraphs[1]!.node_id] }])
    expect(second.scope_revision).toBe(2)
    expect(second.request_order).toBe(update.request_order)
    expect(state.scope('task', update.update_id, 1)?.operations[0]?.type).toBe('replace')
    expect(() => state.assertCurrent('task', update.update_id, 1)).toThrow(expect.objectContaining({ code: 'CONTENT_SCOPE_STALE' }))
  })
  it('rejects hard boundary expansion including a move destination', () => {
    const { state, start, revise, sections, paragraphs } = setup(), update = start('a', [sections[0]!.node_id])
    expect(() => revise(update, [{ type: 'move', node_ids: [paragraphs[0]!.node_id], parent_id: sections[1]!.node_id, position: 'end' }])).toThrow()
    expect(state.update('task', update.update_id)?.scope_revision).toBe(0)
    expect(state.scope('task', update.update_id)).toBeNull()
  })
  it('does not let an old request revise into newer active or delivered intent', () => {
    const { state, start, revise, paragraphs } = setup(), old = start('old'), newer = start('new')
    revise(old, [{ type: 'replace', node_ids: [paragraphs[0]!.node_id] }])
    revise(newer, [{ type: 'replace', node_ids: [paragraphs[2]!.node_id] }])
    expect(() => revise(old, [{ type: 'replace', node_ids: [paragraphs[2]!.node_id] }])).toThrow(expect.objectContaining({ code: 'CONTENT_INTENT_CONFLICT' }))
    state.stage('task', newer.update_id, 'succeeded')
    expect(() => revise(old, [{ type: 'replace', node_ids: [paragraphs[2]!.node_id] }])).toThrow(expect.objectContaining({ code: 'CONTENT_INTENT_CONFLICT' }))
    expect(state.assertCurrent('task', old.update_id).region_ids).toEqual([paragraphs[0]!.node_id])
  })
  it.each(['split', 'delete'] as const)('keeps independent scope revisable after a newer %s while protecting its delivered intent', type => {
    const { db, state, start, revise, tree, manifest, sections, paragraphs } = setup(), old = start('old'), newer = start('new')
    revise(old, [{ type: 'replace', node_ids: [paragraphs[2]!.node_id] }])
    const operation: ContentOperation = type === 'split'
      ? { type: 'replace', node_ids: [paragraphs[0]!.node_id], html: '<p>One</p><p>Two</p>' }
      : { type: 'delete', node_ids: [paragraphs[0]!.node_id] }
    revise(newer, [{ type: operation.type, node_ids: [paragraphs[0]!.node_id] }])
    const applied = applyContentOperations({ html: '<h2>A</h2><p>A1</p><p>A2</p><h2>B</h2><p>B1</p>', tree, operations: [operation] })
    const next: ChapterManifest = { ...manifest, manifest_revision: 2, view_revision: 2, bundle_resource_id: 'published', content_tree: applied.tree, chapters: treeChapters(applied.tree) }
    db.exec("UPDATE views SET revision=2,bundle_resource_id='published' WHERE id='view'"); state.installManifest(next, 1)
    state.stage('task', newer.update_id, 'succeeded')
    const refreshed = revise(old, [{ type: 'replace', node_ids: [paragraphs[2]!.node_id] }])
    expect(refreshed.scope_revision).toBe(2)
    expect(state.assertCurrent('task', old.update_id).region_ids).toEqual([paragraphs[2]!.node_id])
    const protectedScope: ContentOperationPlan = type === 'split'
      ? { type: 'replace', node_ids: [applied.tree.lineage.find(entry => entry.previous_node_id === paragraphs[0]!.node_id)!.successor_node_ids[0]!] }
      : { type: 'insert', parent_id: sections[0]!.node_id, position: 'start' }
    expect(() => revise(refreshed, [protectedScope])).toThrow(expect.objectContaining({ code: 'CONTENT_INTENT_CONFLICT' }))
    expect(state.update('task', old.update_id)?.scope_revision).toBe(2)
  })
  it('installs takeover and its old revision revocation atomically', () => {
    const { db, state, start, revise, paragraphs } = setup(), old = start('old'), newer = start('new')
    revise(old, [{ type: 'replace', node_ids: [paragraphs[0]!.node_id] }])
    expect(() => db.transaction(() => { revise(newer, [{ type: 'delete', node_ids: [paragraphs[0]!.node_id] }]); throw Error('rollback') })()).toThrow('rollback')
    expect(state.update('task', old.update_id)?.state).toBe('generating')
    expect(state.update('task', newer.update_id)?.scope_revision).toBe(0)
    revise(newer, [{ type: 'delete', node_ids: [paragraphs[0]!.node_id] }])
    expect(() => state.assertLive('task', old.update_id)).toThrow()
  })
  it('preserves exploration evidence while binding only selected current reads', () => {
    const { db, state, start, revise, read, paragraphs, manifest } = setup(), update = start('a')
    read(update, paragraphs[0]!.node_id, 'read-old')
    const first = revise(update, [{ type: 'replace', node_ids: [paragraphs[0]!.node_id] }], ['read-old'])
    const next = structuredClone(manifest); next.manifest_revision++; next.view_revision++; next.bundle_resource_id = 'published'; next.content_tree!.revision++; next.content_tree!.nodes.find(node => node.node_id === paragraphs[0]!.node_id)!.revision++
    db.exec("UPDATE views SET revision=2,bundle_resource_id='published' WHERE id='view'"); state.installManifest(next, 1)
    expect(state.assertLive('task', update.update_id).scope_revision).toBe(1)
    expect(() => state.assertCurrent('task', update.update_id)).toThrow(expect.objectContaining({ code: 'CONTENT_BASELINE_STALE' }))
    expect(() => revise(first, first.tree_operations!, ['read-old'])).toThrow(expect.objectContaining({ code: 'CONTENT_DEPENDENCY_STALE' }))
    read(update, paragraphs[0]!.node_id, 'read-new')
    const refreshed = revise(first, first.tree_operations!, ['read-new'])
    expect(refreshed.scope_revision).toBe(2)
    expect(state.scope('task', update.update_id, 1)?.read_refs).toEqual(['read-old'])
    expect(state.scope('task', update.update_id)?.read_refs).toEqual(['read-new'])
    expect(db.prepare("SELECT count(*) n FROM records WHERE kind='content.node.read'").get()).toEqual({ n: 2 })
  })
  it('rejects a read from another producer without replacing current scope', () => {
    const { state, start, revise, read, paragraphs } = setup(), first = start('a'), other = start('b')
    read(other, paragraphs[0]!.node_id, 'foreign-read')
    expect(() => revise(first, [{ type: 'replace', node_ids: [paragraphs[0]!.node_id] }], ['foreign-read'])).toThrow(expect.objectContaining({ code: 'RUNNER_OWNERSHIP_INVALID' }))
    expect(state.update('task', first.update_id)?.scope_revision).toBe(0)
  })
  it('freezes proposals and publications to their installed eligibility revision', () => {
    const { state, start, revise, proposal, paragraphs } = setup(), update = start('a')
    const first = revise(update, [{ type: 'replace', node_ids: [paragraphs[0]!.node_id] }]), candidate = proposal(first)
    state.recordProposal(candidate)
    revise(first, [{ type: 'replace', node_ids: [paragraphs[1]!.node_id] }])
    expect(state.update('task', first.update_id)?.proposal_id).toBeUndefined()
    expect(state.proposal('task', candidate.proposal_id)).toEqual(candidate)
    expect(() => state.recordProposal({ ...candidate, proposal_id: 'late-proposal' })).toThrow(expect.objectContaining({ code: 'CONTENT_SCOPE_STALE' }))
    expect(() => state.registerPublication({ ...chapterPublication(first), proposal_id: candidate.proposal_id, scope_revision: 1 })).toThrow()
  })
  it('releases a known failed scope while keeping the conversation and old evidence', () => {
    const { state, start, revise, proposal, paragraphs } = setup(), update = start('a')
    const first = revise(update, [{ type: 'replace', node_ids: [paragraphs[0]!.node_id] }])
    const candidate = state.recordProposal(proposal(first))
    const released = state.releaseScope('task', update.update_id, 'CONTENT_BASELINE_STALE')
    expect(released.scope_active).toBe(false)
    expect(released.scope_revision).toBe(1)
    expect(state.assertLive('task', update.update_id).state).toBe('generating')
    expect(() => state.assertCurrent('task', update.update_id)).toThrow(expect.objectContaining({ code: 'CONTENT_SCOPE_REQUIRED' }))
    const second = revise(released, first.tree_operations!)
    expect(second.scope_revision).toBe(2)
    expect(second.scope_active).toBe(true)
    expect(state.proposal('task', candidate.proposal_id)).toEqual(candidate)
  })
  it('keeps candidate exploration and stale-baseline correction live during host reconciliation', () => {
    const { db, state, start, revise, paragraphs, manifest } = setup(), update = start('a')
    db.exec("INSERT INTO runner_budgets VALUES ('budget','task','production','goal','{}','time')")
    db.prepare("INSERT INTO runs(id,task_id,request_id,state,runtime_epoch,limits_json,budget_json,created_at,chapter_update_id) VALUES ('run','task','goal','running','epoch','{}','{}','time',?)").run(update.update_id)
    const run = { run_id: 'run', task_id: 'task', purpose: 'production', request_id: 'goal', intent_revision: 1, update_id: update.update_id, runtime_epoch: 'epoch', state: 'running', commit_valid: true, budget_id: 'budget' }
    db.prepare("INSERT INTO runner_runs VALUES ('run','task','production','goal',1,NULL,NULL,'budget',?)").run(JSON.stringify(run))
    state.stage('task', update.update_id, 'generating', { source: chapterSource(update) })
    const host = new ChapterHost(db, 'epoch', chapterBundle, () => 'unused')
    host.reconcile('task')
    expect(state.update('task', update.update_id)?.state).toBe('generating')
    revise(update, [{ type: 'replace', node_ids: [paragraphs[0]!.node_id] }])
    const next = structuredClone(manifest); next.manifest_revision++; next.view_revision++; next.bundle_resource_id = 'published'; next.content_tree!.revision++; next.content_tree!.nodes.find(node => node.node_id === paragraphs[0]!.node_id)!.revision++
    db.exec("UPDATE views SET revision=2,bundle_resource_id='published' WHERE id='view'"); state.installManifest(next, 1)
    host.reconcile('task')
    expect(state.assertLive('task', update.update_id).state).toBe('generating')
    expect(() => state.assertCurrent('task', update.update_id)).toThrow(expect.objectContaining({ code: 'CONTENT_BASELINE_STALE' }))
    db.exec("UPDATE runs SET state='interrupted',commit_valid=0 WHERE id='run'")
    host.reconcile('task')
    expect(state.update('task', update.update_id)?.state).toBe('interrupted')
  })
  it('returns uncertain work for queries without granting a replacement scope', () => {
    const { state, start, revise, paragraphs } = setup(), update = start('a')
    revise(update, [{ type: 'replace', node_ids: [paragraphs[0]!.node_id] }])
    state.stage('task', update.update_id, 'unknown')
    expect(state.assertLive('task', update.update_id).state).toBe('unknown')
    expect(() => state.assertCurrent('task', update.update_id)).toThrow(expect.objectContaining({ code: 'CHAPTER_OUTCOME_UNKNOWN' }))
    expect(() => state.releaseScope('task', update.update_id, 'retry')).toThrow(expect.objectContaining({ code: 'CHAPTER_OUTCOME_UNKNOWN' }))
    expect(() => revise(update, [{ type: 'replace', node_ids: [paragraphs[1]!.node_id] }])).toThrow(expect.objectContaining({ code: 'CHAPTER_OUTCOME_UNKNOWN' }))
  })
  it('does not let a denied publication regain eligibility by changing a node', () => {
    const { state, start, revise, proposal, paragraphs } = setup(), update = start('a')
    const first = revise(update, [{ type: 'replace', node_ids: [paragraphs[0]!.node_id] }]), candidate = state.recordProposal(proposal(first))
    const publication = state.registerPublication({ ...chapterPublication(first), proposal_id: candidate.proposal_id, scope_revision: 1 })
    state.publicationStage('task', publication.operation_id, 'failure', { code: 'APPROVAL_DENIED', denied: true })
    expect(() => state.assertCurrent('task', update.update_id)).toThrow(expect.objectContaining({ code: 'RUNNER_OWNERSHIP_INVALID' }))
    expect(() => state.registerPublication({ ...publication, operation_id: 'bypass', previous_operation_id: publication.operation_id })).toThrow(expect.objectContaining({ code: 'RUNNER_OWNERSHIP_INVALID' }))
    expect(() => state.releaseScope('task', update.update_id, 'retry')).toThrow(expect.objectContaining({ code: 'RUNNER_OWNERSHIP_INVALID' }))
    expect(() => revise(first, [{ type: 'replace', node_ids: [paragraphs[1]!.node_id] }])).toThrow(expect.objectContaining({ code: 'RUNNER_OWNERSHIP_INVALID' }))
  })
  it('blocks a cancelled publication even if its update has not yet received a terminal stage', () => {
    const { state, start, revise, proposal, paragraphs } = setup(), update = start('a')
    const first = revise(update, [{ type: 'replace', node_ids: [paragraphs[0]!.node_id] }]), candidate = state.recordProposal(proposal(first))
    const publication = state.registerPublication({ ...chapterPublication(first), proposal_id: candidate.proposal_id, scope_revision: 1 })
    state.publicationStage('task', publication.operation_id, 'cancelled', { code: 'CANCELLED' })
    expect(() => state.assertLive('task', update.update_id)).toThrow()
    expect(() => revise(first, [{ type: 'replace', node_ids: [paragraphs[1]!.node_id] }])).toThrow()
    expect(() => state.registerPublication({ ...publication, operation_id: 'bypass', previous_operation_id: publication.operation_id })).toThrow()
  })
  it.each(['cancelled', 'interrupted', 'superseded', 'failed'] as const)('does not restore %s work by registering new scope', terminal => {
    const { state, start, revise, paragraphs } = setup(), update = start('a')
    state.stage('task', update.update_id, terminal)
    expect(() => revise(update, [{ type: 'replace', node_ids: [paragraphs[0]!.node_id] }])).toThrow()
    expect(state.update('task', update.update_id)?.scope_revision).toBe(0)
  })
  it('preserves legacy history and unknown operation identity across additive migration', () => {
    const { db, state, manifest } = setup(), legacy = state.start(chapterUpdate('legacy', [manifest.chapters[0]!.region_id], manifest))
    state.recordProposal(chapterProposal(legacy))
    const operation = state.registerPublication(chapterPublication(legacy))
    state.publicationStage('task', operation.operation_id, 'prepared')
    state.publicationStage('task', operation.operation_id, 'dispatched')
    state.publicationStage('task', operation.operation_id, 'unknown', { code: 'NETWORK_INTERRUPTED' })
    state.stage('task', legacy.update_id, 'unknown')
    db.exec('DROP TABLE runner_content_scope_revisions'); installChapterSchema(db)
    const restarted = new ChapterState(db)
    expect(restarted.update('task', legacy.update_id)).toEqual(state.update('task', legacy.update_id))
    expect(restarted.scope('task', legacy.update_id)).toBeNull()
    expect(restarted.publication('task', operation.operation_id)).toEqual(state.publication('task', operation.operation_id))
    expect(() => restarted.reviseScope('task', legacy.update_id, { operations: [], source: chapterSource(legacy) })).toThrow()
    expect(db.prepare('SELECT count(*) n FROM runner_content_scope_revisions').get()).toEqual({ n: 0 })
  })
})
