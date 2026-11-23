import type Database from 'better-sqlite3'
import { isDeepStrictEqual } from 'node:util'
import type { Bundle, ChapterManifest, ChapterUpdate, IpcRequest } from '../../shared/contracts.generated'
import { ContractError } from '../../shared/validation'
import { ChapterState, chapterTerminal } from './chapter-state'
import { deriveChapterMapping } from './chapter-content'
import { RunnerWorkState } from './work-state'
import { captureConversation } from './conversation'
import { buildContentTree } from './content-tree'
import { treeChapters, treeTargetIds } from './content-tree-host'
import { isCorrectableContentError } from './content-errors'

type Row = Record<string, any>
function fail(code: string, message: string): never { throw new ContractError(code, message) }

/** Host metadata only. All body writes continue through the Surface publisher. */
export class ChapterHost {
  readonly state: ChapterState
  constructor(private readonly db: Database.Database, private readonly epoch: string, private readonly bundle: (resource: string) => Bundle, private readonly record: (task: string, kind: string, payload: unknown) => string) { this.state = new ChapterState(db) }

  map(task: string, viewId: string, expected: number): ChapterManifest {
    return this.db.transaction(() => {
      const view = this.db.prepare('SELECT v.* FROM views v JOIN surfaces s ON s.id=v.surface_id WHERE s.task_id=? AND v.id=?').get(task, viewId) as Row | undefined
      if (!view || view.revision !== expected) fail('VERSION_CONFLICT', 'Chapter mapping requires the current published View')
      const previous = this.state.manifest(task, viewId)
      if (previous?.view_revision === expected && previous.bundle_resource_id === view.bundle_resource_id) {
        if (previous.content_tree) return previous
        // Do not change a legacy operation's immutable baseline while it is unsettled.
        if (this.state.updates(task, viewId).some(update => !chapterTerminal.has(update.state))) return previous
        const content_tree = this.initialTree(this.bundle(view.bundle_resource_id).html, previous)
        return this.state.installManifest({ ...previous, content_tree, manifest_revision: previous.manifest_revision + 1 }, previous.manifest_revision)
      }
      const mappingRow = this.db.prepare('SELECT payload_json FROM runner_view_mappings WHERE task_id=? AND view_id=? ORDER BY rowid DESC LIMIT 1').get(task, viewId) as { payload_json: string } | undefined
      const mapping = mappingRow ? JSON.parse(mappingRow.payload_json) : null
      if (mapping && (mapping.view_revision !== view.revision || mapping.published_bundle_resource_id !== view.bundle_resource_id)) fail('CHAPTER_MAPPING_REQUIRED', 'The original publication mapping does not match the current content')
      const artifactRow = mapping ? this.db.prepare('SELECT payload_json FROM runner_artifacts WHERE task_id=? AND artifact_id=? AND artifact_revision=?').get(task, mapping.artifact_id, mapping.artifact_revision) as { payload_json: string } | undefined : undefined
      const artifact = artifactRow ? JSON.parse(artifactRow.payload_json) : null
      if (mapping && (!artifact || artifact.bundle_resource_id !== mapping.source_bundle_resource_id)) fail('CHAPTER_MAPPING_REQUIRED', 'The publication mapping lost its exact accepted source')
      const source = artifact ?? this.db.prepare('SELECT request_id FROM runs WHERE id=? AND task_id=?').get(view.creator_run_id, task) as Row | undefined
      if (!source?.request_id) fail('CHAPTER_MAPPING_REQUIRED', 'Select the original content goal before installing a chapter mapping')
      const goal = new RunnerWorkState(this.db, this.epoch).goal(source.request_id)
      if (goal.task_id !== task || goal.state !== 'active' || artifact && artifact.intent_revision !== goal.intent_revision) fail('CHAPTER_MAPPING_REQUIRED', 'The source content goal is no longer current')
      const bundle = this.bundle(view.bundle_resource_id)
      const content_tree = buildContentTree(bundle.html, previous?.content_tree ? { revision: previous.content_tree.revision + 1, root_id: previous.content_tree.root_id } : {})
      let derived: { chapters: ChapterManifest['chapters'] }
      try { derived = deriveChapterMapping(bundle, { view_id: viewId }) }
      catch (error) {
        if (!(error instanceof ContractError) || !['CHAPTER_MAPPING_INVALID', 'CHAPTER_MAPPING_REQUIRED'].includes(error.code)) throw error
        derived = { chapters: treeChapters(content_tree) }
      }
      const chapters = derived.chapters.map(chapter => {
        const old = previous?.chapters.find(item => item.title_selector === chapter.title_selector && item.body_selector === chapter.body_selector)
        return old ? { ...chapter, region_id: old.region_id, revision: old.revision + 1 } : chapter
      })
      const tree = this.initialTree(bundle.html, { chapters, content_tree })
      if (previous?.content_tree) {
        const oldTree = previous.content_tree, currentIds = new Set(tree.nodes.map(node => node.node_id))
        for (const node of tree.nodes) {
          const old = oldTree.nodes.find(item => item.node_id === node.node_id)
          if (old) {
            node.revision = old.revision + 1
            const oldOrder = oldTree.nodes.find(parent => parent.node_id === old.parent_id)?.children.indexOf(old.node_id)
            const nextOrder = tree.nodes.find(parent => parent.node_id === node.parent_id)?.children.indexOf(node.node_id)
            node.position_revision = old.position_revision + (old.parent_id !== node.parent_id || oldOrder !== nextOrder ? 1 : 0)
          }
        }
        const successors = tree.nodes.find(node => node.node_id === tree.root_id)!.children
        tree.lineage = [...oldTree.lineage, ...oldTree.nodes.filter(node => !currentIds.has(node.node_id)).map(node => ({ previous_node_id: node.node_id, successor_node_ids: successors, revision: tree.revision, reason: 'replaced' as const }))]
      }
      const manifest = this.state.installManifest({ task_id: task, view_id: viewId, view_revision: expected, state_revision: view.state_revision, bundle_resource_id: view.bundle_resource_id, manifest_revision: (previous?.manifest_revision ?? 0) + 1, shared_revision: (previous?.shared_revision ?? 0) + 1, request_id: goal.request_id, intent_revision: goal.intent_revision, ...(artifact ? { artifact_id: artifact.artifact_id, artifact_revision: artifact.artifact_revision } : {}), chapters, content_tree: tree }, previous?.manifest_revision ?? null)
      this.record(task, 'chapter.mapping.installed', { view_id: viewId, view_revision: expected, manifest_revision: manifest.manifest_revision })
      return manifest
    })()
  }

