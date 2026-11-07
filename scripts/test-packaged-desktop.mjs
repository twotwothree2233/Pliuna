import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { verifyDesktop } from './verify-desktop.mjs'

if (process.argv.length !== 3) throw Error('Usage: pnpm test:desktop:packaged /absolute/package-output')
const output = process.argv[2]
verifyDesktop(output)
const require = createRequire(import.meta.url)
execFileSync(process.execPath, [require.resolve('@playwright/test/cli'), 'test', 'platform-smoke.spec.ts'], {
  env: { ...process.env, TRELLIS_PACKAGED_OUTPUT: output }, stdio: 'inherit', windowsHide: true
})
