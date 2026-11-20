import type {
  ArtifactCandidate, ArtifactIndex, ChapterDependency, ChapterInheritance, ChapterIntent, ChapterManifest, ChapterOwnership, ChapterProposal, ChapterPublication, ChapterRegion, ChapterReplacement, ChapterUpdate, CompositionBatch, CompositionScope, ConsumptionStage, ContributionInventory, ContributionInventoryRef, DeliveryQuery, DeliveryRecord,
  ExecutionAttempt, ExecutionScope, GoalRevision, InputEvent, LogicalWork, Outline, OutlineSection, OutcomeRequirement,
  PresentationPlan, PublicationEntry, PublicationManifest, RunnerRun, WorkDependency, WorkOutputDeclaration
} from './contracts.generated'
import { assertContract, ContractError } from './validation'
import { assertIndexBytes, assertIndexTitle, assertRunnerId } from '../runtime/runner/limits'
import type { ContentAuthorization, ContentScopeRevision, ContentLineage, ContentNode, ContentOperation, ContentOperationPlan, ContentTree } from './contracts.generated'

export interface RunnerContractTypes {
  runner_input_event: InputEvent
  runner_consumption_stage: ConsumptionStage
  runner_outcome_requirement: OutcomeRequirement
  runner_goal_revision: GoalRevision
  runner_work_dependency: WorkDependency
  runner_run: RunnerRun
  runner_logical_work: LogicalWork
  runner_execution_attempt: ExecutionAttempt
  runner_execution_scope: ExecutionScope
  runner_outline: Outline
  runner_outline_section: OutlineSection
  runner_artifact_index: ArtifactIndex
  runner_artifact_candidate: ArtifactCandidate
  runner_work_output_declaration: WorkOutputDeclaration
  runner_contribution_inventory: ContributionInventory
  runner_contribution_inventory_ref: ContributionInventoryRef
  runner_presentation_plan: PresentationPlan
  runner_composition_scope: CompositionScope
  runner_composition_batch: CompositionBatch
  runner_delivery_record: DeliveryRecord
  runner_delivery_query: DeliveryQuery
  runner_publication_manifest: PublicationManifest
  runner_publication_entry: PublicationEntry
  runner_chapter_dependency: ChapterDependency
  runner_chapter_ownership: ChapterOwnership
  runner_chapter_region: ChapterRegion
  runner_chapter_manifest: ChapterManifest
  runner_chapter_intent: ChapterIntent
  runner_chapter_update: ChapterUpdate
  runner_chapter_replacement: ChapterReplacement
  runner_chapter_proposal: ChapterProposal
  runner_chapter_inheritance: ChapterInheritance
  runner_chapter_publication: ChapterPublication
  runner_content_tree: ContentTree
  runner_content_node: ContentNode
  runner_content_lineage: ContentLineage
  runner_content_operation: ContentOperation
  runner_content_operation_plan: ContentOperationPlan
  runner_content_authorization: ContentAuthorization
  runner_content_scope_revision: ContentScopeRevision
}

function invalid(message: string): never { throw new ContractError('INVALID_RUNNER_CONTRACT', message) }
function ownership(): never { throw new ContractError('RUNNER_OWNERSHIP_INVALID', 'Execution source, task, goal or exact input version is no longer valid') }
const unique = (values: string[], field: string): void => { if (new Set(values).size !== values.length) invalid(`Duplicate ${field}`) }

type GoalIdentity = Pick<GoalRevision, 'task_id' | 'request_id' | 'intent_revision'>
function sameGoal(owner: GoalIdentity, reference: GoalIdentity): void {
  if (owner.task_id !== reference.task_id || owner.request_id !== reference.request_id || owner.intent_revision !== reference.intent_revision) ownership()
}

function outputDeclaration(output: WorkOutputDeclaration): void {
  unique(output.artifacts.map(artifact => artifact.artifact_id), 'output artifacts')
  unique(output.requirement_ids, 'output requirements')
  unique(output.unresolved.map(item => item.requirement_id), 'unresolved output requirements')
  for (const item of output.unresolved) sameGoal(output, item)
}

