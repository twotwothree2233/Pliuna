import type { Bundle, ChapterManifest, ContentNode, ContentTree, ModelRequest } from '../../shared/contracts.generated'
import { ContractError } from '../../shared/validation'
import { modelReadOptions } from '../model/tool-input'
import { ContentTreeState, type ContentTreeSnapshot } from './content-tree-state'
import { RUNNER_LIMITS } from './limits'
import { randomUUID } from 'node:crypto'

type Query = Extract<ModelRequest, { type: 'read' | 'list' }>
type ReadQuery = Extract<Query, { type: 'read' }>
type ListQuery = Extract<Query, { type: 'list' }>
type ReadCursor = { mode: 'read'; task: string; source: string; kind: string; id: string; view: string; revision: number; offset: number; chars: number; query?: string; read_ref?: string }
export interface ContentReadDependency { view_id: string; node_id: string; revision: number; position_revision: number; bundle_resource_id: string; tree_revision: number }
type ListItem = { kind: 'content_tree' | 'content_node'; id: string; view_id: string; root_id: string; revision: number }
type ListCursor = { mode: 'list'; task: string; source: string; kind: string; limit: number; filter: string; items: ListItem[]; next: string | null }
const fail = (code: string, message: string): never => { throw new ContractError(code, message) }
const invalidCursor = (): never => fail('CONTENT_CURSOR_INVALID', 'Content cursor belongs to another task, source, target, selection or page size')
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const integer = (value: unknown, minimum = 0): value is number => Number.isSafeInteger(value) && (value as number) >= minimum
const cursorPlaceholder = '0'.repeat(36)
const responseSize = (value: unknown): number => JSON.stringify(value).length
const tooSmall = (): never => fail('TOOL_RESULT_LIMIT', 'max_chars cannot hold this content page; request a larger page')
const pageSize = RUNNER_LIMITS.index.page_items
const metadata = (node: ContentNode) => ({
  node_id: node.node_id, parent_id: node.parent_id, kind: node.kind,
  revision: node.revision, position_revision: node.position_revision,
  ...(node.kind === 'section' ? { title: node.title } : {}),
  child_count: node.children.length,
  operations: node.kind === 'document' ? ['replace', 'insert'] : [
    'replace', 'delete', 'move',
    ...(['section', 'list', 'list_item', 'table', 'row', 'cell'].includes(node.kind) || node.kind === 'block' && !!node.tag ? ['insert'] : [])
  ],
  ...(node.kind === 'cell' || node.kind === 'list_item' ? { replacement: 'inner_html', container_tag: node.tag } : { replacement: 'outer_html', container_tag: node.tag })
})

function subtree(tree: ContentTree, node: ContentNode): ContentNode[] {
  const byId = new Map(tree.nodes.map(item => [item.node_id, item])), pending = [node], result: ContentNode[] = []
  while (pending.length) {
    const item = pending.pop()!
    result.push(item)
    pending.push(...item.children.map(id => byId.get(id)!).reverse())
  }
  return result
}

function page<T>(items: readonly T[], offset: number, chars: number, envelope: (items: T[], next: string | null) => unknown): { items: T[]; offset: number } {
  if (offset > items.length) return invalidCursor()
  const remaining = items.slice(offset)
  if (remaining.length <= pageSize && responseSize(envelope(remaining, null)) <= chars) return { items: remaining, offset: items.length }
  const selected: T[] = []
  for (const item of items.slice(offset, offset + pageSize)) {
    const candidate = [...selected, item], nextOffset = offset + candidate.length
    if (responseSize(envelope(candidate, nextOffset < items.length ? cursorPlaceholder : null)) > chars) break
    selected.push(item)
  }
  if (!selected.length && offset < items.length || responseSize(envelope(selected, offset + selected.length < items.length ? cursorPlaceholder : null)) > chars) return tooSmall()
  return { items: selected, offset: offset + selected.length }
}

