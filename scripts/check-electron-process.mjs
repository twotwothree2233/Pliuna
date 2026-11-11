import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
// The Vitest host stays Node. Only supervised work uses the trusted Electron
// executable, with ELECTRON_RUN_AS_NODE supplied by the production launcher.
execFileSync(process.execPath, [fileURLToPath(import.meta.resolve('vitest/vitest.mjs')), 'run', '--config', 'vitest.process.config.ts', 'tests/unit/monty-lifecycle.test.ts'], {
  env: { ...process.env, PLIUNA_TEST_CHILD_RUNTIME: require('electron') }, stdio: 'inherit', windowsHide: true
})
