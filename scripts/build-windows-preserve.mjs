import { createRequire } from 'node:module'
import { cpSync, mkdirSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
if (process.platform !== 'win32') throw Error('WINDOWS_REQUIRED')
const require = createRequire(import.meta.url)
const gyp = createRequire(require.resolve('@electron/rebuild')).resolve('node-gyp/bin/node-gyp.js')
const directory = mkdtempSync(join(tmpdir(), 'trellis-preserve-build-'))
try {
  cpSync(new URL('../tests/native/preserve/', import.meta.url), directory, { recursive: true })
  execFileSync(process.execPath, [gyp, 'rebuild', '--directory', directory], { stdio: 'inherit', timeout: 120000 })
  const destination = 'node_modules/.cache/trellis-native'
  mkdirSync(destination, { recursive: true })
  copyFileSync(join(directory, 'build/Release/trellis_preserve.exe'), join(destination, 'trellis_preserve.exe'))
} finally { rmSync(directory, { recursive: true, force: true }) }
