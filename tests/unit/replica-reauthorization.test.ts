import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeStore } from '../../src/runtime/store'
import { digest } from '../../src/runtime/resources'
import { RestoreJournal } from '../../src/runtime/restore-journal'
import { RecoveryManager } from '../../src/runtime/recovery'
import { validateRetirement, type Retirement } from '../../src/runtime/replicas'

let root: string, store: RuntimeStore, task: string
const state = (): any => store.handle({ type: 'maintenance.status' })
const begin = (): string => (store.handle({ type: 'maintenance.begin' }) as any).reservation.token
const cancel = (token: string): void => { if (state().reservation?.token === token) store.handle({ type: 'maintenance.cancel', token }) }
const control = (): any => { const db = new Database(join(root, 'restore-control.sqlite')); try { return JSON.parse((db.prepare('SELECT manifest FROM restore_control').get() as any).manifest) } finally { db.close() } }
const record = (id: string): Retirement => control().retirements.find((r: Retirement) => r.id === id)
const journal = (): RestoreJournal => Reflect.get(store, 'journal')
const status = (operation_id: string, authorization_id?: string): any => store.handle({ type: 'maintenance.replica.status', operation_id, ...(authorization_id ? { authorization_id } : {}) })
const preview = (operation_id: string, token = begin()): any => store.handle({ type: 'maintenance.replica.reauthorize.preview', operation_id, token, inputs_saved: true })
const confirm = (operation_id: string, authorization_id: string, token: string): any => store.handle({ type: 'maintenance.replica.reauthorize.confirm', operation_id, authorization_id, token, inputs_saved: true, confirm_reauthorize_replica: true })
const retry = (operation_id: string): any => store.handle({ type: 'maintenance.replica.retry', operation_id, token: begin(), inputs_saved: true, confirm_retire_replica: true })
const restart = (): void => { store.close(); store = new RuntimeStore(root, undefined, { viewReplacement: true }) }
const advance = (milliseconds: number): void => { const now = Date.now(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now + milliseconds) }
const point = async (): Promise<any> => store.handle({ type: 'maintenance.create', token: begin(), inputs_saved: true, replace_id: state().active?.id ?? null })
const restore = async (): Promise<any> => store.handle({ type: 'maintenance.restore', token: begin(), point_id: state().active.id, database_sha256: state().active.database_sha256, inputs_saved: true, confirm_replace_newer_data: true })
const busy = (): Error => Object.assign(new Error('fixture failure'), { code: 'EBUSY' })

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'pliuna-reauthorization-'))
  store = new RuntimeStore(root, undefined, { viewReplacement: true })
  task = store.create('清理重新授权').task.id
})
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); store.close(); fs.rmSync(root, { recursive: true, force: true }) })

function failControlWrite(when: (r: Retirement) => boolean): void {
  const original = Database.prototype.prepare
  vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql: string) {
    const statement = original.call(this, sql)
    if (this.name.endsWith('restore-control.sqlite') && sql.startsWith('UPDATE restore_control SET manifest=')) return new Proxy(statement, { get(target, key) {
      if (key === 'run') return (manifest: string) => {
        if (JSON.parse(manifest).retirements.some(when)) throw Object.assign(new Error('control write failed'), { code: 'EIO' })
        return target.run(manifest)
      }
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
    } })
    return statement
  } as typeof Database.prototype.prepare)
}

async function unfinished(attemptZero = false): Promise<{ id: string; file: string; original: Retirement }> {
  const obsolete = (await point()).active
  await point()
  const file = 'recovery/' + obsolete.id + '.sqlite'
  fs.writeFileSync(join(root, file + '-journal'), Buffer.alloc(512))
  const token = begin(), p: any = store.handle({ type: 'maintenance.replica.preview', token, replica_id: digest(Buffer.from(file)), inputs_saved: true })
  if (attemptZero) {
    failControlWrite(r => r.id === p.id && r.attempt === 1)
    expect(() => store.handle({ type: 'maintenance.replica.execute', token, operation_id: p.id, inputs_saved: true, confirm_retire_replica: true })).toThrow()
    expect(record(p.id)).toMatchObject({ phase: 'retired', attempt: 0 })
  } else {
    const unlink = fs.unlinkSync
    vi.spyOn(fs, 'unlinkSync').mockImplementation(path => { if (String(path) === join(root, file + '-journal')) throw busy(); unlink(path) })
    expect(store.handle({ type: 'maintenance.replica.execute', token, operation_id: p.id, inputs_saved: true, confirm_retire_replica: true })).toMatchObject({ phase: 'retired', attempt: 1, reason: 'EBUSY' })
  }
  vi.restoreAllMocks()
  const original = record(p.id)
  await restore(); restart()
  advance(1100)
  expect(control().selected).not.toBe(original.selected)
  return { id: p.id, file, original }
}