function textEnd(text: string, start: number, end: number): number {
  if (end > start && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end]!)) return end - 1
  return end
}

/** Structure reads intentionally contain neither body excerpts nor source locators. */
export class ContentTreeQueries {
  constructor(
    private readonly state: ContentTreeState,
    private readonly manifests: () => ChapterManifest[],
    private readonly bundle: (resource: string) => Bundle,
    private readonly readDependency: (value: ContentReadDependency, readRef?: string) => string | void = () => {}
  ) {}

  query(task: string, source: string, request: Query, bodyAllowed = true): unknown {
    const kind = request.type === 'list' ? request.input.kind : request.input.target.kind
    if (!['content_tree', 'content_node'].includes(kind)) return fail('UNSUPPORTED_OPERATION', 'This query requires a content tree or node')
    if (kind === 'content_node' && !bodyAllowed) return fail('WORKER_CAPABILITY_DENIED', 'This role can read structure only')
    return request.type === 'list' ? this.list(task, source, request) : this.read(task, source, request)
  }

  readBound(snapshot: ContentTreeSnapshot, source: string, request: ReadQuery): unknown {
    return this.read(snapshot.task_id, source, request, snapshot)
  }

  private list(task: string, source: string, request: ListQuery): unknown {
    const { kind, filters, cursor, limit } = request.input
    if (filters && Object.keys(filters).some(key => key !== 'name_query')) return fail('CONTENT_QUERY_INVALID', 'Content lists support only name_query')
    if (cursor) {
      const saved = this.state.readCursor(task, cursor)
      if (!object(saved) || saved.mode !== 'list' || saved.task !== task || saved.source !== source || saved.kind !== kind || !integer(saved.limit, 1) || typeof saved.filter !== 'string' || !Array.isArray(saved.items) || saved.items.length > pageSize || saved.next !== null && typeof saved.next !== 'string') return invalidCursor()
      if (limit !== undefined && limit !== saved.limit || filters?.name_query !== undefined && filters.name_query !== saved.filter) return invalidCursor()
      if (!saved.items.every(item => object(item) && item.kind === kind && typeof item.id === 'string' && typeof item.view_id === 'string' && typeof item.root_id === 'string' && integer(item.revision, 1))) return invalidCursor()
      return { items: saved.items, next_cursor: saved.next, truncated: saved.next !== null }
    }
    const selectedLimit = limit ?? pageSize, filter = filters?.name_query ?? ''
    if (!integer(selectedLimit, 1)) return fail('CONTENT_QUERY_INVALID', 'Content list requires a positive page size')
    if (Buffer.byteLength(filter) > RUNNER_LIMITS.index.title_bytes) return fail('CONTENT_QUERY_INVALID', 'Content name query exceeds the heading metadata size')
    const manifests = this.manifests().filter(manifest => manifest.task_id === task && manifest.content_tree)
    const items: ListItem[] = manifests.filter(manifest => !filter || [manifest.view_id, manifest.content_tree!.root_id, ...manifest.content_tree!.nodes.filter(node => node.kind === 'section').map(node => node.title)].some(name => name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()))).map(manifest => ({
      kind: kind as ListItem['kind'], id: kind === 'content_tree' ? manifest.view_id : manifest.content_tree!.root_id,
      view_id: manifest.view_id, root_id: manifest.content_tree!.root_id, revision: manifest.content_tree!.revision
    }))
    const pages: ListItem[][] = []
    for (const item of items) {
      let current = pages.at(-1)
      if (!current || current.length >= Math.min(pageSize, selectedLimit) || Buffer.byteLength(JSON.stringify([...current, item])) > 6000) pages.push(current = [])
      current.push(item)
    }
    let next: string | null = null
    for (let index = pages.length - 1; index > 0; index--) {
      const part = pages[index]!, first = part[0]!
      next = this.state.createCursor(task, first.view_id, { mode: 'list', task, source, kind, limit: selectedLimit, filter, items: part, next } satisfies ListCursor, first.revision)
    }
    return { items: pages[0] ?? [], next_cursor: next, truncated: next !== null }
  }

  private read(task: string, source: string, request: ReadQuery, fixed?: ContentTreeSnapshot): unknown {
    const target = request.input.target, kind = target.kind, options = modelReadOptions(request), selection = options?.selection
    if (request.input.content || request.input.range || selection?.lines || selection?.pages || selection?.section !== undefined || selection?.view && selection.view !== 'object' || kind === 'content_node' && selection?.find !== undefined) return fail('CONTENT_QUERY_INVALID', 'Content reads support object view and structural heading search only')
    let cursor: ReadCursor | undefined
    if (request.input.cursor) {
      const saved = this.state.readCursor(task, request.input.cursor)
      if (!object(saved) || saved.mode !== 'read' || saved.task !== task || saved.source !== source || saved.kind !== kind || saved.id !== target.id || typeof saved.view !== 'string' || !integer(saved.revision, 1) || !integer(saved.offset) || !integer(saved.chars, 1) || saved.chars > 32000 || saved.query !== undefined && typeof saved.query !== 'string' || saved.read_ref !== undefined && (typeof saved.read_ref !== 'string' || !saved.read_ref)) return invalidCursor()
      if (options?.explicit?.max_chars !== undefined && options.explicit.max_chars !== saved.chars || selection?.find !== undefined && selection.find !== saved.query) return invalidCursor()
      cursor = saved as ReadCursor
    }
    const chars = cursor?.chars ?? options?.max_chars ?? 12000, query = cursor?.query ?? selection?.find
    if (!integer(chars, 1) || chars > 32000) return fail('CONTENT_QUERY_INVALID', 'max_chars must be between 1 and 32000')
    if (query !== undefined && Buffer.byteLength(query) > RUNNER_LIMITS.index.title_bytes) return fail('CONTENT_QUERY_INVALID', 'Heading search exceeds the heading metadata size')
    if (fixed && cursor && (cursor.view !== fixed.view_id || cursor.revision !== fixed.tree.revision)) return invalidCursor()
    const snapshot = fixed ?? this.resolve(task, request, cursor)
    const tree = snapshot.tree
    if (kind === 'content_tree' && target.expected_revision !== undefined && target.expected_revision !== tree.revision) return fail('READ_VERSION_CHANGED', 'Content tree revision conflicts with the fixed snapshot')
    const node = tree.nodes.find(item => item.node_id === (target.id === snapshot.view_id ? tree.root_id : target.id))
    const offset = cursor?.offset ?? 0
    const base: ReadCursor = { mode: 'read', task, source, kind, id: target.id, view: snapshot.view_id, revision: tree.revision, offset, chars, ...(query === undefined ? {} : { query }), ...(cursor?.read_ref ? { read_ref: cursor.read_ref } : {}) }
    const continuation = (nextOffset: number, total: number) => nextOffset < total ? this.state.createCursor(task, snapshot.view_id, { ...base, offset: nextOffset }, tree.revision) : null
    if (!node) {
      const lineage = tree.lineage.find(item => item.previous_node_id === target.id)
      if (!lineage) return fail('CONTENT_NODE_NOT_FOUND', 'Content node does not exist in this snapshot')
      if (query !== undefined) return fail('CONTENT_QUERY_INVALID', 'A retired node has successor links instead of a searchable subtree')
      const envelope = (successors: string[], next: string | null) => ({ data: {
        task_id: task, view_id: snapshot.view_id, tree_revision: tree.revision, node_id: target.id, state: 'retired',
        lineage: { previous_node_id: lineage.previous_node_id, revision: lineage.revision, reason: lineage.reason },
        successor_node_ids: successors, successor_kind: 'direct', successor_count: lineage.successor_node_ids.length
      }, next_cursor: next, truncated: next !== null })
      const selected = page(lineage.successor_node_ids, offset, chars, envelope)
      return envelope(selected.items, continuation(selected.offset, lineage.successor_node_ids.length))
    }
    const binding = { task_id: task, view_id: snapshot.view_id, bundle_resource_id: snapshot.bundle_resource_id, tree_revision: tree.revision, node_id: node.node_id, revision: node.revision, position_revision: node.position_revision }
    if (kind === 'content_tree') {
      const byId = new Map(tree.nodes.map(item => [item.node_id, item]))
      const candidates = query !== undefined ? subtree(tree, node).filter(item => item.kind === 'section' && item.title.includes(query)) : node.children.map(id => byId.get(id)!)
      const envelope = (items: ReturnType<typeof metadata>[], next: string | null) => ({ data: { ...binding, node: metadata(node), items }, next_cursor: next, truncated: next !== null })
      const selected = page(candidates.map(metadata), offset, chars, envelope)
      return envelope(selected.items, continuation(selected.offset, candidates.length))
    }
    if (target.expected_revision !== undefined && target.expected_revision !== node.revision) return fail('READ_VERSION_CHANGED', 'The node changed; read its current baseline')
    const html = this.bundle(snapshot.bundle_resource_id).html.slice(node.span.start, node.span.end)
    if (offset > html.length || textEnd(html, 0, offset) !== offset) return invalidCursor()
    let readRef = cursor?.read_ref ?? cursorPlaceholder
    const envelope = (text: string, next: string | null) => ({ data: { ...binding, read_ref: readRef, node: metadata(node), html: text }, next_cursor: next, truncated: next !== null })
    let end = html.length
    if (responseSize(envelope(html.slice(offset), null)) > chars) {
      let low = offset, high = html.length - 1
      while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        if (responseSize(envelope(html.slice(offset, textEnd(html, offset, middle)), cursorPlaceholder)) <= chars) low = middle
        else high = middle - 1
      }
      end = textEnd(html, offset, low)
      if (end === offset) return tooSmall()
    }
    if (responseSize(envelope(html.slice(offset, end), end < html.length ? cursorPlaceholder : null)) > chars) return tooSmall()
    readRef = this.readDependency({ view_id: snapshot.view_id, node_id: node.node_id, revision: node.revision, position_revision: node.position_revision, bundle_resource_id: snapshot.bundle_resource_id, tree_revision: tree.revision }, cursor?.read_ref) ?? cursor?.read_ref ?? randomUUID()
    base.read_ref = readRef
    const result = envelope(html.slice(offset, end), continuation(end, html.length))
    if (responseSize(result) > chars) return tooSmall()
    return result
  }

  private resolve(task: string, request: ReadQuery, cursor?: ReadCursor): ContentTreeSnapshot {
    if (cursor) return this.state.snapshot(task, cursor.view, cursor.revision) ?? fail('READ_VERSION_CHANGED', 'The requested content snapshot is unavailable')
    const target = request.input.target
    const manifests = this.manifests().filter(manifest => manifest.task_id === task)
    const manifest = manifests.find(item => item.view_id === target.id || item.content_tree?.nodes.some(node => node.node_id === target.id) || item.content_tree?.lineage.some(lineage => lineage.previous_node_id === target.id))
    const view = manifest?.view_id ?? target.id
    const snapshot = this.state.snapshot(task, view, target.kind === 'content_tree' ? target.expected_revision : undefined)
    if (snapshot) return snapshot
    if (this.state.snapshot(task, view)) return fail('READ_VERSION_CHANGED', 'The requested content snapshot is unavailable')
    if (manifest) return fail('CONTENT_BASELINE_MISSING', 'The requested content baseline is unavailable')
    return fail('CONTENT_NODE_NOT_FOUND', 'List content_tree to find available content')
  }
}
