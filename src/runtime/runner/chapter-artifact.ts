import type Database from 'better-sqlite3'
import type { ArtifactCandidate, ArtifactIndex, ChapterInheritance, ChapterManifest, ChapterProposal, ChapterUpdate, ExecutionScope, PublicationEntry, WorkDependency } from '../../shared/contracts.generated'
import defaults from '../../shared/contracts/development-defaults.json'
import { isBundleMediaType } from '../../shared/branding'
import { sameDependencies, validateRunnerContract } from '../../shared/runner-validation'
import { ContractError } from '../../shared/validation'
import { canonical } from '../surface-transition'
import type { RunnerArtifactState } from './artifact-state'
import { ChapterState } from './chapter-state'
import { RunnerPublicationState } from './publication-state'
import { registerRunnerResources } from './resource-references'
import type { RunnerWorkState } from './work-state'
import type { ContentNode } from '../../shared/contracts.generated'
import { ContentTreeState } from './content-tree-state'
import { assertContentAuthority, contentBaselineCurrent, treeChapters } from './content-tree-host'

export interface ChapterAssemblyInstall {
  update: ChapterUpdate
  latestManifest: ChapterManifest
  proposal: ChapterProposal
  publisherOwner: ExecutionScope
  published: {
    operation_id: string; action_id: string; bundle_resource_id: string
    view_id: string; view_revision: number; state_revision: number
    surface_record_id: string; surface_revision: number
  }
  requirement_ids?: string[]
}
export interface ChapterArtifactAssembly {
  update_id: string
  proposal_id: string
  operation_id: string
  previous_artifact_revision: number
  source_manifest_revision: number
  manifest_revision: number
  candidate_id: string
  index: ArtifactIndex
  publisher: ExecutionScope
  published: ChapterAssemblyInstall['published']
  keep: ChapterInheritance[]
  entry: PublicationEntry
  content_tree?: ContentTreeAssemblyEvidence
}
export interface ContentTreeAssemblyEvidence {
  source_tree_revision: number
  tree_revision: number
  retained_nodes: { node_id: string; revision: number; position_revision: number; source_span: ContentNode['span']; span: ContentNode['span'] }[]
  changed_node_ids: string[]
  retired_node_ids: string[]
}
type Row = { payload_json: string }
type MaterialDependency = Extract<WorkDependency, { kind: 'resource' }>
function fail(code: string, message: string): never { throw new ContractError(code, message) }
const equal = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right)
const sameGoal = (left: { task_id: string; request_id: string; intent_revision: number }, right: { task_id: string; request_id: string; intent_revision: number }): boolean => left.task_id === right.task_id && left.request_id === right.request_id && left.intent_revision === right.intent_revision
const regionContent = ({ title_selector: _title, body_selector: _body, ...content }: ChapterManifest['chapters'][number]) => content
const updateBinding = ({ state: _state, source: _source, proposal_id: _proposal, publication_operation_id: _operation, action_id: _action, reason: _reason, ...binding }: ChapterUpdate) => binding

/** Durable host assembly evidence grants readability, never execution authority. */
export class ChapterArtifactState {
  constructor(private readonly db: Database.Database, private readonly work: RunnerWorkState, private readonly artifacts: RunnerArtifactState) {}

