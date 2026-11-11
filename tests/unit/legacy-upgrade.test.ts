import '../helpers/synthetic-file-integrity'
import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeStore as LegacyRuntimeStore } from 'legacy-trellis-runtime'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applicationDirectory } from '../../src/main/application-data'
import { saveExport } from '../../src/main/export-save'
import { RuntimeStore } from '../../src/runtime/store'
import { digest } from '../../src/runtime/resources'
import type { Bundle } from '../../src/shared/contracts.generated'

type Row = Record<string, any>
const homes: string[] = []
let current: RuntimeStore | undefined
afterEach(() => {
  vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs()
  try { current?.close() } finally { current = undefined; for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }) }
})
function call(store: RuntimeStore, type: string, fields: Row = {}): any { return store.handle({ type, ...fields } as any) }
const state = (store: RuntimeStore): Row => call(store, 'maintenance.status')
const begin = (store: RuntimeStore): string => call(store, 'maintenance.begin').reservation.token
function database<T>(root: string, file: string, read: (db: Database.Database) => T): T {
  const db = new Database(join(root, file), { readonly: true, fileMustExist: true })
  try { return read(db) } finally { db.close() }
}
const control = (root: string): Row => database(root, 'restore-control.sqlite', db => JSON.parse((db.prepare('SELECT manifest FROM restore_control WHERE id=1').get() as Row).manifest))
const point = async (store: RuntimeStore): Promise<Row> => call(store, 'maintenance.create', { token: begin(store), inputs_saved: true, replace_id: state(store).active?.id ?? null })
const restore = async (store: RuntimeStore): Promise<Row> => {
  const active = state(store).active
  return call(store, 'maintenance.restore', { token: begin(store), point_id: active.id, database_sha256: active.database_sha256, inputs_saved: true, confirm_replace_newer_data: true })
}
function write(store: RuntimeStore, task: string, input: Row): any {
  vi.useFakeTimers()
  const run = store.start(task, 'held fixture', 'fixture', [])
  try { return store.modelTool(task, run, { type: 'write', input }) }
  finally { call(store, 'run.cancel', { task_id: task, run_id: run }); vi.useRealTimers() }
}
function resource(store: RuntimeStore, task: string, text: string): string {
  return write(store, task, { type: 'resource.create', display_name: '旧版资料', content: { type: 'text', text } }).data.id
}
function retire(store: RuntimeStore, file: string, interrupt = false): Row {
  const token = begin(store), preview = call(store, 'maintenance.replica.preview', { token, replica_id: digest(Buffer.from(file)), inputs_saved: true })
  const fault = interrupt ? vi.spyOn(fs, 'unlinkSync').mockImplementation(() => { throw Object.assign(Error('fixture busy'), { code: 'EBUSY' }) }) : undefined
  try { return call(store, 'maintenance.replica.execute', { token, operation_id: preview.id, inputs_saved: true, confirm_retire_replica: true }) }
  finally { fault?.mockRestore() }
}

