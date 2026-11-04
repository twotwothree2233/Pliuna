import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Force the active Node ABI even when pnpm considers the package already built.
const cli = fileURLToPath(new URL('./cli.js', import.meta.resolve('@electron/rebuild')))
execFileSync(process.execPath, [cli, '-f', '-w', 'better-sqlite3', '--version', process.versions.node, '--dist-url', 'https://nodejs.org/download/release'], { stdio: 'inherit' })
