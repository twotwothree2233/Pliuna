import { createRequire } from 'node:module'
import { cpSync, mkdirSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

if (process.platform !== 'win32') throw Error('WINDOWS_REQUIRED')
const root = fileURLToPath(new URL('../', import.meta.url)), require = createRequire(import.meta.url)
const gyp = createRequire(require.resolve('@electron/rebuild')).resolve('node-gyp/bin/node-gyp.js')
const directory = mkdtempSync(join(tmpdir(), 'pliuna-acl-build-'))
try {
  cpSync(join(root, 'native/windows-acl'), directory, { recursive: true })
  execFileSync(process.execPath, [gyp, 'rebuild', '--directory', directory], { stdio: 'inherit' })
  const production = join(root, 'out/main/native')
  mkdirSync(production, { recursive: true })
  copyFileSync(join(directory, 'build/Release/pliuna_acl.exe'), join(production, 'pliuna_acl.exe'))
} finally { rmSync(directory, { recursive: true, force: true }) }
