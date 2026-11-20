import { expect, it } from 'vitest'
import defaults from '../../src/shared/contracts/development-defaults.json'
import { capacityPlan } from '../../src/runtime/model/capacity'
import { RUNNER_LIMITS, admissionWaitReason, assertCompositionBatchSize, assertIndexBytes, assertIndexTitle, assertRunnerId, boundedIndexPage, compositionReadyAt, progressObservationConfig } from '../../src/runtime/runner/limits'

it('checks UTF-8 identities and titles at the byte boundary without truncation or value disclosure', () => {
  const id = '界'.repeat(42) + 'ab', title = '界'.repeat(85) + 'a'
  expect(Buffer.byteLength(id)).toBe(128)
  expect(Buffer.byteLength(title)).toBe(256)
  expect(() => assertRunnerId(id)).not.toThrow()
  expect(() => assertIndexTitle(title)).not.toThrow()
  expect(() => assertRunnerId(id + 'c')).toThrow(expect.objectContaining({ code: 'RUNNER_LIMIT_EXCEEDED' }))
  expect(() => assertIndexTitle(title + 'b')).toThrow(expect.objectContaining({ code: 'RUNNER_LIMIT_EXCEEDED' }))
  for (const value of ['', null, 1, undefined]) expect(() => assertRunnerId(value)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
  try { assertRunnerId('private-body-'.repeat(20)) } catch (error) { expect(String(error)).not.toContain('private-body-') }
  expect(id.endsWith('ab')).toBe(true)
})

it('counts JSON escapes and multi-byte text in the exact serialized index size', () => {
  const prefix = { title: '\n"界' }
  const overhead = Buffer.byteLength(JSON.stringify({ ...prefix, order_key: '' }))
  const index = { ...prefix, order_key: 'x'.repeat(RUNNER_LIMITS.index.item_bytes - overhead) }
  expect(assertIndexBytes(index)).toBe(4096)
  expect(() => assertIndexBytes({ ...index, order_key: index.order_key + 'x' })).toThrow(expect.objectContaining({ code: 'RUNNER_LIMIT_EXCEEDED' }))
  const circular: { next?: unknown } = {}; circular.next = circular
  for (const value of [undefined, 1n, circular]) expect(() => assertIndexBytes(value)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
})

it('stops at either page count or serialized page bytes and continues without duplicating items', () => {
  const small = Array.from({ length: 33 }, (_, index) => ({ artifact_id: `artifact-${index}` }))
  const first = boundedIndexPage(small)
  expect(first.items).toHaveLength(32)
  expect(first.next_offset).toBe(32)
  expect(boundedIndexPage(small, first.next_offset!)).toEqual({ items: [small[32]], next_offset: null })
  const overhead = Buffer.byteLength(JSON.stringify({ order_key: '' }))
  const large = Array.from({ length: 20 }, () => ({ order_key: 'x'.repeat(4096 - overhead) }))
  const page = boundedIndexPage(large)
  expect(page.items).toHaveLength(15)
  expect(page.next_offset).toBe(15)
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(65536)
  expect(Buffer.byteLength(JSON.stringify({ items: large.slice(0, 16), next_offset: 16 }))).toBeGreaterThan(65536)
  expect([...page.items, ...boundedIndexPage(large, page.next_offset!).items]).toEqual(large)
  const exact = large.slice(0, 16).map(item => ({ ...item }))
  const envelope = Buffer.byteLength(JSON.stringify({ items: exact, next_offset: null })) - 65536
  exact[15]!.order_key = exact[15]!.order_key.slice(0, -envelope)
  expect(Buffer.byteLength(JSON.stringify(boundedIndexPage(exact)))).toBe(65536)
  expect(boundedIndexPage(exact).items).toHaveLength(16)
  exact[15]!.order_key += 'x'
  expect(boundedIndexPage(exact).items).toHaveLength(15)
  expect(boundedIndexPage([], 0)).toEqual({ items: [], next_offset: null })
  for (const offset of [-1, 0.5, 34, NaN]) expect(() => boundedIndexPage(small, offset)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
})

it('does not replace model input capacity or bundle capacity with index limits', () => {
  const page = boundedIndexPage([{ artifact_id: 'artifact' }])
  const messages = [{ role: 'user' as const, content: JSON.stringify(page) }]
  const model = { id: 'small', base_url: 'https://example.invalid', wire_model_id: 'small', context_tokens: 1, compatibility_profile: 'chat-max-tokens' as const }
  expect(capacityPlan(model, messages).fits).toBe(false)
  expect(defaults.surface.inline_bundle_bytes).toBe(262144)
  expect(RUNNER_LIMITS.index.page_bytes).toBeLessThan(defaults.surface.inline_bundle_bytes)
  expect(defaults.queues.model_active_app).toBe(4)
  expect(defaults.queues.model_active_channel).toBe(2)
  expect(RUNNER_LIMITS.admission.active_work_per_task).toBeGreaterThan(defaults.queues.model_active_app)
})

it('uses independent admission ceilings for production, lightweight and composition work', () => {
  const empty = { producer_runs: 0, run_work: 0, task_work: 0, production_work: 0, composition_batches: 0 }
  expect(admissionWaitReason({ ...empty, producer_runs: 1 }, 'producer-run', 1)).toBe('producer-run-limit')
  expect(admissionWaitReason({ ...empty, producer_runs: 1 }, 'producer-run')).toBeNull()
  expect(admissionWaitReason({ ...empty, producer_runs: 2 }, 'producer-run')).toBe('producer-run-limit')
  expect(admissionWaitReason({ ...empty, run_work: 2 }, 'production')).toBe('producer-work-limit')
  expect(admissionWaitReason({ ...empty, production_work: 4 }, 'production')).toBe('production-work-limit')
  expect(admissionWaitReason({ ...empty, production_work: 4 }, 'lightweight')).toBeNull()
  expect(admissionWaitReason({ ...empty, composition_batches: 2 }, 'composition')).toBe('composition-batch-limit')
  for (const kind of ['production', 'lightweight', 'composition'] as const) expect(admissionWaitReason({ ...empty, task_work: 6 }, kind)).toBe('task-work-limit')
  expect(() => admissionWaitReason({ ...empty, producer_runs: -1 }, 'producer-run')).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
})

it('bounds batch size and merges while the first publishable fragment is scheduled immediately', () => {
  expect(() => assertCompositionBatchSize(16)).not.toThrow()
  expect(() => assertCompositionBatchSize(17)).toThrow(expect.objectContaining({ code: 'RUNNER_LIMIT_EXCEEDED' }))
  for (const size of [0, -1, 1.5, Infinity]) expect(() => assertCompositionBatchSize(size)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
  expect(compositionReadyAt(1000, 1000, true)).toBe(1000)
  expect(compositionReadyAt(1000, 1100, false)).toBe(1300)
  expect(compositionReadyAt(1000, 1999, false)).toBe(2000)
  expect(compositionReadyAt(1000, 3000, false)).toBe(2000)
  expect(() => compositionReadyAt(1000, 999, false)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
})

it('bounds progress observation, evidence and diagnostic frequency overrides', () => {
  expect(progressObservationConfig()).toEqual(RUNNER_LIMITS.progress)
  expect(progressObservationConfig({ window_ms: 1000, diagnosis_interval_ms: 10000 })).toMatchObject({ window_ms: 1000, diagnosis_interval_ms: 10000 })
  for (const overrides of [{ window_ms: 300001 }, { diagnosis_interval_ms: 9999 }, { diagnosis_per_window: 9 }, { evidence_max_calls: 257 }, { stalled_success_threshold: 65 }, { repeated_failure_threshold: 1 }]) {
    expect(() => progressObservationConfig(overrides)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
  }
  expect(Object.isFrozen(progressObservationConfig())).toBe(true)
})
