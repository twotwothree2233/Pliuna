import { describe, expect, it } from 'vitest'
import type { ExecutionScope, LogicalWork } from '../../src/shared/contracts.generated'
import { ContractError } from '../../src/shared/validation'
import { PROGRESS_OBSERVATION_BOUNDS, RUNNER_LIMITS } from '../../src/runtime/runner/limits'
import { observeRunnerProgress, type ProgressCallFact, type ProgressRecordRef, type RunnerProgressCheckpoint, type RunnerProgressInput } from '../../src/runtime/runner/progress-observer'

function fixture(now = 100000): RunnerProgressInput {
  return {
    now,
    goal: { task_id: 'task', request_id: 'goal', intent_revision: 2, previous_revision: 1, input_event_id: 'input', state: 'active', requirements: [{ requirement_id: 'answer', kind: 'answer', required: true, provenance_required: true }, { requirement_id: 'artifact', kind: 'artifact', required: true, provenance_required: false }] },
    works: [{ task_id: 'task', run_id: 'run', work_id: 'work', plan_revision: 3, role: 'producer', required: true, requirement_ids: ['answer', 'artifact'], dependencies: [{ kind: 'goal', task_id: 'task', request_id: 'goal', intent_revision: 2 }], state: 'running', max_attempts: 3, current_attempt_id: 'attempt', purpose: 'production', request_id: 'goal', intent_revision: 2 }],
    calls: [], progress: [], waits: [], background: [], diagnosis: { capability_allowed: true }
  }
}
function owner(work: LogicalWork): ExecutionScope {
  if (work.purpose !== 'production') throw new Error('Test requires production work')
  return { task_id: work.task_id, run_id: work.run_id, work_id: work.work_id, attempt_id: work.current_attempt_id!, role: work.role, purpose: 'production', request_id: work.request_id, intent_revision: work.intent_revision }
}
function ref(input: RunnerProgressInput, sequence: number, work = input.works[0]!): ProgressRecordRef {
  return { record_id: `record-${sequence}`, sequence, at: input.now - 100, owner: owner(work), plan_revision: work.plan_revision }
}
function call(input: RunnerProgressInput, sequence: number, outcome: ProgressCallFact['outcome'] = 'success', work = input.works[0]!): ProgressCallFact {
  return { ...ref(input, sequence, work), call_id: `call-${sequence}`, pattern: 'plugin:lookup', outcome, ...(outcome === 'failure' ? { error_source: 'LOOKUP_FAILED' } : {}) }
}
function activity(input: RunnerProgressInput, count: number = RUNNER_LIMITS.progress.stalled_success_threshold, outcome: ProgressCallFact['outcome'] = 'success'): RunnerProgressInput {
  input.calls = Array.from({ length: count }, (_, i) => call(input, i + 1, outcome))
  return input
}
function errorWithoutContent(run: () => unknown): void {
  try { run(); throw new Error('Expected rejection') } catch (error) {
    expect(error).toBeInstanceOf(ContractError)
    expect(String(error)).not.toContain('SECRET BODY')
  }
}

