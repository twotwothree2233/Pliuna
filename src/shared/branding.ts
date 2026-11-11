export const applicationName = 'Pliuna'
export const applicationSlug = 'pliuna'
export const legacyApplicationSlug = 'trellis'
export const defaultDatabaseFile = 'pliuna.sqlite'
export const legacyDatabaseFile = `${legacyApplicationSlug}.sqlite`
export const initialDatabaseFiles = [defaultDatabaseFile, legacyDatabaseFile] as const
export const bundleMediaType = 'application/vnd.pliuna.bundle+json'

// Existing profiles and immutable history retain their original identities.
// New profiles, resources and preferences use the current application name.
export function isInitialDatabaseFile(file: unknown): file is string {
  return file === defaultDatabaseFile || file === legacyDatabaseFile
}

export function isManagedDatabaseFile(file: unknown): file is string {
  return typeof file === 'string' && (isInitialDatabaseFile(file) || /^restore-[0-9a-f-]{36}-(target|rollback)\.sqlite$/.test(file))
}

export function initialDatabaseFile(journal: { selected: string; operations: readonly { previous: string }[] }): string {
  return journal.selected === legacyDatabaseFile || journal.operations.some(operation => operation.previous === legacyDatabaseFile)
    ? legacyDatabaseFile : defaultDatabaseFile
}

export function isBundleMediaType(value: string): boolean {
  return value === bundleMediaType || value === `application/vnd.${legacyApplicationSlug}.bundle+json`
}

export function localResourceName(value: string): string {
  const prefix = [`${applicationSlug}-resource:`, `${legacyApplicationSlug}-resource:`].find(prefix => value.startsWith(prefix))
  return prefix ? value.slice(prefix.length) : ''
}

export function isReferencePdfPlugin(id: string): boolean {
  return id === `${applicationSlug}.pdf-text` || id === `${legacyApplicationSlug}.pdf-text`
}

export function applicationEnvironment(env: NodeJS.ProcessEnv, suffix: string): string | undefined {
  return env[`${applicationSlug.toUpperCase()}_${suffix}`] ?? env[`${legacyApplicationSlug.toUpperCase()}_${suffix}`]
}

export function applicationPreference(storage: Pick<Storage, 'getItem' | 'setItem'>, suffix: 'theme' | 'text-size'): string | null {
  const key = `${applicationSlug}-${suffix}`, current = storage.getItem(key)
  if (current !== null) return current
  const previous = storage.getItem(`${legacyApplicationSlug}-${suffix}`)
  if (previous !== null) {
    try { storage.setItem(key, previous) } catch { /* Reading an existing preference does not require writable storage. */ }
  }
  return previous
}