function contributionInventory(inventory: ContributionInventory): void {
  unique(inventory.required_works.map(work => work.work_id), 'inventory work')
  unique(inventory.required_works.flatMap(work => work.artifacts.map(artifact => artifact.artifact_id)), 'inventory artifacts')
  unique(inventory.unresolved.map(item => item.requirement_id), 'unresolved inventory requirements')
  if (inventory.previous_revision !== undefined && inventory.previous_revision >= inventory.inventory_revision) invalid('Contribution inventory revision must advance its predecessor')
  const covered = new Set(inventory.required_works.flatMap(work => work.requirement_ids))
  const unresolved = new Set(inventory.unresolved.map(item => item.requirement_id))
  for (const work of inventory.required_works) {
    sameGoal(inventory, work)
    outputDeclaration(work)
    if (work.unresolved.some(item => !unresolved.has(item.requirement_id))) invalid('Inventory cannot omit unresolved work requirements')
    if (work.work_id === inventory.sealed_by.work_id && (work.run_id !== inventory.sealed_by.run_id || work.attempt_id !== inventory.sealed_by.attempt_id || work.plan_revision !== inventory.sealed_by.plan_revision)) ownership()
  }
  for (const item of inventory.unresolved) sameGoal(inventory, item)
  if (inventory.requirement_ids.some(id => !covered.has(id))) invalid('Inventory coverage must reference declared work requirements')
}

function fields(value: unknown, key = '', task?: string): void {
  if (Array.isArray(value)) {
    for (const item of value) fields(item, key.endsWith('_ids') ? key.slice(0, -1) : '', task)
  } else if (value && typeof value === 'object') {
    for (const [name, item] of Object.entries(value)) fields(item, name, task)
  } else {
    if (key === 'parent_id' && value === null) return
    if (key === 'id' || key.endsWith('_id') || key === 'order_key' || key === 'runtime_epoch') assertRunnerId(value, key)
    if (key === 'title') assertIndexTitle(value)
    if (key === 'task_id' && task !== undefined && value !== task) ownership()
  }
}

export function dependencyKey(input: WorkDependency): string {
  switch (input.kind) {
    case 'goal': return JSON.stringify([input.kind, input.task_id, input.request_id, input.intent_revision])
    case 'work': return JSON.stringify([input.kind, input.task_id, input.work_id, input.result_revision])
    case 'artifact': return JSON.stringify([input.kind, input.task_id, input.artifact_id, input.artifact_revision])
    case 'resource': return JSON.stringify([input.kind, input.task_id, input.resource_id])
    case 'chapter': return JSON.stringify([input.kind, input.task_id, input.view_id, input.region_id ?? null, input.revision])
  }
}

export function sameDependencies(left: WorkDependency[], right: WorkDependency[]): boolean {
  const a = left.map(dependencyKey).sort(), b = right.map(dependencyKey).sort()
  return a.length === b.length && a.every((value, index) => value === b[index])
}