describe('deterministic runner progress observation', () => {
  it('records suspected spinning from successful calls without claiming execution permission', () => {
    const input = activity(fixture()), result = observeRunnerProgress(input)
    expect(result.works[0]!.disposition).toBe('suspected_stall')
    expect(result.diagnoses).toHaveLength(1)
    expect(result.diagnoses[0]).toMatchObject({ task_id: 'task', request_id: 'goal', intent_revision: 2, work_id: 'work', plan_revision: 3, reason: 'suspected_stall', pattern: 'plugin:lookup', through_sequence: 8, model_diagnosis: 'eligible', required_role: 'diagnostic', automatic_replay: false, execution_permission: false, recovery_permission: false })
    expect(result.diagnoses[0]!.calls.map(call => call.record_id)).toEqual(input.calls.map(call => call.record_id))
    expect(result.diagnoses[0]!.calls[0]!.owner).toEqual(owner(input.works[0]!))
    expect(result.checkpoint.reservations).toHaveLength(1)
  })

  it('requires the configured number of distinct calls in the bounded window', () => {
    const input = activity(fixture(), RUNNER_LIMITS.progress.stalled_success_threshold - 1)
    expect(observeRunnerProgress(input).diagnoses).toEqual([])
    input.calls.push(call(input, 8))
    input.calls[0]!.at = input.now - RUNNER_LIMITS.progress.window_ms
    expect(observeRunnerProgress(input).diagnoses).toEqual([])
    input.calls[0]!.at++
    expect(observeRunnerProgress(input).diagnoses[0]!.reason).toBe('suspected_stall')
  })

  it('recognizes mixed successful operation patterns without treating success as goal progress', () => {
    const input = activity(fixture())
    for (let i = 0; i < input.calls.length; i++) input.calls[i]!.pattern = i % 2 ? 'read:directory' : 'read:status'
    expect(observeRunnerProgress(input).diagnoses[0]).toMatchObject({ reason: 'suspected_stall', pattern: 'mixed_operations' })
  })

  it.each(['requirement_covered', 'work_advanced', 'artifact_accepted', 'input_consumed'] as const)('accepts verified goal progress before anything is published: %s', kind => {
    const input = activity(fixture())
    input.progress.push({ ...ref(input, 100), kind, requirement_ids: ['answer'] })
    const result = observeRunnerProgress(input)
    expect(result.works[0]!.disposition).toBe('progressing')
    expect(result.works[0]!.evidence.progress.map(value => value.record_id)).toEqual(['record-100'])
    expect(result.diagnoses).toEqual([])
    expect(result).not.toHaveProperty('published')
  })

  it('does not count unrelated requirements, old goal revisions or previous plans as current progress', () => {
    const input = activity(fixture())
    input.progress.push(
      { ...ref(input, 100), kind: 'work_advanced', requirement_ids: ['unknown-requirement'] },
      { ...ref(input, 101), owner: { ...owner(input.works[0]!), intent_revision: 1 } as ExecutionScope, kind: 'artifact_accepted', requirement_ids: ['answer'] },
      { ...ref(input, 102), plan_revision: 2, kind: 'work_advanced', requirement_ids: ['answer'] }
    )
    expect(observeRunnerProgress(input).works[0]!.disposition).toBe('suspected_stall')
    input.calls.forEach(call => { call.plan_revision = 2 })
    const result = observeRunnerProgress(input)
    expect(result.diagnoses).toEqual([])
    expect(result.works[0]!.evidence.calls).toEqual([])
  })

  it.each(['approval', 'input'] as const)('classifies a valid %s wait as normal even when it started outside the window', kind => {
    const input = activity(fixture())
    input.works[0]!.state = 'waiting'
    input.waits.push({ ...ref(input, 100), at: 1, kind, valid_until: input.now + 10000 })
    const result = observeRunnerProgress(input)
    expect(result.works[0]!.disposition).toBe(kind === 'approval' ? 'waiting_approval' : 'waiting_input')
    expect(result.diagnoses).toEqual([])
    expect(result.works[0]!.evidence.waits[0]!.record_id).toBe('record-100')
  })

  it('distinguishes confirmed background execution from an unsubstantiated running label', () => {
    const input = activity(fixture())
    input.background.push({ ...ref(input, 100), operation_id: 'operation', valid_until: input.now + 10000 })
    const active = observeRunnerProgress(input)
    expect(active.works[0]!.disposition).toBe('background')
    expect(active.works[0]!.evidence.background[0]!.operation_id).toBe('operation')
    expect(active.diagnoses).toEqual([])
    input.background[0]!.valid_until = input.now
    expect(observeRunnerProgress(input).works[0]!.disposition).toBe('suspected_stall')
  })

  it('does not let expired or old-attempt wait and background facts conceal a stall', () => {
    const input = activity(fixture())
    input.works[0]!.state = 'waiting'
    input.waits.push({ ...ref(input, 100), kind: 'approval', valid_until: input.now })
    input.background.push({ ...ref(input, 101), owner: { ...owner(input.works[0]!), attempt_id: 'old-attempt' }, operation_id: 'old-operation', valid_until: input.now + 10000 })
    const result = observeRunnerProgress(input)
    expect(result.works[0]!.disposition).toBe('suspected_stall')
    expect(result.works[0]!.evidence.waits).toEqual([])
    expect(result.works[0]!.evidence.background).toEqual([])
  })

  it('retains unknown operation evidence and never turns it into a replay recommendation', () => {
    const input = activity(fixture())
    input.calls.push(call(input, 100, 'unknown'))
    const result = observeRunnerProgress(input)
    expect(result.works[0]!.disposition).toBe('unresolved_operation')
    expect(result.diagnoses).toEqual([])
    expect(result.works[0]!.evidence.calls.at(-1)!.call_id).toBe('call-100')
    expect(result.checkpoint.reservations).toEqual([])
  })

  it('uses the latest persisted disposition of the same call without inflating success counts', () => {
    const input = activity(fixture())
    for (const value of input.calls) value.call_id = 'same-call'
    expect(observeRunnerProgress(input).diagnoses).toEqual([])
    input.calls[0]!.outcome = 'unknown'
    expect(observeRunnerProgress(input).works[0]!.disposition).toBe('active')
    const result = observeRunnerProgress(input)
    expect(result.works[0]!.evidence.calls.map(value => value.sequence)).toEqual([8])
  })

  it('groups repeated identifiable failures by work, goal revision, operation and error source', () => {
    const input = activity(fixture(), 3, 'failure')
    input.calls.push({ ...call(input, 4, 'failure'), error_source: 'DIFFERENT_FAILURE' })
    input.progress.push({ ...ref(input, 100), kind: 'work_advanced', requirement_ids: ['answer'] })
    const result = observeRunnerProgress(input)
    expect(result.works[0]!.disposition).toBe('repeated_failure')
    expect(result.diagnoses[0]).toMatchObject({ reason: 'repeated_failure', pattern: 'plugin:lookup', error_source: 'LOOKUP_FAILED', through_sequence: 3 })
    expect(result.diagnoses[0]!.calls.map(value => value.sequence)).toEqual([1, 2, 3])
    expect(result.diagnoses).toHaveLength(1)
  })

  it('keeps concurrent work evidence distinct, including identical call IDs', () => {
    const input = activity(fixture(), 3, 'failure'), second = { ...input.works[0]!, work_id: 'other-work', current_attempt_id: 'other-attempt' }
    input.works.push(second)
    input.calls.push(...Array.from({ length: 3 }, (_, i) => ({ ...call(input, i + 10, 'failure', second), call_id: `call-${i + 1}` })))
    const result = observeRunnerProgress(input)
    expect(result.diagnoses.map(value => value.work_id)).toEqual(['work', 'other-work'])
    expect(result.diagnoses.map(value => value.calls.map(call => call.sequence))).toEqual([[1, 2, 3], [10, 11, 12]])
    expect(result.diagnoses.map(value => value.model_diagnosis)).toEqual(['eligible', 'rate_limited'])
  })

  it.each(['succeeded', 'cancelled', 'invalidated', 'dependency_failed', 'dependency_cancelled'] as const)('does not diagnose historical success activity for a %s work', state => {
    const input = activity(fixture()); input.works[0]!.state = state
    expect(observeRunnerProgress(input).diagnoses).toEqual([])
  })

  it('does not diagnose a withdrawn goal or recursively diagnose diagnostic work', () => {
    const input = activity(fixture()); input.goal.state = 'withdrawn'
    expect(observeRunnerProgress(input).works[0]!.disposition).toBe('inactive')
    input.goal.state = 'active'; input.works[0]!.role = 'diagnostic'
    for (const call of input.calls) call.owner.role = 'diagnostic'
    expect(observeRunnerProgress(input).diagnoses).toEqual([])
  })
})

