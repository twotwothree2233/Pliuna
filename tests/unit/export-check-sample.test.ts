import { expect, it } from 'vitest'
import { exportCheckSample } from '../helpers/export-check-sample'
it('publishes a fresh credential-free 50 View / 90000 row sample', () => {
  const sample = exportCheckSample()
  expect(sample.views).toHaveLength(50)
  expect(sample.bundle_bytes).toBeLessThan(262144)
})
