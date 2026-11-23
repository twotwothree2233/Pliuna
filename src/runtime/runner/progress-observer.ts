import type { ExecutionScope, ContentPlan, LogicalWork } from '../../shared/contracts.generated'
import { validateRunnerContract } from '../../shared/runner-validation'
import { ContractError } from '../../shared/validation'
import { assertRunnerId, progressObservationConfig, PROGRESS_OBSERVATION_BOUNDS, RUNNER_LIMITS, type ProgressObservationConfig } from './limits'

export interface ProgressRecordRef {
  record_id: string
  sequence: number
  at: number
  owner: ExecutionScope
  plan_revision: number
}
export interface ProgressCallFact extends ProgressRecordRef {
  call_id: string
  pattern: string
  outcome: 'success' | 'failure' | 'unknown' | 'not_executed'
  error_source?: string
  query_result_id?: number
}
export interface EffectiveProgressFact extends ProgressRecordRef {
  kind: 'requirement_covered' | 'work_advanced' | 'artifact_accepted' | 'input_consumed'
  requirement_ids: string[]
}
export interface ProgressWaitFact extends ProgressRecordRef {
  kind: 'approval' | 'input'
  valid_until: number
}
export interface ProgressBackgroundFact extends ProgressRecordRef {
  operation_id: string
  valid_until: number
}
export interface RunnerProgressInput {
  now: number
  goal: ContentPlan
  works: LogicalWork[]
  calls: ProgressCallFact[]
  progress: EffectiveProgressFact[]
  waits: ProgressWaitFact[]
  background: ProgressBackgroundFact[]
  diagnosis: { capability_allowed: boolean }
}
type Reason = 'repeated_failure' | 'suspected_stall'
interface DiagnosisKey {
  request_id: string
  intent_revision: number
  work_id: string
  plan_revision: number
  reason: Reason
  pattern: string
  error_source?: string
}
interface DiagnosisReservation extends DiagnosisKey {
  at: number
  through_sequence: number
}
export interface RunnerProgressCheckpoint {
  version: 1
  task_id: string
  observed_at: number
  reservations: DiagnosisReservation[]
}
export type ProgressDisposition = 'inactive' | 'active' | 'completed' | 'waiting_approval' | 'waiting_input' | 'background' | 'progressing' | 'unresolved_operation' | Reason
export interface ProgressWorkObservation {
  task_id: string
  request_id: string
  intent_revision: number
  run_id: string
  work_id: string
  plan_revision: number
  disposition: ProgressDisposition
  evidence: {
    calls: (ProgressRecordRef & { call_id: string })[]
    progress: ProgressRecordRef[]
    waits: ProgressRecordRef[]
    background: (ProgressRecordRef & { operation_id: string })[]
  }
}
export interface ProgressDiagnosis extends DiagnosisKey {
  task_id: string
  through_sequence: number
  calls: (ProgressRecordRef & { call_id: string })[]
  model_diagnosis: 'eligible' | 'same_evidence' | 'rate_limited' | 'capability_blocked'
  required_role: 'diagnostic'
  automatic_replay: false
  execution_permission: false
  recovery_permission: false
}
export interface RunnerProgressObservation {
  checkpoint: RunnerProgressCheckpoint
  works: ProgressWorkObservation[]
  diagnoses: ProgressDiagnosis[]
}