describe('persistent bounded diagnosis reservations', () => {
  it('reuses a JSON checkpoint across process restart without re-diagnosing the same evidence', () => {
    const input = activity(fixture()), first = observeRunnerProgress(input)
    const restored: RunnerProgressCheckpoint = JSON.parse(JSON.stringify(first.checkpoint))
    const second = observeRunnerProgress(input, restored)
    expect(second.diagnoses[0]!.model_diagnosis).toBe('same_evidence')
    expect(second.checkpoint.reservations).toHaveLength(1)
    expect(restored).toEqual(first.checkpoint)
    expect(observeRunnerProgress(input, restored)).toEqual(second)
  })

  it('enforces the task-wide frequency cap when new evidence or a new goal revision arrives', () => {
    const input = activity(fixture()), first = observeRunnerProgress(input)
    input.now += 10000; input.calls.push(call(input, 9))
    expect(observeRunnerProgress(input, first.checkpoint).diagnoses[0]!.model_diagnosis).toBe('rate_limited')
    input.goal.intent_revision = 3; input.goal.previous_revision = 2
    const work = input.works[0]!
    if (work.purpose === 'production') work.intent_revision = 3
    for (const value of input.calls) if (value.owner.purpose === 'production') value.owner.intent_revision = 3
    expect(observeRunnerProgress(input, first.checkpoint).diagnoses[0]!.model_diagnosis).toBe('rate_limited')
  })

  it('retains the interval limit when it outlasts the evidence window', () => {
    const overrides = { window_ms: 1000, diagnosis_interval_ms: 10000 }
    const firstInput = activity(fixture()), first = observeRunnerProgress(firstInput, undefined, overrides)
    const early = activity(fixture(firstInput.now + 2000))
    early.calls.forEach(value => { value.sequence += 20; value.record_id += '-new'; value.call_id += '-new' })
    expect(observeRunnerProgress(early, first.checkpoint, overrides).diagnoses[0]!.model_diagnosis).toBe('rate_limited')
    const later = activity(fixture(firstInput.now + 10000))
    expect(observeRunnerProgress(later, first.checkpoint, overrides).diagnoses[0]!.model_diagnosis).toBe('eligible')
  })

  it('requires host capability before reserving diagnostic work', () => {
    const input = activity(fixture()); input.diagnosis = { capability_allowed: false }
    const result = observeRunnerProgress(input)
    expect(result.diagnoses[0]!.model_diagnosis).toBe('capability_blocked')
    expect(result.checkpoint.reservations).toEqual([])
    expect(result.diagnoses[0]!.execution_permission).toBe(false)
  })

  it('retains the diagnosis interval across distinct failure groups', () => {
    const input = activity(fixture(), 3, 'failure')
    input.calls.push(...Array.from({ length: 3 }, (_, i) => ({ ...call(input, i + 10, 'failure'), error_source: 'OTHER_ERROR' })))
    const result = observeRunnerProgress(input, undefined, { diagnosis_per_window: 2 })
    expect(result.diagnoses.map(value => value.model_diagnosis)).toEqual(['eligible', 'rate_limited'])
    expect(result.checkpoint.reservations).toHaveLength(1)
  })

  it('exposes frozen central bounds and rejects a frequency bypass through configuration', () => {
    expect(Object.isFrozen(PROGRESS_OBSERVATION_BOUNDS)).toBe(true)
    expect(Object.isFrozen(PROGRESS_OBSERVATION_BOUNDS.diagnosis_per_window)).toBe(true)
    for (const config of [{ diagnosis_per_window: 100 }, { diagnosis_interval_ms: 0 }, { window_ms: 0 }, { evidence_max_calls: Infinity }]) errorWithoutContent(() => observeRunnerProgress(activity(fixture()), undefined, config))
  })
})

