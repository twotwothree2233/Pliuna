import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginControl } from '../../src/runtime/plugins/control'
import { RuntimeStore } from '../../src/runtime/store'
import { RestoreJournal } from '../../src/runtime/restore-journal'
import { RecoveryManager } from '../../src/runtime/recovery'
let root: string, store: RuntimeStore | undefined, plugins: PluginControl | undefined
const read = (name: string, table: string): any => { const db = new Database(join(root, name)); try { return JSON.parse((db.prepare(`SELECT manifest FROM ${table}`).get() as any).manifest) } finally { db.close() } }
const recovery = () => read('recovery-control.sqlite', 'control')
const journal = () => read('restore-control.sqlite', 'restore_control')
const status = (): any => store!.handle({ type: 'maintenance.status' })
const begin = (): string => (store!.handle({ type: 'maintenance.begin' }) as any).reservation.token
const point = async (): Promise<any> => store!.handle({ type: 'maintenance.create', token: begin(), inputs_saved: true, replace_id: status().active?.id ?? null })
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pliuna-plugin-protection-')) })
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); store?.close(); store = undefined; plugins?.close(); plugins = undefined; rmSync(root, { recursive: true, force: true }) })
async function setup(): Promise<string> {
  const source = join(root, 'fixture'); mkdirSync(source)
  writeFileSync(join(source, 'backend.cjs'), 'throw Error("not executed")')
  writeFileSync(join(source, 'manifest.json'), JSON.stringify({ manifest_version: '0.1', protocol_version: '0.1', id: 'fixture', version: '1.0.0', access_level: 'task', contributes: [{ id: 'fixture', kind: 'skill', entry: 'backend.cjs', description: 'fixture' }], backend: { command: 'node', args: ['backend.cjs'], entry: 'backend.cjs' } }))
  plugins = new PluginControl(root); const copy = await plugins.install(source); await plugins.grant(copy.digest, { local_code: true, cross_task: false }); plugins.close(); plugins = undefined
  store = new RuntimeStore(root); store.create('fixture task'); return copy.digest
}
it('records exact candidate protection before backup and retains old point until publication', async () => {
  const digest = await setup(); const old = (await point()).active
  const backup = Database.prototype.backup
  vi.spyOn(Database.prototype, 'backup').mockImplementation(function (this: Database.Database, ...args: Parameters<typeof backup>) {
    expect(recovery()).toMatchObject({ version: 2, active: { id: old.id, plugins: [{ digest }] }, candidates: [{ plugins: [{ digest }] }] })
    return backup.apply(this, args)
  })
  await point(); expect(recovery().active.plugins[0].files).toHaveLength(2)
})
it('restores business data without resurrecting revoked code trust; pins both database images', async () => {
  const digest = await setup(), active = (await point()).active
  store!.close(); store = undefined; plugins = new PluginControl(root); plugins.revoke(digest); plugins.close(); plugins = undefined
  store = new RuntimeStore(root)
  await store.handle({ type: 'maintenance.restore', token: begin(), point_id: active.id, database_sha256: active.database_sha256, inputs_saved: true, confirm_replace_newer_data: true })
  expect(journal()).toMatchObject({ version: 5, operations: [{ phase: 'completed', target: { plugins: [{ digest }] }, rollback: { plugins: [{ digest }] } }] })
  store.close(); store = undefined; plugins = new PluginControl(root)
  expect(plugins.trusted(digest)).toBe(false); await expect(plugins.executable(digest)).rejects.toMatchObject({ code: 'PLUGIN_TRUST_REQUIRED' })
})
it('failed backup retains candidate and old exact package protection', async () => {
  const digest = await setup(), old = (await point()).active
  vi.spyOn(Database.prototype, 'backup').mockRejectedValue(new Error('injected'))
  await expect(point()).rejects.toThrow()
  expect(recovery()).toMatchObject({ active: { id: old.id, plugins: [{ digest }] }, candidates: [{ plugins: [{ digest }] }] })
  expect(readFileSync(join(root, 'plugins', digest, 'backend.cjs'), 'utf8')).toContain('not executed')
})
it('managed copy corruption blocks startup recovery use without modifying bytes', async () => {
  const digest = await setup(); await point(); store!.close(); store = undefined
  const file = join(root, 'plugins', digest, 'backend.cjs'); writeFileSync(file, 'damaged')
  store = new RuntimeStore(root); expect(status().phase).toBe('blocked'); expect(readFileSync(file, 'utf8')).toBe('damaged')
})
it('upgrades validated legacy empty controls without fabricating plugin history', () => {
  vi.stubEnv('PLIUNA_TEST_FILE_IDENTITIES', '')
  store = new RuntimeStore(root); store.close(); store = undefined
  const db = new Database(join(root, 'recovery-control.sqlite')); db.prepare('UPDATE control SET manifest=?').run(JSON.stringify({ version: 1, active: null, candidates: [], retired: [], invalidated: [] })); db.close()
  const restore = new Database(join(root, 'restore-control.sqlite')); restore.prepare('UPDATE restore_control SET manifest=?').run(JSON.stringify({ version: 3, selected: 'pliuna.sqlite', deleted_tasks: [], operations: [], verified_head: null, retirements: [], task_deletions: [], resource_cleanups: [] })); restore.close(); writeFileSync(join(root, 'restore-established'), 'restore-v3\n')
  store = new RuntimeStore(root); expect(recovery().version).toBe(2); expect(journal().version).toBe(5)
  expect(recovery().active).toBeNull(); expect(journal().operations).toEqual([])
})
it('rejects downgraded or unknown plugin-bearing controls rather than emptying protections', () => {
  expect(() => RecoveryManager.validateControl({ version: 1, active: { plugins: [] }, candidates: [], retired: [], invalidated: [] })).toThrow()
  expect(() => RestoreJournal.normalizeControl({ version: 3, selected: 'pliuna.sqlite', deleted_tasks: [], operations: [{ target: { plugins: [] }, rollback: {} }], verified_head: null, retirements: [], task_deletions: [], resource_cleanups: [] })).toThrow()
})
