import { mkdirSync } from 'node:fs'
import { join,resolve } from 'node:path'
import { protectPrivatePath } from '../platform/permissions'

export function applicationDirectory(home: string, override?: string): string {
  return override ? resolve(override) : join(home, '.trellis')
}

export function prepareApplicationDirectory(directory: string, platform = process.platform): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  try { protectPrivatePath(directory, 'directory', platform === 'win32') }
  catch { throw new Error('SETTINGS_DIRECTORY_INVALID') }
}
