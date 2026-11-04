import { expect, it } from 'vitest'
import { runtimeFeatures } from '../../src/runtime/features'

it('enables baseline features in ordinary launches without a test profile', () => {
  expect(runtimeFeatures({})).toEqual({ viewReplacement: true, monty: true })
})
it('allows explicit diagnostic disabling independently of data-directory selection', () => {
  expect(runtimeFeatures({ TRELLIS_ENABLE_MONTY: '0' })).toEqual({ viewReplacement: true, monty: false })
  expect(runtimeFeatures({ TRELLIS_ENABLE_VIEW_REPLACEMENT: '0', TRELLIS_TEST_DATA: 'isolated', TRELLIS_TEST_VIEW_REPLACEMENT: '1' })).toEqual({ viewReplacement: false, monty: true })
})
it('does not mutate the environment or restore test-only feature gating', () => {
  const env = { TRELLIS_TEST_DATA: 'isolated' }
  expect(runtimeFeatures(env)).toEqual(runtimeFeatures({}))
  expect(env).toEqual({ TRELLIS_TEST_DATA: 'isolated' })
})
