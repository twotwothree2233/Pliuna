import { types } from 'node:util'
import type { ExecutionScope, ContentPlan, InputEvent } from '../../shared/contracts.generated'
import { validateRunnerContract } from '../../shared/runner-validation'
import { ContractError } from '../../shared/validation'
import { assertIndexBytes, assertRunnerId, RUNNER_LIMITS } from './limits'
import type { RunnerWorkState } from './work-state'

export type TaskRunnerReferenceKind = 'record' | 'resource' | 'action' | 'input' | 'goal' | 'run' | 'work' | 'attempt' | 'operation'
export interface TaskRunnerReference { task_id: string; kind: TaskRunnerReferenceKind; id: string; revision?: number }
export interface TaskRunnerWait { reason: string; ref?: TaskRunnerReference }
export interface TaskRunnerEffect { refs: TaskRunnerReference[]; waits: TaskRunnerWait[] }
export interface TaskRunnerTarget { request_id?: string; run_id?: string; work_id?: string }
export type TaskRunnerCancelKind = 'cancel_work' | 'cancel_run' | 'stop_task'
export type TaskRunnerRoute =
  | { route: 'direct'; kind: 'request' | 'correction' | 'withdraw_goal'; request_id: string }
  | ({ route: 'direct'; kind: 'query' | 'explanation' } & TaskRunnerTarget)
  | { route: 'direct'; kind: 'cancel_work'; scope: 'work'; work_id: string; run_id: string }
  | { route: 'direct'; kind: 'cancel_run'; scope: 'run'; run_id: string }
  | { route: 'direct'; kind: 'stop_task'; scope: 'task' }
  | { route: 'direct'; kind: 'operation_completed' | 'approval_decided'; operation_id: string; owner: ExecutionScope }
  | { route: 'clarification'; kind: 'clarification'; input_kind: InputEvent['kind']; reason: 'goal_target_required' | 'work_target_required' | 'run_target_required' | 'operation_owner_required' }

export interface TaskRunnerInstallation extends TaskRunnerEffect {
  version: 1
  input_event_id: string
  task_id: string
  state: 'installed' | 'clarification'
  route: TaskRunnerRoute
  goal?: Pick<ContentPlan, 'request_id' | 'intent_revision' | 'state'>
}
export interface TaskRunnerStatusQuery { task_id: string; request_id?: string; cursor?: string; limit?: number }
export interface TaskRunnerStatusItem { ref: TaskRunnerReference; state: string; refs: TaskRunnerReference[]; waits: TaskRunnerWait[] }
export interface TaskRunnerStatusPage { task_id: string; items: TaskRunnerStatusItem[]; next_cursor: string | null }
export interface TaskRunnerHost {
  goal(input: InputEvent, current: ContentPlan | null): ContentPlan
  // Persist only. Abort, queue dispatch and external I/O follow advance's return.
  install(input: InputEvent, route: TaskRunnerRoute, goal?: ContentPlan): TaskRunnerEffect
  operationOwner(input: InputEvent): { operation_id: string; owner: ExecutionScope } | null
  status(query: TaskRunnerStatusQuery): TaskRunnerStatusPage
}