// Every persisted recovery, retirement and export record below is written by
// the frozen pre-rename RuntimeStore. No current database is renamed or edited.
async function legacyProfile(outcome: 'completed' | 'rolled_back' = 'completed') {
  if (process.platform === 'win32') vi.stubEnv('TRELLIS_TEST_FILE_IDENTITIES', 'decimal-v2')
  const home = fs.mkdtempSync(join(tmpdir(), 'pliuna-legacy-upgrade-')); homes.push(home)
  const root = join(home, '.trellis')
  let previous = new LegacyRuntimeStore(root)
  try {
    const task = previous.create('更名前的任务').task.id
    const originalResource = resource(previous, task, 'LEGACY_ORIGINAL_RESOURCE')
    const bundle: Bundle = { profile: 'managed-v1', html: '<section id="lesson">LEGACY_LESSON</section>', css: '', state: { schema: { type: 'object', additionalProperties: false, properties: {} }, initial: {}, compatibility_version: 'v1' }, forms: [], behaviors: [], references: [], export: [{ id: 'lesson', category: 'learning', source: { type: 'element', element_id: 'lesson' } }] }
    const surface = previous.snapshot(task).surface
    write(previous, task, { type: 'surface.update', surface_id: surface.id, expected_revision: surface.revision, operations: [{ type: 'view.create', client_ref: 'legacy', slot_id: 'main', bundle: { type: 'inline', bundle } }] })
    const first = (await point(previous)).active
    const newerTask = previous.create('旧恢复点之后的任务').task.id
    const newerResource = resource(previous, newerTask, 'LEGACY_ROLLBACK_ONLY_RESOURCE')
    if (outcome === 'completed') await restore(previous)
    else {
      const pragma = Database.prototype.pragma
      const fault = vi.spyOn(Database.prototype, 'pragma').mockImplementation(function (this: Database.Database, source: string, options?: any) {
        if (this.name.endsWith('-target.sqlite') && source === 'foreign_keys=ON') throw Error('fixture target reopen failure')
        return pragma.call(this, source, options)
      })
      try { await expect(restore(previous)).rejects.toThrow(/failed/) } finally { fault.mockRestore() }
    }
    previous.close(); previous = new LegacyRuntimeStore(root)
    const active = (await point(previous)).active, pointTasks = previous.tasks()
    const released = retire(previous, `recovery/${first.id}.sqlite`)
    expect(released).toMatchObject({ phase: 'released', protection_released: true })
    const pending = retire(previous, 'trellis.sqlite', true)
    expect(pending).toMatchObject({ phase: 'retired', attempt: 1, reason: 'EBUSY', protection_released: false })

    // A genuine failed old publication supplies a registered, reclaimable
    // orphan. The SQL fault changes no saved manifest or staging record itself.
    const prepare = Database.prototype.prepare
    const fault = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql: string) {
      if (sql.startsWith('INSERT INTO resources')) throw Error('fixture resource commit failure')
      return prepare.call(this, sql)
    } as typeof prepare)
    try { expect(() => resource(previous, task, 'LEGACY_RECLAIMABLE_ORPHAN')).toThrow(/publication failed/) }
    finally { fault.mockRestore() }
    const selected = control(root).selected
    const orphan = database(root, selected, db => (db.prepare("SELECT storage_key FROM staging WHERE state='invalid'").get() as Row).storage_key as string)
    const exported = call(previous, 'export.prepare', { task_id: task, answer_ids: [] })
    expect(exported.html).toContain('LEGACY_LESSON')
    const tasks = previous.tasks()
    previous.close()
    const saved = control(root)
    expect(saved).toMatchObject({ selected, operations: [{ previous: 'trellis.sqlite', phase: outcome }], retirements: [{ phase: 'released' }, { file: 'trellis.sqlite', phase: 'retired', attempt: 1 }] })
    expect(saved.retirements[1].members[0].state).toBe('deleting')
    expect(fs.existsSync(join(root, 'pliuna.sqlite'))).toBe(false)
    const files = ['trellis.sqlite', `recovery/${active.id}.sqlite`, ...fs.readdirSync(join(root, 'resources')).filter(file => file !== orphan).map(file => `resources/${file}`)]
    for (const image of [saved.operations[0].target, saved.operations[0].rollback]) if (image.file !== selected) files.push(image.file)
    const protectedBytes = new Map(files.map(file => [file, fs.readFileSync(join(root, file))]))
    return { home, root, task, newerTask, originalResource, newerResource, orphan, active, released, pending, exportId: exported.id, saved, tasks, pointTasks, protectedBytes }
  } finally { previous.close() }
}
type Profile = Awaited<ReturnType<typeof legacyProfile>>
function open(profile: Profile): RuntimeStore {
  expect(applicationDirectory(profile.home)).toBe(profile.root)
  current = new RuntimeStore(profile.root)
  return current
}
function unpin(store: RuntimeStore, profile: Profile): void {
  expect(call(store, 'export.status', { task_id: profile.task, operation_id: profile.exportId })).toMatchObject({ phase: 'interrupted', pinned: true })
  expect(() => begin(store)).toThrow()
  expect(call(store, 'export.cancel', { task_id: profile.task, operation_id: profile.exportId })).toMatchObject({ phase: 'cancelled', pinned: false })
}
function unchanged(profile: Profile, removed: string[] = []): void {
  for (const [file, bytes] of profile.protectedBytes) {
    if (removed.includes(file)) expect(fs.existsSync(join(profile.root, file))).toBe(false)
    else expect(fs.readFileSync(join(profile.root, file)), file).toEqual(bytes)
  }
  expect(fs.existsSync(join(profile.home, '.pliuna'))).toBe(false)
  expect(fs.existsSync(join(profile.root, 'pliuna.sqlite'))).toBe(false)
}