  private initialTree(html: string, previous?: Pick<ChapterManifest, 'chapters' | 'content_tree'>) {
    const tree = previous?.content_tree ? structuredClone(previous.content_tree) : buildContentTree(html)
    const aliases = new Map<string, string>()
    for (const chapter of previous?.chapters ?? []) {
      const matches = tree.nodes.filter(node => node.kind === 'section' && node.selector === chapter.title_selector)
      if (matches.length === 1) aliases.set(matches[0]!.node_id, chapter.region_id)
    }
    for (const node of tree.nodes) {
      node.node_id = aliases.get(node.node_id) ?? node.node_id
      node.parent_id = node.parent_id ? aliases.get(node.parent_id) ?? node.parent_id : null
      node.children = node.children.map(id => aliases.get(id) ?? id)
      const old = previous?.chapters.find(chapter => chapter.region_id === node.node_id)
      if (old) node.revision = old.revision
    }
    tree.root_id = aliases.get(tree.root_id) ?? tree.root_id
    return tree
  }

  start(input: Extract<IpcRequest, { type: 'chapter.update' }>, received?: { record_id: string; conversation: unknown; material_resource_ids: string[]; inherited_requirements?: Row[]; content_authority?: { region_ids: string[] }; conversation_dependency?: { message_id: string; request_id: string; result_id: string } }): ChapterUpdate {
    return this.db.transaction(() => {
      const existing = this.state.update(input.task_id, input.update_id)
      if (existing) {
        const raw = this.db.prepare('SELECT payload_json FROM records WHERE task_id=? AND id=?').get(input.task_id, existing.record_id) as { payload_json: string } | undefined
        if (!raw || !isDeepStrictEqual(JSON.parse(raw.payload_json).chapter_input, input)) fail('CHAPTER_CONFLICT', 'Chapter input identity retains its original payload')
        return existing
      }
      const view = this.db.prepare('SELECT v.* FROM views v JOIN surfaces s ON s.id=v.surface_id WHERE s.task_id=? AND v.id=?').get(input.task_id, input.view_id) as Row | undefined
      if (!view || view.revision !== input.view_revision || view.state_revision !== input.state_revision) fail('VERSION_CONFLICT', 'Content or draft changed before chapter update')
      const manifest = this.map(input.task_id, input.view_id, input.view_revision)
      const region_ids = treeTargetIds(manifest, input.region_ids)
      if (!region_ids.length || new Set(region_ids).size !== region_ids.length || !manifest.content_tree && region_ids.some(region => !manifest.chapters.some(chapter => chapter.region_id === region))) fail('CHAPTER_MAPPING_REQUIRED', 'Content selection must match the exact published mapping')
      const selected = manifest.chapters.filter(chapter => input.region_ids.includes(chapter.region_id))
      const shared = { kind: 'chapter' as const, task_id: input.task_id, view_id: input.view_id, revision: manifest.shared_revision }
      const dependencies = [...new Map([shared, ...selected.flatMap(chapter => chapter.dependencies)].map(dependency => [JSON.stringify(dependency), dependency])).values()]
      const record = this.record(input.task_id, received ? 'chapter.input.received' : 'message.user', { text: input.text, request_id: manifest.request_id, purpose: 'control_input', chapter_input: input, conversation: received?.conversation ?? captureConversation(this.db, input.task_id), ...(received ? { source_record_id: received.record_id, material_resource_ids: received.material_resource_ids, ...(received.inherited_requirements ? { inherited_requirements: received.inherited_requirements } : {}), ...(received.conversation_dependency ? { conversation_dependency: received.conversation_dependency } : {}) } : {}) })
      const scope = manifest.content_tree
        ? { region_ids: [], region_intents: [], scope_revision: 0, scope_active: false, authorization: { record_id: received?.record_id ?? record, input_event_id: input.input_event_id, region_ids: treeTargetIds(manifest, received?.content_authority?.region_ids ?? input.region_ids) }, candidate_region_ids: region_ids, ...(input.tree_operations ? { candidate_operations: input.tree_operations } : {}) }
        : { region_ids, region_intents: region_ids.map(region_id => ({ region_id, intent_revision: 1 })), ...(input.tree_operations ? { tree_operations: input.tree_operations } : {}) }
      const update = this.state.start({ task_id: input.task_id, update_id: input.update_id, input_event_id: input.input_event_id, record_id: record, request_id: manifest.request_id, intent_revision: manifest.intent_revision, view_id: input.view_id, base_manifest: manifest, ...scope, dependencies, state: 'queued', text: input.text, model_config_id: input.model_config_id, previous_update_ids: [] })
      this.record(input.task_id, 'chapter.update.started', { update_id: update.update_id, input_event_id: update.input_event_id, view_id: update.view_id, region_ids: update.region_ids })
      return update
    })()
  }

