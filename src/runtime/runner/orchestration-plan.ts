import { isDeepStrictEqual } from 'node:util'
import type { ContentPlan, LogicalWork, RouteWork, RouteWorkRunnerInstalledInput, RouteWorkRunnerOutputBinding } from '../../shared/contracts.generated'
import { assignmentInputKey } from '../../shared/runner-validation'
import { ContractError } from '../../shared/validation'
import type { DispatchWork } from './orchestration-tool'

type ProductionWork = Extract<LogicalWork, { purpose: 'production' }>
type PlanSource = Pick<ProductionWork, 'task_id' | 'run_id' | 'request_id' | 'intent_revision' | 'dependencies' | 'message_id'>
type Lookup = (binding: RouteWorkRunnerOutputBinding) => ProductionWork
type Checkpoint = (checkpointId: string) => void
export type ContentInput = Exclude<RouteWorkRunnerInstalledInput, RouteWorkRunnerOutputBinding>
type CheckContent = (input: ContentInput, assignment: string) => void

function withInputs(source: PlanSource, inputs: readonly RouteWorkRunnerInstalledInput[]): ProductionWork['dependencies'] {
  if (new Set(inputs.map(assignmentInputKey)).size !== inputs.length) throw new ContractError('RUNNER_PLAN_CONFLICT', 'Duplicate assignment input')
  const outputs = inputs.filter(input => 'work_id' in input)
  const dependencies = [...new Map(outputs.map(input => [input.work_id, { kind: 'work' as const, task_id: source.task_id, work_id: input.work_id, result_revision: input.result_revision ?? 1 }])).values()]
  if (outputs.some(input => dependencies.find(dependency => dependency.work_id === input.work_id)?.result_revision !== (input.result_revision ?? 1))) throw new ContractError('RUNNER_PLAN_CONFLICT', 'One assignment cannot depend on two versions of the same work')
  return [...source.dependencies.filter(dependency => dependency.kind !== 'work'), ...dependencies]
}

export function initialDeliveryRequirements(route: 'new' | 'delegate', decision?: DispatchWork): ContentPlan['requirements'] {
  const kinds = route === 'delegate' ? ['answer'] as const : decision?.final_answer ? ['artifact', 'answer'] as const : ['artifact'] as const
  return kinds.map(kind => ({ requirement_id: kind === 'answer' ? 'answer' : 'content', kind, required: true, provenance_required: false }))
}

function publishesArtifact(outputs: NonNullable<ProductionWork['assignment']>['outputs']): boolean {
  return outputs.some(output => output.kind === 'artifact' && output.exposure === 'publish')
}

