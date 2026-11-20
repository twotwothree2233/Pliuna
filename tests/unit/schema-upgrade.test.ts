import { afterEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import coreSql from '../../src/shared/contracts/001-core.sql?raw'
import runnerSql from '../../src/shared/contracts/002-runner.sql?raw'
import { ownDirectory, RecoveryManager } from '../../src/runtime/recovery'
import { RestoreJournal } from '../../src/runtime/restore-journal'
import { hasV2Writes, openBusinessDatabase, prepareBusinessDatabase, purgeRunnerTask, readBusinessSchema, upgradeCandidate } from '../../src/runtime/schema-upgrade'
import { RuntimeStore } from '../../src/runtime/store'
import { validateRunnerContract } from '../../src/shared/runner-validation'
import { chapterManifest, chapterUpdate as makeChapterUpdate } from '../helpers/chapters'
import { contentTree } from '../helpers/content-tree'

const roots: string[] = [], connections: Database.Database[] = [], journals: RestoreJournal[] = [], managers: RecoveryManager[] = []
const runtimes: RuntimeStore[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const runtime of runtimes.splice(0)) runtime.close()
  for (const manager of managers.splice(0)) manager.close()
  for (const db of connections.splice(0).reverse()) if (db.open) db.close()
  for (const journal of journals.splice(0)) journal.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function profile() {
  const root = mkdtempSync(join(tmpdir(), 'pliuna-schema-upgrade-')); roots.push(root)
  mkdirSync(join(root, 'resources'), { mode: 0o700 })
  const owner = ownDirectory(root); connections.push(owner)
  const journal = new RestoreJournal(root); journals.push(journal)
  return { root, journal }
}
function legacy(root: string, file: string) {
  const db = new Database(join(root, file)); connections.push(db)
  db.exec(coreSql)
  const task = randomUUID(), request = randomUUID(), run = randomUUID()
  db.prepare("INSERT INTO tasks(id,title,state,revision,next_sequence) VALUES (?,?,'active',1,2)").run(task, 'Legacy task')
  db.prepare("INSERT INTO requests VALUES (?,?,'started','{}','{}',?)").run(request, task, new Date().toISOString())
  db.prepare("INSERT INTO runs(id,task_id,request_id,state,commit_valid,runtime_epoch,limits_json,budget_json,created_at,ended_at) VALUES (?,?,?,'completed',0,'legacy','{}','{}',?,?)").run(run, task, request, new Date().toISOString(), new Date().toISOString())
  const record = { id: randomUUID(), task_id: task, sequence: 1, kind: 'request.created', payload_json: JSON.stringify({ request_id: request, content: 'Original goal' }), created_at: new Date().toISOString() }
  db.prepare('INSERT INTO records VALUES (?,?,?,?,?,?)').run(record.id, record.task_id, record.sequence, record.kind, record.payload_json, record.created_at)
  return { db, task, request, run, record }
}
function control(root: string): any {
  const db = new Database(join(root, 'restore-control.sqlite'), { readonly: true })
  try { return JSON.parse((db.prepare('SELECT manifest FROM restore_control WHERE id=1').get() as { manifest: string }).manifest) }
  finally { db.close() }
}
function runtimeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'pliuna-runtime-schema-')); roots.push(root)
  return root
}
function runtime(root: string): RuntimeStore {
  const store = new RuntimeStore(root); runtimes.push(store)
  return store
}
function currentDatabase(root: string): Database.Database {
  const db = new Database(join(root, control(root).selected), { fileMustExist: true }); connections.push(db)
  db.pragma('foreign_keys=ON')
  return db
}
function runnerHistory(db: Database.Database, task: string): { read: string } {
  const request = randomUUID(), run = randomUUID(), record = randomUUID(), input = randomUUID()
  const budget = randomUUID(), reservation = randomUUID(), work = randomUUID(), attempt = randomUUID()
  const artifact = randomUUID(), candidate = randomUUID(), resource = randomUUID(), read = randomUUID()
  const batch = randomUUID(), operation = randomUUID(), action = randomUUID(), now = new Date().toISOString()
  const chapterUpdate = randomUUID(), chapterProposal = randomUUID(), chapterOperation = randomUUID(), view = randomUUID()
  const insert = (sql: string, ...values: (string | number | null)[]) => db.prepare(sql).run(...values)
  const goal = validateRunnerContract('runner_goal_revision', { task_id: task, request_id: request, intent_revision: 1, input_event_id: input, state: 'active', requirements: [{ requirement_id: 'content', kind: 'artifact', required: true, provenance_required: false }] })
  const runner = validateRunnerContract('runner_run', { task_id: task, request_id: request, intent_revision: 1, run_id: run, runtime_epoch: 'fixture', state: 'completed', commit_valid: false, budget_id: budget, purpose: 'production' })
  const unresolved = [{ task_id: task, request_id: request, intent_revision: 1, requirement_id: 'content' }]
  const inventory = validateRunnerContract('runner_contribution_inventory', { task_id: task, request_id: request, intent_revision: 1, inventory_revision: 1, required_works: [], requirement_ids: [], unresolved, sealed_by: { work_id: work, plan_revision: 1, run_id: run, attempt_id: attempt, role: 'producer' } })
  const scope = validateRunnerContract('runner_composition_scope', { task_id: task, composition_version: 1, state: 'working', targets: [{ request_id: request, intent_revision: 1, required: true, requirement_ids: ['content'] }], unresolved })
  db.transaction(() => {
    insert("INSERT INTO requests VALUES (?,?,'started','{}','{}',?)", request, task, now)
    insert("INSERT INTO runs(id,task_id,request_id,state,commit_valid,runtime_epoch,limits_json,budget_json,created_at,ended_at) VALUES (?,?,?,'completed',0,'fixture','{}','{}',?,?)", run, task, request, now, now)
    insert("INSERT INTO records VALUES (?,?,1,'request.created',?,?)", record, task, JSON.stringify({ request_id: request, content: 'Original goal' }), now)
    insert('UPDATE tasks SET next_sequence=2 WHERE id=?', task)
    insert('INSERT INTO resources VALUES (?,?,?,?,?,?,?)', resource, resource, 'a'.repeat(64), 0, 'application/json', 'Accepted bundle', now)
    insert('INSERT INTO task_resources VALUES (?,?)', task, resource)
    insert("INSERT INTO actions(id,task_id,run_id,kind,state,result,source_json,request_json,commit_valid,created_at) VALUES (?,?,?,'mutation','ended','success','{}','{}',0,?)", action, task, run, now)
    insert("INSERT INTO runner_inputs VALUES (?,?,?,'request.created','{}',?)", input, task, record, now)
    insert("INSERT INTO runner_consumptions VALUES (?,?,'installed','{}',?)", input, task, now)
    insert('INSERT INTO runner_goal_revisions VALUES (?,?,1,?,?)', task, request, input, JSON.stringify(goal))
    insert('INSERT INTO runner_goal_heads VALUES (?,?,1)', task, request)
    insert("INSERT INTO runner_budgets VALUES (?,?,'production',?,'{}',?)", budget, task, request, now)
    insert("INSERT INTO runner_budget_reservations VALUES (?,?,?,?,?,'settled','{}','{}',?,?,?)", reservation, task, budget, attempt, operation, now, now, now)
    insert("INSERT INTO runner_runs VALUES (?,?,'production',?,1,NULL,NULL,?,?)", run, task, request, budget, JSON.stringify(runner))
    insert("INSERT INTO runner_work VALUES (?,?,?,1,'completed','{}')", work, task, run)
    insert("INSERT INTO runner_attempts VALUES (?,?,?,?,1,'success','{}')", attempt, task, work, run)
    insert("INSERT INTO runner_outlines VALUES (?,1,'{}')", task)
    insert('INSERT INTO runner_artifact_owners VALUES (?,?,?,1,?,1)', artifact, task, work, randomUUID())
    insert("INSERT INTO runner_candidates VALUES (?,?,?,'{}','{}')", candidate, task, artifact)
    insert("INSERT INTO runner_artifacts VALUES (?,?,1,?,?,'{}')", task, artifact, candidate, resource)
    insert('INSERT INTO runner_inventory_sources VALUES (?,?,1,?,1)', task, request, work)
    insert("INSERT INTO runner_work_outputs VALUES (?,?,1,?,1,1,'{}')", task, request, work)
    insert('INSERT INTO runner_contribution_inventories VALUES (?,?,1,1,?)', task, request, JSON.stringify(inventory))
    insert('INSERT INTO runner_scopes VALUES (?,1,?)', task, JSON.stringify(scope))
    insert('INSERT INTO runner_index_reads VALUES (?,?,?)', read, task, randomUUID())
    insert('INSERT INTO runner_index_read_items VALUES (?,0,?,1)', read, artifact)
    insert('INSERT INTO runner_index_cursors VALUES (?,?,?,?,1)', randomUUID(), task, randomUUID(), read)
    insert("INSERT INTO runner_batches VALUES (?,?,1,'{}')", batch, task)
    insert("INSERT INTO runner_publications VALUES (?,?,?,NULL,'registered','{}',NULL)", operation, task, batch)
    insert("INSERT INTO runner_surface_history VALUES (?,?,?,1,?,'{}')", randomUUID(), task, randomUUID(), action)
    insert("INSERT INTO runner_manifests VALUES (?,?,1,?,'{}')", randomUUID(), task, operation)
    const entry = { task_id: task, request_id: request, intent_revision: 1, artifact_id: artifact, artifact_revision: 1, section_id: 'section', source_bundle_resource_id: resource, published_bundle_resource_id: resource, view_id: view, view_revision: 1, state_revision: 1, surface_history_id: 'history' }
    insert('INSERT INTO runner_view_mappings VALUES (?,?,1,?,?,1,?,?,?)', task, artifact, batch, view, resource, resource, JSON.stringify({ ...entry, batch_id: batch }))
    insert("INSERT INTO runner_deliveries VALUES (?,?,?,'final_answer',?,'{}')", randomUUID(), task, request, record)
    const manifest = { ...chapterManifest(), task_id: task, request_id: request, view_id: view, bundle_resource_id: resource }
    const update = { ...makeChapterUpdate(chapterUpdate, ['a'], manifest), task_id: task, input_event_id: randomUUID(), record_id: record, request_id: request, view_id: view, dependencies: [], state: 'succeeded' as const }
    insert("INSERT INTO runner_chapter_manifests VALUES (?,?,1,1,?,?,?)", task, view, resource, JSON.stringify(manifest), now)
    insert('INSERT INTO runner_chapter_heads VALUES (?,?,1)', task, view)
    insert("INSERT INTO runner_chapter_updates VALUES (?,?,?,?,1,?,'succeeded',?,?,?)", task, chapterUpdate, update.input_event_id, request, view, JSON.stringify(update), JSON.stringify(update), now)
    insert("INSERT INTO runner_chapter_intents VALUES (?,?,'chapter',1,?)", task, view, chapterUpdate)
    insert("INSERT INTO runner_chapter_proposals VALUES (?,?,?,?,'{}')", task, chapterProposal, chapterUpdate, resource)
    insert("INSERT INTO runner_chapter_inheritance VALUES (?,?,'chapter','{}')", task, chapterUpdate)
    insert("INSERT INTO runner_chapter_publications VALUES (?,?,?,NULL,'published','{}','{}')", task, chapterOperation, chapterUpdate)
    insert("INSERT INTO runner_chapter_resources VALUES (?,'manifest',?,?)", task, view, resource)
    insert("INSERT INTO runner_chapter_publication_evidence VALUES (?,?,1,'published','{}',?)", task, chapterOperation, now)
    insert('INSERT INTO runner_chapter_assemblies VALUES (?,?,1,?,?,?)', task, artifact, chapterUpdate, chapterOperation, JSON.stringify({ entry: { ...entry, chapter_update_id: chapterUpdate, chapter_operation_id: chapterOperation } }))
    const content = { task_id: task, view_id: view, view_revision: 1, state_revision: 1, bundle_resource_id: resource, tree: contentTree() }
    insert('INSERT INTO runner_content_trees VALUES (?,?,1,1,1,?,?,?)', task, view, resource, JSON.stringify(content), now)
    insert('INSERT INTO runner_content_tree_heads VALUES (?,?,1)', task, view)
    insert('INSERT INTO runner_content_tree_cursors VALUES (?,?,?,1,?)', randomUUID(), task, view, JSON.stringify({ source: 'tree', offset: 1 }))
    insert('INSERT INTO runner_content_intent_relations VALUES (?,?,?,?)', task, chapterUpdate, randomUUID(), JSON.stringify({ source_record_id: record, retained_node_ids: [], superseded_node_ids: [] }))
  })()
  return { read }
}
it('creates complete v2 databases atomically and reopens without changing identity or history', () => {
  const { root, journal } = profile(), db = prepareBusinessDatabase(root, journal); connections.push(db)
  expect(readBusinessSchema(db)).toBe(2)
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name='one_active_request_run'").get()).toBeTruthy()
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name='one_unfinished_run'").get()).toBeUndefined()
  expect(db.prepare('SELECT * FROM runner_goal_heads').all()).toEqual([])
  expect(db.prepare('SELECT * FROM runner_artifacts').all()).toEqual([])
  expect(db.prepare('SELECT * FROM runner_chapter_assemblies').all()).toEqual([])
  expect(hasV2Writes(db)).toBe(false)
  const file = journal.selected(); db.close()
  const reopened = prepareBusinessDatabase(root, journal); connections.push(reopened)
  expect(readBusinessSchema(reopened)).toBe(2); expect(journal.selected()).toBe(file)
  expect(control(root).operations).toEqual([])
})
it.each(['prepare', 'open', 'candidate'] as const)('installs chapter metadata on an existing v2 database through %s without attributing old runs', path => {
  const { root, journal } = profile(), prior = legacy(root, journal.selected())
  prior.db.exec(runnerSql)
  prior.db.exec('UPDATE schema_version SET version=2; CREATE TABLE business_upgrade_state(id INTEGER PRIMARY KEY,previous_schema INTEGER,v2_writes INTEGER); INSERT INTO business_upgrade_state VALUES (1,1,0)')
  const history = prior.db.prepare('SELECT * FROM records').all(), selected = journal.selected()
  let db = prior.db
  if (path === 'candidate') upgradeCandidate(db)
  else {
    db.close()
    db = path === 'open' ? openBusinessDatabase(root, selected) : prepareBusinessDatabase(root, journal)
    connections.push(db)
  }
  expect(journal.selected()).toBe(selected)
  expect(hasV2Writes(db)).toBe(false)
  expect(db.prepare('SELECT id,chapter_update_id FROM runs').all()).toEqual([{ id: prior.run, chapter_update_id: null }])
  expect(db.prepare('SELECT * FROM records').all()).toEqual(history)
  expect(db.prepare('SELECT * FROM runner_chapter_updates').all()).toEqual([])
  expect(db.prepare('SELECT * FROM runner_chapter_publication_evidence').all()).toEqual([])
  expect(db.prepare('SELECT * FROM runner_chapter_assemblies').all()).toEqual([])
  expect((db.prepare("SELECT sql FROM sqlite_master WHERE name='one_active_request_run'").get() as { sql: string }).sql).toContain('chapter_update_id')
  upgradeCandidate(db)
  expect(hasV2Writes(db)).toBe(false)
  db.prepare("INSERT INTO runner_chapter_updates VALUES (?,?,?,?,1,'view','queued','{}','{}','time')").run(prior.task, randomUUID(), randomUUID(), prior.request)
  expect(hasV2Writes(db)).toBe(true)
  expect(db.pragma('foreign_key_check')).toEqual([])
})
it('upgrades only registered copies and preserves original legacy rows and file bytes', () => {
  const { root, journal } = profile(), prior = legacy(root, journal.selected()); prior.db.close()
  const source = journal.selected(), original = readFileSync(join(root, source))
  const db = prepareBusinessDatabase(root, journal); connections.push(db)
  expect(readBusinessSchema(db)).toBe(2)
  expect(journal.selected()).toMatch(/-target\.sqlite$/)
  expect(db.prepare('SELECT id,request_id,state,commit_valid FROM runs').all()).toEqual([{ id: prior.run, request_id: prior.request, state: 'completed', commit_valid: 0 }])
  expect(db.prepare('SELECT * FROM records').all()).toEqual([prior.record])
  expect(db.prepare('SELECT * FROM runner_runs').all()).toEqual([])
  expect(db.prepare('SELECT * FROM runner_artifacts').all()).toEqual([])
  expect(readFileSync(join(root, source))).toEqual(original)
  const op = control(root).operations[0]
  expect(op).toMatchObject({ kind: 'schema_upgrade', point_id: null, phase: 'completed', target: { schema_version: 2 }, rollback: { schema_version: 1 } })
  const rollback = new Database(join(root, op.rollback.file), { readonly: true }); connections.push(rollback)
  expect(readBusinessSchema(rollback)).toBe(1)
  expect(rollback.prepare('SELECT id FROM runs').all()).toEqual([{ id: prior.run }])
  expect(() => ownDirectory(root)).toThrow(/Another runtime/)
})
it('rolls back a failed candidate installation without enabling a half-upgraded schema', () => {
  const { root, journal } = profile(), prior = legacy(root, journal.selected()); prior.db.close()
  const source = journal.selected(), original = readFileSync(join(root, source)), exec = Database.prototype.exec
  const fault = vi.spyOn(Database.prototype, 'exec').mockImplementation(function (this: Database.Database, sql: string) {
    const result = exec.call(this, sql)
    if (sql === runnerSql) throw new Error('candidate install fault')
    return result
  })
  expect(() => prepareBusinessDatabase(root, journal)).toThrow(/upgrade failed/)
  expect(journal.selected()).toBe(source)
  expect(readFileSync(join(root, source))).toEqual(original)
  expect(control(root).operations[0].phase).toBe('rolled_back')
  const failed = new Database(join(root, control(root).operations[0].target.file), { readonly: true }); connections.push(failed)
  expect(readBusinessSchema(failed)).toBe(1)
  expect(failed.prepare("SELECT name FROM sqlite_master WHERE name='runner_runs'").get()).toBeUndefined()
  failed.close(); fault.mockRestore()
  const db = prepareBusinessDatabase(root, journal); connections.push(db)
  expect(readBusinessSchema(db)).toBe(2)
  expect(db.prepare('SELECT id FROM tasks').all()).toEqual([{ id: prior.task }])
})
it('returns to the controlled legacy copy when reopening fails before new v2 writes', () => {
  const { root, journal } = profile(), prior = legacy(root, journal.selected()); prior.db.close()
  const pragma = Database.prototype.pragma; let targetOpens = 0
  const fault = vi.spyOn(Database.prototype, 'pragma').mockImplementation(function (this: Database.Database, source: string, options?: any) {
    if (this.name.endsWith('-target.sqlite') && source === 'foreign_keys=ON' && ++targetOpens === 2) throw new Error('target reopen fault')
    return pragma.call(this, source, options)
  })
  expect(() => prepareBusinessDatabase(root, journal)).toThrow(/upgrade failed/)
  expect(journal.selected()).toMatch(/-rollback\.sqlite$/)
  expect(control(root).operations[0].phase).toBe('rolled_back')
  fault.mockRestore()
  const db = prepareBusinessDatabase(root, journal); connections.push(db)
  expect(readBusinessSchema(db)).toBe(2)
  expect(db.prepare('SELECT id FROM tasks').all()).toEqual([{ id: prior.task }])
})
it('blocks automatic downgrade after real v2 business writes', () => {
  const { root, journal } = profile(), prior = legacy(root, journal.selected())
  const op = journal.prepareUpgrade(prior.db, [])
  const body = prior.db.serialize(); prior.db.close()
  for (const image of [op.target, op.rollback]) writeFileSync(join(root, image.file), body, { flag: 'wx', mode: 0o600 })
  const candidate = new Database(join(root, op.target.file)); connections.push(candidate)
  upgradeCandidate(candidate); candidate.close(); journal.seal(); journal.switch()
  const db = openBusinessDatabase(root, journal.selected()); connections.push(db)
  expect(hasV2Writes(db)).toBe(false)
  db.prepare("INSERT INTO tasks(id,title,state,revision) VALUES (?,?,'active',1)").run(randomUUID(), 'New result after upgrade')
  expect(hasV2Writes(db)).toBe(true)
  expect(() => journal.rollback()).toThrow(/New v2 business writes/)
  expect(journal.selected()).toBe(op.target.file)
})
it('keeps v1 recovery points immutable and upgrades only their restored candidate', async () => {
  const { root, journal } = profile(), prior = legacy(root, journal.selected())
  let db = prior.db
  let manager = new RecoveryManager(db, root, () => false, () => {}, () => ({}), journal, file => { db = openBusinessDatabase(root, file); connections.push(db); return db })
  managers.push(manager)
  const token = (manager.begin() as any).reservation.token
  const result = await manager.create(token, null) as any, point = result.active
  expect(point.schema_version).toBe(1)
  const original = readFileSync(join(root, 'recovery', point.id + '.sqlite'))
  manager.close(); db.close()
  db = prepareBusinessDatabase(root, journal); connections.push(db)
  manager = new RecoveryManager(db, root, () => false, () => {}, () => ({}), journal, file => { db = openBusinessDatabase(root, file); connections.push(db); return db }); managers.push(manager)
  const restored = await manager.restore((manager.begin() as any).reservation.token, point.id, point.database_sha256) as any
  expect(restored.last.outcome).toBe('restored')
  expect(readBusinessSchema(db)).toBe(2)
  expect(readFileSync(join(root, 'recovery', point.id + '.sqlite'))).toEqual(original)
  expect(db.prepare('SELECT id FROM runs').all()).toEqual([{ id: prior.run }])
  expect(db.prepare('SELECT * FROM records').all()).toEqual([prior.record])
})
it('keeps the default v1 path closed to newer recovery points', async () => {
  const { root, journal } = profile(), prior = legacy(root, journal.selected())
  const modern = new Database(':memory:'); connections.push(modern)
  modern.exec(coreSql); upgradeCandidate(modern, null)
  const source = new RecoveryManager(modern, root, () => false, () => {}, () => ({}), journal, () => modern); managers.push(source)
  const result = await source.create((source.begin() as any).reservation.token, null) as any
  expect(result.active.schema_version).toBe(2)
  source.close()
  const current = new RecoveryManager(prior.db, root, () => false, () => {}, () => ({}), journal, () => prior.db); managers.push(current)
  const token = (current.begin() as any).reservation.token
  expect(() => current.restore(token, result.active.id, result.active.database_sha256)).toThrow(/required business schema/)
  expect(readBusinessSchema(prior.db)).toBe(1)
  expect(prior.db.prepare('SELECT * FROM records').all()).toEqual([prior.record])
  expect(control(root).operations).toEqual([])
})
it('removes outline history only inside the controlled Task deletion transaction', () => {
  const { root, journal } = profile(), db = prepareBusinessDatabase(root, journal); connections.push(db)
  const task = randomUUID(), other = randomUUID()
  for (const id of [task, other]) {
    db.prepare("INSERT INTO tasks(id,title,state,revision) VALUES (?,?,'active',1)").run(id, 'Task with outline')
    db.prepare("INSERT INTO runner_outlines VALUES (?,1,'{}')").run(id)
  }
  expect(() => purgeRunnerTask(db, task)).toThrow(/controlled Task deletion transaction/)
  db.transaction(() => {
    purgeRunnerTask(db, task)
    db.prepare('DELETE FROM tasks WHERE id=?').run(task)
  })()
  expect(db.prepare('SELECT task_id FROM runner_outlines').all()).toEqual([{ task_id: other }])
  expect(db.pragma('foreign_key_check')).toEqual([])
})
it.each([0, 3])('rejects unsupported business version %i instead of guessing compatibility', version => {
  const db = new Database(':memory:'); connections.push(db)
  db.exec('CREATE TABLE schema_version(version INTEGER PRIMARY KEY)'); db.prepare('INSERT INTO schema_version VALUES (?)').run(version)
  expect(() => readBusinessSchema(db)).toThrow(/Unsupported business database version/)
})

