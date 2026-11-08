import { defineConfig } from 'vitest/config'

export default defineConfig({ test: {
  name: 'windows11-startup-probe',
  include: ['tests/unit/windows11-startup-probe.test.ts'],
  setupFiles: ['tests/helpers/synthetic-file-integrity.ts'],
  testTimeout: 90000
} })
