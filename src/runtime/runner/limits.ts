import { ContractError } from '../../shared/validation'

// These limits bound orchestration metadata. Model, bundle and Surface limits
// still apply independently at their existing dispatch and installation gates.
export const RUNNER_LIMITS = Object.freeze({
  admission: Object.freeze({
    producer_runs_per_task: 2,
    active_work_per_producer: 2,
    active_work_per_task: 6,
    production_work_per_task: 4,
    composition_batches_per_task: 2
  }),
  composition: Object.freeze({ batch_fragments: 16, merge_ms: 200, merge_max_ms: 1000, rebuilds: 3 }),
  index: Object.freeze({ id_bytes: 128, title_bytes: 256, item_bytes: 4096, page_items: 32, page_bytes: 65536 }),
  progress: Object.freeze({
    window_ms: 60000,
    repeated_failure_threshold: 3,
    stalled_success_threshold: 8,
    diagnosis_interval_ms: 60000,
    diagnosis_per_window: 1,
    evidence_max_calls: 64
  })
})

function limitError(field: string, limit: number, unit: string): never {
  // Do not include the rejected value: metadata checks also guard Collator input.
  throw new ContractError('RUNNER_LIMIT_EXCEEDED', `${field} exceeds ${limit} ${unit}`)
}

export function assertRunnerId(value: unknown, field = 'id'): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new ContractError('INVALID_REQUEST', `${field} must be a nonempty string`)
  if (Buffer.byteLength(value, 'utf8') > RUNNER_LIMITS.index.id_bytes) limitError(field, RUNNER_LIMITS.index.id_bytes, 'UTF-8 bytes')
}

export function assertIndexTitle(value: unknown): asserts value is string {
  if (typeof value !== 'string') throw new ContractError('INVALID_REQUEST', 'Index title must be a string')
  if (Buffer.byteLength(value, 'utf8') > RUNNER_LIMITS.index.title_bytes) limitError('Index title', RUNNER_LIMITS.index.title_bytes, 'UTF-8 bytes')
}

function serializedBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value)
    if (serialized !== undefined) return Buffer.byteLength(serialized, 'utf8')
  } catch { /* Serialization failures expose no value or body text. */ }
  throw new ContractError('INVALID_REQUEST', 'Index metadata must be JSON serializable')
}

// Call after the strict shape and ownership validator. Size checks never clip IDs.
export function assertIndexBytes(value: unknown): number {
  const bytes = serializedBytes(value)
  if (bytes > RUNNER_LIMITS.index.item_bytes) limitError('Index', RUNNER_LIMITS.index.item_bytes, 'serialized UTF-8 bytes')
  return bytes
}

export interface IndexPage<T> { items: T[]; next_offset: number | null }

// The caller owns the immutable read set and binds its continuation to that set.
// This helper accounts for the complete page envelope, including JSON escaping.
export function boundedIndexPage<T>(items: readonly T[], offset = 0): IndexPage<T> {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > items.length) throw new ContractError('INVALID_REQUEST', 'Invalid index page offset')
  const page: IndexPage<T> = { items: [], next_offset: offset < items.length ? offset : null }
  for (let position = offset; position < items.length && page.items.length < RUNNER_LIMITS.index.page_items; position++) {
    const item = items[position]!
    assertIndexBytes(item)
    const next_offset = position + 1 < items.length ? position + 1 : null
    const candidate = { items: [...page.items, item], next_offset }
    if (serializedBytes(candidate) > RUNNER_LIMITS.index.page_bytes) break
    page.items.push(item)
    page.next_offset = next_offset
  }
  return page
}

export function assertCompositionBatchSize(count: number): void {
  if (!Number.isSafeInteger(count) || count < 1) throw new ContractError('INVALID_REQUEST', 'Composition batch must contain at least one fragment')
  if (count > RUNNER_LIMITS.composition.batch_fragments) limitError('Composition batch', RUNNER_LIMITS.composition.batch_fragments, 'fragments')
}

