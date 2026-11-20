import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import coreSql from '../../src/shared/contracts/001-core.sql?raw'
import runnerSql from '../../src/shared/contracts/002-runner.sql?raw'
import type { IpcRequest } from '../../src/shared/contracts.generated'
import { ChapterHost } from '../../src/runtime/runner/chapter-host'
import { ContentTreeState } from '../../src/runtime/runner/content-tree-state'
import { chapterBundle, chapterManifest, chapterProposal, chapterPublication, chapterUpdate } from '../helpers/chapters'

const databases: Database.Database[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })

function setup(mapped = true) {
  const db = new Database(':memory:'); databases.push(db)
  db.pragma('foreign_keys=ON'); db.exec(coreSql); db.exec(runnerSql)
  db.exec("INSERT INTO tasks(id,title,state,revision,next_sequence) VALUES ('task','Task','active',1,2); INSERT INTO requests VALUES ('goal','task','started','{}','{}','time'); INSERT INTO records VALUES ('record','task',1,'message.user','{}','time'); INSERT INTO runner_inputs VALUES ('input','task','record','request','{}','time')")
  const goal = { task_id: 'task', request_id: 'goal', intent_revision: 1, input_event_id: 'input', state: 'active', requirements: [] }
  db.prepare('INSERT INTO runner_goal_revisions VALUES (?,?,?,?,?)').run('task', 'goal', 1, 'input', JSON.stringify(goal))
  db.exec("INSERT INTO runner_goal_heads VALUES ('task','goal',1)")
  for (const id of ['original', 'candidate', 'assembled']) {
    db.prepare("INSERT INTO resources VALUES (?,?,'fixture',0,'application/json','Body','time')").run(id, id)
    db.prepare("INSERT INTO task_resources VALUES ('task',?)").run(id)
  }
  db.exec("INSERT INTO runs(id,task_id,request_id,state,commit_valid,runtime_epoch,limits_json,budget_json,created_at,ended_at) VALUES ('original-run','task','goal','completed',0,'original-epoch','{}','{}','time','time'); INSERT INTO surfaces VALUES ('surface','task',1,'{}'); INSERT INTO views(id,surface_id,revision,bundle_resource_id,state_revision,draft_json,compatibility_version,creator_run_id) VALUES ('view','surface',1,'original',1,'{}','v1','original-run')")
  let serial = 0
  const record = vi.fn((task: string, kind: string, payload: unknown): string => {
    const id = `host-record-${++serial}`
    const row = db.prepare('SELECT next_sequence FROM tasks WHERE id=?').get(task) as { next_sequence: number }
    db.prepare('INSERT INTO records VALUES (?,?,?,?,?,?)').run(id, task, row.next_sequence, kind, JSON.stringify(payload), 'time')
    db.prepare('UPDATE tasks SET next_sequence=next_sequence+1 WHERE id=?').run(task)
    return id
  })
  const bundle = vi.fn(() => chapterBundle())
  const reopen = (epoch = 'new-epoch') => new ChapterHost(db, epoch, bundle, record)
  const host = reopen('epoch')
  if (mapped) host.state.installManifest(chapterManifest(), null)
  const input: Extract<IpcRequest, { type: 'chapter.update' }> = { type: 'chapter.update', task_id: 'task', input_event_id: 'chapter-input', update_id: 'update-a', view_id: 'view', view_revision: 1, state_revision: 1, region_ids: ['a'], text: 'Revise A', model_config_id: 'model' }
  return { db, host, goal, input, record, bundle, reopen }
}

