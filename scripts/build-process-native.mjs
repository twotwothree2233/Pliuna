import { createRequire } from 'node:module'
import { cpSync, mkdirSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
mkdirSync(join(root, 'out/main'), { recursive: true })
copyFileSync(join(root, 'src/platform/process-supervisor.mjs'), join(root, 'out/main/process-supervisor.mjs'))
if (process.platform === 'win32') {
  const require = createRequire(import.meta.url)
  // Reuse the pinned compiler toolchain already owned by @electron/rebuild.
  const gyp = createRequire(require.resolve('@electron/rebuild')).resolve('node-gyp/bin/node-gyp.js')
  const directory = mkdtempSync(join(tmpdir(), 'trellis-job-build-'))
  try {
    cpSync(join(root, 'native/windows-job'), directory, { recursive: true })
    execFileSync(process.execPath, [gyp, 'rebuild', '--directory', directory], { stdio: 'inherit' })
    const destination = join(root, 'out/main/native')
    mkdirSync(destination, { recursive: true })
    copyFileSync(join(directory, 'build/Release/trellis_job.node'), join(destination, 'trellis_job.node'))
    console.log('Windows Job Object N-API helper built')
  } finally { rmSync(directory, { recursive: true, force: true }) }
} else console.log('Windows Job Object helper: not required on ' + process.platform)
