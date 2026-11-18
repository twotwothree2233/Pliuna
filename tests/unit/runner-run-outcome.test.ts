import { expect, it } from 'vitest'
import type { ExecutionAttempt, LogicalWork, RunnerRun } from '../../src/shared/contracts.generated'
import { aggregateRunOutcome, type RunOutcomeInput } from '../../src/runtime/runner/run-outcome'

type ProductionRun = Extract<RunnerRun, { purpose: 'production' }>
type ProductionWork = Extract<LogicalWork, { purpose: 'production' }>
type ProductionAttempt = Extract<ExecutionAttempt, { purpose: 'production' }>
function run(patch: Partial<ProductionRun> = {}): ProductionRun {
  return { run_id: 'run', task_id: 'task', runtime_epoch: 'epoch', state: 'running', commit_valid: true, budget_id: 'budget', purpose: 'production', request_id: 'goal', intent_revision: 1, ...patch }
}
function work(id: string, state: ProductionWork['state'] = 'succeeded', patch: Partial<ProductionWork> = {}): ProductionWork {
  return { work_id: id, task_id: 'task', run_id: 'run', plan_revision: 1, role: 'producer', required: true, requirement_ids: ['content'], dependencies: [], state, ...(['planned', 'invalidated', 'dependency_failed', 'dependency_cancelled'].includes(state) ? {} : { current_attempt_id: `attempt-${id}` }), max_attempts: 2, purpose: 'production', request_id: 'goal', intent_revision: 1, ...patch }
}
function attempt(id: string, state: ProductionAttempt['state'] = 'succeeded', patch: Partial<ProductionAttempt> = {}): ProductionAttempt {
  const undispatched = ['registered', 'queued', 'revoked'].includes(state)
  return { attempt_id: `attempt-${id}`, task_id: 'task', run_id: 'run', work_id: id, runtime_epoch: 'epoch', attempt_number: 1, profile_id: 'producer', model_config_id: 'model', model_config_revision: 1, input_versions: [], state, dispatch_state: state === 'unknown' ? 'unknown' : undispatched ? 'not_dispatched' : 'dispatched', ...(undispatched ? {} : { operation_id: `operation-${id}` }), usage_refs: [], purpose: 'production', request_id: 'goal', intent_revision: 1, ...patch }
}
function facts(works: ProductionWork[], patch: Partial<RunOutcomeInput> = {}): RunOutcomeInput {
  return { run: run(), works, attempts: works.flatMap(item => item.current_attempt_id ? [attempt(item.work_id, item.state === 'queued' ? 'queued' : item.state === 'running' ? 'running' : item.state === 'waiting' ? 'waiting' : item.state === 'failed' ? 'failed' : item.state === 'cancelled' ? 'cancelled' : 'succeeded')] : []), ...patch }
}

it.each(['run', 'task'] as const)('gives an accepted %s cancellation precedence over required failure', cancellation => {
  const result = aggregateRunOutcome(facts([work('failed', 'failed'), work('cancelled', 'cancelled'), work('finished')], { cancellation }))
  expect(result).toMatchObject({ phase: 'closing', outcome: 'cancelled', release_production_slot: false })
})

it('retains both causes and gives required failure precedence over a local cancellation', () => {
  const failed = work('failed', 'failed', { root_cause: { kind: 'failure', work_id: 'failed', attempt_id: 'attempt-failed' } })
  const cancelled = work('cancelled', 'cancelled', { root_cause: { kind: 'cancellation', work_id: 'cancelled' } })
  const input = facts([cancelled, failed])
  const original = structuredClone(input)
  expect(aggregateRunOutcome(input)).toMatchObject({ phase: 'closing', outcome: 'failed' })
  expect(input).toEqual(original)
})

it.each(['cancelled', 'dependency_cancelled'] as const)('gives necessary %s precedence over other success', state => {
  expect(aggregateRunOutcome(facts([work('finished'), work('cancelled', state, { root_cause: { kind: 'cancellation', work_id: 'upstream' } })]))).toMatchObject({ phase: 'closing', outcome: 'cancelled' })
})