export function validateRunnerContract<K extends keyof RunnerContractTypes>(definition: K, value: unknown): RunnerContractTypes[K] {
  // The generic Ajv error can include caller-controlled field names. Runner errors expose no content.
  try { assertContract<RunnerContractTypes[K]>(definition, value) } catch { invalid(`Invalid ${definition} structure`) }
  const record = value as RunnerContractTypes[K]
  const object = record && typeof record === 'object' ? record as Record<string, any> : undefined
  fields(record, '', object?.task_id)
  if (!object) return record
  if ('dependencies' in object) unique(object.dependencies.map(dependencyKey), 'work dependencies')
  if ('input_versions' in object) unique(object.input_versions.map(dependencyKey), 'attempt inputs')
  if ('requirement_ids' in object) unique(object.requirement_ids, 'requirements')
  if (definition === 'runner_goal_revision') {
    unique(object.requirements.map((item: OutcomeRequirement) => item.requirement_id), 'requirements')
    if (object.previous_revision !== undefined && object.previous_revision >= object.intent_revision) invalid('Goal revision must advance its predecessor')
  }
  if (definition === 'runner_run') {
    if (object.previous_run_id === object.run_id) invalid('A resumed Run must retain a different predecessor')
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(object.state) && object.commit_valid) invalid('Terminal Run cannot retain commit authority')
  }
  if (definition === 'runner_logical_work') {
    if (object.purpose === 'composition' && object.role !== 'collator' || object.purpose === 'production' && object.role === 'collator') invalid('Worker role does not match its execution purpose')
  }
  if (definition === 'runner_execution_attempt' && object.previous_attempt_id === object.attempt_id) invalid('A resumed attempt must retain a different predecessor')
  if (definition === 'runner_outline') unique(object.sections.map((item: OutlineSection) => item.section_id), 'outline sections')
  if (definition === 'runner_artifact_index') assertIndexBytes(record)
  if (definition === 'runner_work_output_declaration') outputDeclaration(record as WorkOutputDeclaration)
  if (definition === 'runner_contribution_inventory') contributionInventory(record as ContributionInventory)
  if (definition === 'runner_composition_scope') {
    const scope = record as CompositionScope
    unique(object.targets.map((item: { request_id: string }) => item.request_id), 'scope targets')
    if (object.previous_version !== undefined && object.previous_version >= object.composition_version) invalid('Composition version must advance its predecessor')
    if (object.state === 'complete' && (object.unresolved.length || !object.publication_manifest_id)) invalid('Complete scope requires a frozen manifest without unresolved requirements')
    for (const target of scope.targets) {
      unique(target.requirement_ids, 'scope target requirements')
      if (target.contribution_inventory) sameGoal({ task_id: scope.task_id, request_id: target.request_id, intent_revision: target.intent_revision }, target.contribution_inventory)
      if (scope.state === 'complete' && target.required && !target.contribution_inventory) invalid('Complete scope requires a sealed inventory for every required target')
    }
  }
  if (definition === 'runner_composition_batch') unique(object.indexes.map((item: { artifact_id: string }) => item.artifact_id), 'batch artifacts')
  if (definition === 'runner_publication_manifest') {
    unique(object.contributions.map((item: PublicationEntry) => item.artifact_id), 'published artifacts')
    if (object.state === 'complete' && object.unresolved.length) invalid('Complete manifest cannot contain unresolved requirements')
  }
  if (definition === 'runner_chapter_ownership') chapterOwnership(record as ChapterOwnership)
  if (definition === 'runner_chapter_region') chapterRegion(record as ChapterRegion)
  if (definition === 'runner_chapter_manifest') chapterManifest(record as ChapterManifest)
  if (definition === 'runner_chapter_update') chapterUpdate(record as ChapterUpdate)
  if (definition === 'runner_content_authorization') unique(object.region_ids, 'content authorization nodes')
  if (definition === 'runner_content_scope_revision') {
    const revision = record as ContentScopeRevision
    chapterManifest(revision.base_manifest)
    unique(revision.read_refs, 'content read references')
    for (const operation of revision.operations) contentOperation(operation)
    if (revision.source.purpose !== 'production' || revision.source.update_id !== revision.update_id || revision.source.task_id !== revision.task_id || revision.base_manifest.task_id !== revision.task_id) ownership()
  }
  if (definition === 'runner_chapter_replacement') chapterReplacement(record as ChapterReplacement)
  if (definition === 'runner_chapter_proposal') chapterProposal(record as ChapterProposal)
  if (definition === 'runner_content_tree') contentTree(record as ContentTree)
  if (definition === 'runner_content_node') contentNode(record as ContentNode)
  if (definition === 'runner_content_operation' || definition === 'runner_content_operation_plan') contentOperation(record as ContentOperationPlan)
  if (definition === 'runner_chapter_inheritance') {
    const keep = record as ChapterInheritance
    if (keep.valid && keep.reason !== undefined) invalid('Valid inherited contributions cannot retain an invalidation reason')
  }
  if (definition === 'runner_chapter_publication') {
    const publication = record as ChapterPublication
    unique(publication.source_bundle_resource_ids, 'publication sources')
    if (publication.previous_operation_id === publication.operation_id) invalid('Publication cannot succeed itself')
    if (publication.request.type !== 'write' || publication.request.input.type !== 'surface.update') invalid('Chapter publication requires a controlled Surface request')
  }
  return record
}

