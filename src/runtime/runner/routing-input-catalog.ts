import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { RouteWorkRunnerInstalledInput, RouteWorkRunnerOutputBinding } from '../../shared/contracts.generated'
import { ContractError } from '../../shared/validation'
import { AssignmentContent, type PublishedInput, type RequestScope } from './assignment-content'
import { ChapterState } from './chapter-state'
import { ContentTreeState } from './content-tree-state'

type Kind = 'material' | 'published' | 'output'
type Filter = { kind?: Kind; name_query?: string; limit: number }
type Entry = { kind: Kind; name: string; status: 'available' | 'published' | 'accepted' | 'expected'; reference: RouteWorkRunnerInstalledInput; source: object; path?: string[]; media_type?: string }
export type CatalogOutput = Entry & { kind: 'output'; reference: RouteWorkRunnerOutputBinding }
const pageBytes = 8192, maxItems = 32
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
const cursorError = () => new ContractError('RUNNER_CATALOG_CURSOR_INVALID', 'Catalog cursor expired, changed scope or belongs to another routing execution; restart the query')
const key = (entry: Entry) => JSON.stringify([entry.kind, entry.reference])
const bounded = (text: string, bytes = 256): string => {
  let end = 0, used = 0
  for (const char of text) { used += Buffer.byteLength(char); if (used > bytes) break; end += char.length }
  return text.slice(0, end)
}

export class RoutingInputCatalog {
  private readonly cursors = new Map<string, { key: string; filter: Filter }>()

  constructor(private readonly db: Database.Database, private readonly scope: RequestScope, private readonly outputs: () => Iterable<CatalogOutput>) {}

  page(raw: unknown) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(field => !['kind', 'name_query', 'limit', 'cursor'].includes(field))) throw new ContractError('INVALID_RUNNER_CONTRACT', 'Catalog expects kind, name_query, limit and/or cursor')
    const args = raw as { kind?: Kind; name_query?: string; limit?: number; cursor?: string }
    if (args.kind !== undefined && !['material', 'published', 'output'].includes(args.kind) || args.name_query !== undefined && (typeof args.name_query !== 'string' || Buffer.byteLength(args.name_query) > 256) || args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > maxItems)) throw new ContractError('INVALID_RUNNER_CONTRACT', 'Invalid catalog kind, name query or page limit')
    if (args.cursor !== undefined && (typeof args.cursor !== 'string' || args.cursor.length !== 36)) throw cursorError()
    const previous = args.cursor ? this.cursors.get(args.cursor) : undefined
    if (args.cursor && (!previous || args.kind !== undefined && args.kind !== previous.filter.kind || args.name_query !== undefined && args.name_query !== previous.filter.name_query || args.limit !== undefined && args.limit !== previous.filter.limit)) throw cursorError()
    const filter = previous?.filter ?? { kind: args.kind, name_query: args.name_query, limit: args.limit ?? 16 }
    const match = filter.name_query?.trim().toLowerCase()
    const items: Entry[] = []
    let anchor = !previous, more = false
    for (const entry of this.entries(filter.kind)) {
      if (match && ![entry.name, ...entry.path ?? []].some(value => value.toLowerCase().includes(match))) continue
      if (!anchor) { if (key(entry) === previous?.key) anchor = true; continue }
      if (items.length === filter.limit || size({ items: [...items, entry], next_cursor: '0'.repeat(36) }) > pageBytes) { more = true; break }
      items.push(entry)
    }
    if (!anchor) throw cursorError()
    if (more && !items.length) throw new ContractError('TOOL_RESULT_LIMIT', 'One catalog entry exceeds the page byte limit')
    const next_cursor = more ? randomUUID() : null
    if (next_cursor) {
      if (this.cursors.size >= 256) this.cursors.delete(this.cursors.keys().next().value!)
      this.cursors.set(next_cursor, { key: key(items.at(-1)!), filter })
    }
    return { items, next_cursor }
  }

  private *entries(kind?: Kind): Iterable<Entry> {
    const content = new AssignmentContent(this.db), scope = this.scope
    if (!kind || kind === 'material') for (const row of content.materials(scope)) {
      const attached = scope.materials.includes(row.id)
      yield { kind: 'material', name: bounded(row.display_name), media_type: bounded(row.media_type, 128), status: 'available', reference: { kind: 'material', resource_id: row.id },
        source: attached ? { kind: 'attachment', request_id: scope.request } : row.import_id ? { kind: 'import', import_id: row.import_id } : { kind: 'request_history' } }
    }
    if (!kind || kind === 'published') {
      const trees = new ContentTreeState(this.db), chapters = new ChapterState(this.db)
      for (const view of content.views(scope.task)) {
        const snapshot = trees.snapshot(scope.task, view.id), manifest = chapters.manifest(scope.task, view.id)
        const title = (this.db.prepare('SELECT display_name FROM resources WHERE id=?').get(view.bundle_resource_id) as { display_name: string } | undefined)?.display_name ?? view.id
        const source = { view_id: view.id, view_revision: view.revision }
        function entry(name: string, node_id: string, revision: number, tree_revision?: number, path?: string[]): Entry {
          const reference: PublishedInput = { kind: 'published', ...source, node_id, revision, ...(tree_revision !== undefined ? { tree_revision } : {}) }
          return { kind: 'published', status: 'published', name: bounded(name || node_id), source, reference, ...(path?.length ? { path } : {}) }
        }
        function* entries(): Iterable<Entry> {
          if (snapshot && snapshot.view_revision === view.revision && snapshot.bundle_resource_id === view.bundle_resource_id) {
            const nodes = new Map(snapshot.tree.nodes.map(node => [node.node_id, node]))
            for (const node of snapshot.tree.nodes) if (node.kind === 'document' || node.kind === 'section') {
              const path: string[] = [bounded(title, 96)]
              let parent = node.parent_id
              while (parent && path.length < 8) {
                const ancestor = nodes.get(parent)!
                if (ancestor.kind === 'section') path.splice(1, 0, bounded(ancestor.title || ancestor.node_id, 96))
                parent = ancestor.parent_id
              }
              yield entry(node.kind === 'document' ? title : node.title, node.node_id, node.revision, snapshot.tree.revision, node.kind === 'section' ? path : undefined)
            }
          } else {
            yield entry(title, view.id, view.revision)
            if (manifest && !manifest.content_tree && manifest.view_revision === view.revision && manifest.bundle_resource_id === view.bundle_resource_id) for (const chapter of manifest.chapters) yield entry(chapter.title, chapter.region_id, chapter.revision, undefined, [bounded(title, 96)])
          }
        }
        for (const candidate of entries()) {
          try { content.checkNew(scope, candidate.reference as PublishedInput, 'catalog'); yield candidate }
          catch (error) { if (!(error instanceof ContractError) || error.code !== 'RUNNER_DEPENDENCY_INVALID') throw error }
        }
      }
    }
    if (!kind || kind === 'output') yield* this.outputs()
  }
}