it.each(['completed', 'rolled_back'] as const)('upgrades actual old %s restore history and released/pending replica records without replay', async outcome => {
  const profile = await legacyProfile(outcome), store = open(profile)
  expect(store.tasks()).toEqual(profile.tasks)
  expect(store.snapshot(profile.task).views[0]!.presentation.html).toContain('LEGACY_LESSON')
  expect(control(profile.root).operations).toEqual(profile.saved.operations)
  // Startup reconciles the interrupted unlink without retrying it or renewing
  // its budget. Every original protection fact and file identity stays bound.
  const before = profile.saved.retirements[1]
  expect(control(profile.root).retirements).toEqual([profile.saved.retirements[0], {
    ...before, reason: 'INTERRUPTED_RECONFIRM', members: [{ ...before.members[0], state: 'pending' }, ...before.members.slice(1)]
  }])
  expect(call(store, 'maintenance.replica.status', { operation_id: profile.released.id })).toEqual(profile.released)
  expect(call(store, 'maintenance.replica.status', { operation_id: profile.pending.id })).toEqual({
    ...profile.pending, reason: 'INTERRUPTED_RECONFIRM', files: [{ ...profile.pending.files[0], state: 'pending' }, ...profile.pending.files.slice(1)]
  })
  unpin(store, profile); unchanged(profile)
  store.close(); const restarted = open(profile)
  expect(restarted.tasks()).toEqual(profile.tasks)
  expect(control(profile.root).selected).toBe(profile.saved.selected)
  expect(call(restarted, 'maintenance.replica.status', { operation_id: profile.pending.id })).toMatchObject({ phase: 'retired', attempt: 1, protection_released: false })
  unchanged(profile)
})

it('exports an old restored view to an actual HTML file while preserving legacy resources and protected replicas', async () => {
  const profile = await legacyProfile(), store = open(profile); unpin(store, profile)
  const preview = call(store, 'export.prepare', { task_id: profile.task, answer_ids: [] }), target = join(profile.home, 'legacy-export.html')
  const request = (type: string, fields: Row = {}): any => call(store, type, { task_id: profile.task, operation_id: preview.id, ...fields })
  const result = await saveExport(target, null, {
    begin: async temporary => request('export.internal.begin', { partial: false, target, temporary }),
    created: async identity => request('export.internal.created', { identity }),
    valid: async () => request('export.internal.valid'),
    finish: async (phase, reason) => request('export.internal.finish', { phase, reason })
  })
  expect(result).toMatchObject({ phase: 'saved', pinned: false })
  expect(fs.readFileSync(target, 'utf8')).toBe(preview.html)
  expect(fs.readFileSync(target, 'utf8')).toContain('LEGACY_LESSON')
  unchanged(profile)
  store.close(); const restarted = open(profile)
  expect(call(restarted, 'export.status', { task_id: profile.task, operation_id: preview.id })).toMatchObject({ phase: 'saved', pinned: false })
  expect(control(profile.root).operations).toEqual(profile.saved.operations)
  unchanged(profile)
})