it('keeps an inherited cancellation from becoming an independent failure', () => {
  const downstream = work('downstream', 'dependency_failed', { root_cause: { kind: 'cancellation', work_id: 'upstream' } })
  expect(aggregateRunOutcome(facts([downstream]))).toMatchObject({ phase: 'closing', outcome: 'cancelled' })
})

it('counts an inherited failure without inventing an executed downstream attempt', () => {
  const downstream = work('downstream', 'dependency_failed', { root_cause: { kind: 'failure', work_id: 'upstream', attempt_id: 'original-attempt' } })
  const input = facts([downstream])
  expect(input.attempts).toEqual([])
  expect(aggregateRunOutcome(input)).toMatchObject({ phase: 'closing', outcome: 'failed', queued_attempt_ids: [], unknown_attempt_ids: [] })
})

it('ignores optional failures and cancellations when the required work succeeds', () => {
  expect(aggregateRunOutcome(facts([work('required'), work('optional-failed', 'failed', { required: false }), work('optional-cancelled', 'cancelled', { required: false })]))).toMatchObject({ phase: 'closing', outcome: 'completed', cancel_work_ids: [], release_production_slot: false })
})

it('reports all remaining optional work and undispatched attempts to the closer', () => {
  const input = facts([work('required'), work('running', 'running', { required: false }), work('waiting', 'waiting', { required: false }), work('queued', 'queued', { required: false }), work('planned', 'planned', { required: false })])
  expect(aggregateRunOutcome(input)).toMatchObject({ phase: 'closing', outcome: 'completed', cancel_work_ids: ['planned', 'queued', 'running', 'waiting'], queued_attempt_ids: ['attempt-queued'], release_production_slot: false })
})

it.each(['planned', 'queued', 'running', 'waiting'] as const)('keeps necessary %s work unfinished after another work succeeds', state => {
  expect(aggregateRunOutcome(facts([work('finished'), work('unfinished', state)]))).toMatchObject({ phase: 'active', pending_work_ids: ['unfinished'], release_production_slot: false })
})

it('continues unrelated necessary work after a known necessary failure', () => {
  expect(aggregateRunOutcome(facts([work('failed', 'failed'), work('independent', 'running')]))).toMatchObject({ phase: 'active', state: 'running', pending_work_ids: ['independent'] })
})

it('does not complete an empty plan vacuously', () => {
  expect(aggregateRunOutcome(facts([]))).toMatchObject({ phase: 'active', state: 'waiting', pending_work_ids: [] })
})

it('preserves each wait source while another owner is running', () => {
  const input = facts([work('approval', 'running'), work('input', 'waiting'), work('active', 'running')], { states: [
    { work_id: 'approval', attempt_id: 'attempt-approval', state: 'waiting', reason: 'approval', operation_id: 'approval-operation' },
    { work_id: 'input', attempt_id: 'attempt-input', state: 'waiting', reason: 'user_input', operation_id: 'input-operation' },
    { work_id: 'active', attempt_id: 'attempt-active', state: 'running' }
  ] })
  expect(aggregateRunOutcome(input)).toMatchObject({ phase: 'active', state: 'running', waits: [
    { work_id: 'approval', attempt_id: 'attempt-approval', reason: 'approval', operation_id: 'approval-operation' },
    { work_id: 'input', attempt_id: 'attempt-input', reason: 'user_input', operation_id: 'input-operation' }
  ] })
})

it('waits when every unfinished owner is waiting without clearing other reasons', () => {
  const input = facts([work('first', 'running'), work('second', 'running')], { states: [
    { work_id: 'first', attempt_id: 'attempt-first', state: 'waiting', reason: 'model_queue' },
    { work_id: 'second', attempt_id: 'attempt-second', state: 'waiting', reason: 'plugin_cleanup', operation_id: 'cleanup-operation' }
  ] })
  expect(aggregateRunOutcome(input)).toMatchObject({ phase: 'active', state: 'waiting', waits: [
    { work_id: 'first', attempt_id: 'attempt-first', reason: 'model_queue' },
    { work_id: 'second', attempt_id: 'attempt-second', reason: 'plugin_cleanup', operation_id: 'cleanup-operation' }
  ] })
})

