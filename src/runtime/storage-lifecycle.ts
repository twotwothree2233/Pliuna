import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import defaults from '../shared/contracts/development-defaults.json'
import { ContractError } from '../shared/validation'
import { publishResourceFile, resourceBody } from './resources'

type Row = Record<string, any>
type Stage = { id: string; taskId: string; actionId: string; key: string; bytes: number; sha256: string }
const now = () => new Date().toISOString()
const fail = (message: string): never => { throw new ContractError('STAGING_INVALID', message) }

// Non-committed staging is the durable pin. This module never unlinks files.
export class StorageLifecycle {
  private timer?: ReturnType<typeof setTimeout>
  private closed = false
  private paused = false
  private maintenanceError: string | null = null
  constructor(private db: Database.Database, private root: string, private epoch: string, private pluginOwner: (action: string, task: string) => boolean = () => false) {}
  private owner(actionId: string, taskId: string): unknown {
    const existing = this.db.prepare("SELECT a.id FROM actions a JOIN tasks t ON t.id=a.task_id LEFT JOIN runs r ON r.id=a.run_id WHERE a.id=? AND a.task_id=? AND a.commit_valid=1 AND a.state!='ended' AND t.state='active' AND ((r.commit_valid=1 AND r.runtime_epoch=? AND r.state IN ('running','waiting')) OR (a.run_id IS NULL AND json_extract(a.source_json,'$.type')='host_import' AND json_extract(a.source_json,'$.epoch')=? AND json_extract(a.request_json,'$.type')='material.import'))").get(actionId, taskId, this.epoch, this.epoch)
    return existing || this.pluginOwner(actionId, taskId)
  }
  publish(stage: Stage, body: Buffer): void {
    if (!/^[a-zA-Z0-9_-]+$/.test(stage.key)) fail('Invalid managed storage key')
    const owner = this.owner(stage.actionId, stage.taskId)
    if (!owner || stage.bytes !== body.length) fail('Stage owner or length invalid')
    this.db.prepare("INSERT INTO staging (id,task_id,owner_kind,owner_id,runtime_epoch,state,storage_key,expected_bytes,sha256,created_at) VALUES (?,?,'action',?,?,'publishing',?,?,?,?)").run(stage.id, stage.taskId, stage.actionId, this.epoch, stage.key, stage.bytes, stage.sha256, now())
    publishResourceFile(this.root, stage.key, body)
    resourceBody(this.root, { id: stage.key, storage_key: stage.key, sha256: stage.sha256, byte_length: stage.bytes, media_type: '', display_name: '', created_at: '' })
    this.db.prepare("UPDATE staging SET state='prepared',received_bytes=expected_bytes WHERE id=? AND state='publishing'").run(stage.id)
  }
  commit(stageId: string, resourceId: string): void {
    if (!this.db.inTransaction) fail('Pin handoff requires the business transaction')
    const s = this.db.prepare('SELECT * FROM staging WHERE id=?').get(stageId) as Row | undefined
    const resource = this.db.prepare('SELECT * FROM resources WHERE id=?').get(resourceId) as Row | undefined
    const owner = s && this.owner(s.owner_id, s.task_id)
    const associated = s && this.db.prepare('SELECT 1 FROM task_resources WHERE task_id=? AND resource_id=?').get(s.task_id, resourceId)
    if (!s || !resource || !owner || !associated || s.runtime_epoch !== this.epoch || s.state !== 'prepared' || resource.storage_key !== s.storage_key || resource.sha256 !== s.sha256 || resource.byte_length !== s.expected_bytes) fail('Pin, owner or formal resource changed before commit')
    this.db.prepare("UPDATE staging SET state='committed',resource_id=? WHERE id=?").run(resourceId, stageId)
  }
  failed(actionId: string): void {
    this.db.prepare("UPDATE staging SET state='invalid' WHERE owner_kind='action' AND owner_id=? AND state!='committed'").run(actionId)
    for (const row of this.db.prepare('SELECT id FROM staging WHERE owner_id=?').all(actionId) as Row[]) this.inspect(row.id)
    this.schedule()
  }
  recover(): void {
    // Keyset batches bound memory, including databases created before this lifecycle existed.
    let after = 0
    while (true) {
      const rows = this.db.prepare('SELECT id,rowid AS ordinal FROM staging WHERE rowid>? ORDER BY rowid LIMIT ?').all(after, defaults.cleanup.reconcile_items) as Row[]
      if (!rows.length) break
      for (const row of rows) {
        const job = this.db.prepare("SELECT attempt,next_attempt_at FROM cleanup_jobs WHERE owner_kind='staging' AND owner_id=?").get(row.id) as Row | undefined
        this.inspect(row.id, job?.attempt ?? 0)
        if (job?.next_attempt_at) this.db.prepare("UPDATE cleanup_jobs SET next_attempt_at=? WHERE owner_kind='staging' AND owner_id=? AND state='failed' AND next_attempt_at IS NOT NULL").run(job.next_attempt_at, row.id)
      }
      after = rows.at(-1)!.ordinal
    }
    this.schedule()
  }
  private assess(s: Row): Row {
    if (!/^[a-zA-Z0-9_-]+$/.test(s.storage_key)) return { assessment: 'review', reason: 'INVALID_STORAGE_KEY', retained_bytes: null }
    const resources = this.db.prepare('SELECT * FROM resources WHERE storage_key=? OR id=?').all(s.storage_key, s.resource_id ?? s.storage_key) as Row[]
    const owner = s.owner_kind === 'action' ? this.db.prepare('SELECT * FROM actions WHERE id=? AND task_id=?').get(s.owner_id, s.task_id) as Row | undefined : undefined
    const references = this.db.prepare("SELECT 1 FROM task_resources WHERE resource_id=? UNION ALL SELECT 1 FROM object_references WHERE target_kind='resource' AND target_id=? AND protects_resource=1 UNION ALL SELECT 1 FROM views WHERE bundle_resource_id=? UNION ALL SELECT 1 FROM view_history WHERE bundle_resource_id=? UNION ALL SELECT 1 FROM recovery_resources WHERE resource_id=? LIMIT 1").get(s.storage_key, s.storage_key, s.storage_key, s.storage_key, s.storage_key)
    let bytes = 0, files = 0
    for (const name of [s.storage_key, s.storage_key + '.tmp']) {
      try {
        const stat = lstatSync(join(this.root, 'resources', name))
        if (!stat.isFile()) return { assessment: 'review', reason: 'UNSAFE_FILE_TYPE', retained_bytes: null }
        bytes += stat.size; files++
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    const matching = resources.find(r => r.id === (s.resource_id ?? s.storage_key) && r.storage_key === s.storage_key && r.sha256 === s.sha256 && r.byte_length === s.expected_bytes)
    if (resources.length || references || s.state === 'committed' || owner?.result === 'success') {
      if (matching) resourceBody(this.root, matching as Parameters<typeof resourceBody>[1])
      if (matching && references && owner?.result === 'success') {
        this.db.prepare("UPDATE staging SET state='committed',resource_id=?,received_bytes=expected_bytes WHERE id=?").run(matching.id, s.id)
        return { assessment: 'committed', reason: 'FORMAL_COMMIT_VERIFIED', retained_bytes: bytes, files }
      }
      return { assessment: 'review', reason: 'FORMAL_FACTS_REQUIRE_REVIEW', retained_bytes: bytes, files }
    }
    const run = owner?.run_id ? this.db.prepare('SELECT * FROM runs WHERE id=?').get(owner.run_id) as Row | undefined : undefined
    if (s.runtime_epoch === this.epoch && owner && this.owner(owner.id, s.task_id)) return { assessment: 'pinned', reason: 'LIVE_OWNER', retained_bytes: bytes, files }
    if (!owner || owner.state !== 'ended' || owner.commit_valid || !['not_executed', 'failure', 'cancelled'].includes(owner.result)) return { assessment: 'review', reason: 'OWNER_UNCERTAIN', retained_bytes: bytes, files }
    this.db.prepare("UPDATE staging SET state='invalid' WHERE id=? AND state!='committed'").run(s.id)
    return { assessment: files ? 'candidate' : 'absent', reason: files ? 'GC_DISABLED' : 'NO_FILES', retained_bytes: bytes, files }
  }
  private inspect(stageId: string, attempt = 0): void {
    const s = this.db.prepare('SELECT * FROM staging WHERE id=?').get(stageId) as Row | undefined
    if (!s) return
    let detail: Row, next: string | null = null
    try { detail = this.assess(s) }
    catch (error) {
      const reason = error instanceof ContractError ? error.code : ['EACCES', 'EPERM', 'EIO', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '') ? (error as NodeJS.ErrnoException).code : 'STORAGE_CHECK_FAILED'
      detail = { assessment: 'review', reason, retained_bytes: null }
      const delay = defaults.cleanup.retry_delays_ms[attempt]
      if (delay !== undefined) next = new Date(Date.now() + delay).toISOString()
    }
    const state = detail.assessment === 'review' ? 'failed' : detail.assessment === 'candidate' || detail.assessment === 'pinned' ? 'pending' : 'done'
    this.db.transaction(() => {
      const job = this.db.prepare("SELECT id FROM cleanup_jobs WHERE owner_kind='staging' AND owner_id=?").get(stageId) as Row | undefined
      if (job) this.db.prepare('UPDATE cleanup_jobs SET state=?,attempt=?,next_attempt_at=?,detail_json=? WHERE id=?').run(state, attempt, next, JSON.stringify(detail), job.id)
      else this.db.prepare("INSERT INTO cleanup_jobs VALUES (?,?, 'staging',?,0,?,?,?,?)").run(randomUUID(), s.task_id, s.id, state, attempt, next, JSON.stringify(detail))
    })()
  }
  retry(jobId: string): unknown {
    const job = this.db.prepare("SELECT * FROM cleanup_jobs WHERE id=? AND owner_kind='staging' AND necessary=0").get(jobId) as Row | undefined
    if (!job) throw new ContractError('NOT_FOUND', 'Storage inspection job unavailable')
    this.inspect(job.owner_id); this.maintenanceError = null; this.schedule()
    return { inspected: true, files_deleted: 0, business_replayed: false }
  }
  private schedule(): void {
    clearTimeout(this.timer)
    if (this.closed || this.paused) return
    const first = this.db.prepare("SELECT min(next_attempt_at) AS at FROM cleanup_jobs WHERE owner_kind='staging' AND state='failed' AND next_attempt_at IS NOT NULL").get() as Row
    if (!first.at) return
    this.timer = setTimeout(() => {
      try {
        const jobs = this.db.prepare("SELECT owner_id,attempt FROM cleanup_jobs WHERE owner_kind='staging' AND state='failed' AND next_attempt_at<=? ORDER BY next_attempt_at LIMIT ?").all(now(), defaults.cleanup.reconcile_items) as Row[]
        for (const job of jobs) this.inspect(job.owner_id, job.attempt + 1)
        this.schedule()
      } catch { this.maintenanceError = 'STORAGE_REGISTRATION_FAILED' }
    }, Math.max(0, Date.parse(first.at) - Date.now()))
    this.timer.unref?.()
  }
  status(after = 0): unknown {
    const rows = this.db.prepare("SELECT id,state,attempt,next_attempt_at,detail_json,rowid AS ordinal FROM cleanup_jobs WHERE owner_kind='staging' AND necessary=0 AND rowid>? ORDER BY rowid LIMIT ?").all(after, defaults.cleanup.reconcile_items + 1) as Row[]
    const items = rows.slice(0, defaults.cleanup.reconcile_items).map(row => ({ id: row.id, state: row.state, attempt: row.attempt, next_attempt_at: row.next_attempt_at, ...JSON.parse(row.detail_json) }))
    const summary = this.db.prepare("SELECT count(*) AS total,sum(CASE WHEN json_extract(detail_json,'$.assessment')='candidate' THEN 1 ELSE 0 END) AS candidates,sum(CASE WHEN state='failed' THEN 1 ELSE 0 END) AS reviews,coalesce(sum(json_extract(detail_json,'$.retained_bytes')),0) AS known_bytes,sum(CASE WHEN json_extract(detail_json,'$.retained_bytes') IS NULL THEN 1 ELSE 0 END) AS unknown_sizes FROM cleanup_jobs WHERE owner_kind='staging' AND necessary=0").get()
    return { gc_enabled: false, files_deleted: 0, maintenance_error: this.maintenanceError, summary, items, next_after: rows.length > items.length ? rows[items.length - 1]!.ordinal : null }
  }
  pause(held: boolean): void { this.paused = held; clearTimeout(this.timer); if (!held) this.schedule() }
  close(): void { this.closed = true; clearTimeout(this.timer) }
}