  private installed(): boolean { return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runner_chapter_assemblies'").get() }
  record(task: string, artifact: string, revision: number): ChapterArtifactAssembly | null {
    if (!this.installed()) return null
    const row = this.db.prepare('SELECT payload_json FROM runner_chapter_assemblies WHERE task_id=? AND artifact_id=? AND artifact_revision=?').get(task, artifact, revision) as Row | undefined
    if (!row) return null
    const value = JSON.parse(row.payload_json) as ChapterArtifactAssembly
    validateRunnerContract('runner_artifact_index', value.index)
    validateRunnerContract('runner_publication_entry', value.entry)
    if (value.index.task_id !== task || value.index.artifact_id !== artifact || value.index.artifact_revision !== revision || value.previous_artifact_revision !== revision - 1 || value.entry.artifact_id !== artifact || value.entry.artifact_revision !== revision || value.entry.chapter_update_id !== value.update_id || value.entry.chapter_operation_id !== value.operation_id) fail('RUNNER_DEPENDENCY_INVALID', 'Chapter assembly evidence is inconsistent')
    return value
  }

  private resource(task: string, resource: string): void {
    const row = this.db.prepare('SELECT r.byte_length,r.media_type FROM resources r JOIN task_resources t ON t.resource_id=r.id WHERE t.task_id=? AND r.id=?').get(task, resource) as { byte_length: number; media_type: string } | undefined
    if (!row || !Number.isSafeInteger(row.byte_length) || row.byte_length < 0 || row.byte_length > defaults.surface.inline_bundle_bytes || row.media_type !== 'application/json' && !isBundleMediaType(row.media_type)) fail('INVALID_BUNDLE_SOURCE', 'Host assembly requires a bounded same-Task Bundle resource')
  }

  private accepted(index: ArtifactIndex): ArtifactCandidate {
    const row = this.db.prepare('SELECT candidate_id FROM runner_artifacts WHERE task_id=? AND artifact_id=? AND artifact_revision=?').get(index.task_id, index.artifact_id, index.artifact_revision) as { candidate_id: string } | undefined
    const record = row && this.artifacts.candidate(index.task_id, row.candidate_id)
    if (!record || record.result.state !== 'accepted' || !equal(record.result.index, index) || !equal(this.artifacts.artifact(index.task_id, index.artifact_id, index.artifact_revision), index)) fail('RUNNER_DEPENDENCY_INVALID', 'Chapter materials require their exact accepted artifact source')
    const { candidate_id: _candidate, base_artifact_revision, plan_revision: _plan, section_position_revision: _position, dependencies: _dependencies, requirement_ids: _requirements, unresolved: _unresolved, ...metadata } = record.candidate
    if (!equal({ ...metadata, artifact_revision: base_artifact_revision + 1, acceptance_state: 'accepted' }, index)) fail('RUNNER_DEPENDENCY_INVALID', 'Accepted artifact metadata lost its original candidate binding')
    this.resource(index.task_id, index.bundle_resource_id)
    return record.candidate
  }

  private contentEvidence(update: ChapterUpdate, baseline: ChapterManifest, manifest: ChapterManifest, proposal: ChapterProposal): ContentTreeAssemblyEvidence {
    const before = baseline.content_tree, after = manifest.content_tree, operations = proposal.tree_operations
    if (!before || !after || !operations?.length || after.revision !== before.revision + 1 || !contentBaselineCurrent(update, baseline)) fail('RUNNER_OUTPUT_INCOMPLETE', 'Content assembly requires exact current structural baselines')
    assertContentAuthority(update, operations)
    const trees = new ContentTreeState(this.db), oldSnapshot = trees.snapshot(update.task_id, baseline.view_id, before.revision), snapshot = trees.snapshot(update.task_id, manifest.view_id, after.revision)
    if (!oldSnapshot || !snapshot || !equal(oldSnapshot.tree, before) || !equal(snapshot.tree, after) || oldSnapshot.bundle_resource_id !== baseline.bundle_resource_id || oldSnapshot.view_revision !== baseline.view_revision || oldSnapshot.state_revision !== baseline.state_revision || snapshot.bundle_resource_id !== manifest.bundle_resource_id || snapshot.view_revision !== manifest.view_revision || snapshot.state_revision !== manifest.state_revision || !equal(manifest.chapters, treeChapters(after, baseline.chapters))) fail('RUNNER_OUTPUT_INCOMPLETE', 'Content assembly lost its exact installed tree and chapter projection')
    const previous = new Map(before.nodes.map(node => [node.node_id, node])), current = new Map(after.nodes.map(node => [node.node_id, node]))
    const mutable = new Set<string>(), ancestors = new Set<string>(), moved = new Set<string>()
    const ascend = (id: string | null): void => {
      while (id !== null) {
        const node = previous.get(id)
        if (!node) fail('RUNNER_OUTPUT_INCOMPLETE', 'Content operation lost its source container')
        ancestors.add(id); id = node.parent_id
      }
    }
    for (const operation of operations) {
      if (operation.type === 'replace' || operation.type === 'delete') for (const id of operation.node_ids) {
        const node = previous.get(id)
        if (!node) fail('RUNNER_OUTPUT_INCOMPLETE', 'Content operation lost its selected source')
        ascend(node.parent_id)
        const pending = [id]
        while (pending.length) { const child = pending.pop()!; mutable.add(child); pending.push(...previous.get(child)!.children) }
      }
      if (operation.type === 'move') {
        const node = previous.get(operation.node_ids[0]!)
        if (!node) fail('RUNNER_OUTPUT_INCOMPLETE', 'Content move lost its selected source')
        moved.add(node.node_id); ascend(node.parent_id)
      }
      if ('parent_id' in operation) ascend(operation.parent_id)
    }
    const retained: ContentTreeAssemblyEvidence['retained_nodes'] = []
    for (const node of before.nodes) {
      const next = current.get(node.node_id)
      if (mutable.has(node.node_id)) {
        if (next && (next.revision < node.revision || next.revision > node.revision + 1 || next.position_revision !== node.position_revision)) fail('RUNNER_OUTPUT_INCOMPLETE', 'Replaced content has inconsistent node versions')
        continue
      }
      if (!next || next.kind !== node.kind || next.tag !== node.tag || next.title !== node.title || next.revision !== node.revision + (ancestors.has(node.node_id) ? 1 : 0) || next.position_revision !== node.position_revision + (moved.has(node.node_id) ? 1 : 0) || !moved.has(node.node_id) && next.parent_id !== node.parent_id || !ancestors.has(node.node_id) && !equal(next.children, node.children)) fail('RUNNER_OUTPUT_INCOMPLETE', 'Content assembly must preserve every unaffected node and version')
      if (!ancestors.has(node.node_id)) {
        if (next.span.end - next.span.start !== node.span.end - node.span.start || next.inner_span.start - next.span.start !== node.inner_span.start - node.span.start || next.inner_span.end - next.span.start !== node.inner_span.end - node.span.start) fail('RUNNER_OUTPUT_INCOMPLETE', 'Retained content must preserve its exact source range length')
        retained.push({ node_id: node.node_id, revision: node.revision, position_revision: next.position_revision, source_span: node.span, span: next.span })
      }
    }
    for (const node of after.nodes) if (!previous.has(node.node_id) && (node.revision !== 1 || node.position_revision !== 1)) fail('RUNNER_OUTPUT_INCOMPLETE', 'New content starts with a new node identity and version')
    return {
      source_tree_revision: before.revision, tree_revision: after.revision, retained_nodes: retained,
      changed_node_ids: after.nodes.filter(node => { const old = previous.get(node.node_id); return !old || old.revision !== node.revision || old.position_revision !== node.position_revision }).map(node => node.node_id),
      retired_node_ids: before.nodes.filter(node => !current.has(node.node_id)).map(node => node.node_id)
    }
  }

  private materials(task: string, dependencies: WorkDependency[], checking: Set<string>): MaterialDependency[] {
    const result = new Map<string, MaterialDependency>()
    for (const dependency of dependencies) {
      if (dependency.task_id !== task) fail('RUNNER_DEPENDENCY_INVALID', 'Chapter material dependencies must stay in the same Task')
      let materials: MaterialDependency[] = []
      if (dependency.kind === 'resource') {
        if (!this.db.prepare('SELECT 1 FROM task_resources t JOIN resources r ON r.id=t.resource_id WHERE t.task_id=? AND r.id=?').get(task, dependency.resource_id)) fail('RUNNER_DEPENDENCY_INVALID', 'Chapter publication lost an actual material dependency')
        materials = [{ ...dependency }]
      } else if (dependency.kind === 'artifact') {
        const index = this.artifacts.artifact(task, dependency.artifact_id, dependency.artifact_revision)
        if (!index) fail('RUNNER_DEPENDENCY_INVALID', 'Chapter material artifact source no longer exists')
        materials = this.materialDependencies(index, checking)
      } else if (dependency.kind === 'work') {
        const key = `work:${JSON.stringify([task, dependency.work_id, dependency.result_revision])}`
        if (checking.has(key)) fail('RUNNER_DEPENDENCY_CYCLE', 'Chapter material dependencies must form a DAG')
        const work = this.work.work(dependency.work_id), attempt = work.current_attempt_id && this.work.attempt(work.current_attempt_id)
        if (work.task_id !== task || work.result_revision !== dependency.result_revision || !attempt || attempt.task_id !== task || attempt.work_id !== work.work_id || attempt.run_id !== work.run_id || !attempt.result_ref || !sameDependencies(work.dependencies, attempt.input_versions)) fail('RUNNER_DEPENDENCY_INVALID', 'Chapter materials lost their exact Work result source')
        checking.add(key)
        materials = this.materials(task, attempt.input_versions, checking)
        checking.delete(key)
      }
      for (const material of materials) result.set(material.resource_id, material)
    }
    return [...result.values()]
  }

  materialDependencies(index: ArtifactIndex, checking = new Set<string>()): MaterialDependency[] {
    const key = `artifact:${JSON.stringify([index.task_id, index.artifact_id, index.artifact_revision])}`
    if (checking.has(key)) fail('RUNNER_DEPENDENCY_CYCLE', 'Chapter material dependencies must form a DAG')
    const candidate = this.accepted(index), assembly = this.record(index.task_id, index.artifact_id, index.artifact_revision)
    checking.add(key)
    if (assembly) {
      if (!equal(assembly.index, index) || assembly.candidate_id !== candidate.candidate_id) fail('RUNNER_DEPENDENCY_INVALID', 'Chapter assembly lost its exact accepted candidate')
      const materials = this.source(assembly, checking).materials
      checking.delete(key)
      return materials
    }
    const work = this.work.work(index.work_id), attempt = this.work.attempt(index.attempt_id), run = this.work.run(index.run_id)
    if (work.purpose !== 'production' || attempt.purpose !== 'production' || run.purpose !== 'production' || !sameGoal(index, work) || !sameGoal(index, attempt) || !sameGoal(index, run) || work.run_id !== index.run_id || work.current_attempt_id !== index.attempt_id || work.plan_revision !== candidate.plan_revision || attempt.work_id !== index.work_id || attempt.run_id !== index.run_id || attempt.dispatch_state !== 'dispatched' || work.update_id !== undefined || attempt.update_id !== undefined || run.update_id !== undefined || !sameDependencies(candidate.dependencies, work.dependencies) || !sameDependencies(candidate.dependencies, attempt.input_versions)) fail('RUNNER_DEPENDENCY_INVALID', 'Chapter materials lost their original production source')
    const materials = this.materials(index.task_id, attempt.input_versions, checking)
    checking.delete(key)
    return materials
  }

  private source(assembly: ChapterArtifactAssembly, checking = new Set<string>()): { state: ChapterState; manifest: ChapterManifest; materials: MaterialDependency[] } {
    const state = new ChapterState(this.db), index = assembly.index
    const update = state.update(index.task_id, assembly.update_id), publication = state.publication(index.task_id, assembly.operation_id)
    const manifest = state.manifest(index.task_id, assembly.entry.view_id, assembly.manifest_revision)
    const proposal = state.proposal(index.task_id, assembly.proposal_id)
    const publisher = assembly.publisher, attempt = this.work.attempt(publisher.attempt_id), work = this.work.work(publisher.work_id), run = this.work.run(publisher.run_id)
    if (!update || update.state !== 'succeeded' || update.publication_operation_id !== assembly.operation_id || update.proposal_id !== assembly.proposal_id || !publication || publication.operation.state !== 'published' || publication.operation.update_id !== update.update_id || publication.operation.proposal_id !== assembly.proposal_id || !proposal || !manifest || !sameGoal(index, update) || !sameGoal(index, manifest) || manifest.artifact_id !== index.artifact_id || manifest.artifact_revision !== index.artifact_revision || manifest.bundle_resource_id !== index.bundle_resource_id || manifest.view_revision !== assembly.entry.view_revision || manifest.state_revision !== assembly.entry.state_revision) fail('RUNNER_DEPENDENCY_INVALID', 'Chapter artifact requires its exact successful publication and installed manifest')
    // Publication is the settled source. A finished Run need not regain a lease
    // or survive dependency reconciliation as an executable producer.
    if (publisher.purpose !== 'production' || publisher.update_id !== update.update_id || publisher.role !== 'lightweight' || !sameGoal(index, publisher) || index.run_id !== publisher.run_id || index.work_id !== publisher.work_id || index.attempt_id !== publisher.attempt_id || work.purpose !== 'production' || attempt.purpose !== 'production' || run.purpose !== 'production' || work.update_id !== update.update_id || attempt.update_id !== update.update_id || run.update_id !== update.update_id || work.task_id !== index.task_id || work.run_id !== publisher.run_id || work.role !== publisher.role || attempt.work_id !== publisher.work_id || attempt.run_id !== publisher.run_id || attempt.profile_id !== 'chapter-host-publisher-v1' || attempt.dispatch_state !== 'dispatched' || attempt.result_ref?.task_id !== index.task_id || attempt.result_ref.kind !== 'record' || attempt.result_ref.id !== assembly.published.surface_record_id || !sameGoal(index, work) || !sameGoal(index, attempt) || !sameGoal(index, run)) fail('RUNNER_DEPENDENCY_INVALID', 'Chapter publication lost its exact host publisher source')
    const previous = this.artifacts.artifact(index.task_id, index.artifact_id, assembly.previous_artifact_revision), baseline = state.manifest(index.task_id, assembly.entry.view_id, assembly.source_manifest_revision)
    const mapping = previous && new RunnerPublicationState(this.db).mapping(index.task_id, index.artifact_id, previous.artifact_revision)
    // Ordinary indexes retain the source; chapter indexes retain the installed Bundle.
    const mappedArtifactResource = mapping && ('chapter_update_id' in mapping ? mapping.published_bundle_resource_id : mapping.source_bundle_resource_id)
    if (!previous || !sameGoal(index, previous) || !baseline || !sameGoal(previous, baseline) || baseline.artifact_id !== previous.artifact_id || baseline.artifact_revision !== previous.artifact_revision || !mapping || !sameGoal(previous, mapping) || mapping.view_id !== baseline.view_id || mapping.view_revision !== baseline.view_revision || mappedArtifactResource !== previous.bundle_resource_id || mapping.published_bundle_resource_id !== baseline.bundle_resource_id || !this.db.prepare('SELECT 1 FROM view_history WHERE task_id=? AND view_id=? AND view_revision=? AND bundle_resource_id=?').get(index.task_id, baseline.view_id, baseline.view_revision, baseline.bundle_resource_id)) fail('RUNNER_DEPENDENCY_INVALID', 'Chapter inheritance lost its exact previous artifact and published manifest')
    if (proposal.tree_operations ? !equal(assembly.content_tree, this.contentEvidence(update, baseline, manifest, proposal)) : assembly.content_tree !== undefined) fail('RUNNER_DEPENDENCY_INVALID', 'Content assembly lost its frozen structural inheritance evidence')
    this.resource(index.task_id, baseline.bundle_resource_id)
    const materials = [...new Map([...this.materialDependencies(previous, checking), ...this.materials(index.task_id, attempt.input_versions, checking)].map(material => [material.resource_id, material])).values()]
    this.resource(index.task_id, index.bundle_resource_id)
    return { state, manifest, materials }
  }

  check(index: ArtifactIndex): ArtifactCandidate | null {
    const assembly = this.record(index.task_id, index.artifact_id, index.artifact_revision)
    if (!assembly) return null
    if (!equal(assembly.index, index)) fail('RUNNER_DEPENDENCY_INVALID', 'Chapter assembly cannot change its installed artifact')
    const { state, manifest } = this.source(assembly), current = state.manifest(index.task_id, manifest.view_id)
    const owner = this.artifacts.owner(index.task_id, index.artifact_id), goal = this.work.goal(index.request_id)
    const view = this.db.prepare('SELECT v.revision,v.bundle_resource_id FROM views v JOIN surfaces s ON s.id=v.surface_id WHERE s.task_id=? AND v.id=?').get(index.task_id, manifest.view_id) as { revision: number; bundle_resource_id: string } | undefined
    if (!sameGoal(index, goal) || goal.state !== 'active' || owner?.current_revision !== index.artifact_revision || owner.work_id !== index.work_id || current?.manifest_revision !== manifest.manifest_revision || !view || view.revision !== manifest.view_revision || view.bundle_resource_id !== manifest.bundle_resource_id || assembly.keep.some(keep => !keep.valid || keep.dependencies.some(dependency => !state.dependencyCurrent(dependency))) || manifest.chapters.some(chapter => chapter.dependencies.some(dependency => !state.dependencyCurrent(dependency)))) fail('RUNNER_DEPENDENCY_INVALID', 'Chapter artifact or an explicitly inherited contribution is no longer current')
    const candidate = this.artifacts.candidate(index.task_id, assembly.candidate_id)
    if (!candidate || candidate.result.state !== 'accepted' || !equal(candidate.result.index, index)) fail('RUNNER_DEPENDENCY_INVALID', 'Chapter assembly lost its accepted artifact record')
    return candidate.candidate
  }

  resolve(original: ArtifactIndex): ArtifactIndex | null {
    const current = this.artifacts.artifact(original.task_id, original.artifact_id)
    if (!current || current.artifact_revision <= original.artifact_revision) return null
    this.check(current) ?? fail('RUNNER_DEPENDENCY_INVALID', 'An artifact takeover needs explicit chapter assembly lineage')
    this.accepted(original)
    let revision = current.artifact_revision
    while (revision > original.artifact_revision) {
      const assembly = this.record(original.task_id, original.artifact_id, revision)
      if (!assembly) fail('RUNNER_DEPENDENCY_INVALID', 'Chapter inheritance cannot skip an accepted artifact source')
      revision = assembly.previous_artifact_revision
    }
    return revision === original.artifact_revision && sameGoal(current, original) ? current : null
  }

  install(input: ChapterAssemblyInstall): ArtifactIndex {
    if (!this.db.inTransaction) fail('RUNNER_TRANSACTION_REQUIRED', 'Chapter artifact installation must join the final Surface transaction')
    const { update: rawUpdate, latestManifest, proposal: rawProposal, published } = input
    const state = new ChapterState(this.db), update = state.update(rawUpdate.task_id, rawUpdate.update_id), proposal = state.proposal(rawProposal.task_id, rawProposal.proposal_id)
    const publisher = validateRunnerContract('runner_execution_scope', input.publisherOwner)
    if (!update || !proposal || !equal(proposal, rawProposal) || !equal(updateBinding(update), updateBinding(rawUpdate)) || latestManifest.artifact_id === undefined || latestManifest.artifact_revision === undefined) fail('RUNNER_OWNERSHIP_INVALID', 'Chapter installation requires its persisted update, proposal and artifact baseline')
    const repeated = this.db.prepare('SELECT artifact_id,artifact_revision FROM runner_chapter_assemblies WHERE task_id=? AND operation_id=?').get(update.task_id, published.operation_id) as { artifact_id: string; artifact_revision: number } | undefined
    if (repeated) {
      const assembly = this.record(update.task_id, repeated.artifact_id, repeated.artifact_revision)!
      const baseline = state.manifest(update.task_id, update.view_id, assembly.source_manifest_revision)
      const coverage = this.artifacts.candidate(update.task_id, assembly.candidate_id)!.candidate.requirement_ids
      if (assembly.update_id !== update.update_id || assembly.proposal_id !== proposal.proposal_id || !equal(assembly.publisher, publisher) || !equal(assembly.published, published) || !equal(baseline, latestManifest) || input.requirement_ids && !equal([...input.requirement_ids].sort(), [...coverage].sort())) fail('RUNNER_ARTIFACT_CONFLICT', 'A published chapter assembly retains its original binding')
      return assembly.index
    }
    const previous = this.artifacts.artifact(update.task_id, latestManifest.artifact_id, latestManifest.artifact_revision), owner = this.artifacts.owner(update.task_id, latestManifest.artifact_id)
    const manifest = state.manifest(update.task_id, update.view_id), oldManifest = state.manifest(update.task_id, update.view_id, latestManifest.manifest_revision)
    const operation = state.publication(update.task_id, published.operation_id)
    if (!previous || !owner || owner.current_revision !== previous.artifact_revision || !sameGoal(previous, update) || !oldManifest || !equal(oldManifest, latestManifest) || !manifest || manifest.manifest_revision !== latestManifest.manifest_revision + 1 || manifest.artifact_id !== previous.artifact_id || manifest.artifact_revision !== previous.artifact_revision + 1 || manifest.shared_revision !== latestManifest.shared_revision || manifest.view_id !== published.view_id || manifest.view_revision !== published.view_revision || manifest.state_revision !== published.state_revision || manifest.bundle_resource_id !== published.bundle_resource_id || !operation || operation.operation.action_id !== published.action_id || operation.operation.expected_view_revision !== latestManifest.view_revision || operation.operation.base_manifest_revision !== latestManifest.manifest_revision) fail('RUNNER_ARTIFACT_CONFLICT', 'Host assembly must install the exact next artifact and published View')
    const previousCandidate = this.db.prepare('SELECT candidate_id FROM runner_artifacts WHERE task_id=? AND artifact_id=? AND artifact_revision=?').get(update.task_id, previous.artifact_id, previous.artifact_revision) as { candidate_id: string }
    const coverage = this.artifacts.candidate(update.task_id, previousCandidate.candidate_id)!.candidate.requirement_ids
    const replaced = proposal.replacements.flatMap(group => group.previous_region_ids), next = proposal.replacements.flatMap(group => group.chapters), keep = state.inheritance(update.task_id, update.update_id)
    const structural = proposal.tree_operations ? this.contentEvidence(update, latestManifest, manifest, proposal) : undefined
    const retained = latestManifest.chapters.filter(chapter => structural ? manifest.content_tree!.nodes.some(node => node.node_id === chapter.region_id && node.revision === chapter.revision) : !replaced.includes(chapter.region_id))
    if (!structural && (!equal([...replaced].sort(), [...update.region_ids].sort()) || manifest.chapters.length !== retained.length + next.length || next.some(chapter => !manifest.chapters.some(current => equal(regionContent(current), regionContent(chapter))))) || retained.length !== keep.length || retained.some(chapter => !structural && !manifest.chapters.some(current => equal(regionContent(current), regionContent(chapter))) || !keep.some(item => item.region_id === chapter.region_id && item.region_revision === chapter.revision && item.view_id === latestManifest.view_id && sameGoal(item, update) && item.artifact_id === previous.artifact_id && item.artifact_revision === previous.artifact_revision && item.source_manifest_revision === latestManifest.manifest_revision && item.source_bundle_resource_id === latestManifest.bundle_resource_id && equal([...item.requirement_ids].sort(), [...coverage].sort()) && sameDependencies(item.dependencies, chapter.dependencies)))) fail('RUNNER_OUTPUT_INCOMPLETE', 'Host assembly must enumerate every replacement and exact inherited chapter')
    const pubWork = this.work.work(publisher.work_id), attempt = this.work.attempt(publisher.attempt_id), run = this.work.run(publisher.run_id)
    if (pubWork.current_attempt_id !== publisher.attempt_id || pubWork.state !== 'succeeded' || attempt.state !== 'succeeded' || !attempt.result_ref || run.runtime_epoch !== this.work.epoch || attempt.runtime_epoch !== this.work.epoch || !run.commit_valid || !['running', 'waiting'].includes(run.state) || publisher.work_id === proposal.source.work_id) fail('RUNNER_OWNERSHIP_INVALID', 'A new successful host publisher must install the assembled artifact')
    const action = this.db.prepare('SELECT task_id,run_id,state,result,commit_valid,source_json,request_json FROM actions WHERE id=?').get(published.action_id) as { task_id: string; run_id: string; state: string; result: string | null; commit_valid: number; source_json: string; request_json: string } | undefined
    const record = this.db.prepare("SELECT payload_json FROM records WHERE task_id=? AND id=? AND kind='surface.published'").get(update.task_id, published.surface_record_id) as Row | undefined
    const payload = record ? JSON.parse(record.payload_json) : null
    if (!action || action.task_id !== update.task_id || action.run_id !== publisher.run_id || !equal(JSON.parse(action.source_json).owner, publisher) || operation.operation.request.type !== 'write' || !equal(JSON.parse(action.request_json), operation.operation.request.input) || (action.state === 'ended' ? action.result !== 'success' : action.commit_valid !== 1) || !payload || payload.action_id !== published.action_id || payload.revision !== published.surface_revision) fail('RUNNER_PROVENANCE_INVALID', 'Chapter assembly requires the actual host Surface publication')
    const section = this.artifacts.outline(update.task_id)?.sections.find(item => item.section_id === previous.section_id)
    if (!section || section.request_id !== update.request_id || section.intent_revision !== update.intent_revision || input.requirement_ids && !equal([...input.requirement_ids].sort(), [...coverage].sort())) fail('RUNNER_OWNERSHIP_INVALID', 'Chapter assembly preserves the original accepted requirement coverage')
    const index = validateRunnerContract('runner_artifact_index', { ...previous, run_id: publisher.run_id, work_id: publisher.work_id, attempt_id: publisher.attempt_id, artifact_revision: previous.artifact_revision + 1, bundle_resource_id: published.bundle_resource_id, provenance_ref: { task_id: update.task_id, kind: 'action', id: published.action_id } })
    const { acceptance_state: _accepted, artifact_revision: _revision, ...metadata } = index
    const candidate = validateRunnerContract('runner_artifact_candidate', { ...metadata, candidate_id: `chapter-assembly:${published.operation_id}`, base_artifact_revision: previous.artifact_revision, plan_revision: pubWork.plan_revision, section_position_revision: section.position_revision, dependencies: proposal.dependencies, requirement_ids: coverage, unresolved: [] })
    const surface = this.db.prepare('SELECT s.id,s.revision,s.layout_json,v.revision view_revision,v.state_revision,v.bundle_resource_id FROM views v JOIN surfaces s ON s.id=v.surface_id WHERE s.task_id=? AND v.id=?').get(update.task_id, published.view_id) as { id: string; revision: number; layout_json: string; view_revision: number; state_revision: number; bundle_resource_id: string } | undefined
    if (!surface || surface.revision !== published.surface_revision || surface.view_revision !== published.view_revision || surface.state_revision !== published.state_revision || surface.bundle_resource_id !== published.bundle_resource_id) fail('RUNNER_ARTIFACT_CONFLICT', 'Chapter artifact must point to the actual committed content')
    const entry = validateRunnerContract('runner_publication_entry', { task_id: update.task_id, chapter_update_id: update.update_id, chapter_operation_id: published.operation_id, artifact_id: index.artifact_id, artifact_revision: index.artifact_revision, request_id: update.request_id, intent_revision: update.intent_revision, section_id: index.section_id, view_id: published.view_id, view_revision: published.view_revision, state_revision: published.state_revision, source_bundle_resource_id: operation.operation.assembled_bundle_resource_id, published_bundle_resource_id: published.bundle_resource_id, surface_history_id: `chapter-history:${published.operation_id}` })
    const assembly: ChapterArtifactAssembly = { update_id: update.update_id, proposal_id: proposal.proposal_id, operation_id: published.operation_id, previous_artifact_revision: previous.artifact_revision, source_manifest_revision: latestManifest.manifest_revision, manifest_revision: manifest.manifest_revision, candidate_id: candidate.candidate_id, index, publisher, published, keep, entry, ...(structural ? { content_tree: structural } : {}) }
    this.source(assembly)
    const historyViews = this.db.prepare('SELECT v.id view_id,v.revision view_revision,v.state_revision,v.bundle_resource_id,h.id view_history_id FROM views v LEFT JOIN view_history h ON h.view_id=v.id AND h.view_revision=v.revision AND h.task_id=? AND h.bundle_resource_id=v.bundle_resource_id WHERE v.surface_id=? ORDER BY v.id').all(update.task_id, surface.id) as { view_id: string; view_revision: number; state_revision: number; bundle_resource_id: string; view_history_id: string | null }[]
    const layout = JSON.parse(surface.layout_json), visible: string[] = layout.slots.flatMap((slot: { groups: { views: string[] }[] }) => slot.groups.flatMap(group => group.views))
    if (new Set(visible).size !== visible.length || visible.length !== historyViews.length || historyViews.some(view => !view.view_history_id || !visible.includes(view.view_id))) fail('RUNNER_PROVENANCE_INVALID', 'Chapter publication requires the full exact Surface history')
    this.db.prepare('INSERT INTO runner_candidates(candidate_id,task_id,artifact_id,payload_json,result_json) VALUES (?,?,?,?,?)').run(candidate.candidate_id, update.task_id, index.artifact_id, JSON.stringify(candidate), JSON.stringify({ state: 'accepted', index }))
    this.db.prepare('INSERT INTO runner_artifacts(task_id,artifact_id,artifact_revision,candidate_id,bundle_resource_id,payload_json) VALUES (?,?,?,?,?,?)').run(update.task_id, index.artifact_id, index.artifact_revision, candidate.candidate_id, index.bundle_resource_id, JSON.stringify(index))
    const installed = this.db.prepare('UPDATE runner_artifact_owners SET work_id=?,plan_revision=?,current_revision=? WHERE task_id=? AND artifact_id=? AND current_revision=? AND work_id=? AND plan_revision=?').run(publisher.work_id, pubWork.plan_revision, index.artifact_revision, update.task_id, index.artifact_id, previous.artifact_revision, owner.work_id, owner.plan_revision)
    if (installed.changes !== 1) fail('RUNNER_ARTIFACT_CONFLICT', 'Chapter assembly lost the current artifact pointer')
    this.db.prepare('INSERT INTO runner_chapter_assemblies(task_id,artifact_id,artifact_revision,update_id,operation_id,payload_json) VALUES (?,?,?,?,?,?)').run(update.task_id, index.artifact_id, index.artifact_revision, update.update_id, published.operation_id, JSON.stringify(assembly))
    const history = { surface_history_id: entry.surface_history_id, task_id: update.task_id, surface_id: surface.id, surface_revision: surface.revision, action_id: published.action_id, layout, views: historyViews.map(({ bundle_resource_id: _bundle, ...view }) => view) }
    this.db.prepare('INSERT INTO runner_surface_history(surface_history_id,task_id,surface_id,surface_revision,action_id,payload_json) VALUES (?,?,?,?,?,?)').run(entry.surface_history_id, update.task_id, surface.id, surface.revision, published.action_id, JSON.stringify(history))
    registerRunnerResources(this.db, update.task_id, 'runner_surface_history', entry.surface_history_id, historyViews.map(view => view.bundle_resource_id))
    registerRunnerResources(this.db, update.task_id, 'runner_artifact', JSON.stringify([index.artifact_id, index.artifact_revision]), [index.bundle_resource_id, operation.operation.assembled_bundle_resource_id, latestManifest.bundle_resource_id, proposal.bundle_resource_id, ...keep.map(item => item.source_bundle_resource_id)])
    return index
  }
}
