import { expect, it } from 'vitest'
import { productionRunsPerTask, runtimeFeatures } from '../../src/runtime/features'

it('retains single-production admission for compatibility launches', () => {
  expect(productionRunsPerTask).toBe(1)
})

it('enables dual production with the rule Collator in ordinary launches', () => {
  expect(runtimeFeatures({})).toEqual({ viewReplacement: true, monty: true, runner: { productionRuns: 2, collator: 'rule', conversationRouting: true } })
})
it('allows explicit diagnostic disabling independently of data-directory selection', () => {
  expect(runtimeFeatures({ PLIUNA_ENABLE_MONTY: '0' })).toEqual({ viewReplacement: true, monty: false, runner: { productionRuns: 2, collator: 'rule', conversationRouting: true } })
  expect(runtimeFeatures({ PLIUNA_ENABLE_VIEW_REPLACEMENT: '0', PLIUNA_TEST_DATA: 'isolated', PLIUNA_TEST_VIEW_REPLACEMENT: '1' })).toEqual({ viewReplacement: false, monty: true, runner: { productionRuns: 2, collator: 'rule', conversationRouting: true } })
})
it('does not mutate the environment or restore test-only feature gating', () => {
  const env = { PLIUNA_TEST_DATA: 'isolated' }
  expect(runtimeFeatures(env)).toEqual(runtimeFeatures({}))
  expect(env).toEqual({ PLIUNA_TEST_DATA: 'isolated' })
})
it('preserves legacy diagnostic disabling while preferring explicit current settings', () => {
  expect(runtimeFeatures({ TRELLIS_ENABLE_MONTY: '0', TRELLIS_ENABLE_VIEW_REPLACEMENT: '0' })).toEqual({ viewReplacement: false, monty: false, runner: { productionRuns: 2, collator: 'rule', conversationRouting: true } })
  expect(runtimeFeatures({ PLIUNA_ENABLE_MONTY: '1', TRELLIS_ENABLE_MONTY: '0' })).toEqual({ viewReplacement: true, monty: true, runner: { productionRuns: 2, collator: 'rule', conversationRouting: true } })
})

it('allows explicit Runner limits and falls back to compatibility for legacy or invalid profiles', () => {
  expect(runtimeFeatures({ PLIUNA_TEST_RUNNER: 'single' }).runner).toEqual({ productionRuns: 1, collator: 'rule' })
  expect(runtimeFeatures({ PLIUNA_TEST_RUNNER: 'dual' }).runner).toEqual({ productionRuns: 2, collator: 'rule' })
  for (const value of ['legacy', '', '1', 'true', 'DUAL', 'production']) {
    expect(runtimeFeatures({ PLIUNA_TEST_RUNNER: value, PLIUNA_TEST_RUNNER_COLLATOR: 'model' }).runner).toBeUndefined()
  }
  expect(productionRunsPerTask).toBe(1)
})

it('requires an explicit Runner profile to select the model Collator', () => {
  expect(runtimeFeatures({ PLIUNA_TEST_DATA: 'isolated', PLIUNA_TEST_RUNNER_COLLATOR: 'model' }).runner).toEqual({ productionRuns: 2, collator: 'rule', conversationRouting: true })
  expect(runtimeFeatures({ TRELLIS_TEST_RUNNER_COLLATOR: 'model' }).runner).toEqual({ productionRuns: 2, collator: 'rule', conversationRouting: true })
  for (const [profile, productionRuns] of [['single', 1], ['dual', 2]] as const) {
    expect(runtimeFeatures({ PLIUNA_TEST_RUNNER: profile, PLIUNA_TEST_RUNNER_COLLATOR: 'model' }).runner).toEqual({ productionRuns, collator: 'model' })
  }
  for (const value of ['', 'true', 'MODEL']) expect(runtimeFeatures({ PLIUNA_TEST_RUNNER: 'single', PLIUNA_TEST_RUNNER_COLLATOR: value }).runner).toEqual({ productionRuns: 1, collator: 'rule' })
})

it('prefers current controlled settings and does not mutate an explicit profile', () => {
  const env = { PLIUNA_TEST_RUNNER: 'single', TRELLIS_TEST_RUNNER: 'dual', PLIUNA_TEST_RUNNER_COLLATOR: 'rule', TRELLIS_TEST_RUNNER_COLLATOR: 'model' }
  expect(runtimeFeatures(env).runner).toEqual({ productionRuns: 1, collator: 'rule' })
  expect(runtimeFeatures({ TRELLIS_TEST_RUNNER: 'dual', TRELLIS_TEST_RUNNER_COLLATOR: 'model' }).runner).toEqual({ productionRuns: 2, collator: 'model' })
  for (const value of ['legacy', '']) expect(runtimeFeatures({ PLIUNA_TEST_RUNNER: value, TRELLIS_TEST_RUNNER: 'dual' }).runner).toBeUndefined()
  expect(env).toEqual({ PLIUNA_TEST_RUNNER: 'single', TRELLIS_TEST_RUNNER: 'dual', PLIUNA_TEST_RUNNER_COLLATOR: 'rule', TRELLIS_TEST_RUNNER_COLLATOR: 'model' })
})
