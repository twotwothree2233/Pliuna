import { defineConfig } from 'vitest/config'
import { hostMontyTarget } from './src/shared/native-targets.mjs'

if (!hostMontyTarget()?.runtimeVerified) throw Error('Native acceptance is closed on this host; run test:portable for candidate targets')

export default defineConfig({ test: { include: [
  'tests/unit/monty-native.test.ts', 'tests/unit/package-macos.test.ts'
] } })
