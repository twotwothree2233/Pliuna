import type { LogicalWork } from '../../shared/contracts.generated'
import { ContractError } from '../../shared/validation'
import { admissionWaitReason, assertRunnerId, type AdmissionCounts, type AdmissionWait } from './limits'

export type RunnerAdmissionWork = { task_id: string; run_id: string; work_id: string } & (
  | { kind: 'production' | 'lightweight' }
  | { kind: 'composition'; batch_id: string }
)
export type RunnerAdmissionCandidate = RunnerAdmissionWork & { attempt_id: string }
export interface RunnerAdmissionRun { task_id: string; run_id: string; request_id: string }
export type RunnerAdmissionWait = AdmissionWait | 'work-active' | 'request-active'
interface Turn { production?: string; priority?: string; priority_used: boolean }

function invalid(): never { throw new ContractError('INVALID_REQUEST', 'Invalid runner admission metadata') }
function validateWork(work: RunnerAdmissionWork): void {
  assertRunnerId(work.task_id, 'task_id'); assertRunnerId(work.run_id, 'run_id'); assertRunnerId(work.work_id, 'work_id')
  if (work.kind === 'composition') assertRunnerId(work.batch_id, 'batch_id')
  else if (!['production', 'lightweight'].includes(work.kind) || 'batch_id' in work) invalid()
}
function activeWorks(task: string, active: readonly RunnerAdmissionWork[]): RunnerAdmissionWork[] {
  const works = new Map<string, RunnerAdmissionWork>()
  for (const work of active) {
    if (work.task_id !== task) continue
    validateWork(work)
    const old = works.get(work.work_id)
    if (old && (old.run_id !== work.run_id || old.kind !== work.kind || old.kind === 'composition' && work.kind === 'composition' && old.batch_id !== work.batch_id)) invalid()
    works.set(work.work_id, work)
  }
  return [...works.values()]
}
function wait(candidate: RunnerAdmissionWork, active: readonly RunnerAdmissionWork[]): RunnerAdmissionWait | null {
  if (active.some(work => work.work_id === candidate.work_id)) return 'work-active'
  const batches = new Set(active.flatMap(work => work.kind === 'composition' ? [work.batch_id] : []))
  // Further work in an already admitted batch does not consume a new batch slot.
  if (candidate.kind === 'composition') batches.delete(candidate.batch_id)
  const counts: AdmissionCounts = {
    producer_runs: 0,
    run_work: active.filter(work => work.run_id === candidate.run_id).length,
    task_work: active.length,
    production_work: active.filter(work => work.kind === 'production').length,
    composition_batches: batches.size
  }
  return admissionWaitReason(counts, candidate.kind)
}

export function admissionWork(work: LogicalWork): RunnerAdmissionWork {
  const identity = { task_id: work.task_id, run_id: work.run_id, work_id: work.work_id }
  if (work.purpose === 'composition') return { ...identity, kind: 'composition', batch_id: work.batch_id }
  return { ...identity, kind: work.role === 'lightweight' || work.role === 'diagnostic' ? 'lightweight' : 'production' }
}

// The host builds snapshots from persistent ownership, not model request slots.
// Waiting, unknown and closing work stay active until reconciliation, settlement
// and necessary cleanup finish. Queued work that has not been admitted is absent.
// Selection does not reserve capacity: persist dispatch synchronously, then use
// a fresh snapshot. Dispatch still checks authority, budgets and actual resources.
export class RunnerAdmission {
  private turns = new Map<string, Turn>()

  runWait(task: string, request: string, active: readonly RunnerAdmissionRun[], producerLimit: 1 | 2 = 1): RunnerAdmissionWait | null {
    assertRunnerId(task, 'task_id'); assertRunnerId(request, 'request_id')
    const runs = new Map<string, RunnerAdmissionRun>()
    for (const run of active) {
      if (run.task_id !== task) continue
      assertRunnerId(run.run_id, 'run_id'); assertRunnerId(run.request_id, 'request_id')
      const old = runs.get(run.run_id)
      if (old && old.request_id !== run.request_id) invalid()
      runs.set(run.run_id, run)
    }
    const reason = admissionWaitReason({ producer_runs: runs.size, run_work: 0, task_work: 0, production_work: 0, composition_batches: 0 }, 'producer-run', producerLimit)
    return [...runs.values()].some(run => run.request_id === request) ? 'request-active' : reason
  }

  wait(candidate: RunnerAdmissionWork, active: readonly RunnerAdmissionWork[]): RunnerAdmissionWait | null {
    validateWork(candidate)
    return wait(candidate, activeWorks(candidate.task_id, active))
  }

  next<T extends RunnerAdmissionCandidate>(task: string, candidates: readonly T[], active: readonly RunnerAdmissionWork[], ready: (candidate: T) => boolean): T | null {
    assertRunnerId(task, 'task_id')
    const current = candidates.filter(candidate => candidate.task_id === task)
    if (!current.length) { this.forget(task); return null }
    const occupants = activeWorks(task, active), eligible: T[] = []
    for (const candidate of current) {
      validateWork(candidate); assertRunnerId(candidate.attempt_id, 'attempt_id')
      if (wait(candidate, occupants) === null && ready(candidate) === true) eligible.push(candidate)
    }
    if (!eligible.length) return null
    const turn = this.turns.get(task) ?? { priority_used: false }
    const production = eligible.filter(candidate => candidate.kind === 'production')
    const priority = eligible.filter(candidate => candidate.kind !== 'production')
    // One priority opportunity, then a ready production work gets the next turn.
    const preferred = priority.length > 0 && (!turn.priority_used || production.length === 0)
    const choices = preferred ? priority : production
    const runs = [...new Set(choices.map(candidate => candidate.run_id))]
    const previous = preferred ? turn.priority : turn.production
    const run = runs[(previous === undefined ? -1 : runs.indexOf(previous)) + 1] ?? runs[0]!
    const selected = choices.find(candidate => candidate.run_id === run)!
    if (preferred) { turn.priority = run; turn.priority_used = true }
    else { turn.production = run; turn.priority_used = false }
    this.turns.set(task, turn)
    return selected
  }

  forget(task: string): void { this.turns.delete(task) }
}
