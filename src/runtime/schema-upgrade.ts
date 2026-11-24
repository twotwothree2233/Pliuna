import Database from 'better-sqlite3'
import { writeFileSync } from 'node:fs'
import { managedRegularFile, entryExistsSync, flushDirectorySync, flushFileSync } from '../platform/files'
import { protectPrivatePath } from '../platform/permissions'
import { ContractError } from '../shared/validation'
import coreSql from '../shared/contracts/001-core.sql?raw'
import runnerSql from '../shared/contracts/002-runner.sql?raw'
import organizationSql from '../shared/contracts/006-task-organization.sql?raw'
import workspaceQuerySql from '../shared/contracts/007-workspace-query-indexes.sql?raw'
import type { PluginCopy } from './plugins/package'
import type { RestoreJournal } from './restore-journal'
import { installChapterSchema } from './runner/chapter-state'
import { installContentTreeSchema } from './runner/content-tree-state'
import { installProductionIdentitySchema } from './runner/production-identity'

export type BusinessSchema = 1 | 2
const fail = (code: string, message: string): never => { throw new ContractError(code, message) }

// Business versions do not describe file identities or independent control files.
export function readBusinessSchema(db: Database.Database): BusinessSchema {
  const rows = db.prepare('SELECT version FROM schema_version ORDER BY version').all() as { version: number }[]
  if (rows.length !== 1 || (rows[0]?.version !== 1 && rows[0]?.version !== 2)) fail('SCHEMA_VERSION', 'Unsupported business database version')
  return rows[0]!.version as BusinessSchema
}

export function hasV2Writes(db: Database.Database): boolean {
  if (readBusinessSchema(db) !== 2) return false
  const row = db.prepare('SELECT v2_writes FROM business_upgrade_state WHERE id=1').get() as { v2_writes: number } | undefined
  if (!row || ![0, 1].includes(row.v2_writes)) fail('SCHEMA_UPGRADE_STATE', 'Business upgrade evidence is unavailable; downgrade is closed')
  return row!.v2_writes === 1
}

export function purgeRunnerTask(db: Database.Database, task: string): void {
  if (!db.inTransaction) fail('TASK_DELETE_TRANSACTION', 'Runner history must be removed in the controlled Task deletion transaction')
  if (readBusinessSchema(db) === 1) return
  for (const table of ['runner_production_submissions', 'runner_artifact_slots', 'runner_content_intent_relations', 'runner_content_tree_cursors', 'runner_content_tree_heads', 'runner_content_trees', 'runner_chapter_assemblies', 'runner_chapter_publication_evidence', 'runner_chapter_publications', 'runner_chapter_inheritance', 'runner_chapter_proposals', 'runner_chapter_intents', 'runner_content_scope_revisions', 'runner_chapter_updates', 'runner_chapter_heads', 'runner_chapter_manifests', 'runner_chapter_resources', 'runner_deliveries', 'runner_view_mappings', 'runner_manifests', 'runner_surface_history', 'runner_publications', 'runner_batches', 'runner_scopes', 'runner_index_cursors', 'runner_index_reads', 'runner_contribution_inventories', 'runner_work_outputs', 'runner_inventory_sources', 'runner_artifacts', 'runner_candidates', 'runner_artifact_owners', 'runner_outlines', 'runner_attempts', 'runner_work', 'runner_runs', 'runner_budget_reservations', 'runner_budgets', 'runner_content_removals', 'runner_content_plans', 'runner_consumptions', 'runner_inputs']) db.prepare(`DELETE FROM ${table} WHERE task_id=?`).run(task)
}

function installWriteEvidence(db: Database.Database, previous: BusinessSchema | null): void {
  db.exec('CREATE TABLE business_upgrade_state (id INTEGER PRIMARY KEY CHECK(id=1), previous_schema INTEGER CHECK(previous_schema=1 OR previous_schema IS NULL), v2_writes INTEGER NOT NULL DEFAULT 0 CHECK(v2_writes IN (0,1)))')
  db.prepare('INSERT INTO business_upgrade_state(id,previous_schema,v2_writes) VALUES (1,?,0)').run(previous)
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_version','business_upgrade_state')").all() as { name: string }[]
  const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"'
  for (const { name } of tables) for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
    db.exec(`CREATE TRIGGER ${quote(`business_v2_${name}_${event.toLowerCase()}`)} AFTER ${event} ON ${quote(name)} BEGIN UPDATE business_upgrade_state SET v2_writes=1 WHERE id=1 AND v2_writes=0; END`)
  }
}

function installTaskOrganization(db: Database.Database): void {
  db.transaction(() => {
    db.exec(organizationSql)
    if (!db.prepare("SELECT 1 FROM pragma_table_info('task_organization') WHERE name='archived_at'").get()) {
      db.exec('ALTER TABLE task_organization ADD COLUMN archived_at INTEGER CHECK(archived_at IS NULL OR archived_at > 0)')
    }
    for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
      db.exec(`CREATE TRIGGER IF NOT EXISTS business_v2_task_organization_${event.toLowerCase()} AFTER ${event} ON task_organization BEGIN UPDATE business_upgrade_state SET v2_writes=1 WHERE id=1 AND v2_writes=0; END`)
    }
  })()
}

