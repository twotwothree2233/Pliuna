import { defineConfig, configDefaults } from 'vitest/config'
import { legacyRuntimePlugin } from './tests/helpers/legacy-runtime-plugin'
export default defineConfig({ plugins: [legacyRuntimePlugin()], test: {
  include: ['tests/unit/**/*.test.ts'],
  exclude: [...configDefaults.exclude, 'tests/unit/monty-native.test.ts', 'tests/unit/package-macos.test.ts']
} })
