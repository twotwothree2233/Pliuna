import { fileLstatSync, fileFstatSync, type FileStat, managedFile, openRegularFileSync } from '../platform/files'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import defaults from '../shared/contracts/development-defaults.json'
import { ExportControl } from './export-control'
import { validatePluginControl } from './plugins/control'
import { RecoveryManager } from './recovery'
import { RestoreJournal } from './restore-journal'

type Row = Record<string, any>
export type InspectionRequest = { scope: 'growth' | 'resources' | 'resource'; resource_id?: string; after?: number }
const controlLimit = 64 * 1024 * 1024
const fail = (code: string): never => { throw Object.assign(new Error(code), { code }) }
const safeCode = (e: unknown) => ['ENOENT', 'EACCES', 'EPERM', 'EIO', 'EBUSY'].includes((e as NodeJS.ErrnoException).code ?? '') ? (e as NodeJS.ErrnoException).code! : /^INSPECT_[A-Z_]+$/.test((e as Error).message ?? '') ? (e as Error).message : 'INSPECT_UNAVAILABLE'
function regular(path: string): FileStat { const s = fileLstatSync(path); if (!s.isFile() || s.nlink !== 1) fail('INSPECT_UNSAFE_FILE'); return s }
function open(root: string, file: string): Database.Database {
  regular(join(root, file))
  const db = new Database(join(root, file), { readonly: true, fileMustExist: true, timeout: 0 })
  db.pragma('query_only=ON'); return db
}
function manifest(db: Database.Database, table: 'restore_control' | 'control' | 'plugin_control'): any {
  const size = (db.prepare(`SELECT length(CAST(manifest AS BLOB)) n FROM ${table} WHERE id=1`).get() as Row)?.n
  if (!Number.isSafeInteger(size) || size > controlLimit) fail('INSPECT_CONTROL_LIMIT')
  return JSON.parse((db.prepare(`SELECT manifest FROM ${table} WHERE id=1`).get() as Row).manifest)
}
function bytes(root: string, file: string): number { return regular(join(root, file)).size }
function selectedControl(root: string): any {
  const db = open(root, 'restore-control.sqlite')
  try { const v = manifest(db, 'restore_control'); if (![1, 2, 3, 4, 5, 6].includes(v.version)) fail('INSPECT_CONTROL_VERSION'); return RestoreJournal.normalizeControl(v) } finally { db.close() }
}
async function observeProtection(db: Database.Database, journal: Row, recovery: Row, rows: Row[], check: () => void): Promise<Map<string, Set<string>>> {
  const observed = new Map<string, Set<string>>(rows.map(r => [r.id, new Set<string>()]))
  const byKey = new Map(rows.flatMap(r => [[r.id, r.id], [r.storage_key, r.id]] as [string, string][]))
  const mark = (id: unknown, reason: string) => { if (typeof id === 'string') { const actual = byKey.get(id); if (actual) observed.get(actual)!.add(reason) } }
  for (const r of rows) {
    const reasons = observed.get(r.id)!
    if (db.prepare('SELECT 1 FROM task_resources WHERE resource_id=? LIMIT 1').get(r.id)) reasons.add('CURRENT_TASK_ASSOCIATION')
    if (db.prepare("SELECT 1 FROM object_references WHERE target_kind='resource' AND target_id IN (?,?) LIMIT 1").get(r.id,r.storage_key)) reasons.add('EXPLICIT_REFERENCE')
    if (db.prepare('SELECT 1 FROM views WHERE bundle_resource_id=? UNION ALL SELECT 1 FROM view_history WHERE bundle_resource_id=? LIMIT 1').get(r.id,r.id)) reasons.add('VIEW_OR_HISTORY_BUNDLE')
    if (db.prepare('SELECT 1 FROM staging WHERE resource_id=? OR storage_key=? LIMIT 1').get(r.id,r.storage_key)) reasons.add('STAGING')
  }
  for (const point of [...recovery.candidates, ...(recovery.active ? [recovery.active] : [])]) for (const r of point.resources) { mark(r.id,'INDEPENDENT_POINT_OR_CANDIDATE'); mark(r.storage_key,'INDEPENDENT_POINT_OR_CANDIDATE') }
  for (const r of journal.retirements) if (r.phase !== 'preview' && r.phase !== 'released') for (const key of r.protection.keys) mark(key,'UNRELEASED_REPLICA')
  const released = new Set(journal.retirements.filter((r: Row)=>r.phase==='released').map((r: Row)=>r.file))
  for (const op of journal.operations) for (const image of [op.target,op.rollback]) if (!released.has(image.file)) for (const r of image.resources) { mark(r.id,'RESTORE_IMAGE'); mark(r.storage_key,'RESTORE_IMAGE') }
  const refs = (value: unknown, reason: string) => {
    if (!Array.isArray(value)) fail('INSPECT_REFERENCE_FACTS_INVALID')
    for (const ref of value as Row[]) { if (!ref?.target || !['resource','task_data'].includes(ref.target.kind) || typeof ref.target.id !== 'string') fail('INSPECT_REFERENCE_FACTS_INVALID'); if (ref.target.kind === 'resource') mark(ref.target.id,reason) }
  }
  for (const table of ['task_data','view_history']) {
    let after=0,total=0
    while(true) {
      check(); const column=table==='task_data'?'references_json':'evidence_snapshot_json'
      const batch=db.prepare(`SELECT rowid ordinal,length(CAST(${column} AS BLOB)) bytes,CASE WHEN length(CAST(${column} AS BLOB))<=? THEN ${column} END value FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT 100`).all(defaults.transport.rpc_message_bytes,after) as Row[]
      if(!batch.length)break
      total+=batch.length;if(total>100000)fail('INSPECT_REFERENCE_SCAN_LIMIT')
      for(const row of batch) {
        if(!Number.isSafeInteger(row.bytes)||row.bytes>defaults.transport.rpc_message_bytes||typeof row.value!=='string')fail('INSPECT_REFERENCE_FACTS_INVALID')
        let value: any;try{value=JSON.parse(row.value)}catch{fail('INSPECT_REFERENCE_FACTS_INVALID')}
        if(table==='task_data')refs(value,'TASK_DATA_JSON')
        else { if(value.resources!==undefined&&!Array.isArray(value.resources))fail('INSPECT_REFERENCE_FACTS_INVALID');for(const r of value.resources??[]){if(typeof r?.id!=='string')fail('INSPECT_REFERENCE_FACTS_INVALID');mark(r.id,'FROZEN_VIEW_RESOURCE')} const sources=value?.evidence?.sources??[];if(!Array.isArray(sources))fail('INSPECT_REFERENCE_FACTS_INVALID');for(const source of sources){if(!Array.isArray(source.resources))fail('INSPECT_REFERENCE_FACTS_INVALID');for(const r of source.resources){if(typeof r?.id!=='string')fail('INSPECT_REFERENCE_FACTS_INVALID');mark(r.id,'FROZEN_HISTORY_JSON')}refs(source.references,'FROZEN_HISTORY_JSON')} }
      }
      after=batch.at(-1)!.ordinal;await setImmediate()
    }
  }
  return observed
}