const referenceKinds: readonly string[] = ['record', 'resource', 'action', 'input', 'goal', 'run', 'work', 'attempt', 'operation']
function invalid(): never { throw new ContractError('RUNNER_RESULT_INVALID', 'Task Runner adapters require bounded synchronous metadata') }
function ownership(): never { throw new ContractError('RUNNER_OWNERSHIP_INVALID', 'Task Runner route does not match its original input or operation owner') }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function fields(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  if (!object(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid()
}
function synchronous<T>(callback: (...args: any[]) => T, receiver: unknown, ...args: unknown[]): T {
  if (types.isAsyncFunction(callback)) invalid()
  const result = Reflect.apply(callback, receiver, args) as T
  if (result && (typeof result === 'object' || typeof result === 'function') && typeof (result as { then?: unknown }).then === 'function') {
    void Promise.resolve(result).catch(() => {})
    invalid()
  }
  return result
}
function copy<T>(value: T): T { return structuredClone(value) }
function pageBytes(value: unknown): void {
  let serialized: string | undefined
  try { serialized = JSON.stringify(value) } catch { invalid() }
  if (!serialized || Buffer.byteLength(serialized) > RUNNER_LIMITS.index.page_bytes) throw new ContractError('RUNNER_LIMIT_EXCEEDED', 'Task Runner metadata exceeds its page byte limit')
}
function code(value: unknown): void { if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) invalid() }
function reference(raw: unknown, task: string): void {
  fields(raw, ['task_id', 'kind', 'id'], ['revision'])
  if (raw.task_id !== task || !referenceKinds.includes(raw.kind as string)) ownership()
  assertRunnerId(raw.task_id, 'task_id'); assertRunnerId(raw.id, 'id')
  if (raw.revision !== undefined && (!Number.isSafeInteger(raw.revision) || (raw.revision as number) < 1)) invalid()
  assertIndexBytes(raw)
}
function effect(raw: unknown, task: string): asserts raw is TaskRunnerEffect {
  fields(raw, ['refs', 'waits'])
  if (!Array.isArray(raw.refs) || !Array.isArray(raw.waits) || raw.refs.length > RUNNER_LIMITS.index.page_items || raw.waits.length > RUNNER_LIMITS.index.page_items) invalid()
  for (const ref of raw.refs) reference(ref, task)
  for (const wait of raw.waits) {
    fields(wait, ['reason'], ['ref']); code(wait.reason)
    if (wait.ref !== undefined) reference(wait.ref, task)
    assertIndexBytes(wait)
  }
  pageBytes(raw)
}

// Coordination and installation use RunnerWorkState's existing transactions.
// This module never reads full records or creates another model execution loop.
export class TaskRunner {
  constructor(private readonly work: RunnerWorkState, private readonly host: TaskRunnerHost) {}

  receive(input: InputEvent): InputEvent { return this.work.receive(input) }

  advance(inputId: string): TaskRunnerInstallation {
    assertRunnerId(inputId, 'input_event_id')
    const route = this.work.consume(inputId, 'routed', input => this.route(input))
    return this.work.consume(inputId, 'installed', input => {
      if (route.route === 'clarification') return {
        version: 1 as const, input_event_id: inputId, task_id: input.task_id, state: 'clarification' as const, route,
        refs: [{ task_id: input.task_id, kind: 'record' as const, id: input.record_id }],
        waits: [{ reason: route.reason, ref: { task_id: input.task_id, kind: 'input' as const, id: inputId } }]
      }
      let goal: ContentPlan | undefined
      if (route.kind === 'request' || route.kind === 'correction' || route.kind === 'withdraw_goal') {
        let current: ContentPlan | null = null
        try { current = this.work.goal(route.request_id) } catch (error) { if (!(error instanceof ContractError) || error.code !== 'RUNNER_NOT_FOUND') throw error }
        const proposed = validateRunnerContract('runner_content_plan', synchronous(this.host.goal, this.host, copy(input), copy(current)))
        if (proposed.task_id !== input.task_id || proposed.request_id !== route.request_id || proposed.input_event_id !== inputId) ownership()
        goal = this.work.installGoal(proposed, current?.intent_revision ?? null)
      }
      const installed = synchronous(this.host.install, this.host, copy(input), copy(route), copy(goal))
      effect(installed, input.task_id)
      const result: TaskRunnerInstallation = {
        version: 1, input_event_id: inputId, task_id: input.task_id, state: 'installed', route,
        ...(goal ? { goal: { request_id: goal.request_id, intent_revision: goal.intent_revision, state: goal.state } } : {}), ...installed
      }
      pageBytes(result)
      return result
    })
  }

  cancel(input: InputEvent & { kind: TaskRunnerCancelKind }): TaskRunnerInstallation {
    if (!['cancel_work', 'cancel_run', 'stop_task'].includes(input.kind)) throw new ContractError('INVALID_REQUEST', 'Task Runner cancellation requires an explicit cancellation input')
    this.receive(input)
    return this.advance(input.input_event_id)
  }

  status(query: TaskRunnerStatusQuery): TaskRunnerStatusPage {
    fields(query, ['task_id'], ['request_id', 'cursor', 'limit'])
    assertRunnerId(query.task_id, 'task_id')
    if (query.request_id !== undefined) assertRunnerId(query.request_id, 'request_id')
    if (query.cursor !== undefined && (typeof query.cursor !== 'string' || !query.cursor || Buffer.byteLength(query.cursor) > RUNNER_LIMITS.index.item_bytes)) invalid()
    const limit = query.limit ?? RUNNER_LIMITS.index.page_items
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > RUNNER_LIMITS.index.page_items) invalid()
    const page = synchronous(this.host.status, this.host, copy({ ...query, limit }))
    fields(page, ['task_id', 'items', 'next_cursor'])
    if (page.task_id !== query.task_id) ownership()
    if (!Array.isArray(page.items) || page.items.length > limit || page.next_cursor !== null && (typeof page.next_cursor !== 'string' || !page.next_cursor || Buffer.byteLength(page.next_cursor) > RUNNER_LIMITS.index.item_bytes)) invalid()
    for (const item of page.items) {
      fields(item, ['ref', 'state', 'refs', 'waits'])
      reference(item.ref, query.task_id); code(item.state)
      effect({ refs: item.refs, waits: item.waits }, query.task_id)
      assertIndexBytes(item)
    }
    pageBytes(page)
    return copy(page)
  }

  private route(input: InputEvent): TaskRunnerRoute {
    const clarify = (reason: Extract<TaskRunnerRoute, { route: 'clarification' }>['reason']): TaskRunnerRoute => ({ route: 'clarification', kind: 'clarification', input_kind: input.kind, reason })
    if (input.kind === 'operation_completed' || input.kind === 'approval_decided') {
      if (!input.operation_id) return clarify('operation_owner_required')
      const known = synchronous(this.host.operationOwner, this.host, copy(input))
      if (!known) return clarify('operation_owner_required')
      fields(known, ['operation_id', 'owner'])
      const owner = validateRunnerContract('runner_execution_scope', known.owner)
      const attempt = this.work.attempt(owner.attempt_id), run = this.work.run(owner.run_id), work = this.work.work(attempt.work_id)
      if (known.operation_id !== input.operation_id || owner.task_id !== input.task_id || attempt.task_id !== owner.task_id || attempt.work_id !== owner.work_id || attempt.run_id !== owner.run_id || run.task_id !== owner.task_id || work.task_id !== owner.task_id || work.run_id !== owner.run_id || work.role !== owner.role || input.run_id !== undefined && input.run_id !== owner.run_id || input.work_id !== undefined && input.work_id !== owner.work_id || attempt.purpose !== owner.purpose || run.purpose !== owner.purpose || work.purpose !== owner.purpose) ownership()
      if (owner.purpose === 'production') {
        if (attempt.purpose !== 'production' || run.purpose !== 'production' || work.purpose !== 'production' || attempt.request_id !== owner.request_id || run.request_id !== owner.request_id || work.request_id !== owner.request_id || attempt.intent_revision !== owner.intent_revision || run.intent_revision !== owner.intent_revision || work.intent_revision !== owner.intent_revision || input.request_id !== undefined && input.request_id !== owner.request_id) ownership()
      } else if (attempt.purpose !== 'composition' || run.purpose !== 'composition' || work.purpose !== 'composition' || attempt.batch_id !== owner.batch_id || run.batch_id !== owner.batch_id || work.batch_id !== owner.batch_id || attempt.composition_version !== owner.composition_version || run.composition_version !== owner.composition_version || work.composition_version !== owner.composition_version || attempt.trigger_request_id !== owner.trigger_request_id || run.trigger_request_id !== owner.trigger_request_id || work.trigger_request_id !== owner.trigger_request_id || input.request_id !== undefined && input.request_id !== owner.trigger_request_id) ownership()
      return { route: 'direct', kind: input.kind, operation_id: input.operation_id, owner: copy(owner) }
    }
    if (input.kind === 'request' || input.kind === 'correction' || input.kind === 'withdraw_goal') return input.request_id ? { route: 'direct', kind: input.kind, request_id: input.request_id } : clarify('goal_target_required')
    if (input.kind === 'query' || input.kind === 'explanation') return { route: 'direct', kind: input.kind, ...(input.request_id ? { request_id: input.request_id } : {}), ...(input.run_id ? { run_id: input.run_id } : {}), ...(input.work_id ? { work_id: input.work_id } : {}) }
    if (input.kind === 'cancel_work') {
      if (!input.work_id) return clarify('work_target_required')
      return { route: 'direct', kind: input.kind, scope: 'work', work_id: input.work_id, run_id: this.work.work(input.work_id).run_id }
    }
    if (input.kind === 'cancel_run') return input.run_id ? { route: 'direct', kind: input.kind, scope: 'run', run_id: input.run_id } : clarify('run_target_required')
    if (input.kind === 'stop_task') return { route: 'direct', kind: input.kind, scope: 'task' }
    throw new ContractError('INVALID_REQUEST', 'Task Runner input kind is not supported')
  }
}
