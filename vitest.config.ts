import { defineConfig, configDefaults } from 'vitest/config'
export default defineConfig({ test: {
  include: ['tests/unit/**/*.test.ts'],
  exclude: [...configDefaults.exclude, 'tests/unit/monty-native.test.ts', 'tests/unit/package-macos.test.ts']
} })
