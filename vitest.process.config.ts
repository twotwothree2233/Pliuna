import { defineConfig } from 'vitest/config'
export default defineConfig({ test: {
  name: 'process-lifecycle-synthetic-integrity', testTimeout: 15000, hookTimeout: 30000,
  setupFiles: ['tests/helpers/synthetic-file-integrity.ts'],
  include: ['tests/unit/platform-process-tree.test.ts', 'tests/unit/monty-lifecycle.test.ts',
    'tests/unit/monty-calls.test.ts', 'tests/unit/plugin-process.test.ts', 'tests/unit/plugin-calls.test.ts',
    'tests/unit/recovery-shutdown.test.ts', 'tests/unit/plugin-rpc.test.ts', 'tests/unit/plugin-queries.test.ts']
} })
