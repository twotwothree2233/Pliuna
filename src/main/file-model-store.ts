import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { SavedConnection } from '../runtime/model/persistence'
import type { VaultLoad } from './secure-model-store'

const limit = 2 * 1024 * 1024
type SettingsRecord = Omit<SavedConnection, 'key'> & { credential: string | null; validation: string }
type Auth = Record<string, string>
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const binding = (record: SavedConnection) => digest({ configuration: record.configuration, key: record.key, revision: record.revision, protocol: record.protocol, roles: record.roles })

// Main-process only. Never opens the legacy encrypted vault or another profile.
export class FileModelStore {
  private snapshot: string | undefined
  private error: string | undefined
  constructor(private directory: string, private fault: (point: 'auth-prepared' | 'settings-committed' | 'auth-pruned') => void = () => {}) {}
  private read(name: string): string | null {
    const path = join(this.directory, name)
    let stat: ReturnType<typeof lstatSync>
    try { stat = lstatSync(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw Error('SETTINGS_READ_FAILED')
    return readFileSync(path, 'utf8')
  }
  private pair(): [string | null, string | null] { return [this.read('settings.json'), this.read('auth.json')] }
  private parse(pair: [string | null, string | null]): { records: SavedConnection[]; auth: Auth } {
    const [settingsText, authText] = pair
    const auth = authText === null ? { version: 1, credentials: {} } : JSON.parse(authText)
    if (auth?.version !== 1 || !auth.credentials || typeof auth.credentials !== 'object' || Array.isArray(auth.credentials) || Object.keys(auth.credentials).length > 200 || Object.entries(auth.credentials).some(([id, key]) => !/^[a-f0-9-]{36}$/.test(id) || typeof key !== 'string' || key.length > 8192)) throw Error('SETTINGS_READ_FAILED')
    if (settingsText === null) {
      if (authText !== null) throw Error('SETTINGS_READ_FAILED')
      return { records: [], auth: {} }
    }
    const settings = JSON.parse(settingsText)
    if (![1, 2, 3].includes(settings?.version) || !Array.isArray(settings.connections) || settings.connections.length > 100) throw Error('SETTINGS_READ_FAILED')
    const referenced: Auth = {}
    const records = settings.connections.map((entry: SettingsRecord) => {
      if (!entry || typeof entry !== 'object' || 'key' in entry || !(entry.credential === null || typeof entry.credential === 'string') || typeof entry.validation !== 'string') throw Error('SETTINGS_READ_FAILED')
      const { credential, validation, ...saved } = entry
      const key = credential === null ? null : auth.credentials[credential]
      if (key === undefined) throw Error('SETTINGS_READ_FAILED')
      if (credential !== null) referenced[credential] = key
      const record = { ...saved, key } as SavedConnection
      if (binding(record) !== validation) record.roles = []
      return record
    })
    return { records, auth: referenced }
  }
  load(): VaultLoad {
    try {
      if (existsSync(join(this.directory, '.settings-write.lock'))) throw Error('SETTINGS_BUSY')
      const pair = this.pair(), parsed = this.parse(pair)
      this.snapshot = digest(pair); this.error = undefined
      return { available: true, backend: 'plain-file', records: parsed.records }
    } catch { this.error = 'SETTINGS_READ_FAILED'; return { available: false, backend: 'plain-file', error: this.error, records: [] } }
  }
  private atomic(name: string, value: unknown): void {
    const text = JSON.stringify(value, null, 2) + '\n'
    if (Buffer.byteLength(text) > limit) throw Error('SETTINGS_WRITE_FAILED')
    const target = join(this.directory, name), temporary = target + '.' + randomUUID() + '.tmp'
    try {
      const fd = openSync(temporary, 'wx', 0o600)
      try { writeFileSync(fd, text); fsyncSync(fd) } finally { closeSync(fd) }
      renameSync(temporary, target)
      if (process.platform !== 'win32') {
        const directory = openSync(this.directory, 'r')
        try { fsyncSync(directory) } finally { closeSync(directory) }
      }
    } finally { try { unlinkSync(temporary) } catch {} }
  }
  save(records: SavedConnection[]): void {
    if (this.error || this.snapshot === undefined) throw Error(this.error || 'SETTINGS_READ_FAILED')
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const lock = join(this.directory, '.settings-write.lock')
    let fd: number
    try { fd = openSync(lock, 'wx', 0o600) } catch { throw Error('SETTINGS_BUSY') }
    let committed = false
    try {
      const pair = this.pair()
      if (digest(pair) !== this.snapshot) throw Error('SETTINGS_CONFLICT')
      const previous = this.parse(pair)
      if (!Array.isArray(records) || records.length > 100) throw Error('SETTINGS_WRITE_FAILED')
      const auth: Auth = {}, connections: SettingsRecord[] = records.map(record => {
        if (!record || typeof record !== 'object' || (record.key !== null && (typeof record.key !== 'string' || record.key.length > 8192))) throw Error('SETTINGS_WRITE_FAILED')
        const { key, ...saved } = record
        const credential = key === null ? null : randomUUID()
        if (credential !== null) auth[credential] = key!
        return { ...saved, credential, validation: binding(record) }
      })
      // Seed an empty settings file before first auth write: a crash still loads an empty profile.
      if (pair[0] === null) this.atomic('settings.json', { version: 3, connections: [] })
      this.atomic('auth.json', { version: 1, credentials: { ...previous.auth, ...auth } })
      this.fault('auth-prepared')
      this.atomic('settings.json', { version: 3, connections })
      committed = true; this.fault('settings-committed')
      this.atomic('auth.json', { version: 1, credentials: auth })
      this.fault('auth-pruned')
      this.snapshot = digest(this.pair())
    } catch (error) {
      this.error = committed ? 'SETTINGS_RESULT_UNKNOWN' : (error instanceof Error && error.message === 'SETTINGS_CONFLICT' ? 'SETTINGS_CONFLICT' : 'SETTINGS_WRITE_FAILED')
      throw Error(this.error)
    } finally { closeSync(fd); unlinkSync(lock) }
  }
}