it('previews the original remaining group without reopening it, changing its ticket, releasing pins or deleting files', async () => {
  const { id, file, original } = await unfinished()
  const prepare = vi.spyOn(Database.prototype, 'prepare'), unlink = vi.spyOn(fs, 'unlinkSync'), token = begin(), p = preview(id, token)
  expect(p).toMatchObject({ id, phase: 'retired', attempt: 1, reauthorization_required: true, can_reauthorize: true, authorization_count: 1, reauthorization: { state: 'preview', files: [{ kind: '-journal', state: 'pending', bytes: 512 }] } })
  expect(unlink).not.toHaveBeenCalled()
  expect(prepare.mock.contexts.every(db => Reflect.get(Object(db), 'name') !== join(root, file))).toBe(true)
  const next = record(id)
  for (const key of ['id', 'token', 'file', 'selected', 'graph', 'created_at', 'protection', 'attempt', 'next_retry_at'] as const) expect(next[key]).toEqual(original[key])
  expect(next.members.map(m => ({ suffix: m.suffix, identity: m.identity }))).toEqual(original.members.map(m => ({ suffix: m.suffix, identity: m.identity })))
  expect(next.reauthorizations![0]).toMatchObject({ version: 1, token, selected: control().selected, expected_attempt: 1, expected_phase: 'retired', members: expect.arrayContaining([expect.objectContaining({ suffix: '', state: 'deleted', observed_present: false }), expect.objectContaining({ suffix: '-journal', state: 'pending', observed_present: true })]) })
  expect(JSON.stringify(p)).not.toMatch(/recovery\/|restore-|storage_key|selected|\/Users\//)
  expect(fs.existsSync(join(root, file + '-journal'))).toBe(true)
  cancel(token)
})

it('keeps old retry rejected and continues the original operation once after explicit confirmation', async () => {
  const { id, file, original } = await unfinished()
  expect(() => retry(id)).toThrow()
  expect(record(id).attempt).toBe(1)
  const token = begin(), p = preview(id, token), unlink = vi.spyOn(fs, 'unlinkSync')
  const result = confirm(id, p.reauthorization.id, token)
  expect(result).toMatchObject({ id, phase: 'released', attempt: 2, protection_released: true, reauthorization: { id: p.reauthorization.id, state: 'confirmed' }, formal_resources_deleted: 0, business_replayed: false })
  expect(unlink.mock.calls.map(([path]) => String(path))).toEqual([join(root, file + '-journal')])
  expect(record(id)).toMatchObject({ selected: original.selected, token: original.token, graph: original.graph, protection: original.protection, reauthorization_confirmations: [{ authorization_id: p.reauthorization.id, attempt: 2 }] })
  restart(); expect(status(id, p.reauthorization.id)).toEqual(result); expect(store.snapshot(task)).toBeTruthy()
})

it('preserves a fresh reservation when a lost confirmation response is queried by duplicate IPC', async () => {
  const { id } = await unfinished(), token = begin(), p = preview(id, token), result = confirm(id, p.reauthorization.id, token)
  const fresh = begin(), unlink = vi.spyOn(fs, 'unlinkSync')
  expect(confirm(id, p.reauthorization.id, fresh)).toEqual(result)
  expect(state()).toMatchObject({ phase: 'preparing', reservation: { token: fresh } })
  expect(unlink).not.toHaveBeenCalled(); expect(record(id).attempt).toBe(2); cancel(fresh)
})

it('keeps each original authorization queryable after a later preview and does not consume that preview', async () => {
  const { id } = await unfinished(), token = begin(), a = preview(id, token).reauthorization.id
  vi.spyOn(fs, 'unlinkSync').mockImplementation(() => { throw busy() })
  expect(confirm(id, a, token)).toMatchObject({ attempt: 2, phase: 'retired', reauthorization: { id: a, state: 'confirmed' } })
  vi.restoreAllMocks(); advance(5001)
  const next = begin(), b = preview(id, next).reauthorization.id, unlink = vi.spyOn(fs, 'unlinkSync')
  expect(status(id, a).reauthorization).toMatchObject({ id: a, state: 'confirmed' })
  expect(confirm(id, a, next)).toMatchObject({ attempt: 2, authorization_count: 2, reauthorization: { id: a, state: 'confirmed' } })
  expect(state().reservation.token).toBe(next); expect(unlink).not.toHaveBeenCalled()
  expect(confirm(id, b, next)).toMatchObject({ phase: 'released', attempt: 3, reauthorization: { id: b, state: 'confirmed' } })
  expect(record(id).reauthorizations!.map(a => a.id)).toEqual([a, b])
})

it('supports retirement before the original first attempt without resetting its independent binding', async () => {
  const { id, original } = await unfinished(true), token = begin(), p = preview(id, token)
  expect(p).toMatchObject({ attempt: 0, reauthorization: { state: 'preview' } })
  expect(confirm(id, p.reauthorization.id, token)).toMatchObject({ phase: 'released', attempt: 1 })
  expect(record(id)).toMatchObject({ selected: original.selected, reauthorization_confirmations: [{ attempt: 1 }] })
})

it.each(['inputs_saved', 'confirm_reauthorize_replica', 'authorization_id'])('rejects confirmation missing %s', async missing => {
  const { id } = await unfinished(), token = begin(), p = preview(id, token)
  const request: any = { type: 'maintenance.replica.reauthorize.confirm', operation_id: id, authorization_id: p.reauthorization.id, token, inputs_saved: true, confirm_reauthorize_replica: true }
  delete request[missing]
  expect(() => store.handle(request)).toThrow(); expect(record(id).attempt).toBe(1); expect(record(id).reauthorization_confirmations).toBeUndefined(); cancel(token)
})

it('keeps an unconfirmed preview across restart but rejects its expired reservation', async () => {
  const { id, file } = await unfinished(), token = begin(), a = preview(id, token).reauthorization.id, before = record(id)
  restart(); expect(status(id, a).reauthorization).toMatchObject({ id: a, state: 'preview' })
  expect(() => confirm(id, a, token)).toThrow()
  const fresh = begin(); expect(() => confirm(id, a, fresh)).toThrow()
  expect(record(id)).toEqual(before); expect(fs.existsSync(join(root, file + '-journal'))).toBe(true)
})

it('requires a fresh reservation after a superseded preview confirmation is rejected', async () => {
  const { id } = await unfinished(), token = begin(), a = preview(id, token).reauthorization.id, b = preview(id, token).reauthorization.id
  expect(() => confirm(id, a, token)).toThrow()
  expect(record(id).attempt).toBe(1)
  // A rejected collection releases its reservation, so the newer preview must be prepared again.
  const fresh = begin(), c = preview(id, fresh).reauthorization.id
  expect(() => confirm(id, b, fresh)).toThrow()
  const last = begin(), d = preview(id, last).reauthorization.id
  expect(status(id, c).reauthorization.state).toBe('preview')
  expect(confirm(id, d, last)).toMatchObject({ phase: 'released', attempt: 2 })
})

it.each(['changed', 'new-member', 'reappeared'])('rejects %s during preview and confirmation without extending the frozen group', async mode => {
  const { id, file } = await unfinished(), token = begin(), p = preview(id, token), before = record(id)
  if (mode === 'changed') fs.utimesSync(join(root, file + '-journal'), new Date(), new Date(Date.now() + 5000))
  if (mode === 'new-member') fs.writeFileSync(join(root, file + '-wal'), 'new member')
  if (mode === 'reappeared') fs.writeFileSync(join(root, file), 'reappeared')
  const unlink = vi.spyOn(fs, 'unlinkSync')
  expect(() => confirm(id, p.reauthorization.id, token)).toThrow()
  const next = begin(); expect(() => preview(id, next)).toThrow(); cancel(next)
  expect(record(id)).toEqual(before); expect(unlink).not.toHaveBeenCalled()
})

it.each(['graph', 'progress', 'presence'])('rejects changed %s between preview and confirmation', async mode => {
  const { id, file } = await unfinished(), token = begin(), p = preview(id, token)
  if (mode === 'graph') vi.spyOn(RecoveryManager.prototype, 'replicaGraph').mockReturnValue({ changed: true })
  if (mode === 'progress') { const r = record(id); r.members.find(m => m.suffix === '-journal')!.state = 'deleting'; journal().saveRetirement(r) }
  if (mode === 'presence') fs.unlinkSync(join(root, file + '-journal'))
  const before = record(id), unlink = vi.spyOn(fs, 'unlinkSync')
  expect(() => confirm(id, p.reauthorization.id, token)).toThrow(); expect(record(id)).toEqual(before); expect(unlink).not.toHaveBeenCalled()
})

it('rejects an old preview after a second actual database selection switch', async () => {
  const { id } = await unfinished(), token = begin(), a = preview(id, token).reauthorization.id, selected = control().selected
  cancel(token); await restore(); restart(); expect(control().selected).not.toBe(selected)
  const fresh = begin(); expect(() => confirm(id, a, fresh)).toThrow(); expect(record(id).attempt).toBe(1)
})

it.each(['selection', 'graph', 'reservation'])('rechecks %s after durable intent and before unlink', async mode => {
  const { id, original } = await unfinished(), token = begin(), p = preview(id, token), save = RestoreJournal.prototype.saveRetirement
  vi.spyOn(RestoreJournal.prototype, 'saveRetirement').mockImplementation(function (this: RestoreJournal, r) {
    save.call(this, r)
    if (r.id === id && r.reason === 'FILE_DELETE_INTENT' && r.reauthorization_confirmations?.length) {
      if (mode === 'selection') vi.spyOn(this, 'selected').mockReturnValue(original.selected)
      if (mode === 'graph') vi.spyOn(RecoveryManager.prototype, 'replicaGraph').mockReturnValue({ changed: true })
      if (mode === 'reservation') vi.spyOn(RecoveryManager.prototype, 'status').mockReturnValue({ phase: 'idle', reservation: null })
    }
  })
  const unlink = vi.spyOn(fs, 'unlinkSync'), r = confirm(id, p.reauthorization.id, token)
  expect(r).toMatchObject({ phase: 'retired', attempt: 2, protection_released: false })
  expect(unlink).not.toHaveBeenCalled(); expect(record(id).reauthorization_confirmations).toHaveLength(1)
})

it('does not mutate the original operation when preview or confirmation persistence fails', async () => {
  const { id, file } = await unfinished(), before = record(id), token = begin()
  failControlWrite(r => r.id === id && !!r.reauthorizations?.length)
  expect(() => preview(id, token)).toThrow(); expect(record(id)).toEqual(before); cancel(token)
  vi.restoreAllMocks()
  const next = begin(), a = preview(id, next).reauthorization.id, frozen = record(id)
  failControlWrite(r => r.id === id && !!r.reauthorization_confirmations?.length)
  const unlink = vi.spyOn(fs, 'unlinkSync')
  expect(() => confirm(id, a, next)).toThrow(); expect(record(id)).toEqual(frozen); expect(unlink).not.toHaveBeenCalled()
  expect(fs.existsSync(join(root, file + '-journal'))).toBe(true)
})

it('consumes a durable confirmation once when execution stops before its first unlink', async () => {
  const { id, file } = await unfinished(), token = begin(), a = preview(id, token).reauthorization.id, save = RestoreJournal.prototype.saveRetirement
  vi.spyOn(RestoreJournal.prototype, 'saveRetirement').mockImplementation(function (this: RestoreJournal, r) {
    save.call(this, r)
    if (r.id === id && r.reason === 'REAUTHORIZATION_DURABLE') throw new Error('response lost after durable confirmation')
  })
  expect(() => confirm(id, a, token)).toThrow()
  vi.restoreAllMocks(); restart()
  expect(record(id)).toMatchObject({ attempt: 2, reauthorization_confirmations: [{ authorization_id: a, attempt: 2 }] })
  const fresh = begin(), unlink = vi.spyOn(fs, 'unlinkSync')
  expect(confirm(id, a, fresh)).toMatchObject({ phase: 'retired', attempt: 2, reauthorization: { id: a, state: 'confirmed' } })
  expect(unlink).not.toHaveBeenCalled(); expect(fs.existsSync(join(root, file + '-journal'))).toBe(true)
  const b = preview(id, fresh).reauthorization.id
  expect(confirm(id, b, fresh)).toMatchObject({ phase: 'released', attempt: 3 })
})

it.each(['intent', 'deleted', 'group_deleted', 'released'])('retains progress and single-use confirmation when %s persistence fails', async phase => {
  const { id } = await unfinished(), token = begin(), a = preview(id, token).reauthorization.id
  failControlWrite(r => r.id === id && !!r.reauthorization_confirmations?.length && (phase === 'intent' ? r.reason === 'FILE_DELETE_INTENT' : phase === 'deleted' ? r.members.find(m => m.suffix === '-journal')?.state === 'deleted' : r.phase === phase))
  const failed = confirm(id, a, token)
  expect(failed).toMatchObject({ phase: phase === 'released' ? 'group_deleted' : 'retired', attempt: 2, reason: 'EIO', protection_released: false })
  expect(Date.parse(failed.next_retry_at) - Date.now()).toBe(5000)
  vi.restoreAllMocks(); restart()
  const fresh = begin(), unlink = vi.spyOn(fs, 'unlinkSync')
  expect(confirm(id, a, fresh)).toMatchObject({ attempt: 2, protection_released: false, reauthorization: { id: a, state: 'confirmed' } })
  expect(unlink).not.toHaveBeenCalled(); cancel(fresh); advance(5001)
  const next = begin(), b = preview(id, next).reauthorization.id
  expect(confirm(id, b, next)).toMatchObject({ phase: 'released', attempt: 3 })
})

it('preserves cumulative backoff and the four-attempt cap across independent authorizations', async () => {
  const { id, file } = await unfinished(), original = record(id)
  vi.spyOn(fs, 'unlinkSync').mockImplementation(() => { throw busy() })
  for (const [index, delay] of [5001, 15001, 0].entries()) {
    const token = begin(), a = preview(id, token).reauthorization.id
    const r = confirm(id, a, token)
    expect(r).toMatchObject({ phase: 'retired', attempt: index + 2, can_reauthorize: false, reauthorization: { id: a, state: 'confirmed' } })
    const next = begin(); expect(() => preview(id, next)).toThrow(); cancel(next)
    const duplicate = confirm(id, a, randomUUID()); expect(duplicate.attempt).toBe(index + 2)
    if (delay) advance(delay)
  }
  expect(record(id)).toMatchObject({ attempt: 4, selected: original.selected, protection: original.protection, next_retry_at: null })
  vi.restoreAllMocks(); restart()
  expect(status(id)).toMatchObject({ attempt: 4, authorization_count: 3, can_reauthorize: false, protection_released: false })
  expect(fs.existsSync(join(root, file + '-journal'))).toBe(true)
})

it('validates complete authorization payloads and confirmation relationships', async () => {
  const { id } = await unfinished(), token = begin(), a = preview(id, token).reauthorization.id
  const frozen = record(id)
  const changes: Array<(r: any) => void> = [
    r => { r.extra = true }, r => { r.reauthorizations = {} }, r => { r.reauthorization_confirmations = {} },
    r => { r.reauthorizations[0].extra = true }, r => { r.reauthorizations[0].version = 2 },
    r => { r.reauthorizations[0].id = 'bad' }, r => { r.reauthorizations[0].token = 'bad' },
    r => { r.reauthorizations[0].selected = '../elsewhere.sqlite' }, r => { r.reauthorizations[0].graph = 'bad' },
    r => { r.reauthorizations[0].created_at = null }, r => { r.reauthorizations[0].expected_attempt = 4 },
    r => { r.reauthorizations[0].expected_phase = 'preview' }, r => { r.reauthorizations[0].members.pop() },
    r => { r.reauthorizations[0].members[1].identity.hash = '0'.repeat(64) },
    r => { r.reauthorizations[0].members[1].observed_present = 'true' },
    r => { r.reauthorizations[0].members[0].observed_present = true },
    r => { r.reauthorizations.push(structuredClone(r.reauthorizations[0])) },
    r => { r.reauthorization_confirmations = [{ authorization_id: randomUUID(), confirmed_at: new Date().toISOString(), attempt: 2 }] },
    r => { r.reauthorization_confirmations = [{ authorization_id: a, confirmed_at: new Date().toISOString(), attempt: 1 }] }
  ]
  for (const mutate of changes) { const value = structuredClone(frozen); mutate(value); expect(() => validateRetirement(value)).toThrow(expect.objectContaining({ code: 'REPLICA_CONTROL_INVALID' })) }
  expect(confirm(id, a, token)).toMatchObject({ phase: 'released' })
  const confirmed = record(id)
  for (const mutate of [(r: any) => { r.reauthorization_confirmations[0].confirmed_at = 'bad' }, (r: any) => { r.reauthorization_confirmations.push(r.reauthorization_confirmations[0]) }, (r: any) => { r.reauthorization_confirmations[0].attempt = 4 }]) {
    const value = structuredClone(confirmed); mutate(value); expect(() => validateRetirement(value)).toThrow(expect.objectContaining({ code: 'REPLICA_CONTROL_INVALID' }))
  }
})

it('rejects mutation or truncation of original authority and append-only history', async () => {
  const { id } = await unfinished(), token = begin(), a = preview(id, token).reauthorization.id
  const frozen = record(id)
  const changes: Array<(r: any) => void> = [
    r => { r.token = randomUUID() }, r => { r.selected = control().selected }, r => { r.graph = '0'.repeat(64) },
    r => { r.created_at = new Date(Date.now() + 1).toISOString() }, r => { r.protection.tasks.push(randomUUID()) },
    r => { r.members[1].identity.mtime++ }, r => { r.members[0].state = 'pending' }, r => { r.attempt = 0 },
    r => { delete r.reauthorizations }, r => { r.reauthorizations[0].token = randomUUID() },
    r => { r.reauthorizations[0].members.find((m: any) => m.suffix === '-journal').observed_present = false },
    r => { r.reauthorizations.push({ ...structuredClone(r.reauthorizations[0]), id: randomUUID() }); r.next_retry_at = null }
  ]
  for (const mutate of changes) { const value = structuredClone(frozen); mutate(value); expect(() => journal().saveRetirement(value)).toThrow(); expect(record(id)).toEqual(frozen) }
  expect(confirm(id, a, token).phase).toBe('released')
  const confirmed = record(id)
  for (const mutate of [(r: any) => { r.reauthorization_confirmations = [] }, (r: any) => { r.reauthorization_confirmations[0].confirmed_at = new Date(Date.now() + 1).toISOString() }]) {
    const value = structuredClone(confirmed); mutate(value); expect(() => journal().saveRetirement(value)).toThrow(); expect(record(id)).toEqual(confirmed)
  }
})

it('compares an original v1 identity under a v2 control journal using its own encoding', async context => {
  const { id } = await unfinished()
  if (record(id).version !== 1) { context.skip(); return }
  expect(record(id).version).toBe(1)
  // Promote only the independent control envelope; existing ticket identities stay numeric v1.
  store.close()
  const db = new Database(join(root, 'restore-control.sqlite')), value = control()
  value.version = 6; value.export_control = 2
  db.prepare('UPDATE restore_control SET manifest=?').run(JSON.stringify(value)); db.close()
  fs.writeFileSync(join(root, 'restore-established'), 'restore-v6\n')
  const exports = new Database(join(root, 'export-control.sqlite'))
  expect(exports.prepare('SELECT count(*) n FROM export_jobs').get()).toEqual({ n: 0 })
  exports.prepare('UPDATE export_version SET version=2').run(); exports.close()
  store = new RuntimeStore(root, undefined, { viewReplacement: true })
  const token = begin(), p = preview(id, token)
  expect(control().version).toBe(6); expect(record(id).version).toBe(1)
  expect(typeof record(id).reauthorizations![0]!.members[1]!.identity.ino).toBe('number')
  expect(confirm(id, p.reauthorization.id, token)).toMatchObject({ phase: 'released', attempt: 2 })
})
