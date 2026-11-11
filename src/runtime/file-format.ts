import { lstatSync,readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { IdentityEncoding } from '../platform/file-identity'
import { applicationEnvironment } from '../shared/branding'

// This selects creation only. Existing control versions are read by their own
// codecs, and are never promoted because a test flag was added on restart.
export function newTestIdentityEncoding(root: string, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): IdentityEncoding {
  if (platform !== 'win32' || applicationEnvironment(env, 'TEST_FILE_IDENTITIES') !== 'decimal-v2') return 1
  let names: string[]
  try { names = readdirSync(root) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 2; throw error }
  // Electron may create browser/cache/log folders before the runtime starts.
  // No registered application data, unknown entry or cached model metadata may
  // turn an existing profile into an eligible fresh test directory.
  const folders = ['resources','recovery','plugins','browser-state','logs','crashes','cache']
  if (names.some(name => !folders.includes(name))) return 1
  for (const name of folders) if (names.includes(name)) {
    const file = join(root, name), stat = lstatSync(file)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return 1
    const entries = readdirSync(file)
    if (['resources','recovery','plugins'].includes(name) && entries.length) return 1
    if (name === 'cache' && entries.some(entry => entry !== 'http')) return 1
  }
  return 2
}
