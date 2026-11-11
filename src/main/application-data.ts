import { mkdirSync } from 'node:fs'
import { join,resolve } from 'node:path'
import { protectPrivatePath } from '../platform/permissions'
import { entryExistsSync } from '../platform/files'
import { applicationSlug, legacyApplicationSlug } from '../shared/branding'

export function applicationDirectory(home: string, override?: string): string {
  if (override) return resolve(override)
  const current = join(home, '.' + applicationSlug), previous = join(home, '.' + legacyApplicationSlug)
  return entryExistsSync(current) || !entryExistsSync(previous) ? current : previous
}

export function prepareApplicationDirectory(directory: string, platform = process.platform): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  try { protectPrivatePath(directory, 'directory', platform === 'win32') }
  catch { throw new Error('SETTINGS_DIRECTORY_INVALID') }
}
