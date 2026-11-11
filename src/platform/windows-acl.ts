import { execFileSync } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { win32 } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { exactFileIdentity, type FileIdentity } from './file-identity'
import { createWindowsJob } from './process-tree'
import { absoluteFilePath } from './paths'

const moduleURL = typeof __filename === 'string' ? pathToFileURL(__filename) : new URL(import.meta.url)
const unavailable = (reason = 'ASSET'): never => { throw Error('FILE_PERMISSIONS_UNAVAILABLE', { cause: Error('WINDOWS_ACL_' + reason) }) }
function helperFile(): string {
  for (const url of [new URL('./native/pliuna_acl.exe', moduleURL), new URL('../native/pliuna_acl.exe', moduleURL),
    new URL('../../out/main/native/pliuna_acl.exe', moduleURL)]) {
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
export function protectWindowsPath(file: string, kind: 'file' | 'directory', hidden: boolean, before: FileIdentity, deadline = performance.now() + 15000): 'verified' | 'legacy' {
  file = absoluteFilePath(file, 'win32')
  if (file.startsWith('\\\\')) return 'legacy'
  const identity = exactFileIdentity(before), helper = helperFile(), owner = createWindowsJob()
  try {
    const remaining = Math.ceil(deadline - performance.now())
    if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 15000) return unavailable('DEADLINE')
    const output = execFileSync(helper, ['protect', owner.name, win32.toNamespacedPath(file), identity.dev, identity.ino, kind, hidden ? '1' : '0'], {
      encoding: 'utf8', windowsHide: true, timeout: remaining, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'],
      env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP }
    })
    const result = JSON.parse(output)
    if (!result || Array.isArray(result) || Object.keys(result).sort().join(',') !== 'backend,changed,verified,version' ||
        result.version !== 1 || typeof result.changed !== 'boolean') return unavailable('PROTOCOL')
    const backend = result.backend === 'native' && result.verified === true ? 'verified' :
      result.backend === 'legacy' && result.verified === false && result.changed === false ? 'legacy' : undefined
    if (!backend) return unavailable('PROTOCOL')
    // Process exit can precede the kernel's Job accounting update. As in the
    // asynchronous supervisor, success needs a confirmed empty Job. Drain only
    // within the *same* monotonic 15-second execution/confirmation budget.
    let waiting: Int32Array | undefined
    while (owner.binding.active(owner.job) !== 0) {
      const remaining = deadline - performance.now()
      if (remaining <= 0) return unavailable('JOB_NOT_EMPTY')
      waiting ??= new Int32Array(new SharedArrayBuffer(4))
      Atomics.wait(waiting, 0, 0, Math.min(5, remaining))
    }
    if (performance.now() > deadline) return unavailable('DEADLINE')
    return backend
  } finally {
    try { owner.binding.terminate(owner.job) } finally { owner.binding.close(owner.job) }
  }
}