export function assertCurrentBusinessFormat(db: Database.Database): void {
  if (readBusinessSchema(db) !== 2 || !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runner_content_removals'").get())
    fail('SCHEMA_VERSION', 'This workspace uses a pre-release format. Open a workspace created with the current format.')
}

function installBusinessExtensions(db: Database.Database): void {
  assertCurrentBusinessFormat(db)
  installChapterSchema(db)
  installContentTreeSchema(db)
  installProductionIdentitySchema(db)
  installTaskOrganization(db)
  db.exec(workspaceQuerySql)
}

// Only a private candidate or a brand-new database may be passed here.
export function upgradeCandidate(db: Database.Database, previous: BusinessSchema | null = 1): void {
  const version = readBusinessSchema(db)
  if (version === 2) { hasV2Writes(db); installBusinessExtensions(db); return }
  if (db.pragma('quick_check', { simple: true }) !== 'ok' || (db.pragma('foreign_key_check') as unknown[]).length) fail('SCHEMA_UPGRADE_INVALID', 'Legacy business database requires inspection before upgrade')
  db.transaction(() => {
    db.exec(runnerSql)
    installChapterSchema(db)
    installContentTreeSchema(db)
    installProductionIdentitySchema(db)
    db.prepare('UPDATE schema_version SET version=2,applied_at=? WHERE version=1').run(new Date().toISOString())
    installWriteEvidence(db, previous)
    installTaskOrganization(db)
    db.exec(workspaceQuerySql)
  })()
  if (readBusinessSchema(db) !== 2 || (db.pragma('foreign_key_check') as unknown[]).length) fail('SCHEMA_UPGRADE_INVALID', 'Upgraded business database is inconsistent')
}

function configure(db: Database.Database): void {
  db.pragma('foreign_keys=ON'); db.pragma('journal_mode=WAL'); db.pragma('synchronous=FULL')
}

export function openBusinessDatabase(root: string, file: string): Database.Database {
  const path = managedRegularFile(root, file), db = new Database(path, { fileMustExist: true })
  try {
    protectPrivatePath(path, 'file')
    if (readBusinessSchema(db) !== 2) fail('SCHEMA_VERSION', 'Current runtime requires business schema v2')
    hasV2Writes(db)
    configure(db)
    installBusinessExtensions(db)
    return db
  } catch (error) { db.close(); throw error }
}

// The caller holds ownDirectory for this entire operation and runtime lifetime.
export function prepareBusinessDatabase(root: string, journal: RestoreJournal, plugins: () => PluginCopy[] = () => [], currentFormatOnly = false): Database.Database {
  const path = managedRegularFile(root, journal.selected()), present = entryExistsSync(path)
  let db = new Database(path, { fileMustExist: present })
  let switched = false, prepared = false
  try {
    protectPrivatePath(path, 'file')
    const schema = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'").get()
    if (!schema) {
      if ((db.prepare('SELECT count(*) AS n FROM sqlite_master').get() as { n: number }).n) fail('SCHEMA_VERSION', 'Existing database has no supported business schema')
      configure(db)
      db.transaction(() => { db.exec(coreSql); upgradeCandidate(db, null) })()
      return db
    }
    if (currentFormatOnly) assertCurrentBusinessFormat(db)
    if (readBusinessSchema(db) === 2) { hasV2Writes(db); configure(db); installBusinessExtensions(db); return db }

    db.exec('BEGIN EXCLUSIVE')
    const operation = journal.prepareUpgrade(db, plugins()); prepared = true
    const body = db.serialize()
    for (const image of [operation.target, operation.rollback]) {
      const destination = managedRegularFile(root, image.file)
      writeFileSync(destination, body, { flag: 'wx', mode: 0o600 })
      protectPrivatePath(destination, 'file'); flushFileSync(destination)
    }
    flushDirectorySync(root)
    const candidate = new Database(managedRegularFile(root, operation.target.file), { fileMustExist: true })
    try { configure(candidate); upgradeCandidate(candidate); candidate.pragma('wal_checkpoint(TRUNCATE)') }
    finally { candidate.close() }
    journal.seal()
    db.exec('ROLLBACK'); db.close()
    journal.switch(); switched = true
    db = openBusinessDatabase(root, journal.selected())
    journal.finish('completed')
    return db
  } catch (error) {
    if (db.open) { if (db.inTransaction) db.exec('ROLLBACK'); db.close() }
    if (prepared) {
      if (switched || journal.phase() === 'switched') journal.rollback()
      else if (journal.phase() === 'preparing') journal.finish('rolled_back')
    }
    if (error instanceof ContractError) throw error
    return fail('SCHEMA_UPGRADE_FAILED', 'Business upgrade failed; original and registered copies remain retained')
  }
}