it('restores an old effective point again after upgrade and retains both old and newly rolled-back data', async () => {
  const profile = await legacyProfile(), store = open(profile); unpin(store, profile)
  const newerTask = store.create('升级后新增任务').task.id, newerResource = resource(store, newerTask, 'NEW_ROLLBACK_RESOURCE')
  const result = await restore(store)
  expect(result).toMatchObject({ phase: 'idle', restore: { last: { phase: 'completed' } } })
  expect(store.tasks()).toEqual(profile.pointTasks)
  expect(() => store.snapshot(newerTask)).toThrow(/not found/)
  expect(fs.readFileSync(join(profile.root, 'resources', newerResource), 'utf8')).toBe('NEW_ROLLBACK_RESOURCE')
  const saved = control(profile.root)
  expect(saved.operations).toHaveLength(2)
  expect(saved.operations[0]).toEqual(profile.saved.operations[0])
  expect(saved.operations[1]).toMatchObject({ previous: profile.saved.selected, phase: 'completed', rollback: { resources: expect.arrayContaining([expect.objectContaining({ id: newerResource })]) } })
  unchanged(profile)
  store.close(); const restarted = open(profile)
  expect(restarted.snapshot(profile.task).views[0]!.presentation.html).toContain('LEGACY_LESSON')
  const token = begin(restarted), preview = call(restarted, 'maintenance.gc.preview', { token, inputs_saved: true })
  expect(preview.items).toEqual([])
  expect(call(restarted, 'maintenance.gc.execute', { token, operation_id: preview.id, inputs_saved: true, confirm_delete_orphans: true })).toMatchObject({ files_deleted: 0, database_files_deleted: 0 })
  expect(fs.readFileSync(join(profile.root, 'resources', newerResource), 'utf8')).toBe('NEW_ROLLBACK_RESOURCE')
  unchanged(profile)
})

it('reclaims only an actual old failed publication and resumes the original old replica retirement after explicit confirmation', async () => {
  const profile = await legacyProfile(), store = open(profile); unpin(store, profile)
  const token = begin(store), preview = call(store, 'maintenance.gc.preview', { token, inputs_saved: true })
  expect(preview.items).toHaveLength(1)
  expect(call(store, 'maintenance.gc.execute', { token, operation_id: preview.id, inputs_saved: true, confirm_delete_orphans: true })).toMatchObject({ phase: 'settled', files_deleted: 1, database_files_deleted: 0, business_replayed: false })
  expect(fs.existsSync(join(profile.root, 'resources', profile.orphan))).toBe(false)
  expect(fs.readFileSync(join(profile.root, 'resources', profile.newerResource), 'utf8')).toBe('LEGACY_ROLLBACK_ONLY_RESOURCE')
  unchanged(profile)
  const record = control(profile.root).retirements.find((row: Row) => row.id === profile.pending.id)
  vi.useFakeTimers(); vi.setSystemTime(Math.max(Date.now(), Date.parse(record.next_retry_at) + 1))
  const result = call(store, 'maintenance.replica.retry', { token: begin(store), operation_id: profile.pending.id, inputs_saved: true, confirm_retire_replica: true })
  expect(result).toMatchObject({ phase: 'released', attempt: 2, protection_released: true, formal_resources_deleted: 0, business_replayed: false })
  vi.useRealTimers(); unchanged(profile, ['trellis.sqlite'])
  store.close(); const restarted = open(profile)
  expect(restarted.tasks()).toEqual(profile.tasks)
  expect(control(profile.root).selected).toBe(profile.saved.selected)
  expect(call(restarted, 'maintenance.replica.status', { operation_id: profile.pending.id })).toEqual(result)
  expect(fs.readFileSync(join(profile.root, 'resources', profile.newerResource), 'utf8')).toBe('LEGACY_ROLLBACK_ONLY_RESOURCE')
  unchanged(profile, ['trellis.sqlite'])
})

it('fails closed when a real old profile also contains the new base name, without rewriting either base file', async () => {
  const profile = await legacyProfile(), bytes = fs.readFileSync(join(profile.root, 'trellis.sqlite'))
  fs.copyFileSync(join(profile.root, 'trellis.sqlite'), join(profile.root, 'pliuna.sqlite'))
  expect(() => new RuntimeStore(profile.root)).toThrow(expect.objectContaining({ code: 'RESTORE_JOURNAL_INVALID' }))
  expect(fs.readFileSync(join(profile.root, 'trellis.sqlite'))).toEqual(bytes)
  expect(fs.readFileSync(join(profile.root, 'pliuna.sqlite'))).toEqual(bytes)
})