function chapterOwnership(ownership: ChapterOwnership): void {
  for (const [field, values] of Object.entries(ownership)) unique(values, `chapter ${field}`)
}
function chapterRegion(region: ChapterRegion, structural = false): void {
  if (!structural && region.title_selector === region.body_selector) invalid('Chapter title and body require separate boundaries')
  chapterOwnership(region.ownership)
  unique(region.dependencies.map(dependencyKey), 'chapter dependencies')
}
function chapterManifest(manifest: ChapterManifest): void {
  unique(manifest.chapters.map(chapter => chapter.region_id), 'chapter identities')
  unique(manifest.chapters.flatMap(chapter => manifest.content_tree ? [...new Set([chapter.title_selector, chapter.body_selector])] : [chapter.title_selector, chapter.body_selector]), 'chapter boundaries')
  for (const chapter of manifest.chapters) chapterRegion(chapter, !!manifest.content_tree)
  for (const field of ['form_ids', 'behavior_ids', 'reference_ids', 'export_ids', 'css_selectors'] as const) unique(manifest.chapters.flatMap(chapter => chapter.ownership[field]), `owned chapter ${field}`)
  if (manifest.content_tree) contentTree(manifest.content_tree)
}
function chapterUpdate(update: ChapterUpdate): void {
  chapterManifest(update.base_manifest)
  sameGoal(update, update.base_manifest)
  if (update.view_id !== update.base_manifest.view_id) ownership()
  unique(update.region_ids, 'update chapters')
  unique(update.region_intents.map(intent => intent.region_id), 'chapter intents')
  unique(update.previous_update_ids, 'previous updates')
  if (update.scope_revision !== undefined) {
    if (!update.authorization || !update.base_manifest.content_tree) invalid('Revisable content work requires an original tree authorization')
    if (update.scope_revision === 0 && (update.region_ids.length || update.region_intents.length || update.tree_operations)) invalid('Candidate scopes cannot grant write authority')
    if (update.scope_revision > 0 && !update.tree_operations?.length) invalid('Registered content work requires its actual operation scope')
    unique(update.authorization.region_ids, 'content authorization nodes')
    unique(update.candidate_region_ids ?? [], 'content candidate nodes')
  } else if (!update.region_ids.length) invalid('Legacy chapter work requires an exact scope')
  if (update.previous_update_ids.includes(update.update_id)) invalid('Chapter update cannot supersede itself')
  const baseline = new Set([...update.base_manifest.chapters.map(chapter => chapter.region_id), ...(update.base_manifest.content_tree?.nodes.map(node => node.node_id) ?? [])])
  if (update.scope_revision === 0 && (update.authorization!.region_ids.some(id => !baseline.has(id)) || update.candidate_region_ids?.some(id => !baseline.has(id)))) invalid('Original authorization and candidates require available baseline nodes')
  if (update.region_ids.some(id => !baseline.has(id)) || update.region_intents.length !== update.region_ids.length || update.region_intents.some(intent => !update.region_ids.includes(intent.region_id))) invalid('Update scope and chapter intent bindings must match the exact baseline')
  if (update.tree_operations) {
    const tree = update.base_manifest.content_tree
    if (!tree) invalid('Content operations require an exact structural baseline')
    const ids = new Set(tree.nodes.map(node => node.node_id))
    for (const operation of update.tree_operations) {
      contentOperation(operation)
      const references = [...('node_ids' in operation ? operation.node_ids : []), ...('parent_id' in operation ? [operation.parent_id] : []), ...('anchor_id' in operation ? [operation.anchor_id] : [])]
      if (references.some(id => !ids.has(id))) invalid('Content operations reference unavailable baseline nodes')
    }
  }
  if (update.source && (update.source.purpose !== 'production' || update.source.update_id !== update.update_id || update.source.request_id !== update.request_id || update.source.intent_revision !== update.intent_revision)) ownership()
}
function chapterReplacement(replacement: ChapterReplacement): void {
  unique(replacement.previous_region_ids, 'replaced chapters')
  unique(replacement.chapters.map(chapter => chapter.region_id), 'replacement chapters')
  for (const chapter of replacement.chapters) chapterRegion(chapter)
}
function chapterProposal(proposal: ChapterProposal): void {
  if (proposal.read_refs) unique(proposal.read_refs, 'proposal read references')
  unique(proposal.replacements.flatMap(replacement => replacement.previous_region_ids), 'proposal replaced chapters')
  unique(proposal.replacements.flatMap(replacement => replacement.chapters.map(chapter => chapter.region_id)), 'proposal chapter identities')
  for (const replacement of proposal.replacements) chapterReplacement(replacement)
  for (const operation of proposal.tree_operations ?? []) contentOperation(operation)
  if (proposal.source.purpose !== 'production' || proposal.source.update_id !== proposal.update_id || proposal.source.intent_revision !== proposal.intent_revision) ownership()
}

