import { expect, it } from 'vitest'
import { runtimeFeatures } from '../../src/runtime/features'

it('enables baseline features in ordinary launches without a test profile', () => {
  expect(runtimeFeatures({})).toEqual({ viewReplacement: true, monty: true })
})
it('allows explicit diagnostic disabling independently of data-directory selection', () => {
  expect(runtimeFeatures({ PLIUNA_ENABLE_MONTY: '0' })).toEqual({ viewReplacement: true, monty: false })
  expect(runtimeFeatures({ PLIUNA_ENABLE_VIEW_REPLACEMENT: '0', PLIUNA_TEST_DATA: 'isolated', PLIUNA_TEST_VIEW_REPLACEMENT: '1' })).toEqual({ viewReplacement: false, monty: true })
})
it('does not mutate the environment or restore test-only feature gating', () => {
  const env = { PLIUNA_TEST_DATA: 'isolated' }
  expect(runtimeFeatures(env)).toEqual(runtimeFeatures({}))
  expect(env).toEqual({ PLIUNA_TEST_DATA: 'isolated' })
})
it('preserves legacy diagnostic disabling while preferring explicit current settings', () => {
  expect(runtimeFeatures({ TRELLIS_ENABLE_MONTY: '0', TRELLIS_ENABLE_VIEW_REPLACEMENT: '0' })).toEqual({ viewReplacement: false, monty: false })
  expect(runtimeFeatures({ PLIUNA_ENABLE_MONTY: '1', TRELLIS_ENABLE_MONTY: '0' })).toEqual({ viewReplacement: true, monty: true })
})
