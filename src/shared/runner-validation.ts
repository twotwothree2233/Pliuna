import type {
  ArtifactCandidate, ArtifactIndex, CompositionBatch, CompositionScope, ConsumptionStage, ContributionInventory, ContributionInventoryRef, DeliveryQuery, DeliveryRecord,
  ExecutionAttempt, ExecutionScope, GoalRevision, InputEvent, LogicalWork, Outline, OutlineSection, OutcomeRequirement,
  PresentationPlan, PublicationEntry, PublicationManifest, RunnerRun, WorkDependency, WorkOutputDeclaration
} from './contracts.generated'
import { assertContract, ContractError } from './validation'
import { assertIndexBytes, assertIndexTitle, assertRunnerId } from '../runtime/runner/limits'

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
  return record
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
