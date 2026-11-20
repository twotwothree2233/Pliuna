import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { ContentTreeState, installContentTreeSchema } from '../../src/runtime/runner/content-tree-state'
import { contentTree } from '../helpers/content-tree'

const core = readFileSync(new URL('../../src/shared/contracts/001-core.sql', import.meta.url), 'utf8')
const runner = readFileSync(new URL('../../src/shared/contracts/002-runner.sql', import.meta.url), 'utf8')
const databases: Database.Database[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
const binding = { task_id: 'task', view_id: 'view', view_revision: 1, state_revision: 1, bundle_resource_id: 'original' }
function setup() {
  const db = new Database(':memory:'); databases.push(db); db.pragma('foreign_keys=ON'); db.exec(core); db.exec(runner)
  db.exec("INSERT INTO tasks(id,title,state,revision) VALUES ('task','Task','active',1); INSERT INTO tasks(id,title,state,revision) VALUES ('other','Other','active',1)")
  for (const id of ['original', 'published']) {
    db.prepare("INSERT INTO resources VALUES (?,?,'fixture',0,'application/json','Body','time')").run(id, id)
    db.prepare("INSERT INTO task_resources VALUES ('task',?)").run(id)
  }
  db.exec("INSERT INTO surfaces VALUES ('surface','task',1,'{}'); INSERT INTO views(id,surface_id,revision,bundle_resource_id,state_revision,draft_json,compatibility_version) VALUES ('view','surface',1,'original',1,'{}','v1')")
  return { db, state: new ContentTreeState(db) }
}
function successor() {
  const tree = contentTree(); tree.revision = 2; tree.nodes[0]!.revision = 2
  tree.nodes[0]!.children = ['node-b']; tree.nodes.splice(1, 1)
  tree.lineage = [{ previous_node_id: 'node-a', successor_node_ids: [], revision: 2, reason: 'deleted' }]
  return tree
}

describe('durable content trees', () => {
  it('upgrades idempotently without inventing a tree or editing existing Views', () => {
    const { db, state } = setup(); installContentTreeSchema(db); installContentTreeSchema(db)
    expect(state.snapshot('task', 'view')).toBeNull()
    expect(db.prepare('SELECT revision,bundle_resource_id FROM views').get()).toEqual({ revision: 1, bundle_resource_id: 'original' })
    expect(db.pragma('foreign_key_check')).toEqual([])
  })
  it('installs one immutable snapshot identity and survives reopening', () => {
    const { db, state } = setup(), tree = contentTree()
    const installed = state.install(binding, tree, null)
    expect(state.install(binding, tree, null)).toEqual(installed)
    expect(new ContentTreeState(db).snapshot('task', 'view')).toEqual(installed)
    const different = contentTree(); different.nodes[1]!.title = 'Changed'
    expect(() => state.install(binding, different, null)).toThrow()
    expect(db.prepare('SELECT count(*) n FROM runner_content_trees').get()).toEqual({ n: 1 })
  })
  it('checks task, View and state bindings before installing any metadata', () => {
    const { db, state } = setup()
    for (const changed of [{ ...binding, task_id: 'other' }, { ...binding, view_revision: 2 }, { ...binding, state_revision: 2 }, { ...binding, bundle_resource_id: 'published' }]) expect(() => state.install(changed, contentTree(), null)).toThrow()
    expect(db.prepare('SELECT count(*) n FROM runner_content_trees').get()).toEqual({ n: 0 })
    expect(db.prepare("SELECT count(*) n FROM object_references WHERE source_kind='runner_content_trees'").get()).toEqual({ n: 0 })
  })
  it('retains history and retirement without reviving old identities', () => {
    const { db, state } = setup(); state.install(binding, contentTree(), null)
    db.exec("UPDATE views SET revision=2,bundle_resource_id='published' WHERE id='view'")
    const nextBinding = { ...binding, view_revision: 2, bundle_resource_id: 'published' }
    state.install(nextBinding, successor(), 1)
    expect(state.snapshot('task', 'view', 1)!.tree).toEqual(contentTree())
    expect(state.lookup('task', 'view', 'node-a')).toEqual({ state: 'retired', tree_revision: 2, lineage: { previous_node_id: 'node-a', successor_node_ids: [], revision: 2, reason: 'deleted' }, successor_node_ids: [] })
    expect(state.lookup('task', 'view', 'node-a', 1)?.state).toBe('current')
    expect(state.lookup('other', 'view', 'node-b')).toBeNull()
    expect(() => state.install(nextBinding, contentTree(), 2)).toThrow()
    const resurrected = contentTree(); resurrected.revision = 3
    expect(() => state.install(nextBinding, resurrected, 2)).toThrow()
    expect(state.snapshot('task', 'view')!.tree.revision).toBe(2)
  })
  it('rolls back source, snapshot and retained resources in the publication transaction', () => {
    const { db, state } = setup(); state.install(binding, contentTree(), null)
    expect(() => db.transaction(() => {
      db.exec("UPDATE views SET revision=2,bundle_resource_id='published' WHERE id='view'")
      state.install({ ...binding, view_revision: 2, bundle_resource_id: 'published' }, successor(), 1)
      throw Error('publication failed')
    })()).toThrow('publication failed')
    expect(state.snapshot('task', 'view')!.tree.revision).toBe(1)
    expect(db.prepare('SELECT revision FROM views').get()).toEqual({ revision: 1 })
    expect(db.prepare("SELECT target_id FROM object_references WHERE source_kind='runner_content_trees'").all()).toEqual([{ target_id: 'original' }])
  })
  it('keeps navigation cursors bound to the original snapshot and scope', () => {
    const { db, state } = setup(); state.install(binding, contentTree(), null)
    const first = state.page('task', 'view', { limit: 1 })
    expect(first.nodes.map(node => node.node_id)).toEqual(['node-a'])
    expect(first.next_cursor!.length).toBeLessThanOrEqual(200)
    db.exec("UPDATE views SET revision=2,bundle_resource_id='published' WHERE id='view'")
    state.install({ ...binding, view_revision: 2, bundle_resource_id: 'published' }, successor(), 1)
    const reopened = new ContentTreeState(db)
    const next = reopened.page('task', 'view', { cursor: first.next_cursor!, limit: 1 })
    expect(next.tree_revision).toBe(1)
    expect(next.nodes.map(node => node.node_id)).toEqual(['node-b'])
    expect(() => reopened.page('task', 'view', { cursor: first.next_cursor!, revision: 2 })).toThrow()
    expect(() => reopened.page('task', 'view', { cursor: first.next_cursor!, query: 'changed' })).toThrow()
    expect(reopened.readCursor('other', first.next_cursor!)).toBeNull()
  })
})