// This module never constructs runtime/recovery managers or calls maintenance reconciliation.
export async function inspectStorage(root: string, request: InspectionRequest, progress: (value: Row) => void, signal = new AbortController().signal): Promise<Row> {
  const started = new Date().toISOString(), result: Row = { scope: request.scope, started_at: started, readonly: true, deletion_authority: false, complete: false, items: [], next_after: null, sqlite_auxiliary_files_possible: true }
  const check = () => { if (signal.aborted) fail('INSPECT_CANCELLED') }
  try {
    if (!fileLstatSync(root).isDirectory()) fail('INSPECT_UNSAFE_DIRECTORY')
    progress({ phase: 'checking_control', checked: 0 }); check()
    const journal = selectedControl(root); check()
    const db = open(root, journal.selected)
    try {
      if (JSON.stringify(db.prepare('SELECT version FROM schema_version').all()) !== '[{"version":1}]') fail('INSPECT_SCHEMA_UNKNOWN')
      if (request.scope === 'growth') {
        const recovery = open(root, 'recovery-control.sqlite')
        let gc: Database.Database | undefined
        try {
          gc = open(root, 'gc-control.sqlite')
          const rv = manifest(recovery, 'control'); RecoveryManager.validateControl(rv)
          if (JSON.stringify(gc.prepare('SELECT version FROM gc_version').all()) !== JSON.stringify([{ version: journal.export_control }])) fail('INSPECT_CONTROL_VERSION')
          const phases: Row = {}; for (const r of journal.resource_cleanups) phases[r.phase] = (phases[r.phase] ?? 0) + 1
          result.controls = { format: journal.version, restore_bytes: bytes(root, 'restore-control.sqlite'), recovery_bytes: bytes(root, 'recovery-control.sqlite'), gc_bytes: bytes(root, 'gc-control.sqlite'), resource_records: journal.resource_cleanups.length, deletion_sources: journal.task_deletions.length, replica_records: journal.retirements.length, restore_operations: journal.operations.length, deleted_task_intents: journal.deleted_tasks.length, resource_phases: phases, gc_records: (gc.prepare('SELECT count(*) n FROM gc_operations').get() as Row).n, retained_candidates: rv.candidates.length, effective_points: rv.active ? 1 : 0, retired_points: rv.retired.length, invalidated_points: rv.invalidated.length, records_pruned: 0 }
          const plugins = open(root, 'plugin-control.sqlite')
          try {
            const pv = manifest(plugins, 'plugin_control'); validatePluginControl(pv)
            result.controls.plugins = { format: pv.version, bytes: bytes(root, 'plugin-control.sqlite'), packages: pv.packages.length, trust_records: pv.trusts.length, enabled: pv.enabled.length, workflows: pv.workflows.length, records_pruned: 0, physical_package_gc: false }
          } finally { plugins.close() }
          const exports = open(root, 'export-control.sqlite')
          try {
            if (JSON.stringify(exports.prepare('SELECT version FROM export_version').all()) !== JSON.stringify([{ version: journal.export_control }])) fail('INSPECT_CONTROL_VERSION')
            result.controls.exports = { format: journal.export_control, bytes: bytes(root, 'export-control.sqlite'), jobs: (exports.prepare('SELECT count(*) n FROM export_jobs').get() as Row).n, unfinished: (exports.prepare("SELECT count(*) n FROM export_jobs WHERE phase NOT IN ('saved','failed','cancelled')").get() as Row).n, records_pruned: 0 }
          } finally { exports.close() }
          result.business = db.transaction(() => {
            const counts: Row = {}; for (const table of ['tasks', 'resources', 'records', 'view_history', 'staging']) counts[table] = (db.prepare(`SELECT count(*) n FROM ${table}`).get() as Row).n
            return { counts, resource_declared_bytes: (db.prepare('SELECT coalesce(sum(byte_length),0) n FROM resources').get() as Row).n, database_file_bytes: bytes(root, journal.selected), wal_bytes: fs.existsSync(join(root, journal.selected + '-wal')) ? bytes(root, journal.selected + '-wal') : 0 }
          })()
          result.protection = { retained_generation_entries: new Set(['trellis.sqlite', journal.selected, ...journal.operations.flatMap((op: Row) => [op.previous, op.target.file, op.rollback.file])]).size, unreleased_replica_records: journal.retirements.filter((r: Row) => r.phase !== 'preview' && r.phase !== 'released').length, files_not_scanned: true, bytes_are_not_free_space: true }
        } finally { recovery.close(); gc?.close() }
      } else {
        if (!fileLstatSync(join(root, 'resources')).isDirectory()) fail('INSPECT_UNSAFE_DIRECTORY')
        // A short consistent metadata snapshot; no long transaction is held while hashing resource bodies.
        const rows = db.transaction(() => request.scope === 'resource'
          ? db.prepare('SELECT rowid ordinal,* FROM resources WHERE id=?').all(request.resource_id)
          : db.prepare('SELECT rowid ordinal,* FROM resources WHERE rowid>? ORDER BY rowid LIMIT 51').all(request.after ?? 0))() as Row[]
        if (request.scope === 'resource' && !rows.length) fail('INSPECT_RESOURCE_UNAVAILABLE')
        const recoveryDb = open(root, 'recovery-control.sqlite')
        let recovery: Row
        try { recovery = manifest(recoveryDb, 'control'); RecoveryManager.validateControl(recovery) } finally { recoveryDb.close() }
        const observed = await observeProtection(db, journal, recovery, rows.slice(0, 50), check)
        const exports = open(root, 'export-control.sqlite')
        try {
          if (JSON.stringify(exports.prepare('SELECT version FROM export_version').all()) !== JSON.stringify([{ version: journal.export_control }])) fail('INSPECT_CONTROL_VERSION')
          const unfinished = exports.prepare("SELECT manifest,length(CAST(manifest AS BLOB)) bytes FROM export_jobs WHERE phase NOT IN ('saved','failed','cancelled') LIMIT 2").all() as Row[]
          if (unfinished.length > 1) fail('INSPECT_EXPORT_CONTROL_INVALID')
          for (const row of unfinished) {
            if (row.bytes > 32 * 1024 * 1024) fail('INSPECT_CONTROL_LIMIT')
            const job = JSON.parse(row.manifest); ExportControl.validate(job); if (journal.export_control === 1 && job.version !== 1) fail('INSPECT_CONTROL_VERSION')
            for (const resource of rows.slice(0, 50)) if (job.resources.some((r: Row) => r.id === resource.id || r.storage_key === resource.storage_key)) observed.get(resource.id)!.add('INDEPENDENT_EXPORT_PIN')
          }
        } finally { exports.close() }
        result.protection_scope = 'current_relations_json_and_independent_manifests; retained_database_bodies_not_scanned'
        result.next_after = rows.length > 50 ? rows[49]!.ordinal : null
        for (const r of rows.slice(0, 50)) {
          check(); const item: Row = { resource_id: r.id, state: 'not_checked', observed_protection_sources: [...observed.get(r.id)!], checked_at: new Date().toISOString(), scope: 'current_registered_resource', protection: 'NOT_EVALUATED_NO_DELETION_AUTHORITY', blocks: ['resource_use_if_unavailable', 'maintenance_requiring_verified_resource'] }
          progress({ phase: 'checking_resources', checked: result.items.length, resource_id: r.id }); await setImmediate(); check()
          let fd: number | undefined
          try {
            if (!/^[A-Za-z0-9_-]+$/.test(r.storage_key) || !/^[a-f0-9]{64}$/.test(r.sha256) || !Number.isSafeInteger(r.byte_length) || r.byte_length < 0 || r.byte_length > defaults.transport.resource_bytes) fail('INSPECT_METADATA_INVALID')
            const path = managedFile(root, 'resources', r.storage_key), initial = regular(path)
            if (initial.size !== r.byte_length) fail('INSPECT_LENGTH_MISMATCH')
            fd = openRegularFileSync(path)
            const opened = fileFstatSync(fd); if (opened.dev !== initial.dev || opened.ino !== initial.ino) fail('INSPECT_IDENTITY_CHANGED')
            const hash = createHash('sha256'), buffer = Buffer.alloc(256 * 1024); let read = 0
            while (read < initial.size) { check(); const n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, initial.size - read), read); if (!n) fail('INSPECT_IDENTITY_CHANGED'); hash.update(buffer.subarray(0, n)); read += n; if (read % (4 * 1024 * 1024) === 0) { progress({ phase: 'hashing', checked: result.items.length, bytes_read: read, resource_id: r.id }); await setImmediate() } }
            const end = fileFstatSync(fd), current = regular(path)
            if ([end, current].some(s => s.dev !== initial.dev || s.ino !== initial.ino || s.size !== initial.size || s.mtimeMs !== initial.mtimeMs || s.ctimeMs !== initial.ctimeMs)) fail('INSPECT_IDENTITY_CHANGED')
            if (hash.digest('hex') !== r.sha256) fail('INSPECT_HASH_MISMATCH')
            const row = db.prepare('SELECT * FROM resources WHERE id=?').get(r.id) as Row | undefined
            const { ordinal: _, ...material } = r
            if (!row || JSON.stringify(row) !== JSON.stringify(material)) fail('INSPECT_METADATA_CHANGED')
            item.state = 'verified'; item.bytes_read = read
          } catch (e) { if (signal.aborted) throw e; item.state = ['EACCES', 'EPERM', 'EIO', 'EBUSY'].includes(safeCode(e)) ? 'unavailable' : 'anomaly'; item.reason = safeCode(e) }
          finally { if (fd !== undefined) fs.closeSync(fd) }
          result.items.push(item)
        }
      }
      check(); if (selectedControl(root).selected !== journal.selected) fail('INSPECT_GENERATION_CHANGED'); result.complete = true
    } finally { db.close() }
  } catch (e) { result.error = safeCode(e) }
  result.finished_at = new Date().toISOString(); return result
}