export function checkAssignmentRequirements(decision: DispatchWork, needs: ContentPlan['requirements'], existing: readonly ProductionWork[] = []) {
  const final = decision.assignments.find(item => item.assignment_key === decision.final_answer)
  if (final && (!final.required || existing.some(work => work.assignment?.final_answer))) throw new ContractError('RUNNER_PLAN_CONFLICT', 'The designated final answer must be required and unique')
  const answer = needs.find(need => need.kind === 'answer')
  const requirements = (item: DispatchWork['assignments'][number]) => item === final && answer && !item.requirement_ids.includes(answer.requirement_id) ? [...item.requirement_ids, answer.requirement_id] : item.requirement_ids
  if (answer && decision.assignments.some(item => item !== final && item.requirement_ids.includes(answer.requirement_id))) throw new ContractError('RUNNER_PLAN_CONFLICT', 'Only the designated final source may cover the answer requirement')
  if (decision.assignments.some(item => requirements(item).some(requirement => !needs.some(need => need.requirement_id === requirement)))) throw new ContractError('RUNNER_PLAN_CONFLICT', 'Assignments may only claim requirements in the request')
  for (const item of decision.assignments) {
    const artifactRequirements = needs.filter(need => need.kind === 'artifact' && item.requirement_ids.includes(need.requirement_id)).map(need => need.requirement_id)
    if (artifactRequirements.length && !publishesArtifact(item.outputs)) {
      throw new ContractError('RUNNER_PLAN_CONFLICT', `Assignment ${JSON.stringify(item.assignment_key)} claims final artifact requirements ${JSON.stringify(artifactRequirements)} in requirement_ids but has no artifact output with exposure:"publish". Remove those IDs if the assignment is internal, or declare a publishing output if it delivers them`)
    }
  }
  if (needs.every(need => need.kind === 'answer') && decision.assignments.some(item => item.outputs.some(output => output.kind !== 'answer'))) throw new ContractError('RUNNER_PLAN_CONFLICT', 'Answer-only work cannot publish artifacts')
  for (const need of needs) if (need.required && !existing.some(work => work.required && work.requirement_ids.includes(need.requirement_id)
    && (need.kind !== 'artifact' || !work.assignment || publishesArtifact(work.assignment.outputs))) && !decision.assignments.some(item => item.required && requirements(item).includes(need.requirement_id)
    && (need.kind !== 'answer' || item === final && item.outputs.some(output => output.kind === 'answer')))) {
    throw new ContractError('RUNNER_PLAN_CONFLICT', need.kind === 'artifact' && need.requirement_id === 'content' ? 'A required assignment with a publishing artifact output must include "content" in requirement_ids' : 'The draft must preserve each required user outcome')
  }
  return { final, requirements }
}

export function installableAssignments(decision: DispatchWork, goal: ContentPlan, source: PlanSource, id: () => string, lookup: Lookup, existing: readonly ProductionWork[] = [], checkpoint?: Checkpoint, checkContent?: CheckContent): ProductionWork[] {
  const { final, requirements } = checkAssignmentRequirements(decision, goal.requirements, existing)
  const ids = new Map(decision.assignments.map(item => [item.assignment_key, id()]))
  return decision.assignments.map(item => {
    if (item.checkpoint_id) validateCheckpoint(item.checkpoint_id, checkpoint)
    const inputs = (item.inputs ?? []).map<RouteWorkRunnerInstalledInput>(input => {
      if ('assignment_key' in input) return { work_id: ids.get(input.assignment_key)!, plan_revision: 1, output_key: input.output_key }
      if ('kind' in input) return checkedContent(input, item.assignment_key, checkContent)
      const work = lookup(input)
      return bindOutput(source.task_id, work, input)
    })
    return {
      task_id: source.task_id, run_id: source.run_id, request_id: source.request_id, intent_revision: source.intent_revision,
      ...(source.message_id ? { message_id: source.message_id } : {}), purpose: 'production', work_id: ids.get(item.assignment_key)!, plan_revision: 1,
      role: 'producer', required: item.required, requirement_ids: requirements(item), state: 'planned', max_attempts: 2,
      dependencies: withInputs(source, inputs),
      assignment: { instructions: item.instructions, inputs, outputs: item.outputs, ...(item.checkpoint_id ? { checkpoint_id: item.checkpoint_id } : {}), ...(item === final ? { final_answer: true as const } : {}) }
    }
  })
}

export function bindOutput(task: string, work: ProductionWork, input: RouteWorkRunnerOutputBinding): RouteWorkRunnerOutputBinding {
  if (work.task_id !== task || work.plan_revision !== input.plan_revision || !work.assignment?.outputs.some(output => output.output_key === input.output_key)
    || !['planned', 'queued', 'running', 'waiting', 'succeeded'].includes(work.state)
    || input.result_revision !== undefined && (work.state !== 'succeeded' || input.result_revision !== work.result_revision)) {
    throw new ContractError('RUNNER_DEPENDENCY_INVALID', `Output ${input.work_id}/${input.output_key} is not current or cannot become available`)
  }
  return { ...input, ...(work.state === 'succeeded' ? { result_revision: work.result_revision } : {}) }
}

