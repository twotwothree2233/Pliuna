import type { ExecutionScope } from '../../shared/contracts.generated'
import { validateRunnerContract } from '../../shared/runner-validation'
import { ContractError } from '../../shared/validation'
import type { ChatMessage } from '../model/adapter'
import type { ContextRecovery } from '../model/agent'
import { assertRunnerId, PROGRESS_OBSERVATION_BOUNDS, RUNNER_LIMITS } from './limits'
import type { ProgressDiagnosis } from './progress-observer'
import { createWorkerProfile, type WorkerProfile } from './worker-profile'

export interface RunnerDiagnosticResult {
  version: 1
  assessment: ProgressDiagnosis['reason'] | 'inconclusive'
  evidence_record_ids: string[]
  recommendation: 'review_goal' | 'review_dependency' | 'review_configuration' | 'wait_for_external_result' | 'none'
  automatic_replay: false
  execution_permission: false
  recovery_permission: false
}
export interface RunnerDiagnostic {
  readonly profile: WorkerProfile<RunnerDiagnosticResult>
  readonly source: Readonly<ProgressDiagnosis>
  initial(): ChatMessage[]
  context(messages: ChatMessage[], recovery?: ContextRecovery): Promise<ChatMessage[]>
  reserve(): void
}

const system = `You diagnose bounded runner activity from host-confirmed metadata only.
Return one JSON object with version:1, assessment, evidence_record_ids, recommendation,
automatic_replay:false, execution_permission:false, recovery_permission:false.
assessment is the observed reason or inconclusive. recommendation is review_goal,
review_dependency, review_configuration, wait_for_external_result, or none.
Cite only supplied record IDs. You have no tools, content access, replay or recovery
permission. Your result is an internal suggestion and cannot execute an action.`
function invalid(): never { throw new ContractError('INVALID_RUNNER_DIAGNOSIS', 'Diagnosis requires bounded metadata, exact evidence and no execution permission') }
function object(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key))
}
function integer(value: unknown, minimum = 0): value is number { return Number.isSafeInteger(value) && (value as number) >= minimum }
function code(value: unknown): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/@-]*$/.test(value)) invalid()
  assertRunnerId(value)
}
function bounded(value: unknown, maximum: number = RUNNER_LIMITS.index.page_bytes): string {
  try { const json = JSON.stringify(value); if (json && Buffer.byteLength(json) <= maximum) return json } catch { /* Do not expose rejected input. */ }
  return invalid()
}
function metadata(raw: ProgressDiagnosis): ProgressDiagnosis {
  const value = JSON.parse(bounded(raw)) as ProgressDiagnosis
  if (!object(value, ['task_id', 'request_id', 'intent_revision', 'work_id', 'plan_revision', 'reason', 'pattern', 'error_source', 'through_sequence', 'calls', 'model_diagnosis', 'required_role', 'automatic_replay', 'execution_permission', 'recovery_permission']) || !integer(value.intent_revision, 1) || !integer(value.plan_revision, 1) || !integer(value.through_sequence, 1) || !['repeated_failure', 'suspected_stall'].includes(value.reason) || value.model_diagnosis !== 'eligible' || value.required_role !== 'diagnostic' || value.automatic_replay !== false || value.execution_permission !== false || value.recovery_permission !== false || !Array.isArray(value.calls) || value.calls.length === 0 || value.calls.length > PROGRESS_OBSERVATION_BOUNDS.evidence_max_calls[1]) invalid()
  for (const key of ['task_id', 'request_id', 'work_id'] as const) assertRunnerId(value[key], key)
  code(value.pattern)
  if (value.error_source !== undefined) code(value.error_source)
  if (value.reason === 'repeated_failure' ? !value.error_source : value.error_source !== undefined) invalid()
  const records = new Set<string>(), sequences = new Set<number>()
  for (const call of value.calls) {
    if (!object(call, ['record_id', 'sequence', 'at', 'owner', 'plan_revision', 'call_id']) || !integer(call.sequence, 1) || !integer(call.at) || call.plan_revision !== value.plan_revision || call.sequence > value.through_sequence || records.has(call.record_id) || sequences.has(call.sequence)) invalid()
    assertRunnerId(call.record_id, 'record_id'); assertRunnerId(call.call_id, 'call_id')
    const owner: ExecutionScope = validateRunnerContract('runner_execution_scope', call.owner)
    if (owner.purpose !== 'production' || owner.role === 'diagnostic' || owner.task_id !== value.task_id || owner.request_id !== value.request_id || owner.intent_revision !== value.intent_revision || owner.work_id !== value.work_id) invalid()
    records.add(call.record_id); sequences.add(call.sequence)
  }
  if (Math.max(...sequences) !== value.through_sequence) invalid()
  return value
}

// A diagnosis gets one ordinary, accounted model request. Its local context
// rebuild never reads a Task summary, tool body or another Worker's history.
export function createRunnerDiagnostic(raw: ProgressDiagnosis): RunnerDiagnostic {
  const source = metadata(raw), recordIds = new Set(source.calls.map(call => call.record_id))
  const profile = createWorkerProfile<RunnerDiagnosticResult>({
    id: 'runner-diagnostic-v1', role: 'diagnostic', system, grants: [],
    parseResult(response) {
      let value: unknown
      try { if (Buffer.byteLength(response.text) > RUNNER_LIMITS.index.item_bytes) return invalid(); value = JSON.parse(response.text) } catch { return invalid() }
      if (response.calls.length || !object(value, ['version', 'assessment', 'evidence_record_ids', 'recommendation', 'automatic_replay', 'execution_permission', 'recovery_permission']) || value.version !== 1 || ![source.reason, 'inconclusive'].includes(value.assessment as string) || !['review_goal', 'review_dependency', 'review_configuration', 'wait_for_external_result', 'none'].includes(value.recommendation as string) || value.automatic_replay !== false || value.execution_permission !== false || value.recovery_permission !== false || !Array.isArray(value.evidence_record_ids) || !value.evidence_record_ids.length || value.evidence_record_ids.length > recordIds.size || new Set(value.evidence_record_ids).size !== value.evidence_record_ids.length || value.evidence_record_ids.some(id => typeof id !== 'string' || !recordIds.has(id))) invalid()
      return JSON.parse(bounded(value, RUNNER_LIMITS.index.item_bytes)) as RunnerDiagnosticResult
    }
  })
  let compact = false, requests = 0
  const initial = (): ChatMessage[] => [{ role: 'user', content: bounded({ ...source, calls: compact ? source.calls.slice(-Math.min(source.calls.length, RUNNER_LIMITS.progress.repeated_failure_threshold)) : source.calls }) }]
  return Object.freeze({
    profile, get source() { return structuredClone(source) }, initial,
    async context(_messages: ChatMessage[], recovery?: ContextRecovery): Promise<ChatMessage[]> {
      if (recovery) compact = true
      const messages: ChatMessage[] = [{ role: 'system', content: system }, ...initial()]
      bounded(messages)
      return messages
    },
    reserve(): void {
      if (requests >= 1) throw new ContractError('RUNNER_DIAGNOSTIC_LIMIT', 'A diagnosis permits one model request and no tool execution')
      requests++
    }
  })
}