function contentNode(node: ContentNode): void {
  unique(node.children, 'content children')
  for (const id of node.children) assertRunnerId(id, 'content child')
  if (node.span.start > node.inner_span.start || node.inner_span.start > node.inner_span.end || node.inner_span.end > node.span.end) invalid('Content node boundaries are inconsistent')
  if (node.children.includes(node.node_id) || node.parent_id === node.node_id) invalid('Content nodes cannot contain themselves')
}

function contentOperation(operation: ContentOperationPlan): void {
  if ('node_ids' in operation) unique(operation.node_ids, 'content operation targets')
  if ('anchor_id' in operation && 'node_ids' in operation && operation.node_ids.includes(operation.anchor_id)) invalid('A content move cannot anchor to itself')
}

function contentTree(tree: ContentTree): void {
  unique(tree.nodes.map(node => node.node_id), 'content node identities')
  unique(tree.lineage.map(item => item.previous_node_id), 'retired content identities')
  const nodes = new Map(tree.nodes.map(node => [node.node_id, node]))
  const root = nodes.get(tree.root_id)
  if (!root || root.parent_id !== null || root.kind !== 'document') invalid('Content tree requires one document root')
  for (const node of tree.nodes) {
    contentNode(node)
    if (node.revision > tree.revision || node.position_revision > tree.revision) invalid('Content node versions exceed their snapshot')
    if (node.node_id !== root.node_id && (node.parent_id === null || !nodes.has(node.parent_id))) invalid('Content nodes require an existing parent')
    let previousEnd = node.span.start
    for (const id of node.children) {
      const child = nodes.get(id)
      if (!child || child.parent_id !== node.node_id || child.span.start < node.span.start || child.span.end > node.span.end || child.span.start < previousEnd) invalid('Content child order or containment is inconsistent')
      previousEnd = child.span.end
    }
    if (node.parent_id !== null && !nodes.get(node.parent_id)?.children.includes(node.node_id)) invalid('Content parent links must be reciprocal')
  }
  const visited = new Set<string>(), pending = [root.node_id]
  while (pending.length) {
    const id = pending.pop()!
    if (visited.has(id)) invalid('Content tree cannot contain cycles')
    visited.add(id)
    pending.push(...nodes.get(id)!.children)
  }
  if (visited.size !== nodes.size) invalid('Content tree must be connected')
  const lineage = new Map(tree.lineage.map(item => [item.previous_node_id, item]))
  for (const item of tree.lineage) {
    unique(item.successor_node_ids, 'content successors')
    if (nodes.has(item.previous_node_id) || item.revision > tree.revision || item.successor_node_ids.some(id => id === item.previous_node_id || !nodes.has(id) && !lineage.has(id))) invalid('Content lineage must retain retired identities and valid successors')
    if (item.reason === 'deleted' && item.successor_node_ids.length) invalid('Deleted content cannot declare successors')
  }
  const completed = new Set<string>(), active = new Set<string>()
  for (const id of lineage.keys()) {
    const pending: [string, boolean][] = [[id, false]]
    while (pending.length) {
      const [current, expanded] = pending.pop()!
      if (expanded) { active.delete(current); completed.add(current); continue }
      if (completed.has(current) || nodes.has(current)) continue
      if (active.has(current)) invalid('Content lineage cannot contain cycles')
      active.add(current); pending.push([current, true])
      for (const successor of lineage.get(current)!.successor_node_ids) pending.push([successor, false])
    }
  }
}

export interface ArtifactAcceptanceContext {
  task_id: string
  runtime_epoch: string
  goal: GoalRevision
  run: RunnerRun
  work: LogicalWork
  attempt: ExecutionAttempt
  section: OutlineSection
  current_artifact_revision: number
  resource_task_id: string
}