it('creates schema v2 through RuntimeStore and reopens the same task without another migration', () => {
  const root = runtimeRoot(), store = runtime(root), created = store.create('Runtime v2 task')
  const db = currentDatabase(root), selected = control(root).selected
  expect(readBusinessSchema(db)).toBe(2)
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name='one_active_request_run'").get()).toBeTruthy()
  expect(db.prepare('SELECT * FROM runner_goal_heads').all()).toEqual([])
  expect(control(root).operations).toEqual([])
  db.close(); store.close()
  const reopened = runtime(root), current = currentDatabase(root)
  expect(readBusinessSchema(current)).toBe(2)
  expect(control(root).selected).toBe(selected)
  expect(control(root).operations).toEqual([])
  const { runtime_epoch: beforeEpoch, ...before } = created
  const { runtime_epoch: afterEpoch, ...after } = reopened.snapshot(created.task.id)
  expect(afterEpoch).not.toBe(beforeEpoch)
  expect(after).toEqual(before)
})

it('migrates v1 history through RuntimeStore once without inventing runner attribution', () => {
  const root = runtimeRoot(), prior = legacy(root, 'pliuna.sqlite')
  const original = {
    requests: prior.db.prepare('SELECT * FROM requests').all(),
    runs: prior.db.prepare('SELECT *,NULL AS chapter_update_id FROM runs').all(),
    records: prior.db.prepare('SELECT * FROM records').all()
  }
  prior.db.close()
  const bytes = readFileSync(join(root, 'pliuna.sqlite')), store = runtime(root), db = currentDatabase(root)
  expect(readBusinessSchema(db)).toBe(2)
  expect(store.tasks()).toEqual([expect.objectContaining({ id: prior.task, title: 'Legacy task' })])
  for (const [table, rows] of Object.entries(original)) expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual(rows)
  for (const table of ['runner_inputs', 'runner_runs', 'runner_outlines', 'runner_artifacts']) expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual([])
  expect(readFileSync(join(root, 'pliuna.sqlite'))).toEqual(bytes)
  const saved = control(root)
  expect(saved.operations).toEqual([expect.objectContaining({ kind: 'schema_upgrade', phase: 'completed', previous: 'pliuna.sqlite' })])
  db.close(); store.close()
  const reopened = runtime(root), current = currentDatabase(root)
  expect(reopened.tasks()).toEqual([expect.objectContaining({ id: prior.task })])
  expect(control(root).selected).toBe(saved.selected)
  expect(control(root).operations).toEqual(saved.operations)
  for (const [table, rows] of Object.entries(original)) expect(current.prepare(`SELECT * FROM ${table}`).all()).toEqual(rows)
  expect(readFileSync(join(root, 'pliuna.sqlite'))).toEqual(bytes)
})

it('deletes the complete runner graph through RuntimeStore while preserving another task', () => {
  const root = runtimeRoot(), store = runtime(root)
  const removed = store.create('Delete runner history').task.id, retained = store.create('Keep runner history').task.id
  const db = currentDatabase(root)
  runnerHistory(db, removed)
  const kept = runnerHistory(db, retained)
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'runner_%'").all() as { name: string }[]).map(row => row.name)
  const remaining = new Map(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} WHERE ${table === 'runner_index_read_items' ? 'read_id' : 'task_id'}=?`).all(table === 'runner_index_read_items' ? kept.read : retained)]))
  for (const table of tables) expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 2 })
  expect(db.pragma('foreign_key_check')).toEqual([])
  expect(store.handle({ type: 'task.delete', task_id: removed })).toMatchObject({ deleted: true })
  expect(store.tasks()).toEqual([expect.objectContaining({ id: retained })])
  expect(() => store.snapshot(removed)).toThrow(/not found/)
  for (const table of tables) expect(db.prepare(`SELECT * FROM ${table}`).all(), table).toEqual(remaining.get(table))
  expect(db.pragma('foreign_key_check')).toEqual([])
  expect(control(root).deleted_tasks).toContain(removed)
})
