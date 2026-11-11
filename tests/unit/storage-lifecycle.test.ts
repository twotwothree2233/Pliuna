import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { RuntimeStore } from '../../src/runtime/store'
import { StorageLifecycle } from '../../src/runtime/storage-lifecycle'
import * as resources from '../../src/runtime/resources'
import type { Snapshot } from '../../src/shared/types'

let root: string, store: RuntimeStore, db: Database.Database, task: Snapshot, run: string, life: StorageLifecycle
beforeEach(() => {
  vi.useFakeTimers(); root = mkdtempSync(join(tmpdir(), 'pliuna-storage-'))
  store = new RuntimeStore(root); task = store.create('存储核对'); run = store.start(task.task.id, 'held fixture', 'fixture', [])
  db = new Database(join(root, 'pliuna.sqlite')); life = new StorageLifecycle(db, root, store.epoch)
})
afterEach(() => { life.close(); db.close(); store.close(); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); vi.useRealTimers() })
const create = (): any => store.modelTool(task.task.id, run, { type: 'write', input: { type: 'resource.create', display_name: '材料', content: { type: 'text', text: 'original' } } })
const status = (): any => store.handle({ type: 'storage.status' })
function restart() { life.close(); store.close(); store = new RuntimeStore(root); life = new StorageLifecycle(db, root, store.epoch) }
function seed(state = 'publishing', owner = 'ended', result: string | null = 'not_executed', epoch = 'old') {
  db.prepare("INSERT INTO actions (id,task_id,run_id,kind,state,result,source_json,request_json,commit_valid,created_at) VALUES ('owner',?,?,'mutation',?,?, '{}','{}',?,?)").run(task.task.id, run, owner, result, owner === 'ended' ? 0 : 1, new Date().toISOString())
  db.prepare("INSERT INTO staging (id,task_id,owner_kind,owner_id,runtime_epoch,state,storage_key,expected_bytes,sha256,created_at) VALUES ('stage',?,'action','owner',?,?,'orphan',8,?,?)").run(task.task.id, epoch, state, resources.digest(Buffer.from('original')), new Date().toISOString())
}