function publishedSource(db: Database.Database): void {
  db.exec("INSERT INTO runner_budgets VALUES ('budget','task','production','goal','{}','time'); INSERT INTO runner_runs VALUES ('original-run','task','production','goal',1,NULL,NULL,'budget','{}'); INSERT INTO runner_work VALUES ('work','task','original-run',1,'succeeded','{}'); INSERT INTO runner_artifact_owners VALUES ('artifact','task','work',1,'section',1); INSERT INTO runner_candidates VALUES ('candidate','task','artifact','{}','{}')")
  const index = { task_id: 'task', request_id: 'goal', intent_revision: 1, run_id: 'original-run', work_id: 'work', attempt_id: 'attempt', artifact_id: 'artifact', artifact_revision: 1, bundle_resource_id: 'original', section_id: 'section', order_key: 'a', presentation_kind: 'managed-v1', width_constraint: 'full', interaction_kind: 'none', provenance_ref: { task_id: 'task', kind: 'record', id: 'record' }, acceptance_state: 'accepted' }
  db.prepare("INSERT INTO runner_artifacts VALUES ('task','artifact',1,'candidate','original',?)").run(JSON.stringify(index))
  db.exec("INSERT INTO runner_scopes VALUES ('task',1,'{}'); INSERT INTO runner_batches VALUES ('batch','task',1,'{}')")
  const entry = { task_id: 'task', batch_id: 'batch', request_id: 'goal', intent_revision: 1, artifact_id: 'artifact', artifact_revision: 1, section_id: 'section', source_bundle_resource_id: 'original', published_bundle_resource_id: 'original', view_id: 'view', view_revision: 1, state_revision: 1, surface_history_id: 'history' }
  db.prepare("INSERT INTO runner_view_mappings VALUES ('task','artifact',1,'batch','view',1,'original','original',?)").run(JSON.stringify(entry))
}

function unknownPublication(fixture: ReturnType<typeof setup>, result: 'failure' | 'not_executed' | 'cancelled' | 'unknown') {
  const { db, host } = fixture
  const update = host.state.start(chapterUpdate())
  host.state.recordProposal(chapterProposal(update))
  const operation = { ...chapterPublication(update), action_id: 'action' }
  host.state.registerPublication(operation)
  host.state.publicationStage('task', operation.operation_id, 'prepared')
  host.state.publicationStage('task', operation.operation_id, 'dispatched')
  host.state.publicationStage('task', operation.operation_id, 'unknown', { code: 'OPERATION_UNKNOWN' })
  host.state.stage('task', update.update_id, 'unknown')
  db.prepare("INSERT INTO actions(id,task_id,kind,state,result,source_json,request_json,result_json,commit_valid,created_at) VALUES ('action','task','mutation','ended',?,'{}','{}',?,0,'time')").run(result, JSON.stringify({ code: result === 'failure' ? 'APPROVAL_DENIED' : 'EXECUTION_INTERRUPTED' }))
  return operation
}