it('does not let a prior attempt callback affect its successor', () => {
  const input = facts([work('worker', 'running', { current_attempt_id: 'new-attempt' })], { attempts: [attempt('worker', 'failed'), attempt('worker', 'running', { attempt_id: 'new-attempt', attempt_number: 2 })], states: [{ work_id: 'worker', attempt_id: 'attempt-worker', state: 'waiting', reason: 'old_wait' }] })
  expect(aggregateRunOutcome(input)).toMatchObject({ phase: 'active', state: 'running', waits: [], retry_work_ids: [] })
})

it('keeps a failed attempt unfinished while its installed bounded retry remains', () => {
  const input = facts([work('worker', 'waiting')], { attempts: [attempt('worker', 'failed')], states: [{ work_id: 'worker', attempt_id: 'attempt-worker', state: 'waiting', reason: 'old_wait' }] })
  expect(aggregateRunOutcome(input)).toMatchObject({ phase: 'active', state: 'running', pending_work_ids: ['worker'], retry_work_ids: ['worker'], waits: [] })
  expect(input.attempts[0]?.state).toBe('failed')
})

it('does not hold an exhausted failure open for hypothetical replanning', () => {
  const input = facts([work('worker', 'queued')], { attempts: [attempt('worker', 'failed', { attempt_number: 2 })] })
  expect(aggregateRunOutcome(input)).toMatchObject({ phase: 'closing', outcome: 'failed', pending_work_ids: [], cancel_work_ids: [] })
})

it('respects a declared final failure even when its previous retry bound was larger', () => {
  expect(aggregateRunOutcome(facts([work('worker', 'failed')]))).toMatchObject({ phase: 'closing', outcome: 'failed' })
})

it('does not retry a cancelled attempt within an otherwise unused bound', () => {
  const input = facts([work('worker', 'waiting')], { attempts: [attempt('worker', 'cancelled')] })
  expect(aggregateRunOutcome(input)).toMatchObject({ phase: 'closing', outcome: 'cancelled', cancel_work_ids: [] })
})

it('requires reconciliation of an unknown current attempt before retry or completion', () => {
  const input = facts([work('worker', 'waiting', { current_attempt_id: 'unknown-attempt' })], { attempts: [attempt('worker', 'failed'), attempt('worker', 'unknown', { attempt_id: 'unknown-attempt', attempt_number: 2 })], states: [{ work_id: 'worker', attempt_id: 'unknown-attempt', state: 'running' }] })
  expect(aggregateRunOutcome(input)).toMatchObject({ phase: 'active', state: 'waiting', retry_work_ids: [], unknown_attempt_ids: ['unknown-attempt'], waits: [{ work_id: 'worker', attempt_id: 'unknown-attempt', reason: 'operation_unknown', operation_id: 'operation-worker' }] })
})

it('retains an older unknown operation while proposing normal closing', () => {
  const input = facts([work('worker')], { attempts: [attempt('worker', 'unknown', { attempt_id: 'old-unknown' }), attempt('worker', 'succeeded')], run: run({ commit_valid: false }) })
  expect(aggregateRunOutcome(input)).toMatchObject({ phase: 'closing', outcome: 'completed', unknown_attempt_ids: ['old-unknown'], release_production_slot: false })
})

it('keeps explicit cancellation in closing while an unknown effect remains', () => {
  const input = facts([work('worker', 'waiting')], { attempts: [attempt('worker', 'unknown')], cancellation: 'run' })
  expect(aggregateRunOutcome(input)).toMatchObject({ phase: 'closing', outcome: 'cancelled', cancel_work_ids: ['worker'], unknown_attempt_ids: ['attempt-worker'], release_production_slot: false })
})

it('does not infer a Run cancellation from commit revocation', () => {
  expect(aggregateRunOutcome(facts([work('worker', 'running')], { run: run({ commit_valid: false }) }))).toMatchObject({ phase: 'active', state: 'running' })
})

