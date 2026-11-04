import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface SecureStorageBackend {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend(): string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}
export interface VaultStatus { available: boolean; backend: string; error?: string }
export interface VaultLoad extends VaultStatus { records: unknown[] }
const linuxBackends = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])
const limit = 2 * 1024 * 1024

// Only the trusted main process owns this file and the OS encryption API.
export class SecureModelStore {
  private file: string
  private readError: string | undefined
  constructor(private directory: string, private secure: SecureStorageBackend, private platform = process.platform) {
    this.file = join(directory, 'model-connections.secure')
  }
  status(): VaultStatus {
    try {
      const backend = this.platform === 'linux' ? this.secure.getSelectedStorageBackend() : this.platform === 'darwin' ? 'keychain' : this.platform === 'win32' ? 'dpapi' : 'unsupported'
      const supported = this.platform === 'darwin' || this.platform === 'win32' || (this.platform === 'linux' && linuxBackends.has(backend))
      return { available: supported && this.secure.isEncryptionAvailable(), backend, ...(this.readError ? { error: this.readError } : {}) }
    } catch { return { available: false, backend: 'unavailable' } }
  }
  load(): VaultLoad {
    const status = this.status()
    if (!existsSync(this.file)) return { ...status, records: [] }
    if (!status.available) { this.readError = 'SECURE_STORAGE_UNAVAILABLE'; return { ...status, error: this.readError, records: [] } }
    try {
      const bytes = readFileSync(this.file)
      if (bytes.length > limit) throw new Error()
      const value: unknown = JSON.parse(this.secure.decryptString(bytes))
      if (!value || typeof value !== 'object' || (value as any).version !== 1 || !Array.isArray((value as any).records) || (value as any).records.length > 100) throw new Error()
      this.readError = undefined
      return { ...status, records: (value as { records: unknown[] }).records }
    } catch { this.readError = 'SECURE_STORAGE_READ_FAILED'; return { ...status, error: this.readError, records: [] } }
  }
  save(records: unknown[]): void {
    if (this.readError) throw new Error(this.readError)
    if (!this.status().available) throw new Error('SECURE_STORAGE_UNAVAILABLE')
    const temporary = this.file + '.' + randomUUID() + '.tmp'
    try {
      if (records.length > 100) throw new Error()
      const text = JSON.stringify({ version: 1, records })
      if (Buffer.byteLength(text) > limit) throw new Error()
      const encrypted = this.secure.encryptString(text)
      if (encrypted.length > limit) throw new Error()
      mkdirSync(this.directory, { recursive: true, mode: 0o700 })
      const fd = openSync(temporary, 'wx', 0o600)
      try { writeFileSync(fd, encrypted); fsyncSync(fd) } finally { closeSync(fd) }
      renameSync(temporary, this.file)
    } catch {
      try { unlinkSync(temporary) } catch {}
      throw new Error('SECURE_STORAGE_WRITE_FAILED')
    }
  }
}
