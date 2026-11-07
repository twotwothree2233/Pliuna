import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach,expect,it,vi } from 'vitest'
import { prepareApplicationDirectory } from '../../src/main/application-data'
import { exportTargetIdentity,reconcileExport,saveExport } from '../../src/main/export-save'
import { FileModelStore } from '../../src/main/file-model-store'
import * as files from '../../src/platform/files'
import { atomicWriteFileSync } from '../../src/platform/files'
import type { SavedConnection } from '../../src/runtime/model/persistence'
import Database from 'better-sqlite3'
import { RuntimeStore } from '../../src/runtime/store'

const roots: string[] = []
function scene() { const root = fs.mkdtempSync(join(tmpdir(), 'trellis-persistence-')); roots.push(root); prepareApplicationDirectory(root); return root }
const record: SavedConnection = { configuration: { id: 'fixture', base_url: 'https://example.test/v1', wire_model_id: 'fixture', context_tokens: 10000, max_output_tokens: 1000, compatibility_profile: 'chat-max-tokens' }, key: 'old-key', revision: 1, protocol: 'fixture', roles: [] }
function settings() { const root = scene(), store = new FileModelStore(root); store.load(); store.save([record]); return { root, store } }
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

it('restores the committed configuration after losing the settings rename completion', () => {
  const { root, store } = settings(), rename = fs.renameSync
  vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
    rename(source, destination)
    if (destination === join(root, 'settings.json')) throw Object.assign(Error('lost completion'), { code: 'EIO' })
  })
  expect(() => store.save([{ ...record, key: 'new-key', revision: 2 }])).toThrow('SETTINGS_RESULT_UNKNOWN')
  vi.restoreAllMocks()
  expect(new FileModelStore(root).load().records).toMatchObject([{ key: 'new-key', revision: 2 }])
  expect(JSON.parse(fs.readFileSync(join(root, 'settings.json'), 'utf8')).version).toBe(3)
})
it.runIf(process.platform !== 'win32')('retains unknown status if directory flush fails after settings publication', () => {
  const { root, store } = settings(), rename = fs.renameSync, sync = fs.fsyncSync
  let published = false
  vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => { rename(source, destination); if (destination === join(root, 'settings.json')) published = true })
  vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => { if (published && fs.fstatSync(fd).isDirectory()) throw Object.assign(Error('flush failed'), { code: 'EIO' }); sync(fd) })
  expect(() => store.save([{ ...record, key: 'new-key' }])).toThrow('SETTINGS_RESULT_UNKNOWN')
  vi.restoreAllMocks()
  expect(new FileModelStore(root).load().records).toMatchObject([{ key: 'new-key' }])
})
it('preserves the old configuration when Windows-style replacement is denied', () => {
  const { root, store } = settings(), old = fs.readFileSync(join(root, 'settings.json'), 'utf8'), rename = fs.renameSync
  vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
    if (destination === join(root, 'settings.json')) throw Object.assign(Error('occupied'), { code: 'EPERM' })
    return rename(source, destination)
  })
  expect(() => store.save([{ ...record, key: 'new-key' }])).toThrow('SETTINGS_WRITE_FAILED')
  vi.restoreAllMocks()
  expect(fs.readFileSync(join(root, 'settings.json'), 'utf8')).toBe(old)
  expect(new FileModelStore(root).load().records).toMatchObject([{ key: 'old-key' }])
})
it('does not remove a replaced settings lock after a successful commit', () => {
  const { root } = settings(), lock = join(root, '.settings-write.lock')
  const store = new FileModelStore(root, point => { if (point === 'auth-prepared') { fs.renameSync(lock, join(root, 'old-lock')); fs.writeFileSync(lock, 'foreign owner') } })
  store.load()
  expect(() => store.save([{ ...record, key: 'new-key' }])).toThrow('SETTINGS_RESULT_UNKNOWN')
  expect(fs.readFileSync(lock, 'utf8')).toBe('foreign owner')
  expect(new FileModelStore(root).load().available).toBe(false)
})
it('does not treat a dangling settings lock as an empty profile', () => {
  const root = scene(); fs.symlinkSync(join(root, 'missing'), join(root, '.settings-write.lock'), 'file')
  expect(new FileModelStore(root).load().available).toBe(false)
  expect(fs.existsSync(join(root, 'missing'))).toBe(false)
})
it('publishes through an actual long Unicode path', () => {
  const root = scene(), directory = join(root, ...Array.from({ length: 40 }, () => '学习data'))
  fs.mkdirSync(directory, { recursive: true })
  const target = join(directory, '材料 file.json')
  atomicWriteFileSync(target, 'long path')
  expect(fs.readFileSync(target, 'utf8')).toBe('long path')
})
it('keeps an existing destination when native read-only permissions reject publication', () => {
  const root = scene(), target = join(root, 'readonly.json'); fs.writeFileSync(target, 'old')
  if (process.platform === 'win32') fs.chmodSync(target, 0o400)
  else fs.chmodSync(root, 0o500)
  try { expect(() => atomicWriteFileSync(target, 'new')).toThrow(); expect(fs.readFileSync(target, 'utf8')).toBe('old') }
  finally { fs.chmodSync(root, 0o700); fs.chmodSync(target, 0o600) }
})
it('refuses a junction in the managed resource directory', () => {
  const root = scene(), outside = scene(); fs.writeFileSync(join(outside, 'keep'), 'foreign')
  fs.symlinkSync(outside, join(root, 'resources'), process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => new RuntimeStore(root)).toThrow('FILE_DIRECTORY_UNSAFE')
  expect(fs.readFileSync(join(outside, 'keep'), 'utf8')).toBe('foreign')
})
it('does not create a database through a dangling restore-control link', () => {
  const root = scene(), outside = join(root, 'foreign.sqlite')
  fs.symlinkSync(outside, join(root, 'restore-control.sqlite'), 'file')
  expect(() => new RuntimeStore(root)).toThrow()
  expect(fs.existsSync(outside)).toBe(false)
})
it('refuses a multiply linked selected database before business writes', () => {
  const root = scene(), store = new RuntimeStore(root); store.create('retained'); store.close()
  const file = join(root, 'trellis.sqlite'), outside = join(root, 'foreign.sqlite')
  fs.renameSync(file, outside); fs.linkSync(outside, file); const before = fs.readFileSync(outside)
  expect(() => new RuntimeStore(root)).toThrow('FILE_UNSAFE')
  expect(fs.readFileSync(outside)).toEqual(before)
})
it('reconciles only the registered two-link export after interruption', async () => {
  const root = scene(), temporary = join(root, 'registered.tmp'), target = join(root, 'output.html')
  fs.writeFileSync(temporary, 'fixed'); const identity = files.fileStatSync(temporary)
  fs.linkSync(temporary, target)
  expect(await reconcileExport({ html: 'fixed', destination: { temporary, target, identity } }, false)).toBe('saved')
  expect(fs.existsSync(temporary)).toBe(false)
  expect(fs.statSync(target).nlink).toBe(1)
  expect(fs.readFileSync(target, 'utf8')).toBe('fixed')
})
it('does not accept an additional foreign export hard link', async () => {
  const root = scene(), temporary = join(root, 'registered.tmp'), target = join(root, 'output.html')
  fs.writeFileSync(temporary, 'fixed'); const identity = files.fileStatSync(temporary)
  fs.linkSync(temporary, target); fs.linkSync(target, join(root, 'foreign.html'))
  await expect(reconcileExport({ html: 'fixed', destination: { temporary, target, identity } }, true)).rejects.toThrow()
  expect(fs.statSync(target).nlink).toBe(3)
})
it('preserves an explicit user-selected export directory alias', async () => {
  const root = scene(), directory = scene(), alias = join(root, 'selected')
  fs.symlinkSync(directory, alias, process.platform === 'win32' ? 'junction' : 'dir')
  let phase = ''
  await saveExport(join(alias, 'output.html'), null, { begin: async () => ({ html: 'fixed' }), finish: async value => { phase = value } })
  expect(phase).toBe('saved'); expect(fs.readFileSync(join(directory, 'output.html'), 'utf8')).toBe('fixed')
})
it('rechecks an overwritten export target at the publication seam', async () => {
  const root = scene(), target = join(root, 'output.html'); fs.writeFileSync(target, 'original')
  const expected = await exportTargetIdentity(target), publish = files.publishPreparedFile
  vi.spyOn(files, 'publishPreparedFile').mockImplementation((...args) => {
    fs.writeFileSync(target, 'external edit')
    return publish(...args)
  })
  let phase = ''
  await saveExport(target, expected, { begin: async () => ({ html: 'new' }), finish: async value => { phase = value } })
  expect(phase).toBe('failed'); expect(fs.readFileSync(target, 'utf8')).toBe('external edit')
})
it.runIf(process.platform === 'win32')('retains a file held by the native Windows SQLite sharing lock', () => {
  const root = scene(), target = join(root, 'occupied.sqlite'), db = new Database(target)
  try {
    db.exec('CREATE TABLE retained (value INTEGER); INSERT INTO retained VALUES (42)')
    expect(() => atomicWriteFileSync(target, 'replacement')).toThrow()
    expect(db.prepare('SELECT value FROM retained').get()).toEqual({ value: 42 })
  } finally { db.close() }
  atomicWriteFileSync(target, 'explicit new attempt')
  expect(fs.readFileSync(target, 'utf8')).toBe('explicit new attempt')
})
