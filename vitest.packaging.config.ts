import { defineConfig } from 'vitest/config'

// Pure packaging/structure checks use no SQLite ABI or file digests.
export default defineConfig({ test: { include: ['tests/unit/desktop-packaging.test.ts', 'tests/unit/desktop-platform.test.ts', 'tests/unit/package-paths.test.ts'] } })
