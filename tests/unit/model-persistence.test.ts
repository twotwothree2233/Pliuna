import { afterEach, describe, expect, it } from 'vitest'
import { ModelService } from '../../src/runtime/model/service'
import type { ModelPersistence, SavedConnection } from '../../src/runtime/model/persistence'
import { modelServer, synthetic } from '../helpers/model-server'
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
async function setup() {
  const server = await modelServer(({ body, url }, res) => { if (url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"wire-model"}]}') } else synthetic(body, res) }); cleanups.push(server.close)
  let records: SavedConnection[] = [], fail = false
  const persistence: ModelPersistence = {
    async load() { return { available: true, backend: 'test-protected', records: structuredClone(records) } },
    async save(next) { if (fail) throw new Error('private-backend-error'); records = structuredClone(next) }
  }
  const create = async (protocol = 'protocol-one') => {
    const service = new ModelService(undefined, undefined, persistence, protocol); cleanups.push(() => service.close()); await service.restore(); return service
  }
  const configuration = { id: 'saved-main', base_url: server.url, wire_model_id: 'wire-model', context_tokens: 1000000, max_output_tokens: 1024, compatibility_profile: 'chat-max-tokens' }
  const input = { type: 'model.configure', configuration, api_key: 'secret-sentinel', confirm_memory_only: true, remember_connection: true, confirm_secure_storage: true }
  return { create, input, server, records: () => records, fail: () => { fail = true } }
}
describe('remembered model configuration lifecycle', () => {
  it('restores config, credential and validation without network or exposing the key', async () => {
    const { create, input, server } = await setup(), service = await create()
    await service.configureConnection(input); await service.test('saved-main', 'main')
    const count = server.exchanges.length
    const restored = await create()
    expect(server.exchanges).toHaveLength(count)
    expect(restored.list()).toMatchObject([{ ...input.configuration, roles: ['main'], credential_storage: 'system-secure', credential_missing: false }])
    expect(JSON.stringify(restored.list())).not.toContain(input.api_key)
    restored.acquire('saved-main', 'main').release()
    await restored.discover('saved-main').catch(() => {})
    expect(server.exchanges.at(-1)!.authorization).toBe('Bearer secret-sentinel')
  })
  it('invalidates validation on protocol change without forgetting connection or key', async () => {
    const { create, input, server } = await setup(), service = await create()
    await service.configureConnection(input); await service.test('saved-main', 'main')
    const count = server.exchanges.length, changed = await create('protocol-two')
    expect(changed.list()).toMatchObject([{ wire_model_id: 'wire-model', roles: [], credential_storage: 'system-secure' }])
    expect(() => changed.acquire('saved-main', 'main')).toThrow('explicit synthetic test')
    expect(server.exchanges).toHaveLength(count)
    await changed.test('saved-main', 'main'); changed.acquire('saved-main', 'main').release()
  })
  it('retains validation for unchanged config, invalidates changed config and reuses a key without returning it', async () => {
    const { create, input } = await setup(), service = await create()
    await service.configureConnection(input); await service.test('saved-main', 'main')
    await service.configureConnection({ ...input, api_key: '', use_saved_credential: true })
    expect(service.list()).toMatchObject([{ roles: ['main'], revision: 1 }])
    await service.configureConnection({ ...input, api_key: '', use_saved_credential: true, configuration: { ...input.configuration, max_output_tokens: 2048 } })
    expect(service.list()).toMatchObject([{ roles: [], revision: 2, max_output_tokens: 2048 }])
    expect((await create()).list()).toMatchObject([{ roles: [], max_output_tokens: 2048 }])
    await expect(service.configureConnection({ ...input, api_key: '', use_saved_credential: true, configuration: { ...input.configuration, base_url: 'https://different.example/v1' } })).rejects.toThrow('same saved address')
  })
  it('deletes the credential durably, blocks discovery and testing, and allows explicit re-entry', async () => {
    const { create, input, records } = await setup(), service = await create()
    await service.configureConnection(input); await service.test('saved-main', 'main')
    await service.deleteCredential('saved-main')
    expect(records()[0]).toMatchObject({ key: null, roles: [] })
    const restored = await create()
    expect(restored.list()).toMatchObject([{ credential_missing: true, roles: [], wire_model_id: 'wire-model' }])
    await expect(restored.test('saved-main', 'main')).rejects.toThrow('Credential was deleted')
    await expect(restored.discover('saved-main')).rejects.toThrow('Credential was deleted')
    await restored.configureConnection(input); await restored.test('saved-main', 'main')
    restored.acquire('saved-main', 'main').release()
    await restored.removeConnection('saved-main')
    expect((await create()).list()).toEqual([])
  })
  it('can remember an existing memory-only connection without resubmitting a credential', async () => {
    const { create, input, records } = await setup(), service = await create()
    await service.configureConnection({ ...input, remember_connection: false })
    expect(records()).toEqual([])
    await service.test('saved-main', 'main'); await service.remember('saved-main')
    expect((await create()).list()).toMatchObject([{ roles: ['main'], credential_storage: 'system-secure' }])
  })
  it('forgets memory-only connections and durably unremembers an existing connection', async () => {
    const { create, input, records } = await setup(), service = await create()
    await service.configureConnection({ ...input, remember_connection: false })
    expect((await create()).list()).toEqual([])
    await service.remember('saved-main')
    await service.configureConnection({ ...input, remember_connection: false })
    expect(records()).toEqual([])
    expect(service.list()).toMatchObject([{ credential_storage: 'memory-only' }])
    expect((await create()).list()).toEqual([])
  })
  it('restores no roles or partial registry from invalid encrypted records and refuses overwrite', async () => {
    let writes = 0
    const service = new ModelService(undefined, undefined, {
      async load() { return { available: true, backend: 'test-protected', records: [{ configuration: { id: 'invalid' }, key: 'secret', revision: 1, protocol: 'current', roles: ['main'] }] } },
      async save() { writes++ }
    }); cleanups.push(() => service.close())
    await service.restore()
    expect(service.list()).toEqual([])
    expect(service.storageStatus()).toMatchObject({ error: 'SECURE_STORAGE_READ_FAILED' })
    await expect(service.configureConnection({ type: 'model.configure', configuration: { id: 'new', base_url: 'https://example.test/v1', wire_model_id: 'wire', context_tokens: 100000, max_output_tokens: 1024, compatibility_profile: 'chat-max-tokens' }, api_key: 'secret', confirm_memory_only: true, remember_connection: true, confirm_secure_storage: true })).rejects.toThrow('no plaintext fallback')
    expect(writes).toBe(0)
  })
  it('retains the old runtime and durable state after a failed save', async () => {
    const { create, input, fail, records } = await setup(), service = await create()
    await service.configureConnection(input); await service.test('saved-main', 'main')
    const previous = structuredClone(records()); fail()
    await expect(service.configureConnection({ ...input, api_key: 'different-secret' })).rejects.toThrow('previous state was retained')
    expect(records()).toEqual(previous)
    service.acquire('saved-main', 'main').release()
    await expect(service.deleteCredential('saved-main')).rejects.toThrow('previous state was retained')
    expect(service.list()).toMatchObject([{ credential_missing: false }])
  })
  it('honors existing configuration locks when remembering, deleting or editing', async () => {
    const { create, input } = await setup(), service = await create()
    await service.configureConnection(input); await service.test('saved-main', 'main')
    const lease = service.acquire('saved-main', 'main')
    for (const operation of [() => service.remember('saved-main'), () => service.deleteCredential('saved-main'), () => service.removeConnection('saved-main'), () => service.configureConnection(input)]) await expect(operation()).rejects.toThrow('occupied')
    lease.release()
  })
  it('deletes credentials for the shared channel, honors sibling locks and permits re-entry', async () => {
    const { create, input, records } = await setup(), service = await create()
    await service.configureConnection(input)
    await service.configureConnection({ ...input, configuration: { ...input.configuration, id: 'sibling' } })
    await service.test('sibling', 'main')
    const lease = service.acquire('sibling', 'main')
    await expect(service.deleteCredential('saved-main')).rejects.toThrow('occupied'); lease.release()
    await service.deleteCredential('saved-main')
    expect(records().map(entry => entry.key)).toEqual([null, null])
    const restored = await create()
    expect(restored.list()).toMatchObject([{ credential_missing: true, roles: [] }, { credential_missing: true, roles: [] }])
    await restored.configureConnection(input)
    expect((await create()).list()).toMatchObject([{ credential_missing: false }, { credential_missing: true }])
  })
  it('does not resurrect the previous validation after a failed explicit retest', async () => {
    const { create, input, server } = await setup(), service = await create()
    await service.configureConnection(input); await service.test('saved-main', 'main')
    await server.close()
    await expect(service.test('saved-main', 'main')).rejects.toBeDefined()
    expect((await create()).list()).toMatchObject([{ roles: [] }])
  })
  it('requires explicit confirmation before remembering a new connection', async () => {
    const { create, input } = await setup(), service = await create()
    await expect(service.configureConnection({ ...input, confirm_secure_storage: undefined })).rejects.toThrow('Explicitly confirm')
    expect(service.list()).toEqual([])
  })
  it('does not change validation or send a request if invalidation cannot be saved', async () => {
    const { create, input, fail, server } = await setup(), service = await create()
    await service.configureConnection(input); await service.test('saved-main', 'main')
    const requests = server.exchanges.length
    fail()
    await expect(service.test('saved-main', 'main')).rejects.toThrow('previous state was retained')
    expect(server.exchanges).toHaveLength(requests)
    service.acquire('saved-main', 'main').release()
    expect((await create()).list()).toMatchObject([{ roles: ['main'] }])
  })
  it('rejects a second mutation during a pending secure write', async () => {
    let release!: () => void
    const persistence: ModelPersistence = {
      async load() { return { available: true, backend: 'test-protected', records: [] } },
      save() { return new Promise<void>(resolve => { release = resolve }) }
    }
    const service = new ModelService(undefined, undefined, persistence); cleanups.push(() => service.close()); await service.restore()
    const input = { type: 'model.configure', configuration: { id: 'pending', base_url: 'https://example.test/v1', wire_model_id: 'wire', context_tokens: 100000, max_output_tokens: 1024, compatibility_profile: 'chat-max-tokens' }, api_key: 'secret', confirm_memory_only: true, remember_connection: true, confirm_secure_storage: true }
    const first = service.configureConnection(input)
    await expect(service.configureConnection({ ...input, configuration: { ...input.configuration, id: 'other' } })).rejects.toThrow('in progress')
    release(); await first
    expect(service.list()).toMatchObject([{ id: 'pending' }])
  })
  it('blocks further persistent writes after an unknown timeout result instead of replaying', async () => {
    let writes = 0
    const persistence: ModelPersistence = {
      async load() { return { available: true, backend: 'test-protected', records: [] } },
      async save() { writes++; throw new Error('SECURE_STORAGE_TIMEOUT') }
    }
    const service = new ModelService(undefined, undefined, persistence); cleanups.push(() => service.close()); await service.restore()
    const input = { type: 'model.configure', configuration: { id: 'unknown', base_url: 'https://example.test/v1', wire_model_id: 'wire', context_tokens: 100000, max_output_tokens: 1024, compatibility_profile: 'chat-max-tokens' }, api_key: 'secret', confirm_memory_only: true, remember_connection: true, confirm_secure_storage: true }
    await expect(service.configureConnection(input)).rejects.toThrow('result is unknown')
    expect(service.storageStatus()).toMatchObject({ error: 'SECURE_STORAGE_RESULT_UNKNOWN' })
    await expect(service.configureConnection(input)).rejects.toThrow('nothing was saved')
    expect(writes).toBe(1)
    expect(service.list()).toEqual([])
  })
  it('ends cancellation eligibility before committing successful validation, keeping disk and runtime consistent', async () => {
    const { input, server } = await setup()
    let records: SavedConnection[] = [], release!: () => void, savingSuccess = false
    const persistence: ModelPersistence = {
      async load() { return { available: true, backend: 'test-protected', records: structuredClone(records) } },
      async save(next) {
        records = structuredClone(next)
        if (next.some(entry => entry.roles.includes('main')) && !savingSuccess) { savingSuccess = true; await new Promise<void>(resolve => { release = resolve }) }
      }
    }
    const service = new ModelService(undefined, undefined, persistence); cleanups.push(() => service.close()); await service.restore()
    await service.configureConnection(input)
    const testing = service.test('saved-main', 'main', 'cancel-during-save')
    while (!savingSuccess) await new Promise(resolve => setTimeout(resolve, 2))
    expect(() => service.cancel('cancel-during-save')).toThrow('Operation has already ended')
    release()
    await expect(testing).resolves.toMatchObject({ enabled: true })
    expect(server.exchanges).toHaveLength(2)
    expect(records[0]!.roles).toEqual(['main'])
    expect(service.list()).toMatchObject([{ roles: ['main'] }])
    const restarted = new ModelService(undefined, undefined, persistence); cleanups.push(() => restarted.close()); await restarted.restore()
    expect(restarted.list()).toMatchObject([{ roles: ['main'] }])
  })
  it('rejects remembering when secure storage is unavailable instead of falling back to memory', async () => {
    const service = new ModelService(undefined, undefined, { async load() { return { available: false, backend: 'basic_text', records: [] } }, async save() { throw new Error('must not call') } }); cleanups.push(() => service.close())
    await service.restore()
    await expect(service.configureConnection({ type: 'model.configure', configuration: { id: 'blocked', base_url: 'https://example.test/v1', wire_model_id: 'wire', context_tokens: 100000, max_output_tokens: 1024, compatibility_profile: 'chat-max-tokens' }, api_key: 'secret', confirm_memory_only: true, remember_connection: true, confirm_secure_storage: true })).rejects.toThrow('no plaintext fallback')
    expect(service.list()).toEqual([])
  })
})
