import type { ExecutionScope, ModelRequest, ReportMissingInput, RouteWork } from '../../shared/contracts.generated'
import { validateRunnerContract } from '../../shared/runner-validation'
import { ContractError } from '../../shared/validation'

export const ROUTE_WORK = 'builtin:route-work:v1'
export const REPORT_MISSING_INPUT = 'builtin:report-missing-input:v1'
export const READ_WORK_OUTPUT = 'builtin:read-work-output:v1'

type Call = Extract<ModelRequest, { type: 'call' }>['input']
type Owner = Extract<ExecutionScope, { purpose: 'production' }>
export type DispatchWork = Extract<RouteWork, { action: 'dispatch' }>
export type WorkRoutingResult = { kind: 'updated' | 'blocked' } | { kind: 'clarification'; question: string }
export interface OrchestrationInstallation {
  readonly revision: number
  route(decision: RouteWork, owner: Owner): unknown
  report(report: ReportMissingInput, owner: Owner): unknown
}

export function orchestrationCapability(capability: string): boolean {
  return capability === ROUTE_WORK || capability === REPORT_MISSING_INPUT
}

export function orchestrationRoleAllows(capability: string, role: ExecutionScope['role']): boolean {
  if (capability === ROUTE_WORK) return role === 'router'
  if (capability === REPORT_MISSING_INPUT || capability === READ_WORK_OUTPUT) return role === 'producer' || role === 'integrator' || role === 'lightweight'
  return !orchestrationCapability(capability)
}

function invalid(message: string): never { throw new ContractError('INVALID_RUNNER_CONTRACT', message) }
function unique(ids: readonly string[], field: string): void {
  if (new Set(ids).size !== ids.length) invalid(`Duplicate ${field}`)
}

function routeWork(raw: unknown, previous?: DispatchWork): RouteWork {
  const decision = validateRunnerContract('runner_route_work', raw)
  if (decision.action === 'dispatch') {
    const proposed = [...previous?.assignments ?? [], ...decision.assignments]
    const assignments = new Map(proposed.map(assignment => [assignment.assignment_key, assignment]))
    unique(proposed.map(assignment => assignment.assignment_key), 'assignment keys')
    if (decision.final_answer !== undefined && !assignments.get(decision.final_answer)?.outputs.some(output => output.kind === 'answer')) invalid('Final answer must designate an assignment with an answer output')
    for (const assignment of decision.assignments) {
      unique(assignment.outputs.map(output => output.output_key), 'output keys')
      if (assignment.outputs.filter(output => output.kind === 'answer').length > 1) invalid('Each assignment may declare at most one answer output')
      for (const output of assignment.outputs) {
        const path = `${assignment.assignment_key}.${output.output_key}`
        if (output.kind === 'answer' && output.exposure !== undefined) invalid(`Remove exposure from text output ${path}; use an input reference for internal handoff or final_answer for a user reply`)
        if (output.kind === 'artifact' && output.exposure === undefined) invalid(`Artifact output ${path} requires exposure: handoff or publish`)
      }
      for (const input of assignment.inputs ?? []) if ('assignment_key' in input && !assignments.get(input.assignment_key)?.outputs.some(output => output.output_key === input.output_key)) invalid('Local references must identify a declared assignment output')
    }
  } else if (decision.action === 'revise') {
    unique(decision.changes.map(change => change.work_id), 'revised work identities')
    if (decision.changes.some(change => change.inputs?.some(input => 'assignment_key' in input))) invalid('Plan revisions require installed work references')
  }
  return decision
}

export class InitialWorkDraft {
  private draft?: DispatchWork
  private revision = 0

  constructor(saved?: unknown, private readonly checkpoint?: (id: string) => void) {
    if (saved !== undefined) this.draft = this.validate(saved)
  }

  decision(): DispatchWork | undefined { return this.draft }

  discard(): number { this.draft = undefined; return ++this.revision }

  propose(call: Call): { revision: number; assignment_keys: string[] } {
    if (call.capability !== ROUTE_WORK) throw new ContractError('WORKER_CAPABILITY_DENIED', 'This Router can only draft initial work')
    if (call.references.length) invalid('Put references in the orchestration arguments')
    const decision = routeWork(call.arguments, this.draft)
    if (decision.action !== 'dispatch') invalid('There is no installed plan to modify')
    if (decision.base_revision !== this.revision) throw new ContractError('RUNNER_PLAN_CONFLICT', `Draft changed; current revision is ${this.revision}`)
    for (const assignment of decision.assignments) if (assignment.checkpoint_id) {
      if (!this.checkpoint) throw new ContractError('RUNNER_CHECKPOINT_UNAVAILABLE', 'No checkpoint is available in this routing context')
      this.checkpoint(assignment.checkpoint_id)
    }
    const finalAnswer = decision.final_answer ?? this.draft?.final_answer
    this.draft = this.validate({ action: 'dispatch', base_revision: 0, assignments: [...this.draft?.assignments ?? [], ...decision.assignments], ...(finalAnswer ? { final_answer: finalAnswer } : {}) })
    return { revision: ++this.revision, assignment_keys: decision.assignments.map(assignment => assignment.assignment_key) }
  }

  private validate(raw: unknown): DispatchWork {
    const decision = routeWork(raw)
    if (decision.action !== 'dispatch' || decision.base_revision !== 0) return invalid('Initial production requires a dispatch from baseline zero')
    const assignments = new Map(decision.assignments.map(assignment => [assignment.assignment_key, assignment]))
    const visiting = new Set<string>(), visited = new Set<string>()
    function visit(key: string): void {
      if (visiting.has(key)) throw new ContractError('RUNNER_DEPENDENCY_CYCLE', 'Assignment inputs must form a DAG')
      if (visited.has(key)) return
      visiting.add(key)
      for (const input of assignments.get(key)?.inputs ?? []) if ('assignment_key' in input) visit(input.assignment_key)
      visiting.delete(key); visited.add(key)
    }
    for (const key of assignments.keys()) visit(key)
    return decision
  }
}

export function dispatchOrchestrationTool(call: Call, owner: ExecutionScope, installation?: OrchestrationInstallation): unknown {
  if (!installation || owner.purpose !== 'production' || owner.update_id || !orchestrationCapability(call.capability) || !orchestrationRoleAllows(call.capability, owner.role)) throw new ContractError('WORKER_CAPABILITY_DENIED', 'Orchestration requires an authorized production role')
  if (call.references.length) invalid('Put references in the orchestration arguments')
  if (call.capability === ROUTE_WORK) {
    const decision = routeWork(call.arguments)
    if (decision.base_revision !== installation.revision) throw new ContractError('RUNNER_PLAN_CONFLICT', `Work plan changed; current revision is ${installation.revision}`)
    return installation.route(decision, owner)
  }
  const report = validateRunnerContract('runner_report_missing_input', call.arguments)
  if (report.references?.some(reference => reference.task_id !== owner.task_id)) throw new ContractError('RUNNER_OWNERSHIP_INVALID', 'Missing-input references must belong to this Task')
  return installation.report(report, owner)
}
