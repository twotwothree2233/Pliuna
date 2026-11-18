import { expect, it } from 'vitest'
import { RunnerAdmission, admissionWork, type RunnerAdmissionCandidate, type RunnerAdmissionRun, type RunnerAdmissionWork } from '../../src/runtime/runner/admission'
import { RUNNER_LIMITS } from '../../src/runtime/runner/limits'
import type { LogicalWork } from '../../src/shared/contracts.generated'

const candidate = (run: string, id: string, kind: RunnerAdmissionWork['kind'] = 'production', task = 'task'): RunnerAdmissionCandidate => ({ task_id: task, run_id: run, work_id: id, attempt_id: `attempt-${id}`, ...(kind === 'composition' ? { kind, batch_id: `batch-${run}` } : { kind }) })
const run = (id: string, request = id, task = 'task'): RunnerAdmissionRun => ({ task_id: task, run_id: id, request_id: request })

it('defaults to one production Run and explicitly permits the central controlled limit', () => {
  const admission = new RunnerAdmission(), active = [run('a')]
  expect(admission.runWait('task', 'b', [])).toBeNull()
  expect(admission.runWait('task', 'b', active)).toBe('producer-run-limit')
  expect(admission.runWait('task', 'b', active, RUNNER_LIMITS.admission.producer_runs_per_task)).toBeNull()
  expect(admission.runWait('task', 'c', [...active, run('b')], 2)).toBe('producer-run-limit')
  expect(admission.runWait('task', 'a', active, 2)).toBe('request-active')
})

it('retains all supplied waiting, unknown and closing production occupants until the host reconciles them', () => {
  const admission = new RunnerAdmission(), active = [run('waiting'), run('closing')]
  expect(admission.runWait('task', 'ready', active, 2)).toBe('producer-run-limit')
  expect(admission.runWait('task', 'ready', active.slice(0, 1), 2)).toBeNull()
  const unresolved = [candidate('a', 'unknown'), candidate('a', 'closing')]
  expect(admission.wait(candidate('a', 'ready'), unresolved)).toBe('producer-work-limit')
})

it('enforces per-Run, total production and overall Task work limits independently', () => {
  const admission = new RunnerAdmission()
  const producer = Array.from({ length: RUNNER_LIMITS.admission.active_work_per_producer }, (_, n) => candidate('a', `a-${n}`))
  expect(admission.wait(candidate('a', 'extra-a'), producer)).toBe('producer-work-limit')
  expect(admission.wait(candidate('b', 'b'), producer)).toBeNull()
  const production = [...producer, candidate('b', 'b-0'), candidate('b', 'b-1')]
  expect(production).toHaveLength(RUNNER_LIMITS.admission.production_work_per_task)
  expect(admission.wait(candidate('c', 'extra'), production)).toBe('production-work-limit')
  expect(admission.wait(candidate('query', 'light', 'lightweight'), production)).toBeNull()
  const full = [...production, candidate('query', 'light-0', 'lightweight'), candidate('query', 'light-1', 'lightweight')]
  expect(full).toHaveLength(RUNNER_LIMITS.admission.active_work_per_task)
  expect(admission.wait(candidate('composition', 'collator', 'composition'), full)).toBe('task-work-limit')
})

it('bounds composition batches while allowing another work within an already admitted batch', () => {
  const admission = new RunnerAdmission(), active = [candidate('c1', 'one', 'composition'), candidate('c2', 'two', 'composition')]
  expect(active).toHaveLength(RUNNER_LIMITS.admission.composition_batches_per_task)
  expect(admission.wait(candidate('c3', 'three', 'composition'), active)).toBe('composition-batch-limit')
  expect(admission.wait(candidate('c1', 'same-batch', 'composition'), active)).toBeNull()
  expect(admission.wait(candidate('p', 'producer'), active)).toBeNull()
})

it('does not give the same active logical work a second admission opportunity', () => {
  const admission = new RunnerAdmission(), value = candidate('a', 'work')
  expect(admission.wait({ ...value, attempt_id: 'new-attempt' } as RunnerAdmissionCandidate, [value])).toBe('work-active')
  expect(admission.next('task', [value], [value], () => true)).toBeNull()
})

