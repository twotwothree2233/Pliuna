import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { SecureModelStore, type SecureStorageBackend } from '../../src/main/secure-model-store'
const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function setup(platform: NodeJS.Platform = 'darwin', backend = 'gnome_libsecret', available = true) {
  const directory = mkdtempSync(join(tmpdir(), 'trellis-vault-')); directories.push(directory)
  const key = randomBytes(32)
  const secure: SecureStorageBackend = {
    isEncryptionAvailable: () => available, getSelectedStorageBackend: () => backend,
    encryptString(text) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const bytes = Buffer.concat([cipher.update(text), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]) },
    decryptString(bytes) { const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString() }
  }
  return { directory, secure, store: new SecureModelStore(directory, secure, platform) }
}
describe('OS-protected model vault, never plaintext fallback', () => {
  for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']) it('accepts protected Linux backend ' + backend, () => {
    const { store } = setup('linux', backend)
    expect(store.status()).toMatchObject({ available: true, backend })
    store.load(); store.save([{ protected: true }])
    expect(store.load().records).toEqual([{ protected: true }])
  })
  for (const platform of ['darwin', 'win32', 'linux'] as const) it('encrypts and restores on the ' + platform + ' backend contract', () => {
    const { directory, store, secure } = setup(platform)
    expect(store.load().records).toEqual([])
    store.save([{ configuration: { id: 'sentinel' }, key: 'never-plaintext-sentinel' }])
    const disk = readFileSync(join(directory, 'model-connections.secure'))
    expect(disk.includes(Buffer.from('never-plaintext-sentinel'))).toBe(false)
    expect(disk.includes(Buffer.from('configuration'))).toBe(false)
    expect(new SecureModelStore(directory, secure, platform).load().records).toEqual([{ configuration: { id: 'sentinel' }, key: 'never-plaintext-sentinel' }])
    store.save([])
    expect(new SecureModelStore(directory, secure, platform).load().records).toEqual([])
  })
  for (const backend of ['basic_text', 'unknown', 'unexpected']) it('refuses Linux backend ' + backend, () => {
    const { store } = setup('linux', backend)
    expect(store.status().available).toBe(false)
    expect(() => store.save([{ key: 'not-written' }])).toThrow('SECURE_STORAGE_UNAVAILABLE')
  })
  for (const platform of ['darwin', 'win32', 'linux'] as const) it('fails closed when secure storage is unavailable on ' + platform, () => {
    const { store } = setup(platform, 'gnome_libsecret', false)
    expect(() => store.save([])).toThrow('SECURE_STORAGE_UNAVAILABLE')
  })
  it('does not overwrite an unreadable existing vault or return raw backend errors', () => {
    const { store, directory } = setup()
    writeFileSync(join(directory, 'model-connections.secure'), 'broken-vault')
    expect(store.load().error).toBe('SECURE_STORAGE_READ_FAILED')
    expect(() => store.save([])).toThrow('SECURE_STORAGE_READ_FAILED')
    expect(readFileSync(join(directory, 'model-connections.secure'), 'utf8')).toBe('broken-vault')
  })
  it('leaves the old encrypted registry intact on encryption failure', () => {
    const { store, directory, secure } = setup()
    store.load(); store.save([{ key: 'old-secret' }])
    const previous = readFileSync(join(directory, 'model-connections.secure'))
    secure.encryptString = () => { throw new Error('raw-credential-error') }
    expect(() => store.save([{ key: 'new-secret' }])).toThrow('SECURE_STORAGE_WRITE_FAILED')
    expect(readFileSync(join(directory, 'model-connections.secure'))).toEqual(previous)
  })
  it('reports a filesystem replace failure without leaving a temporary file', () => {
    const { store, directory } = setup()
    store.load()
    mkdirSync(join(directory, 'model-connections.secure'))
    expect(() => store.save([{ key: 'not-written' }])).toThrow('SECURE_STORAGE_WRITE_FAILED')
    expect(readdirSync(directory)).toEqual(['model-connections.secure'])
  })
})
