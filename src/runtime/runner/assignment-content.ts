import type Database from 'better-sqlite3'
import { isDeepStrictEqual } from 'node:util'
import type { Bundle, ChapterManifest, ContentNode, LogicalWork, ModelRequest } from '../../shared/contracts.generated'
import { ContractError } from '../../shared/validation'
import { isMaterialRemoved, materialRemoved } from '../material-removals'
import type { ContentInput } from './orchestration-plan'
import { ChapterState } from './chapter-state'
import { ContentTreeState, type ContentTreeSnapshot } from './content-tree-state'
import { ContentTreeQueries } from './content-tree-queries'
import { chapterInput } from './chapter-content'
import { modelToolRequest } from '../model/tool-input'
import { RepresentationPager } from '../model/representation'

export type MaterialInput = Extract<ContentInput, { kind: 'material' }>
export type PublishedInput = Extract<ContentInput, { kind: 'published' }>
type Material = { id: string; display_name: string; media_type: string; byte_length: number }
type PublishedView = { id: string; revision: number; bundle_resource_id: string }
export type PublishedSource = { resource: string; snapshot?: ContentTreeSnapshot; node?: ContentNode; manifest?: ChapterManifest; chapter?: ChapterManifest['chapters'][number] }
export type RequestScope = { task: string; request: string; through: number; materials: readonly string[]; history: readonly string[]; chapter?: { manifest: ChapterManifest; region_ids: string[] } }
type ReadRequest = Extract<ModelRequest, { type: 'read' }>

export function boundContentInputs(work: LogicalWork): ContentInput[] {
  return work.purpose === 'production' ? work.assignment?.inputs.filter(input => 'kind' in input) ?? [] : []
}

export class BoundContentError extends ContractError {
  constructor(readonly input: ContentInput, reason: string, assignment?: string) {
    const source = input.kind === 'material' ? `material ${input.resource_id}` : `published ${input.view_id}/${input.node_id}@${input.revision}`
    super('RUNNER_DEPENDENCY_INVALID', `${assignment ? `Assignment ${assignment}: ` : ''}${source}: ${reason}`)
  }
}
const invalid = (input: ContentInput, reason: string, assignment?: string): never => { throw new BoundContentError(input, reason, assignment) }

function branch(nodes: ContentNode[], root: ContentNode): unknown {
  const index = new Map(nodes.map(node => [node.node_id, node])), pending = [root], versions = []
  while (pending.length) {
    const node = pending.pop()!
    versions.push([node.node_id, node.revision, node.position_revision, node.children])
    for (const child of node.children) pending.push(index.get(child)!)
  }
  return versions
}

export class AssignmentContent {
  constructor(private readonly db: Database.Database) {}

  scope(task: string, request: string, attachments?: readonly string[]): RequestScope {
    const row = this.db.prepare('SELECT input_json FROM requests WHERE task_id=? AND id=?').get(task, request) as { input_json: string } | undefined
    if (!row) throw new ContractError('RUNNER_OWNERSHIP_INVALID', 'The original request is unavailable')
    const input = JSON.parse(row.input_json)
    return { task, request, through: input.conversation?.through_sequence ?? 0, materials: attachments ?? input.bound_materials?.map((item: Material) => item.id) ?? [], history: input.conversation?.resource_ids ?? [], chapter: input.chapter_query }
  }

  material(task: string, input: MaterialInput, assignment?: string): Material {
    const row = this.db.prepare('SELECT r.id,r.display_name,r.media_type,r.byte_length FROM resources r JOIN task_resources t ON t.resource_id=r.id WHERE t.task_id=? AND r.id=?').get(task, input.resource_id) as Material | undefined
    return row ?? invalid(input, 'source is no longer readable in this Task', assignment)
  }