it('pins before writing and atomically hands off to a formal immutable resource', () => {
  const publish = resources.publishResourceFile
  vi.spyOn(resources, 'publishResourceFile').mockImplementation((...args) => {
    expect(db.prepare('SELECT state,runtime_epoch,owner_kind FROM staging').get()).toEqual({ state: 'publishing', runtime_epoch: store.epoch, owner_kind: 'action' })
    expect(db.prepare('SELECT * FROM resources').all()).toEqual([]); publish(...args)
  })
  const result = create(); expect(result.execution).toBe('success')
  expect(db.prepare('SELECT state,resource_id,received_bytes FROM staging').get()).toEqual({ state: 'committed', resource_id: result.data.id, received_bytes: 8 })
  expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 1 })
})
it('rejects pin handoff outside the business transaction', () => { expect(() => life.commit('missing', 'missing')).toThrow('transaction') })
it('rolls back the complete resource publication if pin handoff fails', () => {
  db.exec("CREATE TRIGGER fail_pin BEFORE UPDATE OF state ON staging WHEN NEW.state='committed' BEGIN SELECT RAISE(ABORT,'pin fault'); END")
  expect(create).toThrow('publication failed')
  expect(db.prepare('SELECT * FROM resources').all()).toEqual([])
  expect(db.prepare('SELECT * FROM task_resources').all()).toEqual([])
  expect(db.prepare("SELECT * FROM records WHERE kind='resource.created'").all()).toEqual([])
  expect(db.prepare('SELECT result FROM actions').get()).toEqual({ result: 'not_executed' })
  expect(status().items[0]).toMatchObject({ assessment: 'candidate', reason: 'GC_DISABLED', retained_bytes: 8 })
  expect(readdirSync(join(root, 'resources'))).toHaveLength(1)
})
it.each(['ENOSPC', 'EIO'])('registers write failure %s without a valid resource and never retries business', code => {
  vi.spyOn(resources, 'publishResourceFile').mockImplementation(() => { throw Object.assign(new Error('private path not to leak'), { code }) })
  expect(create).toThrow('publication failed'); expect(status().items[0]).toMatchObject({ assessment: 'absent' })
  const before = db.prepare('SELECT count(*) n FROM actions').get(), item = status().items[0]
  expect(store.handle({ type: 'storage.retry', job_id: item.id })).toEqual({ inspected: true, files_deleted: 0, business_replayed: false })
  expect(db.prepare('SELECT count(*) n FROM actions').get()).toEqual(before)
})
it('preserves committed resources and repairs legacy noncommitted staging from formal facts', () => {
  const result = create(); db.prepare("UPDATE staging SET state='publishing',resource_id=NULL,received_bytes=0").run()
  restart(); expect(db.prepare('SELECT state,resource_id FROM staging').get()).toEqual({ state: 'committed', resource_id: result.data.id })
  expect(status().items[0]).toMatchObject({ assessment: 'committed', reason: 'FORMAL_COMMIT_VERIFIED' })
  expect(readFileSync(join(root, 'resources', result.data.id), 'utf8')).toBe('original')
  expect(db.prepare('SELECT result FROM actions').get()).toEqual({ result: 'success' })
})
it.each(['publishing', 'prepared', 'invalid'])('retains failed %s files across restart and registers one candidate only', state => {
  seed(state); writeFileSync(join(root, 'resources', 'orphan'), 'original'); writeFileSync(join(root, 'resources', 'orphan.tmp'), 'partial')
  restart(); expect(status().items[0]).toMatchObject({ assessment: 'candidate', retained_bytes: 15 })
  const id = status().items[0].id; restart(); expect(status().items).toHaveLength(1); expect(status().items[0].id).toBe(id)
  expect(readdirSync(join(root, 'resources'))).toEqual(['orphan', 'orphan.tmp'])
})
it('keeps a current live owner pinned regardless of age', () => {
  seed('prepared', 'registered', null, store.epoch); db.prepare("UPDATE staging SET created_at='1970-01-01'").run()
  writeFileSync(join(root, 'resources', 'orphan'), 'original'); life.recover()
  expect(status().items[0]).toMatchObject({ assessment: 'pinned', reason: 'LIVE_OWNER' })
  expect(db.prepare('SELECT state FROM staging').get()).toEqual({ state: 'prepared' })
})
it.each(['missing_owner', 'unknown_effect', 'committed_without_resource', 'success_without_resource'])('retains uncertain facts: %s', mode => {
  seed(mode === 'committed_without_resource' ? 'committed' : 'publishing', 'ended', mode === 'success_without_resource' ? 'success' : mode === 'unknown_effect' ? 'unknown' : 'not_executed')
  if (mode === 'missing_owner') db.prepare("UPDATE staging SET owner_id='unavailable'").run()
  writeFileSync(join(root, 'resources', 'orphan'), 'original'); life.recover()
  expect(status().items[0]).toMatchObject({ assessment: 'review', state: 'failed', next_attempt_at: null })
  expect(readFileSync(join(root, 'resources', 'orphan'), 'utf8')).toBe('original')
})
it('does not classify an unassociated formal resource as garbage', () => {
  seed(); writeFileSync(join(root, 'resources', 'orphan'), 'original')
  db.prepare('INSERT INTO resources VALUES (?,?,?,?,?,?,?)').run('orphan', 'orphan', resources.digest(Buffer.from('original')), 8, 'text/plain; charset=utf-8', '材料', new Date().toISOString())
  life.recover(); expect(status().items[0]).toMatchObject({ assessment: 'review', reason: 'FORMAL_FACTS_REQUIRE_REVIEW' })
})
it('preserves legacy direct View/history resource references even without registry entries', () => {
  const r = create(); db.prepare("UPDATE actions SET result='unknown'").run(); db.prepare('DELETE FROM task_resources').run()
  db.prepare('INSERT INTO view_history VALUES (?,?,?,?,?,?)').run('history', task.task.id, 'view', 1, r.data.id, '{}')
  life.recover(); expect(status().items[0].assessment).toBe('review'); expect(readdirSync(join(root, 'resources'))).toContain(r.data.id)
})
it('never follows unsafe storage keys or symlinks during reconciliation', () => {
  seed(); const outside = join(root, 'outside'); writeFileSync(outside, 'secret'); symlinkSync(outside, join(root, 'resources', 'orphan'))
  life.recover(); expect(status().items[0]).toMatchObject({ assessment: 'review', reason: 'UNSAFE_FILE_TYPE', retained_bytes: null })
  db.prepare("UPDATE staging SET storage_key='../outside'").run(); life.recover()
  expect(status().items[0].reason).toBe('INVALID_STORAGE_KEY'); expect(readFileSync(outside, 'utf8')).toBe('secret')
})
it('bounds automatic rechecks at 1/5/15 seconds, persists exhaustion and allows explicit recheck', async () => {
  const r = create(); writeFileSync(join(root, 'resources', r.data.id), 'damaged')
  life.recover(); expect(status().items[0]).toMatchObject({ assessment: 'review', reason: 'RESOURCE_CORRUPT', attempt: 0 })
  const id = status().items[0].id
  for (const [index, delay] of [1000, 5000, 15000].entries()) {
    await vi.advanceTimersByTimeAsync(delay); expect(status().items[0].attempt).toBe(index + 1)
  }
  expect(status().items[0].next_attempt_at).toBeNull(); await vi.advanceTimersByTimeAsync(100000)
  expect(status().items[0].attempt).toBe(3); restart(); expect(status().items[0].attempt).toBe(3)
  writeFileSync(join(root, 'resources', r.data.id), 'original')
  store.handle({ type: 'storage.retry', job_id: id }); expect(status().items[0]).toMatchObject({ assessment: 'committed', attempt: 0 })
})
it('reports missing formal files without recreating them or changing Action success', () => {
  const r = create(); unlinkSync(join(root, 'resources', r.data.id)); restart()
  expect(status().items[0]).toMatchObject({ assessment: 'review', reason: 'RESOURCE_MISSING', retained_bytes: null })
  expect(db.prepare('SELECT result FROM actions').get()).toEqual({ result: 'success' }); expect(readdirSync(join(root, 'resources'))).toEqual([])
})
it('bounds status pages and does not expose owner, storage paths or saved error messages', () => {
  seed(); for (let i = 0; i < 101; i++) db.prepare("INSERT INTO cleanup_jobs VALUES (?,?,'staging',?,0,'failed',0,NULL,?)").run('job' + i, task.task.id, 'stage' + i, '{"assessment":"review","reason":"OWNER_UNCERTAIN","retained_bytes":null}')
  let after: number | undefined, count = 0
  do {
    const page: any = store.handle({ type: 'storage.status', ...(after ? { after } : {}) }); count += page.items.length
    expect(page.items.length).toBeLessThanOrEqual(50); expect(JSON.stringify(page)).not.toContain(root); after = page.next_after
  } while (after)
  expect(count).toBe(101); expect(() => store.handle({ type: 'storage.retry', job_id: 'missing' })).toThrow('unavailable')
  expect(() => store.handle({ type: 'storage.status', delete_files: true })).toThrow()
})
it('does not scan or delete unregistered files, or offer storage operations to a model', () => {
  writeFileSync(join(root, 'resources', 'unknown.tmp'), 'keep'); life.recover()
  expect(status().summary.total).toBe(0); expect(readdirSync(join(root, 'resources'))).toEqual(['unknown.tmp'])
  expect(() => store.modelTool(task.task.id, run, { type: 'storage.retry', job_id: 'x' })).toThrow()
})
it('does not postpone the persisted retry deadline on restart', () => {
  const r = create(); writeFileSync(join(root, 'resources', r.data.id), 'broken'); life.recover()
  const deadline = status().items[0].next_attempt_at
  vi.setSystemTime(Date.now() + 500); restart()
  expect(status().items[0].next_attempt_at).toBe(deadline)
})
it('rechecks newly attached historical protection instead of treating an old candidate as garbage', () => {
  seed(); writeFileSync(join(root, 'resources', 'orphan'), 'original'); life.recover()
  expect(status().items[0].assessment).toBe('candidate')
  db.prepare("INSERT INTO object_references VALUES (?,'view_history','legacy','basis','resource','orphan',NULL,1,0)").run(task.task.id)
  store.handle({ type: 'storage.retry', job_id: status().items[0].id })
  expect(status().items[0]).toMatchObject({ assessment: 'review', reason: 'FORMAL_FACTS_REQUIRE_REVIEW' })
  expect(readFileSync(join(root, 'resources', 'orphan'), 'utf8')).toBe('original')
})
it('stops background checking on registration failure and reports it without throwing a timer error', async () => {
  const r = create(); writeFileSync(join(root, 'resources', r.data.id), 'broken'); life.recover()
  db.exec("CREATE TRIGGER fail_maintenance BEFORE UPDATE ON cleanup_jobs BEGIN SELECT RAISE(ABORT,'injected registration failure'); END")
  await vi.advanceTimersByTimeAsync(1000)
  expect((life.status() as any).maintenance_error).toBe('STORAGE_REGISTRATION_FAILED')
  expect(status().items[0].attempt).toBe(0)
  db.exec('DROP TRIGGER fail_maintenance'); writeFileSync(join(root, 'resources', r.data.id), 'original')
  life.retry(status().items[0].id)
  expect((life.status() as any).maintenance_error).toBeNull()
  expect(status().items[0].assessment).toBe('committed')
})
it.each(['cancel', 'stage_tamper'])('does not publish after file preparation when %s invalidates the pin', mode => {
  const publish = resources.publishResourceFile
  vi.spyOn(resources, 'publishResourceFile').mockImplementation((...args) => {
    publish(...args)
    if (mode === 'cancel') store.handle({ type: 'run.cancel', task_id: task.task.id, run_id: run })
    else db.prepare("UPDATE staging SET runtime_epoch='obsolete'").run()
  })
  expect(create).toThrow()
  expect(db.prepare('SELECT * FROM resources').all()).toEqual([])
  expect(db.prepare('SELECT * FROM task_resources').all()).toEqual([])
  expect(status().items[0].assessment).toBe('candidate')
  expect(readdirSync(join(root, 'resources'))).toHaveLength(1)
})
it('holds a missing-owner pin for review rather than treating it as a clean orphan', () => {
  seed(); db.prepare("UPDATE staging SET owner_kind='unsupported'").run(); life.recover()
  expect(status().items[0]).toMatchObject({ assessment: 'review', reason: 'OWNER_UNCERTAIN' })
})
it('uses the same integrity gate for View publication and preserves the old Surface on damage', async () => {
  store.handle({ type: 'run.cancel', task_id: task.task.id, run_id: run })
  const publish = resources.publishResourceFile
  vi.spyOn(resources, 'publishResourceFile').mockImplementation((...args) => { publish(...args); writeFileSync(join(root, 'resources', args[1]), 'broken') })
  store.start(task.task.id, 'publish fixture', 'fixture', []); await vi.advanceTimersByTimeAsync(160)
  const snapshot = store.snapshot(task.task.id)
  expect(snapshot.views).toEqual([]); expect(snapshot.surface.revision).toBe(1)
  expect(status().items[0].assessment).toBe('candidate')
  expect(snapshot.runs[0]!.state).toBe('failed')
})
