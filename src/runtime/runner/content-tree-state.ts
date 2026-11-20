import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { ContentLineage, ContentNode, ContentTree } from '../../shared/contracts.generated'
import contentTreeSql from '../../shared/contracts/004-content-tree.sql?raw'
import { validateRunnerContract } from '../../shared/runner-validation'
import { ContractError } from '../../shared/validation'
import { assertRunnerId, boundedIndexPage } from './limits'
import { registerRunnerResources } from './resource-references'

export interface ContentTreeBinding {
  task_id: string
  view_id: string
  view_revision: number
  state_revision: number
  bundle_resource_id: string
}
export interface ContentTreeSnapshot extends ContentTreeBinding { tree: ContentTree }
export type ContentNodeLookup =
  | { state: 'current'; node: ContentNode; tree_revision: number }
  | { state: 'retired'; lineage: ContentLineage; successor_node_ids: string[]; tree_revision: number }
export interface ContentTreePageInput { revision?: number; parent_id?: string; query?: string; cursor?: string; limit?: number }
export interface ContentTreePage {
  tree_revision: number
  root_id: string
  parent_id: string
  nodes: (Pick<ContentNode, 'node_id' | 'parent_id' | 'kind' | 'title' | 'revision' | 'position_revision'> & { child_count: number })[]
  total: number
  next_cursor: string | null
}
type Row = { payload_json: string }
type Cursor = { kind: 'content_tree_page'; revision: number; parent_id: string; query: string; offset: number }
function fail(message: string): never { throw new ContractError('CONTENT_TREE_CONFLICT', message) }
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

export function installContentTreeSchema(db: Database.Database): void {
  db.transaction(() => {
    db.exec(contentTreeSql)
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='business_upgrade_state'").get()) {
      for (const table of ['runner_content_trees', 'runner_content_tree_heads', 'runner_content_tree_cursors', 'runner_content_intent_relations']) {
        for (const event of ['INSERT', 'UPDATE', 'DELETE']) db.exec(`CREATE TRIGGER IF NOT EXISTS business_v2_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN UPDATE business_upgrade_state SET v2_writes=1 WHERE id=1 AND v2_writes=0; END`)
      }
    }
  })()
}

export class ContentTreeState {
  constructor(private readonly db: Database.Database) { installContentTreeSchema(db) }

  snapshot(taskId: string, viewId: string, revision?: number): ContentTreeSnapshot | null {
    const row = revision === undefined
      ? this.db.prepare('SELECT m.payload_json FROM runner_content_tree_heads h JOIN runner_content_trees m USING(task_id,view_id,tree_revision) WHERE h.task_id=? AND h.view_id=?').get(taskId, viewId) as Row | undefined
      : this.db.prepare('SELECT payload_json FROM runner_content_trees WHERE task_id=? AND view_id=? AND tree_revision=?').get(taskId, viewId, revision) as Row | undefined
    if (!row) return null
    const snapshot = JSON.parse(row.payload_json) as ContentTreeSnapshot
    snapshot.tree = validateRunnerContract('runner_content_tree', snapshot.tree)
    return snapshot
  }

  install(binding: ContentTreeBinding, raw: ContentTree, expectedTreeRevision: number | null): ContentTreeSnapshot {
    for (const key of ['task_id', 'view_id', 'bundle_resource_id'] as const) assertRunnerId(binding[key], key)
    if (![binding.view_revision, binding.state_revision].every(value => Number.isSafeInteger(value) && value >= 1)) fail('Content tree requires exact View and state versions')
    const tree = validateRunnerContract('runner_content_tree', raw)
    const snapshot: ContentTreeSnapshot = { task_id: binding.task_id, view_id: binding.view_id, view_revision: binding.view_revision, state_revision: binding.state_revision, bundle_resource_id: binding.bundle_resource_id, tree }
    return this.db.transaction(() => {
      const current = this.snapshot(binding.task_id, binding.view_id)
      const existing = this.snapshot(binding.task_id, binding.view_id, tree.revision)
      const view = this.db.prepare('SELECT v.revision,v.state_revision,v.bundle_resource_id FROM views v JOIN surfaces s ON s.id=v.surface_id WHERE s.task_id=? AND v.id=?').get(binding.task_id, binding.view_id) as { revision: number; state_revision: number; bundle_resource_id: string } | undefined
      if (!view || view.revision !== binding.view_revision || view.state_revision !== binding.state_revision || view.bundle_resource_id !== binding.bundle_resource_id) fail('Content tree requires the exact published View and state')
      if (existing) {
        if (canonical(existing) !== canonical(snapshot)) fail('A content tree snapshot retains its original binding')
        if (current?.tree.revision !== tree.revision) fail('A historical content tree cannot become current again')
        return existing
      }
      if ((current?.tree.revision ?? null) !== expectedTreeRevision || tree.revision !== (expectedTreeRevision ?? 0) + 1) fail('Content tree installation baseline changed')
      if (current) {
        const retired = new Set(current.tree.lineage.map(item => item.previous_node_id))
        if (tree.nodes.some(node => retired.has(node.node_id))) fail('Retired content identities cannot be reused')
        const nextLineage = new Map(tree.lineage.map(item => [item.previous_node_id, item]))
        for (const item of current.tree.lineage) if (canonical(nextLineage.get(item.previous_node_id)) !== canonical(item)) fail('Content lineage retains its original successor relation')
        const nextIds = new Set(tree.nodes.map(node => node.node_id))
        for (const node of current.tree.nodes) if (!nextIds.has(node.node_id) && !nextLineage.has(node.node_id)) fail('Removed content requires an explicit retired identity')
      }
      registerRunnerResources(this.db, binding.task_id, 'runner_content_trees', JSON.stringify([binding.task_id, binding.view_id, tree.revision]), [binding.bundle_resource_id])
      this.db.prepare('INSERT INTO runner_content_trees(task_id,view_id,tree_revision,view_revision,state_revision,bundle_resource_id,payload_json,installed_at) VALUES (?,?,?,?,?,?,?,?)').run(binding.task_id, binding.view_id, tree.revision, binding.view_revision, binding.state_revision, binding.bundle_resource_id, canonical(snapshot), new Date().toISOString())
      this.db.prepare('INSERT INTO runner_content_tree_heads(task_id,view_id,tree_revision) VALUES (?,?,?) ON CONFLICT(task_id,view_id) DO UPDATE SET tree_revision=excluded.tree_revision').run(binding.task_id, binding.view_id, tree.revision)
      return copy(snapshot)
    })()
  }

