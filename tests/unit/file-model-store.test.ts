import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileModelStore } from '../../src/main/file-model-store'
import { applicationDirectory, prepareApplicationDirectory } from '../../src/main/application-data'
import { ModelService } from '../../src/runtime/model/service'
import type { SavedConnection } from '../../src/runtime/model/persistence'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function setup() {
  const parent = mkdtempSync(join(tmpdir(), 'trellis-settings-unit-')); roots.push(parent)
  const root = join(parent, '.trellis'); prepareApplicationDirectory(root)
  const store = new FileModelStore(root); expect(store.load().records).toEqual([])
  return { root, parent, store }
}
const record: SavedConnection = {
  configuration: { id: 'local-config', base_url: 'https://example.test/v1', wire_model_id: 'synthetic', context_tokens: 100000, max_output_tokens: 1024, compatibility_profile: 'chat-max-tokens' },
  key: 'synthetic-key-do-not-use', revision: 1, protocol: 'test-protocol', roles: ['main']
}
describe('hidden profile file settings', () => {
  it('resolves every normal platform to the same hidden directory without probing legacy paths', () => {
    expect(applicationDirectory('/synthetic/home')).toBe('/synthetic/home/.trellis')
    expect(applicationDirectory('/synthetic/home', '/isolated/.trellis')).toBe('/isolated/.trellis')
  })
  it('stores configuration and plaintext credentials separately and restarts without networking', () => {
    const { root, store } = setup(); store.save([record])
    expect(readFileSync(join(root, 'settings.json'), 'utf8')).not.toContain(record.key)
    expect(readFileSync(join(root, 'auth.json'), 'utf8')).toContain(record.key)
    expect(new FileModelStore(root).load()).toMatchObject({ backend: 'plain-file', records: [record] })
  })
  it('does not open or migrate a legacy credential file', () => {
    const { root } = setup(); writeFileSync(join(root, 'model-connections.secure'), 'legacy-do-not-open')
    const store = new FileModelStore(root); expect(store.load().records).toEqual([]); store.save([record])
    expect(readFileSync(join(root, 'model-connections.secure'), 'utf8')).toBe('legacy-do-not-open')
  })
  it('durably deletes credentials without forgetting ordinary settings', () => {
    const { root, store } = setup(); store.save([record]); store.save([{ ...record, key: null, roles: [], revision: 2 }])
    expect(readFileSync(join(root, 'auth.json'), 'utf8')).not.toContain(record.key)
    expect(new FileModelStore(root).load().records).toMatchObject([{ key: null, roles: [], revision: 2 }])
  })
  it('removes both remembered connection and its credential', () => {
    const { root, store } = setup(); store.save([record]); store.save([])
    expect(new FileModelStore(root).load().records).toEqual([])
    expect(JSON.parse(readFileSync(join(root, 'auth.json'), 'utf8')).credentials).toEqual({})
  })
  for (const point of ['auth-prepared', 'settings-committed', 'auth-pruned'] as const) it(`recovers actual committed facts after fault at ${point}`, () => {
    const { root, store } = setup(); store.save([record])
    const broken = new FileModelStore(root, at => { if (at === point) throw Error('injected') }); broken.load()
    const replacement = { ...record, key: 'new-synthetic-key', revision: 2, roles: [] }
    expect(() => broken.save([replacement])).toThrow(point === 'auth-prepared' ? 'SETTINGS_WRITE_FAILED' : 'SETTINGS_RESULT_UNKNOWN')
    expect(() => broken.save([record])).toThrow()
    const loaded = new FileModelStore(root).load()
    expect(loaded.error).toBeUndefined()
    expect(loaded.records).toEqual([point === 'auth-prepared' ? record : replacement])
  })
  it('does not claim deletion succeeded if pruning failed, and never reactivates an orphan key', () => {
    const { root, store } = setup(); store.save([record])
    const broken = new FileModelStore(root, point => { if (point === 'settings-committed') throw Error('injected') }); broken.load()
    expect(() => broken.save([{ ...record, key: null, roles: [] }])).toThrow('SETTINGS_RESULT_UNKNOWN')
    expect(readFileSync(join(root, 'auth.json'), 'utf8')).toContain(record.key)
    const restarted = new FileModelStore(root); expect(restarted.load().records).toMatchObject([{ key: null, roles: [] }])
    restarted.save([{ ...record, key: null, roles: [] }])
    expect(readFileSync(join(root, 'auth.json'), 'utf8')).not.toContain(record.key)
  })
  it('retains an empty profile on an interrupted first save', () => {
    const { root } = setup(), broken = new FileModelStore(root, () => { throw Error('injected') }); broken.load()
    expect(() => broken.save([record])).toThrow('SETTINGS_WRITE_FAILED')
    expect(new FileModelStore(root).load()).toMatchObject({ available: true, records: [] })
  })
  it('detects another window changing files instead of overwriting it', () => {
    const { root, store } = setup(), other = new FileModelStore(root); other.load(); store.save([record])
    expect(() => other.save([])).toThrow('SETTINGS_CONFLICT')
    expect(new FileModelStore(root).load().records).toEqual([record])
  })
  it('does not accumulate orphan credentials across repeated interrupted preparations', () => {
    const { root, store } = setup(); store.save([record])
    for (let n = 0; n < 4; n++) {
      const broken = new FileModelStore(root, point => { if (point === 'auth-prepared') throw Error('injected') }); broken.load()
      expect(() => broken.save([{ ...record, key: 'candidate-' + n }])).toThrow('SETTINGS_WRITE_FAILED')
      expect(Object.keys(JSON.parse(readFileSync(join(root, 'auth.json'), 'utf8')).credentials)).toHaveLength(2)
      expect(new FileModelStore(root).load().records).toEqual([record])
    }
    const restarted = new FileModelStore(root); restarted.load(); restarted.save([record])
    expect(Object.keys(JSON.parse(readFileSync(join(root, 'auth.json'), 'utf8')).credentials)).toHaveLength(1)
  })
  it('does not steal a live or abandoned write lock', () => {
    const { root, store } = setup(); writeFileSync(join(root, '.settings-write.lock'), '')
    expect(() => store.save([record])).toThrow('SETTINGS_BUSY')
    expect(new FileModelStore(root).load()).toMatchObject({ available: false, error: 'SETTINGS_READ_FAILED' })
    expect(existsSync(join(root, '.settings-write.lock'))).toBe(true)
  })
  for (const file of ['settings.json', 'auth.json']) it(`preserves malformed ${file} and blocks overwrite`, () => {
    const { root, store } = setup(); store.save([record]); writeFileSync(join(root, file), 'broken')
    const broken = new FileModelStore(root); expect(broken.load()).toMatchObject({ available: false, records: [] })
    expect(() => broken.save([])).toThrow('SETTINGS_READ_FAILED'); expect(readFileSync(join(root, file), 'utf8')).toBe('broken')
  })
  it('rejects missing credentials and a symlinked settings file', () => {
    const { root, parent, store } = setup(); store.save([record]); rmSync(join(root, 'auth.json'))
    expect(new FileModelStore(root).load().error).toBe('SETTINGS_READ_FAILED')
    rmSync(join(root, 'settings.json')); writeFileSync(join(parent, 'outside'), '{}'); symlinkSync(join(parent, 'outside'), join(root, 'settings.json'))
    expect(new FileModelStore(root).load().error).toBe('SETTINGS_READ_FAILED')
    expect(readFileSync(join(parent, 'outside'), 'utf8')).toBe('{}')
  })
  for (const edited of ['configuration', 'key', 'roles'] as const) it(`disables persisted validation after external ${edited} changes`, () => {
    const { root, store } = setup(); store.save([{ ...record, roles: [] }])
    if (edited === 'key') {
      const auth = JSON.parse(readFileSync(join(root, 'auth.json'), 'utf8')); auth.credentials[Object.keys(auth.credentials)[0]!] = 'changed'; writeFileSync(join(root, 'auth.json'), JSON.stringify(auth))
    } else {
      const settings = JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8'))
      if (edited === 'roles') settings.connections[0].roles = ['main']
      else settings.connections[0].configuration.max_output_tokens = 2048
      writeFileSync(join(root, 'settings.json'), JSON.stringify(settings))
    }
    expect(new FileModelStore(root).load().records).toMatchObject([{ roles: [] }])
  })
  it('requires explicit plaintext confirmation and invalidates roles on protocol change', async () => {
    const { root, store } = setup(); store.save([record])
    const backend = new FileModelStore(root)
    const service = new ModelService(undefined, undefined, { async load() { return backend.load() }, async save(records) { backend.save(records) } }, 'changed-protocol')
    await service.restore()
    expect(service.list()).toMatchObject([{ credential_storage: 'plain-file', roles: [] }])
    const input = { type: 'model.configure', configuration: record.configuration, api_key: record.key, confirm_memory_only: true, remember_connection: true }
    await expect(service.configureConnection({ ...input, confirm_secure_storage: true })).rejects.toThrow('Explicitly confirm')
    await service.configureConnection({ ...input, confirm_plaintext_storage: true })
    expect(JSON.stringify(service.list())).not.toContain(record.key)
    service.close()
  })
  it('leaves business files and resource protection directories untouched', () => {
    const { root, store } = setup()
    for (const name of ['resources', 'staging', 'plugins', 'recovery']) { mkdirSync(join(root, name)); writeFileSync(join(root, name, 'sentinel'), 'protected') }
    writeFileSync(join(root, 'trellis.sqlite'), 'business-sentinel')
    store.save([record]); store.save([])
    for (const name of ['resources', 'staging', 'plugins', 'recovery']) expect(readFileSync(join(root, name, 'sentinel'), 'utf8')).toBe('protected')
    expect(readFileSync(join(root, 'trellis.sqlite'), 'utf8')).toBe('business-sentinel')
  })
})