  materials(scope: RequestScope): (Material & { import_id: string | null })[] {
    return this.db.prepare(`WITH imports AS (
      SELECT json_extract(payload_json,'$.resource_id') AS resource_id, MAX(COALESCE(json_extract(payload_json,'$.action_id'),id)) AS import_id
      FROM records WHERE task_id=@task AND kind='material.imported' AND sequence<=@through GROUP BY resource_id
    ) SELECT r.id,r.display_name,r.media_type,r.byte_length,i.import_id FROM task_resources t JOIN resources r ON r.id=t.resource_id
      LEFT JOIN imports i ON i.resource_id=r.id WHERE t.task_id=@task AND NOT ${materialRemoved('t.task_id', 't.resource_id')}
      AND (i.import_id IS NOT NULL OR r.id IN (SELECT value FROM json_each(@accepted))) ORDER BY r.id`).all({ task: scope.task, through: scope.through, accepted: JSON.stringify([...scope.materials, ...scope.history]) }) as (Material & { import_id: string | null })[]
  }

  views(task: string): PublishedView[] {
    return this.db.prepare('SELECT v.id,v.revision,v.bundle_resource_id FROM views v JOIN surfaces s ON s.id=v.surface_id WHERE s.task_id=? ORDER BY v.id').all(task) as PublishedView[]
  }

  private view(task: string, view: string): PublishedView | undefined {
    return this.db.prepare('SELECT v.id,v.revision,v.bundle_resource_id FROM views v JOIN surfaces s ON s.id=v.surface_id WHERE s.task_id=? AND v.id=?').get(task, view) as PublishedView | undefined
  }

  published(task: string, input: PublishedInput, assignment?: string): PublishedSource {
    const history = this.db.prepare('SELECT bundle_resource_id FROM view_history WHERE task_id=? AND view_id=? AND view_revision=?').get(task, input.view_id, input.view_revision) as { bundle_resource_id: string } | undefined
    if (!history) return invalid(input, 'the published snapshot is unavailable in this Task', assignment)
    const resource = history.bundle_resource_id
    if (!this.db.prepare('SELECT 1 FROM task_resources WHERE task_id=? AND resource_id=?').get(task, resource)) return invalid(input, 'the published snapshot is no longer readable', assignment)
    if (input.tree_revision !== undefined) {
      const snapshot = new ContentTreeState(this.db).snapshot(task, input.view_id, input.tree_revision)
      const node = snapshot?.tree.nodes.find(node => node.node_id === input.node_id && (node.kind === 'document' || node.kind === 'section'))
      if (!snapshot || snapshot.view_revision !== input.view_revision || snapshot.bundle_resource_id !== resource || node?.revision !== input.revision) return invalid(input, 'the exact published node is unavailable', assignment)
      return { resource, snapshot, node }
    }
    if (input.node_id === input.view_id && input.revision === input.view_revision) return { resource }
    const manifestRow = this.db.prepare('SELECT payload_json FROM runner_chapter_manifests WHERE task_id=? AND view_id=? AND view_revision=? AND bundle_resource_id=? ORDER BY manifest_revision DESC LIMIT 1').get(task, input.view_id, input.view_revision, resource) as { payload_json: string } | undefined
    const manifest: ChapterManifest | undefined = manifestRow && JSON.parse(manifestRow.payload_json)
    const chapter = manifest?.chapters.find(chapter => chapter.region_id === input.node_id && chapter.revision === input.revision)
    if (!chapter || !manifest || manifest.content_tree) return invalid(input, 'the exact published chapter is unavailable', assignment)
    return { resource, manifest, chapter }
  }

  checkNew(scope: RequestScope, input: ContentInput, assignment: string): void {
    if (input.kind === 'material') {
      this.material(scope.task, input, assignment)
      if (isMaterialRemoved(this.db, scope.task, input.resource_id)) invalid(input, 'removed from active materials', assignment)
      if (!scope.materials.includes(input.resource_id) && !scope.history.includes(input.resource_id) && !this.db.prepare(`SELECT 1 FROM records WHERE task_id=? AND kind='material.imported' AND sequence<=?
        AND json_extract(payload_json,'$.resource_id')=?`).get(scope.task, scope.through, input.resource_id)) invalid(input, 'outside the original request material scope', assignment)
      return
    }
    const source = this.published(scope.task, input, assignment)
    const view = this.view(scope.task, input.view_id)
    if (!view || view.revision !== input.view_revision || view.bundle_resource_id !== source.resource) invalid(input, 'the published version changed before binding', assignment)
    if (scope.chapter && (scope.chapter.manifest.view_id !== input.view_id || !scope.chapter.region_ids.includes(input.node_id))) invalid(input, 'outside the original request chapter scope', assignment)
    if (source.chapter?.dependencies.some(dependency => !new ChapterState(this.db).dependencyCurrent(dependency))) invalid(input, 'a published chapter dependency changed', assignment)
  }