it.each([
  ['revoked', 'attempt_revoked'],
  ['succeeded', 'work_result_pending']
] as const)('waits for the owner after a %s attempt instead of inventing its work outcome', (state, reason) => {
  expect(aggregateRunOutcome(facts([work('worker', 'queued')], { attempts: [attempt('worker', state)] }))).toMatchObject({ phase: 'active', state: 'waiting', retry_work_ids: [], waits: [{ work_id: 'worker', attempt_id: 'attempt-worker', reason }] })
})

it('keeps invalidated required work visible until its effective plan is resolved', () => {
  expect(aggregateRunOutcome(facts([work('invalidated', 'invalidated')]))).toMatchObject({ phase: 'active', state: 'waiting', waits: [{ work_id: 'invalidated', reason: 'work_invalidated' }] })
})

it('retains a precise wait when the current attempt fact is unavailable', () => {
  expect(aggregateRunOutcome(facts([work('worker', 'running')], { attempts: [] }))).toMatchObject({ phase: 'active', state: 'waiting', waits: [{ work_id: 'worker', attempt_id: 'attempt-worker', reason: 'attempt_unavailable' }] })
})

it('never reopens a Run that has already entered closing', () => {
  expect(aggregateRunOutcome(facts([work('worker', 'running')], { run: run({ state: 'closing' }) }))).toMatchObject({ phase: 'closing', outcome: null, pending_work_ids: ['worker'], cancel_work_ids: ['worker'], release_production_slot: false })
})

it.each(['completed', 'failed', 'cancelled', 'interrupted'] as const)('preserves persisted %s after later cancellation or completion callbacks', state => {
  expect(aggregateRunOutcome(facts([work('worker', 'failed')], { run: run({ state, commit_valid: false }), cancellation: 'task' }))).toEqual({ phase: 'terminal', outcome: state, release_production_slot: false })
})

it('ignores other Run histories rather than mixing their waits or failures', () => {
  const input = facts([work('current', 'waiting'), work('other', 'failed', { run_id: 'other-run' })], { attempts: [attempt('current', 'waiting'), attempt('other', 'unknown', { run_id: 'other-run' })], states: [{ work_id: 'other', attempt_id: 'attempt-other', state: 'waiting', reason: 'other_reason' }] })
  expect(aggregateRunOutcome(input)).toMatchObject({ phase: 'active', state: 'waiting', pending_work_ids: ['current'], unknown_attempt_ids: [], waits: [{ work_id: 'current', attempt_id: 'attempt-current', reason: 'work_waiting' }] })
})

it('rejects inconsistent ownership, duplicate facts and a current attempt from another work', () => {
  const invalid = [
    facts([work('worker', 'running', { task_id: 'other-task' })]),
    facts([work('worker', 'running', { request_id: 'other-goal' })]),
    facts([work('worker', 'running')], { attempts: [attempt('worker', 'running', { runtime_epoch: 'old-epoch' })] }),
    facts([work('worker'), work('worker')]),
    facts([work('worker')], { attempts: [attempt('worker'), attempt('worker')] }),
    facts([work('worker')], { attempts: [attempt('other', 'running', { attempt_id: 'attempt-worker' })] })
  ]
  for (const input of invalid) expect(() => aggregateRunOutcome(input)).toThrow('inconsistent ownership')
})

it('is deterministic across fact order and does not mutate frozen owner input', () => {
  const input = facts([work('second', 'waiting'), work('first', 'running')], { states: [
    { work_id: 'second', attempt_id: 'attempt-second', state: 'waiting', reason: 'user_input' },
    { work_id: 'first', attempt_id: 'attempt-first', state: 'waiting', reason: 'approval' }
  ] })
  function freeze(value: unknown): void {
    if (!value || typeof value !== 'object') return
    Object.freeze(value)
    for (const nested of Object.values(value)) freeze(nested)
  }
  const original = structuredClone(input)
  freeze(input)
  const result = aggregateRunOutcome(input)
  expect(aggregateRunOutcome({ ...input, works: [...input.works].reverse(), attempts: [...input.attempts].reverse(), states: [...input.states!].reverse() })).toEqual(result)
  expect(input).toEqual(original)
})