function validateCheckpoint(id: string, checkpoint?: Checkpoint): void {
  if (!checkpoint) throw new ContractError('RUNNER_PLAN_CONFLICT', 'No checkpoint is available in this routing context')
  checkpoint(id)
}

function checkedContent(input: ContentInput, assignment: string, check?: CheckContent): ContentInput {
  if (!check) throw new ContractError('RUNNER_DEPENDENCY_INVALID', 'Content inputs are unavailable in this routing context')
  check(input, assignment)
  return input
}

export function assignmentRevisions(decision: Exclude<RouteWork, DispatchWork>, works: readonly ProductionWork[], lookup: Lookup, checkpoint?: Checkpoint, checkContent?: CheckContent): ProductionWork[] {
  const changes = decision.action === 'bind' ? [{ work_id: decision.work_id, input: decision.input }] : decision.changes
  const updated = changes.map(change => {
    const previous = works.find(item => item.work_id === change.work_id)
    if (!previous?.assignment || previous.update_id || !['planned', 'waiting'].includes(previous.state)) throw new ContractError('RUNNER_PLAN_CONFLICT', 'Only a pending assignment in this Run can be revised')
    const { checkpoint_id: oldCheckpoint, ...assignment } = previous.assignment
    const nextCheckpoint = 'checkpoint_id' in change && change.checkpoint_id !== undefined ? change.checkpoint_id ?? undefined : oldCheckpoint
    if (nextCheckpoint && nextCheckpoint !== oldCheckpoint) validateCheckpoint(nextCheckpoint, checkpoint)
    const inputs = ('input' in change ? [...assignment.inputs, change.input] : change.inputs ?? assignment.inputs).map(item => {
      if ('assignment_key' in item) throw new ContractError('RUNNER_PLAN_CONFLICT', 'Use exact installed work references when revising')
      if ('kind' in item) return assignment.inputs.some(input => isDeepStrictEqual(input, item)) ? item : checkedContent(item, previous.work_id, checkContent)
      return bindOutput(previous.task_id, lookup(item), item)
    })
    const instructions = 'instructions' in change ? change.instructions ?? assignment.instructions : assignment.instructions
    if (instructions === assignment.instructions && isDeepStrictEqual(inputs, assignment.inputs) && nextCheckpoint === oldCheckpoint) throw new ContractError('RUNNER_PLAN_CONFLICT', 'Revision does not change the assignment')
    const { current_attempt_id: _attempt, root_cause: _cause, result_revision: _result, ...source } = previous
    return { ...source, state: 'planned' as const, plan_revision: previous.plan_revision + 1, assignment: { ...assignment, instructions, inputs, ...(nextCheckpoint ? { checkpoint_id: nextCheckpoint } : {}) } }
  })
  return propagateAssignmentRevisions(updated, works)
}

export function propagateAssignmentRevisions(updated: (ProductionWork & { assignment: NonNullable<ProductionWork['assignment']> })[], works: readonly ProductionWork[]): ProductionWork[] {
  const changed = new Map(updated.map(work => [work.work_id, work.plan_revision]))
  let expanded = true
  while (expanded) {
    expanded = false
    for (const previous of works) {
      if (changed.has(previous.work_id) || previous.state !== 'planned' || previous.current_attempt_id || !previous.assignment?.inputs.some(input => 'work_id' in input && input.result_revision === undefined && changed.has(input.work_id))) continue
      updated.push({ ...previous, assignment: previous.assignment, plan_revision: previous.plan_revision + 1, state: 'planned' })
      changed.set(previous.work_id, previous.plan_revision + 1)
      expanded = true
    }
  }
  return updated.map(work => {
    const inputs = work.assignment.inputs.map(input => 'work_id' in input && input.result_revision === undefined ? { ...input, plan_revision: changed.get(input.work_id) ?? input.plan_revision } : input)
    return { ...work, assignment: { ...work.assignment, inputs }, dependencies: withInputs(work, inputs) }
  })
}