const recordKeys = ['record_id', 'sequence', 'at', 'owner', 'plan_revision']
function invalid(): never { throw new ContractError('INVALID_PROGRESS_OBSERVATION', 'Progress observation requires bounded current metadata and exact record references') }
function object(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key))
}
function integer(value: unknown, minimum = 0): value is number { return Number.isSafeInteger(value) && (value as number) >= minimum }
function code(value: unknown): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/@-]*$/.test(value)) invalid()
  assertRunnerId(value)
}
function bounded(value: unknown): void {
  try { if (Buffer.byteLength(JSON.stringify(value)) <= RUNNER_LIMITS.index.page_bytes) return } catch { /* No raw value is exposed. */ }
  throw new ContractError('RUNNER_LIMIT_EXCEEDED', 'Progress observation exceeds the bounded metadata page size')
}
function records<T extends ProgressRecordRef>(values: T[], extra: string[], input: RunnerProgressInput, max: number, check: (fact: T) => void): T[] {
  if (!Array.isArray(values) || values.length > max) invalid()
  const ids = new Set<string>(), sequences = new Set<number>()
  for (const fact of values) {
    if (!object(fact, [...recordKeys, ...extra]) || !integer(fact.sequence, 1) || !integer(fact.at) || fact.at > input.now || !integer(fact.plan_revision, 1)) invalid()
    assertRunnerId(fact.record_id, 'record_id')
    const owner = validateRunnerContract('runner_execution_scope', fact.owner)
    if (owner.task_id !== input.goal.task_id || ids.has(fact.record_id) || sequences.has(fact.sequence)) invalid()
    ids.add(fact.record_id); sequences.add(fact.sequence); check(fact)
  }
  return values
}
function reference(value: ProgressRecordRef): ProgressRecordRef {
  return { record_id: value.record_id, sequence: value.sequence, at: value.at, owner: structuredClone(value.owner), plan_revision: value.plan_revision }
}
function callReference(value: ProgressCallFact): ProgressRecordRef & { call_id: string } { return { ...reference(value), call_id: value.call_id } }
function current(fact: ProgressRecordRef, work: LogicalWork): boolean {
  const source = fact.owner
  return source.purpose === 'production' && work.purpose === 'production' && source.task_id === work.task_id && source.request_id === work.request_id && source.intent_revision === work.intent_revision && source.work_id === work.work_id && source.run_id === work.run_id && source.role === work.role && fact.plan_revision === work.plan_revision
}
function sameKey(left: DiagnosisKey, right: DiagnosisKey): boolean {
  return left.request_id === right.request_id && left.intent_revision === right.intent_revision && left.work_id === right.work_id && left.plan_revision === right.plan_revision && left.reason === right.reason && left.pattern === right.pattern && left.error_source === right.error_source
}
function checkpoint(raw: RunnerProgressCheckpoint | undefined, input: RunnerProgressInput): RunnerProgressCheckpoint {
  if (raw === undefined) return { version: 1, task_id: input.goal.task_id, observed_at: input.now, reservations: [] }
  if (!object(raw, ['version', 'task_id', 'observed_at', 'reservations']) || raw.version !== 1 || raw.task_id !== input.goal.task_id || !integer(raw.observed_at) || raw.observed_at > input.now || !Array.isArray(raw.reservations) || raw.reservations.length > PROGRESS_OBSERVATION_BOUNDS.diagnosis_per_window[1]) invalid()
  for (const reservation of raw.reservations) {
    if (!object(reservation, ['request_id', 'intent_revision', 'work_id', 'plan_revision', 'reason', 'pattern', 'error_source', 'at', 'through_sequence']) || !integer(reservation.at) || reservation.at > raw.observed_at || !integer(reservation.intent_revision, 1) || !integer(reservation.plan_revision, 1) || !integer(reservation.through_sequence, 1) || !['repeated_failure', 'suspected_stall'].includes(reservation.reason)) invalid()
    assertRunnerId(reservation.request_id, 'request_id'); assertRunnerId(reservation.work_id, 'work_id'); code(reservation.pattern)
    if (reservation.error_source !== undefined) code(reservation.error_source)
    if (reservation.reason === 'repeated_failure' && !reservation.error_source || reservation.reason === 'suspected_stall' && reservation.error_source !== undefined) invalid()
  }
  return structuredClone(raw)
}

function repeatedQueries(calls: ProgressCallFact[], attemptId: string | undefined, threshold: number): ProgressCallFact[] {
  const seen = new Map<string, ProgressCallFact>()
  const evidence = new Set<ProgressCallFact>()
  let repeats = 0
  for (const call of calls) {
    if (call.owner.attempt_id !== attemptId) continue
    const key = call.query_result_id === undefined ? undefined : `${call.pattern}:${call.query_result_id}`
    const original = key === undefined ? undefined : seen.get(key)
    if (original) {
      repeats++; evidence.add(original); evidence.add(call)
    } else {
      // Novel reads (including continuations) or opaque tool results break the streak.
      repeats = 0; evidence.clear()
      if (key !== undefined) seen.set(key, call)
    }
  }
  return repeats >= threshold ? calls.filter(call => evidence.has(call)) : []
}

