import { defineConfig } from 'vitest/config'

export default defineConfig({ test: {
  name: 'filesystem-synthetic-integrity',
  testTimeout: 30000,
  setupFiles: ['tests/helpers/synthetic-file-integrity.ts'],
  include: [
    'tests/unit/file-identity.test.ts', 'tests/unit/file-format.test.ts', 'tests/unit/export-control.test.ts',
    'tests/unit/platform-paths.test.ts', 'tests/unit/platform-files.test.ts',
    'tests/unit/platform-permissions.test.ts', 'tests/unit/platform-persistence.test.ts',
    'tests/unit/file-model-store.test.ts', 'tests/unit/secure-model-store.test.ts',
    'tests/unit/export-save.test.ts', 'tests/unit/resources.test.ts',
    'tests/unit/storage-lifecycle.test.ts', 'tests/unit/recovery.test.ts',
    'tests/unit/restore.test.ts', 'tests/unit/gc.test.ts',
    'tests/unit/replicas.test.ts', 'tests/unit/resource-cleanup.test.ts',
    'tests/unit/plugin-packages.test.ts', 'tests/unit/material-imports.test.ts',
    'tests/unit/plugin-uploads.test.ts', 'tests/unit/storage-inspection.test.ts',
    'tests/unit/model-metadata.test.ts'
  ]
} })