describe('chapter host admission and recovery', () => {
  it.each([
    '<p>Opening paragraph</p><p>Second paragraph</p><ul><li>One item</li></ul>',
    '<article><header><p>Context</p><h1>Guide</h1></header><section><h2>Details</h2><p>First detail</p><p>Second detail</p><table><tbody><tr><td>Value</td></tr></tbody></table></section></article>'
  ])('indexes an initial publication with conservative boundaries without changing its body: %s', html => {
    const { db, host, bundle } = setup(false); publishedSource(db)
    const original = { ...chapterBundle(), html }
    bundle.mockReturnValue(original)
    const mapped = host.map('task', 'view', 1)
    expect(mapped.content_tree!.nodes.filter(node => node.kind === 'paragraph').length).toBeGreaterThanOrEqual(2)
    expect(new ContentTreeState(db).snapshot('task', 'view')!.tree).toEqual(mapped.content_tree)
    expect(original.html).toBe(html)
    expect(db.prepare('SELECT revision,bundle_resource_id,state_revision,draft_json FROM views').get()).toEqual({ revision: 1, bundle_resource_id: 'original', state_revision: 1, draft_json: '{}' })
  })

  it('retries the original input idempotently when object properties arrive in another order', () => {
    const { host, input, record, db } = setup(), update = host.start(input)
    const retry = { model_config_id: input.model_config_id, text: input.text, region_ids: [...input.region_ids], state_revision: input.state_revision, view_revision: input.view_revision, view_id: input.view_id, update_id: input.update_id, input_event_id: input.input_event_id, task_id: input.task_id, type: input.type }
    const before = record.mock.calls.length
    expect(host.start(retry)).toEqual(update)
    expect(record).toHaveBeenCalledTimes(before)
    expect(db.prepare('SELECT COUNT(*) n FROM runner_chapter_updates').get()).toEqual({ n: 1 })
    expect(() => host.start({ ...retry, text: 'Changed original payload' })).toThrow(expect.objectContaining({ code: 'CHAPTER_CONFLICT' }))
  })

  it('does not bind an older published artifact to a newer goal revision', () => {
    const { db, host, goal } = setup(false); publishedSource(db)
    db.prepare("INSERT INTO runner_goal_revisions VALUES ('task','goal',2,'input',?)").run(JSON.stringify({ ...goal, intent_revision: 2, previous_revision: 1 }))
    db.exec("UPDATE runner_goal_heads SET intent_revision=2 WHERE request_id='goal'")
    expect(() => host.map('task', 'view', 1)).toThrow(expect.objectContaining({ code: 'CHAPTER_MAPPING_REQUIRED' }))
    expect(host.state.manifest('task', 'view')).toBeNull()
  })

  it('does not reuse old publication source metadata after the View has been replaced', () => {
    const { db, host } = setup(false); publishedSource(db)
    db.exec("UPDATE views SET revision=2,bundle_resource_id='candidate' WHERE id='view'")
    expect(() => host.map('task', 'view', 2)).toThrow()
    expect(host.state.manifest('task', 'view')).toBeNull()
  })

  it('versions an externally replaced View without reviving its previous descendants', () => {
    const { db, host, bundle, record, reopen } = setup()
    const first = host.map('task', 'view', 1), oldTree = first.content_tree!
    const trees = new ContentTreeState(db)
    db.exec("UPDATE views SET revision=2,bundle_resource_id='candidate' WHERE id='view'")
    bundle.mockReturnValue({ ...chapterBundle(), html: '<h2 id="new-title">New section</h2><div id="new-body"><p>New body</p></div>' })
    const mapped = host.map('task', 'view', 2), tree = mapped.content_tree!
    expect(tree.revision).toBe(oldTree.revision + 1)
    expect(tree.root_id).toBe(oldTree.root_id)
    expect(tree.nodes.find(node => node.node_id === tree.root_id)!.revision).toBe(oldTree.nodes[0]!.revision + 1)
    for (const node of oldTree.nodes.filter(node => node.node_id !== oldTree.root_id)) {
      expect(tree.nodes.some(current => current.node_id === node.node_id)).toBe(false)
      expect(trees.lookup('task', 'view', node.node_id)).toMatchObject({ state: 'retired', tree_revision: 2, lineage: { previous_node_id: node.node_id, revision: 2, reason: 'replaced' } })
    }
    expect(trees.snapshot('task', 'view', 1)!.tree).toEqual(oldTree)
    expect(trees.snapshot('task', 'view', 2)!.tree).toEqual(tree)
    const calls = record.mock.calls.length, bundleCalls = bundle.mock.calls.length
    expect(host.map('task', 'view', 2)).toEqual(mapped)
    expect(reopen().map('task', 'view', 2)).toEqual(mapped)
    expect(record).toHaveBeenCalledTimes(calls)
    expect(bundle).toHaveBeenCalledTimes(bundleCalls)
  })

  it('rolls back tree activation when its manifest installation fails', () => {
    const { db, host } = setup(), before = host.state.manifest('task', 'view')
    const trees = new ContentTreeState(db)
    const references = db.prepare('SELECT * FROM object_references ORDER BY rowid').all()
    db.exec("CREATE TEMP TRIGGER fail_tree_activation BEFORE INSERT ON runner_chapter_manifests WHEN NEW.manifest_revision=2 BEGIN SELECT RAISE(ABORT,'activation failed'); END")
    expect(() => host.map('task', 'view', 1)).toThrow('activation failed')
    expect(host.state.manifest('task', 'view')).toEqual(before)
    expect(trees.snapshot('task', 'view')).toBeNull()
    expect(db.prepare('SELECT count(*) n FROM runner_content_trees').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT * FROM object_references ORDER BY rowid').all()).toEqual(references)
    expect(db.prepare('SELECT revision,bundle_resource_id FROM views').get()).toEqual({ revision: 1, bundle_resource_id: 'original' })
    db.exec('DROP TRIGGER fail_tree_activation')
    expect(host.map('task', 'view', 1).content_tree!.revision).toBe(1)
  })

  it('keeps the previous tree and history when external remapping fails atomically', () => {
    const { db, host, bundle, record } = setup(), first = host.map('task', 'view', 1)
    const trees = new ContentTreeState(db), references = db.prepare('SELECT * FROM object_references ORDER BY rowid').all()
    db.exec("UPDATE views SET revision=2,bundle_resource_id='candidate' WHERE id='view'")
    bundle.mockReturnValue({ ...chapterBundle(), html: '<p>Replacement without headings</p>' })
    record.mockImplementationOnce(() => { throw Error('record failed') })
    expect(() => host.map('task', 'view', 2)).toThrow('record failed')
    expect(host.state.manifest('task', 'view')).toEqual(first)
    expect(trees.snapshot('task', 'view')!.tree).toEqual(first.content_tree)
    expect(trees.snapshot('task', 'view', 2)).toBeNull()
    expect(db.prepare('SELECT * FROM object_references ORDER BY rowid').all()).toEqual(references)
    expect(db.prepare('SELECT revision,bundle_resource_id FROM views').get()).toEqual({ revision: 2, bundle_resource_id: 'candidate' })
    expect(host.map('task', 'view', 2).content_tree!.revision).toBe(2)
  })

  it('marks a queued update without an execution source interrupted after restart', () => {
    const { host, input, reopen, record, bundle } = setup()
    const update = host.start(input), calls = record.mock.calls.length
    const bundleCalls = bundle.mock.calls.length
    const recovered = reopen(); recovered.reconcile('task'); recovered.reconcile('task')
    expect(recovered.state.update('task', update.update_id)).toMatchObject({ state: 'interrupted', reason: 'execution_no_longer_current' })
    expect(record).toHaveBeenCalledTimes(calls)
    expect(bundle).toHaveBeenCalledTimes(bundleCalls)
  })

  it.each(['failure', 'not_executed', 'cancelled'] as const)('settles an unknown publication from the persisted %s action without another dispatch', result => {
    const fixture = setup(), operation = unknownPublication(fixture, result), recovered = fixture.reopen()
    recovered.reconcile('task'); recovered.reconcile('task')
    expect(recovered.state.publication('task', operation.operation_id)).toMatchObject({ operation: { state: result === 'cancelled' ? 'cancelled' : 'failure' }, result: { action_id: 'action', code: result === 'failure' ? 'APPROVAL_DENIED' : 'EXECUTION_INTERRUPTED' } })
    expect(recovered.state.update('task', 'update-a')!.state).toBe(result === 'cancelled' ? 'cancelled' : 'failed')
    expect(fixture.db.prepare('SELECT COUNT(*) n FROM runner_chapter_publications').get()).toEqual({ n: 1 })
    expect(fixture.db.prepare('SELECT state FROM runner_chapter_publication_evidence ORDER BY sequence').all()).toEqual([{ state: 'unknown' }, { state: result === 'cancelled' ? 'cancelled' : 'failure' }])
    expect(fixture.bundle).not.toHaveBeenCalled()
    expect(fixture.record).not.toHaveBeenCalled()
  })

  it('retains an unknown action outcome for explicit reconciliation after restart', () => {
    const fixture = setup(), operation = unknownPublication(fixture, 'unknown'), recovered = fixture.reopen()
    recovered.reconcile('task')
    expect(recovered.state.publication('task', operation.operation_id)!.operation.state).toBe('unknown')
    expect(recovered.state.update('task', 'update-a')!.state).toBe('unknown')
    expect(fixture.db.prepare('SELECT COUNT(*) n FROM runner_chapter_publications').get()).toEqual({ n: 1 })
  })

  it('keeps a cancelled update terminal across repeated restarts without creating new work', () => {
    const { db, host, input, reopen, record, bundle } = setup(), update = host.start(input)
    host.state.stage('task', update.update_id, 'cancelled', { reason: 'user_cancelled' })
    const calls = record.mock.calls.length
    const bundleCalls = bundle.mock.calls.length
    reopen().reconcile('task'); reopen('another-epoch').reconcile('task')
    expect(host.state.update('task', update.update_id)).toMatchObject({ state: 'cancelled', reason: 'user_cancelled' })
    expect(host.start(input).state).toBe('cancelled')
    expect(db.prepare('SELECT COUNT(*) n FROM runner_chapter_updates').get()).toEqual({ n: 1 })
    expect(db.prepare('SELECT COUNT(*) n FROM runner_chapter_publications').get()).toEqual({ n: 0 })
    expect(record).toHaveBeenCalledTimes(calls)
    expect(bundle).toHaveBeenCalledTimes(bundleCalls)
  })
})