  lookup(taskId: string, viewId: string, nodeId: string, revision?: number): ContentNodeLookup | null {
    const snapshot = this.snapshot(taskId, viewId, revision)
    if (!snapshot) return null
    const node = snapshot.tree.nodes.find(item => item.node_id === nodeId)
    if (node) return { state: 'current', node, tree_revision: snapshot.tree.revision }
    const lineage = snapshot.tree.lineage.find(item => item.previous_node_id === nodeId)
    if (!lineage) return null
    const current = new Set(snapshot.tree.nodes.map(item => item.node_id)), relations = new Map(snapshot.tree.lineage.map(item => [item.previous_node_id, item]))
    const successors = new Set<string>(), visited = new Set<string>(), pending = [...lineage.successor_node_ids]
    while (pending.length) {
      const id = pending.shift()!
      if (visited.has(id)) continue
      visited.add(id)
      if (current.has(id)) successors.add(id)
      else pending.push(...(relations.get(id)?.successor_node_ids ?? []))
    }
    return { state: 'retired', lineage, successor_node_ids: [...successors], tree_revision: snapshot.tree.revision }
  }

  createCursor(taskId: string, viewId: string, payload: unknown, revision?: number): string {
    const snapshot = this.snapshot(taskId, viewId, revision)
    if (!snapshot) fail('Content cursor requires an installed snapshot')
    const value = JSON.stringify(payload)
    if (value === undefined || Buffer.byteLength(value) > 8192) fail('Content cursor metadata is invalid')
    const cursor = randomUUID()
    this.db.prepare('INSERT INTO runner_content_tree_cursors(cursor_id,task_id,view_id,tree_revision,payload_json) VALUES (?,?,?,?,?)').run(cursor, taskId, viewId, snapshot.tree.revision, value)
    return cursor
  }

  readCursor(taskId: string, cursor: string): unknown | null {
    const row = this.db.prepare('SELECT payload_json FROM runner_content_tree_cursors WHERE cursor_id=? AND task_id=?').get(cursor, taskId) as Row | undefined
    return row ? JSON.parse(row.payload_json) : null
  }

  page(taskId: string, viewId: string, input: ContentTreePageInput = {}): ContentTreePage {
    const limit = input.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > 200 || input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 256)) fail('Content navigation requires bounded query and page size')
    let cursor: Cursor | undefined
    if (input.cursor) {
      const row = this.db.prepare('SELECT payload_json FROM runner_content_tree_cursors WHERE cursor_id=? AND task_id=? AND view_id=?').get(input.cursor, taskId, viewId) as Row | undefined
      if (!row) fail('Content cursor does not belong to this View')
      cursor = JSON.parse(row.payload_json) as Cursor
      if (cursor.kind !== 'content_tree_page' || !Number.isSafeInteger(cursor.revision) || typeof cursor.parent_id !== 'string' || typeof cursor.query !== 'string' || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) fail('Content cursor belongs to a different navigation operation')
      if (input.revision !== undefined && input.revision !== cursor.revision || input.parent_id !== undefined && input.parent_id !== cursor.parent_id || input.query !== undefined && input.query !== cursor.query) fail('Content cursor retains its original structural scope')
    }
    const snapshot = this.snapshot(taskId, viewId, cursor?.revision ?? input.revision)
    if (!snapshot) fail('Content tree is unavailable')
    const parentId = cursor?.parent_id ?? input.parent_id ?? snapshot.tree.root_id
    const parent = snapshot.tree.nodes.find(node => node.node_id === parentId)
    if (!parent) fail('Content navigation parent is unavailable in this snapshot')
    const query = cursor?.query ?? input.query ?? '', offset = cursor?.offset ?? 0
    const nodesById = new Map(snapshot.tree.nodes.map(node => [node.node_id, node]))
    const ids = new Set(parent.children)
    if (query) {
      const pending = [...parent.children]
      while (pending.length) {
        const id = pending.pop()!
        ids.add(id); pending.push(...nodesById.get(id)!.children)
      }
    }
    const matches = snapshot.tree.nodes.filter(node => ids.has(node.node_id) && (!query || node.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())))
    const metadata = matches.slice(offset, offset + limit).map(node => ({ node_id: node.node_id, parent_id: node.parent_id, kind: node.kind, title: node.title, revision: node.revision, position_revision: node.position_revision, child_count: node.children.length }))
    const nodes = boundedIndexPage(metadata).items
    let nextCursor: string | null = null
    if (offset + nodes.length < matches.length) {
      const next: Cursor = { kind: 'content_tree_page', revision: snapshot.tree.revision, parent_id: parentId, query, offset: offset + nodes.length }
      nextCursor = this.createCursor(taskId, viewId, next, snapshot.tree.revision)
    }
    return { tree_revision: snapshot.tree.revision, root_id: snapshot.tree.root_id, parent_id: parentId, nodes, total: matches.length, next_cursor: nextCursor }
  }

}
