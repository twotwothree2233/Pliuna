import { defineConfig } from 'vitest/config'

// Stage A/B baseline. Filesystem recovery and process-tree acceptance belong to C/D.
export default defineConfig({ test: { include: [
  'tests/unit/native-targets.test.ts',
  'tests/unit/monty-locations.test.ts',
  'tests/unit/monty-assets.test.ts',
  'tests/unit/package-paths.test.ts',
  'tests/unit/contracts.test.ts',
  'tests/unit/features.test.ts',
  'tests/unit/workspace-layout.test.ts',
  'tests/unit/desktop-platform.test.ts',
  'tests/unit/tool-input.test.ts',
  'tests/unit/monty-diagnostics.test.ts'
] } })
