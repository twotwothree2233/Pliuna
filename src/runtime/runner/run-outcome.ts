import type { ExecutionAttempt, LogicalWork, RunnerRun } from '../../shared/contracts.generated'
import { ContractError } from '../../shared/validation'

export type RunTerminalState = Extract<RunnerRun['state'], 'completed' | 'failed' | 'cancelled' | 'interrupted'>
export type RunClosingOutcome = Exclude<RunTerminalState, 'interrupted'>

// The owner supplies its current projection, not a history of state callbacks.
// Binding it to the attempt prevents a late callback from changing its successor.
export interface WorkRunState {
  work_id: string
  attempt_id: string
  state: 'running' | 'waiting'
  reason?: string
  operation_id?: string
}
export interface RunWaitReason {
  work_id: string
  attempt_id?: string
  reason: string
  operation_id?: string
}
export interface RunOutcomeInput {
  run: RunnerRun
  works: readonly LogicalWork[]
  attempts: readonly ExecutionAttempt[]
  states?: readonly WorkRunState[]
  // Only a cancellation accepted before the persisted terminal result belongs here.
  cancellation?: 'run' | 'task'
}
interface UnfinishedRunOutcome {
  waits: RunWaitReason[]
  unknown_attempt_ids: string[]
  // Settlement, cleanup and the atomic admission release belong to the closer.
  release_production_slot: false
}
export type RunOutcome = (UnfinishedRunOutcome & {
  phase: 'active'
  state: 'running' | 'waiting'
  pending_work_ids: string[]
  retry_work_ids: string[]
}) | (UnfinishedRunOutcome & {
  phase: 'closing'
  outcome: RunClosingOutcome | null
  pending_work_ids: string[]
  cancel_work_ids: string[]
  queued_attempt_ids: string[]
}) | {
  phase: 'terminal'
  outcome: RunTerminalState
  release_production_slot: false
}

type WorkResult = 'succeeded' | 'failed' | 'cancelled' | 'pending'
interface WorkOutcome { result: WorkResult; runnable: boolean; retry: boolean }
const terminalRun = new Set<RunnerRun['state']>(['completed', 'failed', 'cancelled', 'interrupted'])
const liveWork = new Set<LogicalWork['state']>(['planned', 'queued', 'running', 'waiting'])
const knownAttempt = new Set<ExecutionAttempt['state']>(['succeeded', 'failed', 'cancelled', 'revoked'])
const fail = (): never => { throw new ContractError('RUNNER_OUTCOME_FACTS_INVALID', 'Run outcome facts have inconsistent ownership') }
const sorted = (ids: string[]): string[] => ids.sort()
function sameSource(run: RunnerRun, source: LogicalWork | ExecutionAttempt): boolean {
  return source.task_id === run.task_id && source.purpose === run.purpose &&
    (run.purpose === 'production' ? source.purpose === 'production' && source.request_id === run.request_id && source.intent_revision === run.intent_revision && source.update_id === run.update_id : source.purpose === 'composition' && source.batch_id === run.batch_id && source.composition_version === run.composition_version && source.trigger_request_id === run.trigger_request_id)
}
function waitKey(wait: RunWaitReason): string { return JSON.stringify([wait.work_id, wait.attempt_id ?? null, wait.operation_id ?? null, wait.reason]) }

