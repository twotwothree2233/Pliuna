import { expect, it } from 'vitest'
import { createRunnerDiagnostic, type RunnerDiagnosticResult } from '../../src/runtime/runner/diagnostic'
import type { ProgressDiagnosis } from '../../src/runtime/runner/progress-observer'

function diagnosis(): ProgressDiagnosis {
  const owner = { purpose: 'production' as const, task_id: 'task', request_id: 'goal', intent_revision: 2, run_id: 'run', work_id: 'work', attempt_id: 'attempt', role: 'producer' as const }
  return { task_id: 'task', request_id: 'goal', intent_revision: 2, work_id: 'work', plan_revision: 3, reason: 'suspected_stall', pattern: 'read', through_sequence: 8, calls: Array.from({ length: 8 }, (_, index) => ({ record_id: `record-${index + 1}`, sequence: index + 1, at: 1000 + index, owner, plan_revision: 3, call_id: `call-${index + 1}` })), model_diagnosis: 'eligible', required_role: 'diagnostic', automatic_replay: false, execution_permission: false, recovery_permission: false }
}
const result = (): RunnerDiagnosticResult => ({ version: 1, assessment: 'suspected_stall', evidence_record_ids: ['record-8'], recommendation: 'review_goal', automatic_replay: false, execution_permission: false, recovery_permission: false })
const response = (value: unknown) => ({ text: JSON.stringify(value), calls: [], finish: 'stop' as const })

it('rebuilds only bounded diagnosis metadata and never reuses live content or summaries', async () => {
  const diagnostic = createRunnerDiagnostic(diagnosis()), secret = 'PRIVATE TASK BODY AND TOOL ERROR'
  const full = await diagnostic.context([{ role: 'user', content: secret }, { role: 'tool', tool_call_id: 'injected', content: secret }])
  expect(JSON.stringify(full)).not.toContain(secret)
  expect(JSON.parse(full[1]!.content!).calls).toHaveLength(8)
  const compact = await diagnostic.context(full, { overflow: true, partial: secret })
  expect(JSON.parse(compact[1]!.content!).calls).toHaveLength(3)
  expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(full).length)
  expect(JSON.stringify(compact)).not.toContain(secret)
  const copy = diagnostic.source; copy.calls[0]!.record_id = 'mutated'
  expect(diagnostic.source.calls[0]!.record_id).toBe('record-1')
})

it('has no tool grants and permits one model request for a diagnosis', () => {
  const diagnostic = createRunnerDiagnostic(diagnosis())
  expect(diagnostic.profile.tools).toEqual([])
  for (const request of [{ type: 'read', input: { target: { kind: 'resource', id: 'body' } } }, { type: 'list', input: { kind: 'event' } }, { type: 'call', input: { capability: 'plugin:execution', arguments: {} } }, { type: 'write', input: { type: 'task_data.remove', id: 'data', expected_revision: 1 } }]) expect(() => diagnostic.profile.authorize(request)).toThrowError(expect.objectContaining({ code: 'WORKER_CAPABILITY_DENIED' }))
  diagnostic.reserve()
  expect(() => diagnostic.reserve()).toThrowError(expect.objectContaining({ code: 'RUNNER_DIAGNOSTIC_LIMIT' }))
})

it('accepts only known evidence and a bounded internal suggestion without execution permission', () => {
  const diagnostic = createRunnerDiagnostic(diagnosis())
  expect(diagnostic.profile.parseResult(response(result()))).toEqual(result())
  for (const value of [{ ...result(), execution_permission: true }, { ...result(), automatic_replay: true }, { ...result(), recovery_permission: true }, { ...result(), evidence_record_ids: ['other-record'] }, { ...result(), evidence_record_ids: ['record-8', 'record-8'] }, { ...result(), action: 'replay' }, { ...result(), assessment: 'repeated_failure' }]) expect(() => diagnostic.profile.parseResult(response(value))).toThrowError(expect.objectContaining({ code: 'INVALID_RUNNER_DIAGNOSIS' }))
  for (const value of [{ ...diagnosis(), body: 'PRIVATE' }, { ...diagnosis(), calls: [{ ...diagnosis().calls[0]!, body: 'PRIVATE' }] }, { ...diagnosis(), model_diagnosis: 'budget_blocked' }, { ...diagnosis(), execution_permission: true }]) expect(() => createRunnerDiagnostic(value as ProgressDiagnosis)).toThrowError()
})