it.each([1, 2])('reads settings v%s without writing, upgrades only on explicit save, and retains auth v1', version => {
  const { root, store } = setup(); store.save([record])
  const settings = JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8')); settings.version = version
  writeFileSync(join(root, 'settings.json'), JSON.stringify(settings))
  const before = readFileSync(join(root, 'settings.json'), 'utf8'), auth = readFileSync(join(root, 'auth.json'), 'utf8')
  const fresh = new FileModelStore(root); expect(fresh.load().records).toEqual([record]); expect(readFileSync(join(root, 'settings.json'), 'utf8')).toBe(before); expect(readFileSync(join(root, 'auth.json'), 'utf8')).toBe(auth)
  fresh.save([record]); expect(JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8')).version).toBe(3); expect(JSON.parse(readFileSync(join(root, 'auth.json'), 'utf8')).version).toBe(1)
})
it('persists omitted output and explicit optional limits in v3 and restores without inventing defaults', async () => {
  const { root, store } = setup(), { max_output_tokens: _, ...configuration } = record.configuration
  const next: SavedConnection = { ...record, configuration: { ...configuration, limits: { run_model_requests: 55, request_timeout_ms: 300000 } } }
  store.save([next]); const settings = JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8'))
  expect(settings.version).toBe(3); expect(settings.connections[0].configuration).not.toHaveProperty('max_output_tokens')
  const backend = new FileModelStore(root), before = readFileSync(join(root, 'settings.json'), 'utf8')
  const service = new ModelService(undefined, undefined, { async load() { return backend.load() }, async save(values) { backend.save(values) } }, record.protocol)
  await service.restore(); expect(service.list()).toMatchObject([{ limits: next.configuration.limits }]); expect(service.recoverySettings()[0]).not.toHaveProperty('max_output_tokens')
  expect(readFileSync(join(root, 'settings.json'), 'utf8')).toBe(before); service.close()
})
it('persists provenance and compaction role in v2 with no credential in settings', () => {
  const { root, store }=setup(), next:SavedConnection={...record,roles:['compaction'],configuration:{...record.configuration,metadata:{context_tokens:{source:'service',fetched_at:'2026-10-29T00:00:00Z',manual_override:false},max_output_tokens:{source:'manual',fetched_at:null,manual_override:true},capabilities:{tools:'unknown',streaming:'unknown',vision:'unknown',structured_output:'unknown'}}}}
  store.save([next]);expect(new FileModelStore(root).load().records).toEqual([next]);expect(readFileSync(join(root,'settings.json'),'utf8')).not.toContain(record.key)
})