// This function proposes a closing result; it never installs a new terminal state.
// Callers pass the current effective work plan and all attempt history for the Run.
export function aggregateRunOutcome(input: RunOutcomeInput): RunOutcome {
  const { run } = input
  if (terminalRun.has(run.state)) return { phase: 'terminal', outcome: run.state as RunTerminalState, release_production_slot: false }
  const works = input.works.filter(work => work.run_id === run.run_id)
  const attempts = input.attempts.filter(attempt => attempt.run_id === run.run_id)
  if (works.some(work => !sameSource(run, work)) || attempts.some(attempt => !sameSource(run, attempt) || attempt.runtime_epoch !== run.runtime_epoch) || new Set(works.map(work => work.work_id)).size !== works.length || new Set(attempts.map(attempt => attempt.attempt_id)).size !== attempts.length) fail()
  const byAttempt = new Map(attempts.map(attempt => [attempt.attempt_id, attempt]))
  const waits: RunWaitReason[] = []
  const unknown = attempts.filter(attempt => attempt.state === 'unknown' || attempt.dispatch_state === 'unknown')
  for (const attempt of unknown) waits.push({ work_id: attempt.work_id, attempt_id: attempt.attempt_id, reason: 'operation_unknown', ...(attempt.operation_id ? { operation_id: attempt.operation_id } : {}) })
  const outcomes = new Map<string, WorkOutcome>()
  for (const work of works) {
    let result: WorkResult = 'pending', runnable = false, retry = false
    const attempt = work.current_attempt_id ? byAttempt.get(work.current_attempt_id) : undefined
    if (attempt && attempt.work_id !== work.work_id) fail()
    const wait = (reason: string): void => { waits.push({ work_id: work.work_id, ...(work.current_attempt_id ? { attempt_id: work.current_attempt_id } : {}), reason, ...(attempt?.operation_id ? { operation_id: attempt.operation_id } : {}) }) }
    if (work.state === 'succeeded') result = 'succeeded'
    else if (work.state === 'cancelled' || work.state === 'dependency_cancelled') result = 'cancelled'
    else if (work.state === 'failed' || work.state === 'dependency_failed') result = work.state === 'dependency_failed' && work.root_cause?.kind === 'cancellation' ? 'cancelled' : 'failed'
    else if (work.state === 'invalidated') {
      if (work.purpose === 'production' && work.assignment) result = 'failed'
      else wait('work_invalidated')
    }
    else if (work.current_attempt_id && !attempt) wait(work.state === 'waiting' && (input.states ?? []).some(state => state.work_id === work.work_id && state.attempt_id === work.current_attempt_id && state.reason === 'input_required') ? 'input_required' : 'attempt_unavailable')
    else if (attempt?.state === 'unknown' || attempt?.dispatch_state === 'unknown') { /* Original operation must be reconciled. */ }
    else if (attempt?.state === 'failed') {
      if (attempt.attempt_number >= work.max_attempts) result = 'failed'
      else { retry = true; runnable = true }
    } else if (attempt?.state === 'cancelled') result = 'cancelled'
    else if (attempt?.state === 'revoked') wait((input.states ?? []).find(state => state.work_id === work.work_id && state.attempt_id === attempt.attempt_id && ['missing_input', 'input_required'].includes(state.reason ?? ''))?.reason ?? 'attempt_revoked')
    else {
      const states = (input.states ?? []).filter(state => state.work_id === work.work_id && state.attempt_id === work.current_attempt_id && !knownAttempt.has(attempt?.state ?? 'registered'))
      for (const state of states) if (state.state === 'waiting') waits.push({ work_id: work.work_id, attempt_id: state.attempt_id, reason: state.reason ?? 'work_waiting', ...(state.operation_id ? { operation_id: state.operation_id } : {}) })
      if (states.length) runnable = states.some(state => state.state === 'running')
      else if (work.state === 'waiting' || attempt?.state === 'waiting') wait('work_waiting')
      else if (attempt?.state === 'succeeded') wait('work_result_pending')
      else runnable = true
    }
    outcomes.set(work.work_id, { result, runnable, retry })
  }
  const uniqueWaits = [...new Map(waits.map(wait => [waitKey(wait), wait])).entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, wait]) => wait)
  const details: UnfinishedRunOutcome = { waits: uniqueWaits, unknown_attempt_ids: sorted(unknown.map(attempt => attempt.attempt_id)), release_production_slot: false }
  const pending = works.filter(work => outcomes.get(work.work_id)!.result === 'pending')
  const required = works.filter(work => work.required)
  const settled = works.length > 0 && required.every(work => outcomes.get(work.work_id)!.result !== 'pending')
  const outcome: RunClosingOutcome | null = input.cancellation ? 'cancelled' : !settled ? null : required.some(work => outcomes.get(work.work_id)!.result === 'failed') ? 'failed' : required.some(work => outcomes.get(work.work_id)!.result === 'cancelled') ? 'cancelled' : 'completed'
  if (outcome || run.state === 'closing') return {
    ...details, phase: 'closing', outcome, pending_work_ids: sorted(pending.map(work => work.work_id)),
    cancel_work_ids: sorted(pending.filter(work => liveWork.has(work.state)).map(work => work.work_id)),
    queued_attempt_ids: sorted(attempts.filter(attempt => attempt.dispatch_state === 'not_dispatched' && (attempt.state === 'registered' || attempt.state === 'queued')).map(attempt => attempt.attempt_id))
  }
  return { ...details, phase: 'active', state: pending.some(work => outcomes.get(work.work_id)!.runnable) ? 'running' : 'waiting', pending_work_ids: sorted(pending.map(work => work.work_id)), retry_work_ids: sorted(pending.filter(work => outcomes.get(work.work_id)!.retry).map(work => work.work_id)) }
}
