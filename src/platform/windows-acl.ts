import { execFileSync } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { win32 } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { exactFileIdentity, type FileIdentity } from './file-identity'
import { createWindowsJob } from './process-tree'
import { absoluteFilePath } from './paths'

const moduleURL = typeof __filename === 'string' ? pathToFileURL(__filename) : new URL(import.meta.url)
const unavailable = (): never => { throw Error('FILE_PERMISSIONS_UNAVAILABLE') }
function helperFile(): string {
  for (const url of [new URL('./native/trellis_acl.exe', moduleURL), new URL('../native/trellis_acl.exe', moduleURL),
    new URL('../../out/main/native/trellis_acl.exe', moduleURL)]) {
    try {
      const stat = lstatSync(url)
      if (!stat.isFile() || stat.nlink !== 1) return unavailable()
      return fileURLToPath(url)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  return unavailable()
}
// "legacy" is only a known unsupported classification made before any write.
// Execution, identity, protocol and verification failures never select fallback.
export function protectWindowsPath(file: string, kind: 'file' | 'directory', hidden: boolean, before: FileIdentity): 'verified' | 'legacy' {
  file = absoluteFilePath(file, 'win32')
  if (file.startsWith('\\\\')) return 'legacy'
  const identity = exactFileIdentity(before), helper = helperFile(), owner = createWindowsJob()
  try {
    const output = execFileSync(helper, ['protect', owner.name, win32.toNamespacedPath(file), identity.dev, identity.ino, kind, hidden ? '1' : '0'], {
      encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'],
      env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP }
    })
    const result = JSON.parse(output)
    if (!result || Array.isArray(result) || Object.keys(result).sort().join(',') !== 'backend,changed,verified,version' ||
        result.version !== 1 || typeof result.changed !== 'boolean' || owner.binding.active(owner.job) !== 0) return unavailable()
    if (result.backend === 'native' && result.verified === true) return 'verified'
    if (result.backend === 'legacy' && result.verified === false && result.changed === false) return 'legacy'
    return unavailable()
  } finally {
    try { owner.binding.terminate(owner.job) } finally { owner.binding.close(owner.job) }
  }
}