  reconcile(task?: string): void {
    const tasks = task ? [task] : (this.db.prepare('SELECT DISTINCT task_id FROM runner_chapter_updates').all() as { task_id: string }[]).map(row => row.task_id)
    for (const taskId of tasks) for (const update of this.state.updates(taskId)) {
      const publication = update.publication_operation_id ? this.state.publication(taskId, update.publication_operation_id) : null
      if (chapterTerminal.has(update.state) && publication?.operation.state !== 'unknown') continue
      if (publication?.operation.state === 'published') { this.state.stage(taskId, update.update_id, 'succeeded'); continue }
      if (publication?.operation.state === 'unknown') {
        const action = publication.operation.action_id ? this.db.prepare('SELECT state,result,result_json,source_json FROM actions WHERE id=? AND task_id=?').get(publication.operation.action_id, taskId) as Row | undefined : undefined
        if (action?.state === 'ended' && ['failure', 'not_executed', 'cancelled'].includes(action.result)) {
          const result = { action_id: publication.operation.action_id, ...(action.result_json ? JSON.parse(action.result_json) : { code: 'EXECUTION_INTERRUPTED' }) }
          this.db.transaction(() => {
            this.state.publicationStage(taskId, publication.operation.operation_id, action.result === 'cancelled' ? 'cancelled' : 'failure', result)
            const state = new RunnerWorkState(this.db, this.epoch)
            const owner = action.source_json ? JSON.parse(action.source_json).owner : undefined
            const publisher = state.taskWorks(taskId).filter(work => work.purpose === 'production' && work.update_id === update.update_id && work.role === 'lightweight' && work.current_attempt_id).map(work => state.attempt(work.current_attempt_id!)).find(attempt => attempt.profile_id === 'chapter-host-publisher-v1' && (!owner?.attempt_id || attempt.attempt_id === owner.attempt_id))
            let corrected = false
            if (!chapterTerminal.has(update.state) && update.scope_revision !== undefined && publisher?.state === 'unknown' && action.result !== 'cancelled' && !result.denied && isCorrectableContentError(result.code ?? '')) {
              try {
                this.state.releaseScope(taskId, update.update_id, result.code)
                state.updateAttempt({ ...publisher, state: 'running', dispatch_state: 'dispatched' })
                corrected = true
              } catch (error) { if (!(error instanceof ContractError)) throw error }
            }
            if (!corrected) {
              const cancelled = action.result === 'cancelled' || update.state === 'cancelled'
              if (!chapterTerminal.has(update.state)) this.state.stage(taskId, update.update_id, cancelled ? 'cancelled' : 'failed', { reason: result.code ?? 'PUBLICATION_FAILED' })
              if (publisher && !['succeeded', 'failed', 'cancelled', 'revoked'].includes(publisher.state)) state.updateAttempt({ ...publisher, state: cancelled ? 'cancelled' : 'failed', dispatch_state: 'dispatched' })
            }
          })()
        } else if (!chapterTerminal.has(update.state) && update.state !== 'unknown') this.state.stage(taskId, update.update_id, 'unknown')
        continue
      }
      try {
        if (update.scope_revision !== undefined) this.state.assertLive(taskId, update.update_id)
        else this.state.assertCurrent(taskId, update.update_id)
        if (update.source) {
          const run = new RunnerWorkState(this.db, this.epoch).run(update.source.run_id)
          if (run.runtime_epoch === this.epoch && run.commit_valid && ['running', 'waiting'].includes(run.state)) continue
        }
      } catch {}
      if (publication && ['registered', 'dispatched', 'prepared'].includes(publication.operation.state)) {
        const action = publication.operation.action_id ? this.db.prepare('SELECT state,result,result_json FROM actions WHERE id=? AND task_id=?').get(publication.operation.action_id, taskId) as Row | undefined : undefined
        if (publication.operation.state === 'dispatched' && (!action || action.result === 'unknown' || action.state !== 'ended')) {
          this.state.publicationStage(taskId, publication.operation.operation_id, 'unknown')
          this.state.stage(taskId, update.update_id, 'unknown', { reason: 'publication_outcome_unknown' }); continue
        }
        this.state.publicationStage(taskId, publication.operation.operation_id, 'failure', { code: 'EXECUTION_INTERRUPTED' })
      }
      this.state.stage(taskId, update.update_id, 'interrupted', { reason: 'execution_no_longer_current' })
    }
  }
}