  checkInstalled(task: string, input: ContentInput, assignment?: string): void {
    if (input.kind === 'material') { this.material(task, input, assignment); return }
    const source = this.published(task, input, assignment), view = this.view(task, input.view_id)
    if (!view) return invalid(input, 'the published View is no longer current', assignment)
    if (source.snapshot && source.node?.kind === 'section') {
      const snapshot = new ContentTreeState(this.db).snapshot(task, input.view_id), current = snapshot?.tree.nodes.find(node => node.node_id === input.node_id)
      if (!snapshot || snapshot.view_revision !== view.revision || snapshot.bundle_resource_id !== view.bundle_resource_id || !current || !isDeepStrictEqual(branch(source.snapshot.tree.nodes, source.node), branch(snapshot.tree.nodes, current))) invalid(input, 'the selected chapter changed', assignment)
    } else if (source.chapter) {
      const state = new ChapterState(this.db)
      if (!state.dependencyCurrent({ kind: 'chapter', task_id: task, view_id: input.view_id, region_id: input.node_id, revision: input.revision }) || source.chapter.dependencies.some(dependency => !state.dependencyCurrent(dependency))) invalid(input, 'the selected chapter or its dependency changed', assignment)
    } else if (view.revision !== input.view_revision || view.bundle_resource_id !== source.resource) invalid(input, 'the selected document changed', assignment)
  }
}

export class BoundContentReader {
  private readonly pager = new RepresentationPager()

  entries(content: AssignmentContent, work: LogicalWork, attempt: string) {
    return boundContentInputs(work).map((binding, index) => ({ input_ref: `${attempt}:${index}`, binding,
      ...(binding.kind === 'material' ? { display_name: content.material(work.task_id, binding).display_name } : {}) }))
  }

  async read(db: Database.Database, work: LogicalWork, attempt: string, raw: unknown, bundle: (resource: string) => Bundle, material: (request: ReadRequest, source: string) => unknown): Promise<unknown> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !['input_ref', 'cursor'].includes(key))) throw new ContractError('INVALID_RUNNER_CONTRACT', 'Use input_ref and an optional next cursor')
    const args = raw as { input_ref?: unknown; cursor?: unknown }
    if (typeof args.input_ref !== 'string' || args.cursor !== undefined && (typeof args.cursor !== 'string' || args.cursor.length > 2048)) throw new ContractError('INVALID_RUNNER_CONTRACT', 'Invalid bound input reference or cursor')
    const content = new AssignmentContent(db), binding = boundContentInputs(work).find((_input, index) => `${attempt}:${index}` === args.input_ref)
    if (!binding) throw new ContractError('WORKER_CAPABILITY_DENIED', 'Input entry does not belong to this Worker attempt')
    content.checkInstalled(work.task_id, binding, work.work_id)
    const source = `bound:${args.input_ref}`, cursor = args.cursor ? { cursor: args.cursor } : {}
    if (binding.kind === 'material') return material(modelToolRequest('read', { kind: 'resource', id: binding.resource_id, max_chars: 4000, ...cursor }) as ReadRequest, source)
    const published = content.published(work.task_id, binding)
    if (published.snapshot) return new ContentTreeQueries(new ContentTreeState(db), () => [], bundle).readBound(published.snapshot, source,
      modelToolRequest('read', { kind: 'content_node', id: binding.node_id, max_chars: 4000, selection: { revision: binding.revision }, ...cursor }) as ReadRequest)
    const value = bundle(published.resource)
    const html = published.manifest && published.chapter ? chapterInput(value, published.manifest, [published.chapter.region_id]).chapters[0]!.html : value.html
    return this.pager.page({ html }, [work.task_id, source, binding], { max_chars: 4000, selection: {} }, args.cursor)
  }
}
