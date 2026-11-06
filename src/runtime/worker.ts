import { backgroundExport } from './export-runner'
import { RuntimeStore } from './store'
import { ModelError } from './model/adapter'
import { ContractError } from '../shared/validation'
import { ModelService } from './model/service'
import type { ModelPersistence } from './model/persistence'
import { randomUUID } from 'node:crypto'
import { runtimeFeatures } from './features'
const directory = process.argv[2]
if (!directory || !process.parentPort) throw new Error('Runtime requires a private directory and utility-process channel')
const vaultPending = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
function vaultRequest(vault: 'load' | 'save', records?: unknown[], channels?: import('./model/channels').SavedChannel[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = randomUUID()
    const timer = setTimeout(() => { vaultPending.delete(id); reject(new Error('SETTINGS_TIMEOUT')) }, 30000)
    vaultPending.set(id, { resolve, reject, timer }); process.parentPort!.postMessage({ id, vault, records, channels })
  })
}
const persistence: ModelPersistence = { load: () => vaultRequest('load'), save: (records, channels) => vaultRequest('save', records, channels) }
const models = new ModelService(undefined, undefined, persistence)
const ready = models.restore()
// Baseline features retain authorization, platform and asset validation.
let store: RuntimeStore | undefined, startupError: ContractError | undefined
let shuttingDown = false
try { store = new RuntimeStore(directory, models, runtimeFeatures(process.env), backgroundExport, process.argv[3]) }
catch (error) { startupError = error instanceof ContractError ? error : new ContractError('MAINTENANCE_BLOCKED', 'Storage startup failed; business access is closed and files are retained') }
process.parentPort.on('message', async ({ data }: { data: { id: string; request: unknown; vault_response?: string; ok?: boolean; data?: unknown; error?: string; shutdown?: boolean } }) => {
  if (data.vault_response) {
    const waiting = vaultPending.get(data.vault_response)
    if (waiting) { clearTimeout(waiting.timer); vaultPending.delete(data.vault_response); data.ok ? waiting.resolve(data.data) : waiting.reject(new Error(data.error && /^SETTINGS_[A-Z_]+$/.test(data.error) ? data.error : 'SETTINGS_WRITE_FAILED')) }
    return
  }
  if (data.shutdown) {
    shuttingDown = true
    try { await store?.shutdown(); process.parentPort!.postMessage({ id: data.id, response: { ok: true, data: { closed: true } } }) }
    catch { process.parentPort!.postMessage({ id: data.id, response: { ok: false, error: { code: 'SHUTDOWN_UNCONFIRMED', message: 'Cleanup is unresolved; files remain protected' } } }) }
    return
  }
  await ready
  try {
    if (shuttingDown) throw new ContractError('SHUTTING_DOWN', 'Host is shutting down; no new work is accepted')
    if (startupError) {
      const type = (data.request as { type?: string })?.type
      if (type === 'maintenance.status') { process.parentPort!.postMessage({ id: data.id, response: { ok: true, data: { phase: 'blocked', error: startupError.code, active: null, reservation: null, restore_enabled: false, restore: { error: startupError.code, last: null }, retained_candidates: 0, gc_enabled: false, migration_enabled: false } } }); return }
      throw startupError
    }
    process.parentPort!.postMessage({ id: data.id, response: { ok: true, data: await store!.handle(data.request) } })
  }
  catch (error) { process.parentPort!.postMessage({ id: data.id, response: { ok: false, error: { code: error instanceof ContractError || error instanceof ModelError ? error.code : 'RUNTIME_ERROR', message: error instanceof ContractError ? error.message : 'Runtime operation failed; no automatic retry' } } }) }
})
