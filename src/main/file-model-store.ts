import { createHash,randomUUID } from 'node:crypto'
import { closeSync,fstatSync,mkdirSync } from 'node:fs'
import { atomicWriteFileSync,entryExistsSync,managedFile,openExclusiveFileSync,readRegularFileSync,removeOwnedFileSync } from '../platform/files'
import { protectPrivatePath } from '../platform/permissions'
import type { SavedChannel } from '../runtime/model/channels'
import type { SavedConnection } from '../runtime/model/persistence'
import type { VaultLoad } from './secure-model-store'

const limit = 2 * 1024 * 1024
type SettingsRecord = Omit<SavedConnection, 'key'> & { credential: string | null; validation: string }
type Auth = Record<string, string>
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const channelBinding = (channel: SavedChannel) => digest({ id: channel.id, name: channel.name, base_url: channel.base_url, compatibility_profile: channel.compatibility_profile, revision: channel.revision, key: channel.key })
const binding = (record: SavedConnection) => digest({ configuration: record.configuration, key: record.key, revision: record.revision, protocol: record.protocol, roles: record.roles })

// Main-process only. Never opens the legacy encrypted vault or another profile.
export class FileModelStore {
  private snapshot: string | undefined
  private error: string | undefined
  private protectedFiles = new Set<string>()
  constructor(private directory: string, private fault: (point: 'auth-prepared' | 'settings-committed' | 'auth-pruned') => void = () => {}) {}
  private read(name: string): string | null {
    try {
      const file = managedFile(this.directory, name)
      if (!this.protectedFiles.has(name) && entryExistsSync(file)) { protectPrivatePath(file, 'file'); this.protectedFiles.add(name) }
      return readRegularFileSync(file, limit).toString('utf8')
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }
  private pair(): [string | null, string | null] { return [this.read('settings.json'), this.read('auth.json')] }
  private parse(pair: [string | null, string | null]): { records: SavedConnection[]; auth: Auth; channels?: SavedChannel[] } {
    const [settingsText, authText] = pair
    const auth = authText === null ? { version: 1, credentials: {} } : JSON.parse(authText)
    if (auth?.version !== 1 || !auth.credentials || typeof auth.credentials !== 'object' || Array.isArray(auth.credentials) || Object.keys(auth.credentials).length > 400 || Object.entries(auth.credentials).some(([id, key]) => !/^[a-f0-9-]{36}$/.test(id) || typeof key !== 'string' || key.length > 8192)) throw Error('SETTINGS_READ_FAILED')
    if (settingsText === null) {
      if (authText !== null) throw Error('SETTINGS_READ_FAILED')
      return { records: [], auth: {} }
    }
    const settings = JSON.parse(settingsText)
    if (![1, 2, 3, 4].includes(settings?.version) || !Array.isArray(settings.connections) || settings.connections.length > 100) throw Error('SETTINGS_READ_FAILED')
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
    let channels: SavedChannel[] | undefined
    if (settings.version === 4) {
      if (!Array.isArray(settings.channels) || settings.channels.length > 100) throw Error('SETTINGS_READ_FAILED')
      const ids = new Set<string>()
      channels = settings.channels.map((entry: Omit<SavedChannel, 'key'> & { credential: string | null; validation: string }) => {
        if (!entry || typeof entry !== 'object' || 'key' in entry || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id) || typeof entry.name !== 'string' || !entry.name || typeof entry.base_url !== 'string' || !['chat-max-tokens','chat-max-completion-tokens'].includes(entry.compatibility_profile) || !Number.isSafeInteger(entry.revision) || entry.revision < 1 || !(entry.credential === null || typeof entry.credential === 'string')) throw Error('SETTINGS_READ_FAILED')
        const key = entry.credential === null ? null : auth.credentials[entry.credential]
        if (key === undefined) throw Error('SETTINGS_READ_FAILED')
        const { credential, validation, ...saved } = entry
        const channel = { ...saved, key } as SavedChannel
        if (channelBinding(channel) !== validation) for (const record of records) if (record.configuration.channel_id === channel.id) record.roles = []
        if (credential !== null) referenced[credential] = key
        ids.add(entry.id); return channel
      })
    }
    return { records, auth: referenced, ...(channels ? { channels } : {}) }
  }
  load(): VaultLoad {
    try {
      if (entryExistsSync(managedFile(this.directory, '.settings-write.lock'))) throw Error('SETTINGS_BUSY')
      const pair = this.pair(), parsed = this.parse(pair)
      this.snapshot = digest(pair); this.error = undefined
      return { available: true, backend: 'plain-file', records: parsed.records, ...(parsed.channels ? { channels: parsed.channels } : {}) }
    } catch { this.error = 'SETTINGS_READ_FAILED'; return { available: false, backend: 'plain-file', error: this.error, records: [] } }
  }
  private atomic(name: string, value: unknown, onPublished: () => void = () => {}): void {
    const text = JSON.stringify(value, null, 2) + '\n'
    if (Buffer.byteLength(text) > limit) throw Error('SETTINGS_WRITE_FAILED')
    atomicWriteFileSync(managedFile(this.directory, name), text, onPublished)
  }
  save(records: SavedConnection[], channels?: SavedChannel[]): void {
    if (this.error || this.snapshot === undefined) throw Error(this.error || 'SETTINGS_READ_FAILED')
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const lock = managedFile(this.directory, '.settings-write.lock')
    let fd: number
    try { fd = openExclusiveFileSync(lock) } catch { throw Error('SETTINGS_BUSY') }
    const lockIdentity = fstatSync(fd)
    let committed = false
    try {
      const pair = this.pair()
      if (digest(pair) !== this.snapshot) throw Error('SETTINGS_CONFLICT')
      const previous = this.parse(pair)
      if (!Array.isArray(records) || records.length > 100) throw Error('SETTINGS_WRITE_FAILED')
      const auth: Auth = {}, credentials = new Map<string, string>()
      const credentialFor = (key: string | null) => {
        if (key === null) return null
        const id = credentials.get(key) ?? randomUUID(); credentials.set(key, id); auth[id] = key; return id
      }
      if (channels && channels.length > 100) throw Error('SETTINGS_WRITE_FAILED')
      const savedChannels = channels?.map(channel => { const { key, ...saved } = channel; if (key !== null && (typeof key !== 'string' || key.length > 8192)) throw Error('SETTINGS_WRITE_FAILED'); return { ...saved, credential: credentialFor(key), validation: channelBinding(channel) } })
      const connections: SettingsRecord[] = records.map(record => {
        if (!record || typeof record !== 'object' || (record.key !== null && (typeof record.key !== 'string' || record.key.length > 8192))) throw Error('SETTINGS_WRITE_FAILED')
        const { key, ...saved } = record
        const credential = credentialFor(key)
        return { ...saved, credential, validation: binding(record) }
      })
      // Seed an empty settings file before first auth write: a crash still loads an empty profile.
      if (pair[0] === null) this.atomic('settings.json', { version: 3, connections: [] })
      this.atomic('auth.json', { version: 1, credentials: { ...previous.auth, ...auth } })
      this.fault('auth-prepared')
      this.atomic('settings.json', { version: channels ? 4 : 3, connections, ...(savedChannels ? { channels: savedChannels } : {}) }, () => { committed = true })
      committed = true; this.fault('settings-committed')
      this.atomic('auth.json', { version: 1, credentials: auth })
      this.fault('auth-pruned')
      this.snapshot = digest(this.pair())
    } catch (error) {
      this.error = committed ? 'SETTINGS_RESULT_UNKNOWN' : (error instanceof Error && error.message === 'SETTINGS_CONFLICT' ? 'SETTINGS_CONFLICT' : 'SETTINGS_WRITE_FAILED')
      throw Error(this.error)
    } finally {
      closeSync(fd)
      try { removeOwnedFileSync(lock, lockIdentity) }
      catch { this.error = committed ? 'SETTINGS_RESULT_UNKNOWN' : 'SETTINGS_WRITE_FAILED'; throw Error(this.error) }
    }
  }
}