describe('progress metadata validation', () => {
  it.each([
    (input: RunnerProgressInput) => { Object.assign(input.calls[0]!, { error_text: 'SECRET BODY' }) },
    (input: RunnerProgressInput) => { input.calls[0]!.error_source = 'SECRET BODY' },
    (input: RunnerProgressInput) => { input.calls[0]!.pattern = 'SECRET BODY' },
    (input: RunnerProgressInput) => { Object.assign(input.progress, { summary: 'SECRET BODY' }); Object.assign(input, { summary: 'SECRET BODY' }) },
    (input: RunnerProgressInput) => { input.calls[0]!.owner.task_id = 'different-task' },
    (input: RunnerProgressInput) => { input.calls[0]!.at = input.now + 1 },
    (input: RunnerProgressInput) => { input.calls.push({ ...input.calls[0]! }) },
    (input: RunnerProgressInput) => { input.calls = Array.from({ length: RUNNER_LIMITS.progress.evidence_max_calls + 1 }, (_, i) => call(input, i + 1)) },
    (input: RunnerProgressInput) => { input.background.push({ ...ref(input, 100), operation_id: 'operation', valid_until: input.now + RUNNER_LIMITS.progress.window_ms }) },
    (input: RunnerProgressInput) => { input.works[0]!.requirement_ids.push('unknown-requirement') }
  ])('rejects unbounded facts and body-bearing or inaccurate inputs: %#', change => {
    const input = activity(fixture()); change(input)
    errorWithoutContent(() => observeRunnerProgress(input))
  })

  it.each([
    (value: RunnerProgressCheckpoint) => { value.task_id = 'other-task' },
    (value: RunnerProgressCheckpoint) => { value.observed_at++ },
    (value: RunnerProgressCheckpoint) => { Object.assign(value, { summary: 'SECRET BODY' }) },
    (value: RunnerProgressCheckpoint) => { value.reservations[0]!.pattern = 'SECRET BODY' },
    (value: RunnerProgressCheckpoint) => { value.reservations = Array.from({ length: PROGRESS_OBSERVATION_BOUNDS.diagnosis_per_window[1] + 1 }, () => ({ ...value.reservations[0]! })) }
  ])('rejects checkpoints with another scope, body text or excessive history: %#', change => {
    const input = activity(fixture()), value = observeRunnerProgress(input).checkpoint; change(value)
    errorWithoutContent(() => observeRunnerProgress(input, value))
  })
})