// The first publishable fragment bypasses coalescing. Continuous arrivals cannot
// extend a subsequent merge beyond the first arrival's maximum wait.
export function compositionReadyAt(first: number, latest: number, firstPublication: boolean): number {
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(latest) || first < 0 || latest < first || latest > Number.MAX_SAFE_INTEGER - RUNNER_LIMITS.composition.merge_max_ms) throw new ContractError('INVALID_REQUEST', 'Invalid composition merge timestamps')
  return firstPublication ? first : Math.min(latest + RUNNER_LIMITS.composition.merge_ms, first + RUNNER_LIMITS.composition.merge_max_ms)
}

export interface AdmissionCounts {
  producer_runs: number
  run_work: number
  task_work: number
  production_work: number
  composition_batches: number
}
export type AdmissionKind = 'producer-run' | 'production' | 'lightweight' | 'composition'
export type AdmissionWait = 'producer-run-limit' | 'producer-work-limit' | 'task-work-limit' | 'production-work-limit' | 'composition-batch-limit'

// Waiting and closing work remain in these counts until the owning host has
// reconciled operations, settled usage and installed its terminal state.
export function admissionWaitReason(counts: AdmissionCounts, kind: AdmissionKind, producerRunLimit: 1 | 2 = RUNNER_LIMITS.admission.producer_runs_per_task): AdmissionWait | null {
  if (Object.values(counts).some(count => !Number.isSafeInteger(count) || count < 0) || ![1, 2].includes(producerRunLimit)) throw new ContractError('INVALID_REQUEST', 'Invalid admission counters or producer limit')
  const limits = RUNNER_LIMITS.admission
  if (kind === 'producer-run') return counts.producer_runs >= producerRunLimit ? 'producer-run-limit' : null
  if (counts.task_work >= limits.active_work_per_task) return 'task-work-limit'
  if (kind === 'production') {
    if (counts.run_work >= limits.active_work_per_producer) return 'producer-work-limit'
    if (counts.production_work >= limits.production_work_per_task) return 'production-work-limit'
  }
  if (kind === 'composition' && counts.composition_batches >= limits.composition_batches_per_task) return 'composition-batch-limit'
  return null
}

export interface ProgressObservationConfig {
  window_ms: number
  repeated_failure_threshold: number
  stalled_success_threshold: number
  diagnosis_interval_ms: number
  diagnosis_per_window: number
  evidence_max_calls: number
}

// Calibration is explicit and bounded; no override can create an unlimited
// observation window, evidence list or model diagnosis frequency.
export const PROGRESS_OBSERVATION_BOUNDS: Readonly<{ [K in keyof ProgressObservationConfig]: readonly [number, number] }> = Object.freeze({
  window_ms: Object.freeze([1000, 300000] as const),
  repeated_failure_threshold: Object.freeze([2, 256] as const),
  stalled_success_threshold: Object.freeze([2, 256] as const),
  diagnosis_interval_ms: Object.freeze([10000, 3600000] as const),
  diagnosis_per_window: Object.freeze([1, 8] as const),
  evidence_max_calls: Object.freeze([8, 256] as const)
})

export function progressObservationConfig(overrides: Partial<ProgressObservationConfig> = {}): Readonly<ProgressObservationConfig> {
  if (Object.keys(overrides).some(key => !Object.hasOwn(PROGRESS_OBSERVATION_BOUNDS, key))) throw new ContractError('INVALID_REQUEST', 'Unknown progress observation setting')
  const config = { ...RUNNER_LIMITS.progress, ...overrides }
  for (const key of Object.keys(PROGRESS_OBSERVATION_BOUNDS) as (keyof ProgressObservationConfig)[]) {
    const [minimum, maximum] = PROGRESS_OBSERVATION_BOUNDS[key], value = config[key]
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new ContractError('INVALID_REQUEST', `Progress setting ${key} must be an integer from ${minimum} to ${maximum}`)
  }
  if (config.repeated_failure_threshold > config.evidence_max_calls || config.stalled_success_threshold > config.evidence_max_calls) throw new ContractError('INVALID_REQUEST', 'Progress thresholds exceed the evidence window')
  return Object.freeze(config)
}
