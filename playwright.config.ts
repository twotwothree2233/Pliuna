import { defineConfig } from '@playwright/test'
export default defineConfig({ testDir: 'tests/electron', workers: 1, timeout: 30000 })