// The host supplies facts confirmed against persistent operations and current
// goal requirements. This function never reads content or executes a suggestion.
// Persist its returned checkpoint together with the diagnosis reservation.
export function observeRunnerProgress(input: RunnerProgressInput, previous?: RunnerProgressCheckpoint, overrides: Partial<ProgressObservationConfig> = {}): RunnerProgressObservation {
  const config = progressObservationConfig(overrides)
  if (!object(input, ['now', 'goal', 'works', 'calls', 'progress', 'waits', 'background', 'diagnosis']) || !integer(input.now) || !Array.isArray(input.works) || input.works.length > config.evidence_max_calls || !object(input.diagnosis, ['capability_allowed']) || typeof input.diagnosis.capability_allowed !== 'boolean') invalid()
  const goal = validateRunnerContract('runner_content_plan', input.goal)
  const works = input.works.map(work => validateRunnerContract('runner_logical_work', work))
  if (new Set(works.map(work => work.work_id)).size !== works.length || works.some(work => work.task_id !== goal.task_id || work.purpose !== 'production' || work.request_id !== goal.request_id || work.intent_revision !== goal.intent_revision || work.requirement_ids.some(id => !goal.requirements.some(requirement => requirement.requirement_id === id)))) invalid()
  const calls = records(input.calls, ['call_id', 'pattern', 'outcome', 'error_source', 'query_result_id'], input, config.evidence_max_calls, fact => {
    assertRunnerId(fact.call_id, 'call_id'); code(fact.pattern)
    if (!['success', 'failure', 'unknown', 'not_executed'].includes(fact.outcome)) invalid()
    if (fact.error_source !== undefined) code(fact.error_source)
    if (fact.outcome === 'failure' && !fact.error_source) invalid()
    if (fact.query_result_id !== undefined && (!integer(fact.query_result_id, 1) || fact.outcome !== 'success' || !['read', 'list'].includes(fact.pattern))) invalid()
  })
  const progress = records(input.progress, ['kind', 'requirement_ids'], input, config.evidence_max_calls, fact => {
    if (!['requirement_covered', 'work_advanced', 'artifact_accepted', 'input_consumed'].includes(fact.kind) || !Array.isArray(fact.requirement_ids) || fact.requirement_ids.length === 0 || fact.requirement_ids.length > config.evidence_max_calls || new Set(fact.requirement_ids).size !== fact.requirement_ids.length) invalid()
    for (const id of fact.requirement_ids) assertRunnerId(id, 'requirement_id')
  })
  const waits = records(input.waits, ['kind', 'valid_until'], input, config.evidence_max_calls, fact => {
    if (!['approval', 'input'].includes(fact.kind) || !integer(fact.valid_until) || fact.valid_until < fact.at) invalid()
  })
  const background = records(input.background, ['operation_id', 'valid_until'], input, config.evidence_max_calls, fact => {
    assertRunnerId(fact.operation_id, 'operation_id')
    if (!integer(fact.valid_until) || fact.valid_until < fact.at || fact.valid_until - fact.at > config.window_ms) invalid()
  })
  bounded(input)
  const state = checkpoint(previous, input)
  state.reservations = state.reservations.filter(reservation => input.now - reservation.at < Math.max(config.window_ms, config.diagnosis_interval_ms))
  state.observed_at = input.now
  const observations: ProgressWorkObservation[] = [], diagnoses: ProgressDiagnosis[] = []

  for (const work of works) {
    const latestCalls = new Map<string, ProgressCallFact>()
    for (const call of calls.filter(fact => current(fact, work) && input.now - fact.at < config.window_ms)) {
      const key = JSON.stringify([call.owner.attempt_id, call.call_id]), previousCall = latestCalls.get(key)
      if (!previousCall || previousCall.sequence < call.sequence) latestCalls.set(key, call)
    }
    const workCalls = [...latestCalls.values()].sort((a, b) => a.sequence - b.sequence)
    const workProgress = progress.filter(fact => current(fact, work) && input.now - fact.at < config.window_ms && fact.requirement_ids.every(id => work.requirement_ids.includes(id) && goal.requirements.some(requirement => requirement.requirement_id === id)))
    const workWaits = waits.filter(fact => current(fact, work) && fact.valid_until > input.now && work.current_attempt_id === fact.owner.attempt_id && work.state === 'waiting')
    const workBackground = background.filter(fact => current(fact, work) && fact.valid_until > input.now && work.current_attempt_id === fact.owner.attempt_id && ['running', 'waiting'].includes(work.state))
    const report: ProgressWorkObservation = {
      task_id: goal.task_id, request_id: goal.request_id, intent_revision: goal.intent_revision, run_id: work.run_id, work_id: work.work_id, plan_revision: work.plan_revision, disposition: 'active',
      evidence: { calls: workCalls.map(callReference), progress: workProgress.map(reference), waits: workWaits.map(reference), background: workBackground.map(fact => ({ ...reference(fact), operation_id: fact.operation_id })) }
    }
    observations.push(report)
    if (goal.state !== 'active' || work.role === 'diagnostic' || ['cancelled', 'invalidated', 'dependency_cancelled', 'dependency_failed'].includes(work.state)) { report.disposition = 'inactive'; continue }
    if (work.state === 'succeeded') { report.disposition = 'completed'; continue }
    if (workWaits.length) { report.disposition = workWaits.some(fact => fact.kind === 'approval') ? 'waiting_approval' : 'waiting_input'; continue }
    if (workBackground.length) { report.disposition = 'background'; continue }
    if (workCalls.some(fact => fact.outcome === 'unknown')) { report.disposition = 'unresolved_operation'; continue }

    const groups = new Map<string, { reason: Reason; pattern: string; error_source?: string; calls: ProgressCallFact[] }>()
    for (const call of workCalls) {
      if (call.outcome !== 'failure') continue
      const key = JSON.stringify([call.pattern, call.error_source])
      const group = groups.get(key) ?? { reason: 'repeated_failure', pattern: call.pattern, error_source: call.error_source, calls: [] }
      group.calls.push(call); groups.set(key, group)
    }
    for (const [key, group] of groups) if (group.calls.length < config.repeated_failure_threshold) groups.delete(key)
    if (!workProgress.length && ['running', 'waiting'].includes(work.state)) {
      const repeated = repeatedQueries(workCalls, work.current_attempt_id, config.stalled_repeat_threshold)
      if (repeated.length) {
        const patterns = new Set(repeated.map(call => call.pattern))
        groups.set('stall', { reason: 'suspected_stall', pattern: patterns.size === 1 ? repeated[0]!.pattern : 'mixed_operations', calls: repeated })
      }
    }
    report.disposition = groups.size ? [...groups.values()].some(group => group.reason === 'repeated_failure') ? 'repeated_failure' : 'suspected_stall' : workProgress.length ? 'progressing' : 'active'
    for (const group of groups.values()) {
      const key: DiagnosisKey = { request_id: goal.request_id, intent_revision: goal.intent_revision, work_id: work.work_id, plan_revision: work.plan_revision, reason: group.reason, pattern: group.pattern, ...(group.error_source ? { error_source: group.error_source } : {}) }
      const through = Math.max(...group.calls.map(call => call.sequence))
      let decision: ProgressDiagnosis['model_diagnosis']
      if (state.reservations.some(reservation => sameKey(reservation, key) && reservation.through_sequence >= through)) decision = 'same_evidence'
      else if (!input.diagnosis.capability_allowed) decision = 'capability_blocked'
      else if (state.reservations.filter(reservation => input.now - reservation.at < config.window_ms).length >= config.diagnosis_per_window || state.reservations.some(reservation => input.now - reservation.at < config.diagnosis_interval_ms)) decision = 'rate_limited'
      else {
        decision = 'eligible'
        state.reservations.push({ ...key, at: input.now, through_sequence: through })
      }
      diagnoses.push({ ...key, task_id: goal.task_id, through_sequence: through, calls: group.calls.map(callReference), model_diagnosis: decision, required_role: 'diagnostic', automatic_replay: false, execution_permission: false, recovery_permission: false })
    }
  }
  const result: RunnerProgressObservation = { checkpoint: state, works: observations, diagnoses }
  bounded(result)
  return result
}