export function validateArtifactCandidate(value: unknown, context: ArtifactAcceptanceContext): ArtifactCandidate {
  const candidate = validateRunnerContract('runner_artifact_candidate', value)
  const goal = validateRunnerContract('runner_goal_revision', context.goal)
  const run = validateRunnerContract('runner_run', context.run)
  const work = validateRunnerContract('runner_logical_work', context.work)
  const attempt = validateRunnerContract('runner_execution_attempt', context.attempt)
  const section = validateRunnerContract('runner_outline_section', context.section)
  if (run.purpose !== 'production' || work.purpose !== 'production' || attempt.purpose !== 'production') return ownership()
  if ([candidate.task_id, goal.task_id, run.task_id, work.task_id, attempt.task_id, context.resource_task_id].some(task => task !== context.task_id)) ownership()
  if ([goal.request_id, run.request_id, work.request_id, attempt.request_id, section.request_id].some(request => request !== candidate.request_id)) ownership()
  if ([goal.intent_revision, run.intent_revision, work.intent_revision, attempt.intent_revision, section.intent_revision].some(revision => revision !== candidate.intent_revision)) ownership()
  if (goal.state !== 'active' || !run.commit_valid || !['running', 'waiting'].includes(run.state)) ownership()
  if (run.runtime_epoch !== context.runtime_epoch || attempt.runtime_epoch !== context.runtime_epoch) ownership()
  if ([run.run_id, work.run_id, attempt.run_id].some(id => id !== candidate.run_id)) ownership()
  if (work.work_id !== candidate.work_id || attempt.work_id !== candidate.work_id || attempt.attempt_id !== candidate.attempt_id || work.current_attempt_id !== candidate.attempt_id) ownership()
  if (!['running', 'waiting', 'succeeded'].includes(work.state) || !['running', 'waiting', 'succeeded'].includes(attempt.state)) ownership()
  if (work.plan_revision !== candidate.plan_revision || section.section_id !== candidate.section_id || section.position_revision !== candidate.section_position_revision || section.order_key !== candidate.order_key) ownership()
  if (candidate.base_artifact_revision !== context.current_artifact_revision || !sameDependencies(candidate.dependencies, attempt.input_versions) || !sameDependencies(candidate.dependencies, work.dependencies)) ownership()
  if (candidate.requirement_ids.some(id => !work.requirement_ids.includes(id) || !goal.requirements.some(requirement => requirement.requirement_id === id))) ownership()
  return candidate
}

export function validatePresentationPlan(value: unknown, context: { batch: CompositionBatch; indexes: ArtifactIndex[]; sections: OutlineSection[] }): PresentationPlan {
  const plan = validateRunnerContract('runner_presentation_plan', value)
  const batch = validateRunnerContract('runner_composition_batch', context.batch)
  if (plan.task_id !== batch.task_id || plan.run_id !== batch.run_id || plan.batch_id !== batch.batch_id || plan.composition_version !== batch.composition_version) ownership()
  unique(plan.intents.map(intent => intent.artifact.artifact_id), 'presentation artifacts')
  const indexes = context.indexes.map(index => validateRunnerContract('runner_artifact_index', index))
  const sections = context.sections.map(section => validateRunnerContract('runner_outline_section', section))
  for (const intent of plan.intents) {
    const reference = intent.artifact
    const index = indexes.find(item => item.task_id === reference.task_id && item.artifact_id === reference.artifact_id && item.artifact_revision === reference.artifact_revision)
    const section = sections.find(item => item.section_id === intent.section_id)
    const position = batch.sections.find(item => item.section_id === intent.section_id)
    if (!index || !section || !position || !batch.indexes.some(item => item.task_id === reference.task_id && item.artifact_id === reference.artifact_id && item.artifact_revision === reference.artifact_revision)) ownership()
    if (reference.task_id !== plan.task_id || index.section_id !== intent.section_id || index.width_constraint !== intent.width_constraint) ownership()
    if (section.position_revision !== intent.section_position_revision || position.position_revision !== intent.section_position_revision || section.order_key !== intent.order_key || position.order_key !== intent.order_key) ownership()
  }
  return plan
}

export function queryDeliveries(values: unknown[], query: unknown): { items: DeliveryRecord[]; next_after: string | null } {
  const selection = validateRunnerContract('runner_delivery_query', query)
  const records = values.map(value => validateRunnerContract('runner_delivery_record', value)).filter(record =>
    record.task_id === selection.task_id && record.purpose === selection.purpose &&
    (selection.request_id === undefined || 'request_id' in record && record.request_id === selection.request_id) &&
    (selection.input_event_id === undefined || record.input_event_id === selection.input_event_id))
  const after = selection.after_delivery_id === undefined ? -1 : records.findIndex(record => record.delivery_id === selection.after_delivery_id)
  if (selection.after_delivery_id !== undefined && after < 0) throw new ContractError('INVALID_CURSOR', 'Delivery page anchor is unavailable within this selection')
  const items = records.slice(after + 1, after + 1 + selection.limit)
  return { items, next_after: after + 1 + items.length < records.length ? items.at(-1)!.delivery_id : null }
}
