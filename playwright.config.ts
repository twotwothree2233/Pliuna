import { defineConfig } from '@playwright/test'

// Existing desktop fixtures exercise the legacy model protocol. Runner suites
// select their mode explicitly; default-mode acceptance clears this override.
process.env.PLIUNA_TEST_RUNNER ??= process.env.TRELLIS_TEST_RUNNER ?? 'legacy'

export default defineConfig({ testDir: 'tests/electron', workers: 1, timeout: 30000 })