it('deduplicates the same persistent occupancy when several evidence records reference it', () => {
  const admission = new RunnerAdmission(), value = candidate('a', 'work')
  expect(admission.wait(candidate('a', 'other'), [value, { ...value }])).toBeNull()
  expect(admission.runWait('task', 'other', [run('a'), run('a')], 2)).toBeNull()
  expect(() => admission.wait(candidate('b', 'next'), [value, { ...value, run_id: 'different' }])).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
  expect(() => admission.runWait('task', 'next', [run('a'), run('a', 'different')], 2)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
})

it('rotates ready work between production Runs instead of draining the first Run', () => {
  const admission = new RunnerAdmission(), pending = ['a1', 'a2', 'a3', 'b1', 'b2', 'b3'].map(id => candidate(id[0]!, id)), selected: string[] = []
  while (pending.length) {
    const next = admission.next('task', pending, [], () => true)!
    selected.push(next.work_id); pending.splice(pending.indexOf(next), 1)
  }
  expect(selected).toEqual(['a1', 'b1', 'a2', 'b2', 'a3', 'b3'])
})

it('offers at most one lightweight or composition priority turn before ready production', () => {
  const admission = new RunnerAdmission(), selected: string[] = []
  const pending = [candidate('q', 'q1', 'lightweight'), candidate('q', 'q2', 'lightweight'), candidate('c', 'c1', 'composition'), candidate('c', 'c2', 'composition'), candidate('a', 'a1'), candidate('a', 'a2'), candidate('b', 'b1'), candidate('b', 'b2')]
  while (pending.length) {
    const next = admission.next('task', pending, [], () => true)!
    selected.push(next.work_id); pending.splice(pending.indexOf(next), 1)
  }
  expect(selected).toEqual(['q1', 'a1', 'c1', 'b1', 'q2', 'a2', 'c2', 'b2'])
})

it('keeps production making progress under continuously arriving priority work', () => {
  const admission = new RunnerAdmission(), selected: string[] = []
  for (let n = 0; n < 12; n++) {
    const candidates = [candidate('q', `query-${n}`, 'lightweight'), candidate('a', 'producer-a'), candidate('b', 'producer-b')]
    selected.push(admission.next('task', candidates, [], () => true)!.work_id)
  }
  expect(selected.filter(id => id.startsWith('producer'))).toEqual(['producer-a', 'producer-b', 'producer-a', 'producer-b', 'producer-a', 'producer-b'])
})

it('gives ready production the first turn when it arrives after a priority-only interval', () => {
  const admission = new RunnerAdmission(), query = candidate('q', 'query', 'lightweight'), producer = candidate('a', 'producer')
  expect(admission.next('task', [query], [], () => true)).toBe(query)
  expect(admission.next('task', [query, producer], [], () => true)).toBe(producer)
})

it('skips unmet dependencies and actual resource conflicts using the host readiness check', () => {
  const admission = new RunnerAdmission(), blocked = candidate('a', 'upstream-wait'), dependent = candidate('a', 'dependent'), ready = candidate('b', 'ready')
  const candidates = [blocked, dependent, ready]
  expect(admission.next('task', candidates, [], value => value === ready)).toBe(ready)
  expect(admission.next('task', [blocked, dependent], [], () => false)).toBeNull()
  expect(admission.next('task', [blocked, dependent], [], value => value === blocked)).toBe(blocked)
})

it('does not call the readiness adapter for work that already exceeds capacity', () => {
  const admission = new RunnerAdmission(), active = Array.from({ length: RUNNER_LIMITS.admission.active_work_per_task }, (_, n) => candidate('q', `active-${n}`, 'lightweight'))
  let calls = 0
  expect(admission.next('task', [candidate('a', 'next')], active, () => { calls++; return true })).toBeNull()
  expect(calls).toBe(0)
})

it('isolates scheduling turns and counters by the real task_id', () => {
  const admission = new RunnerAdmission(), a = candidate('a', 'a'), b = candidate('b', 'b'), other = candidate('x', 'other', 'production', 'other-task')
  expect(admission.next('task', [a, b, other], [other], () => true)).toBe(a)
  expect(admission.next('other-task', [a, b, other], [a, b], () => true)).toBe(other)
  expect(admission.next('task', [a, b, other], [other], () => true)).toBe(b)
  expect(admission.runWait('task', 'new', [run('x', 'new', 'other-task')], 1)).toBeNull()
})

it('uses the fresh active snapshot after each dispatch rather than treating selection as a reservation', () => {
  const admission = new RunnerAdmission(), pending = [candidate('a', 'a1'), candidate('a', 'a2'), candidate('a', 'a3'), candidate('b', 'b1'), candidate('b', 'b2'), candidate('b', 'b3')], active: RunnerAdmissionWork[] = []
  for (let n = 0; n < RUNNER_LIMITS.admission.production_work_per_task; n++) active.push(admission.next('task', pending, active, () => true)!)
  expect(active.map(value => value.work_id)).toEqual(['a1', 'b1', 'a2', 'b2'])
  expect(admission.next('task', pending, active, () => true)).toBeNull()
  active.splice(0, 1)
  expect(admission.next('task', pending, active, value => value.work_id !== 'a1')?.work_id).toBe('a3')
})

it('forgets inactive task turns and resumes deterministically when a new plan appears', () => {
  const admission = new RunnerAdmission(), a = candidate('a', 'a'), b = candidate('b', 'b')
  expect(admission.next('task', [a, b], [], () => true)).toBe(a)
  admission.forget('task')
  expect(admission.next('task', [a, b], [], () => true)).toBe(a)
  expect(admission.next('task', [], [], () => true)).toBeNull()
  expect(admission.next('task', [a, b], [], () => true)).toBe(a)
})

it('classifies planning, integration, lightweight and composition work using their original owner', () => {
  const work: LogicalWork = { task_id: 'task', run_id: 'a', work_id: 'work', purpose: 'production', request_id: 'goal', intent_revision: 1, plan_revision: 1, role: 'router', required: true, requirement_ids: ['answer'], dependencies: [], state: 'planned', max_attempts: 1 }
  for (const role of ['router', 'producer', 'integrator'] as const) expect(admissionWork({ ...work, role }).kind).toBe('production')
  for (const role of ['lightweight', 'diagnostic'] as const) expect(admissionWork({ ...work, role }).kind).toBe('lightweight')
  const { request_id: _request, intent_revision: _revision, ...identity } = work
  expect(admissionWork({ ...identity, role: 'collator', purpose: 'composition', batch_id: 'batch', composition_version: 1, trigger_request_id: 'goal' })).toEqual({ task_id: 'task', run_id: 'a', work_id: 'work', kind: 'composition', batch_id: 'batch' })
})

it('rejects malformed admission identity without exposing rejected metadata', () => {
  const admission = new RunnerAdmission(), secret = 'PRIVATE_BODY_'.repeat(100)
  expect(() => admission.wait({ ...candidate('a', 'work'), work_id: secret }, [])).toThrow(expect.objectContaining({ code: 'RUNNER_LIMIT_EXCEEDED' }))
  try { admission.wait({ ...candidate('a', 'work'), work_id: secret }, []) } catch (error) { expect((error as Error).message).not.toContain('PRIVATE_BODY') }
  expect(() => admission.runWait('task', 'new', [], 3 as 1)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
})
