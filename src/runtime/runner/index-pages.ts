import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { ArtifactIndex } from '../../shared/contracts.generated'
import { validateRunnerContract } from '../../shared/runner-validation'
import { ContractError } from '../../shared/validation'
import { assertIndexBytes, assertRunnerId, RUNNER_LIMITS } from './limits'

export interface ArtifactIndexPage {
  task_id: string
  composition_version: number
  batch_id?: string
  items: ArtifactIndex[]
  next_cursor: string | null
}
type Branch = { kind: 'scope'; composition_version: number } | { kind: 'batch'; composition_version: number; batch_id: string }
type Cursor = { task_id: string; epoch: string; branch: Branch; watermark: number; after: number }
type IndexRow = { position: number; bytes: number | null; payload_json: string | null }
function expired(): never { throw new ContractError('INVALID_CURSOR', 'Index cursor expired or belongs to another Task, epoch or fixed read scope') }
function missing(): never { throw new ContractError('RUNNER_NOT_FOUND', 'Fixed index read scope does not exist') }
function overflow(): never { throw new ContractError('RUNNER_LIMIT_EXCEEDED', 'Index metadata exceeds its bounded item or page size') }

// Cursors are opaque host tokens. Their immutable scope and watermark stay in
// this epoch's bounded cache; restarting the host requires a new index read.
export class RunnerIndexPages {
  private readonly cursors = new Map<string, Cursor>()
  constructor(private readonly db: Database.Database, private readonly epoch: string) { assertRunnerId(epoch, 'runtime_epoch') }

  scope(taskId: string, compositionVersion: number, cursor?: string): ArtifactIndexPage {
    assertRunnerId(taskId, 'task_id')
    if (!Number.isSafeInteger(compositionVersion) || compositionVersion < 1) expired()
    return this.db.transaction(() => {
      if (!this.db.prepare('SELECT 1 FROM runner_scopes WHERE task_id=? AND composition_version=?').get(taskId, compositionVersion)) missing()
      return this.page(taskId, { kind: 'scope', composition_version: compositionVersion }, cursor)
    })()
  }

  batch(taskId: string, batchId: string, cursor?: string): ArtifactIndexPage {
    assertRunnerId(taskId, 'task_id'); assertRunnerId(batchId, 'batch_id')
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT composition_version FROM runner_batches WHERE task_id=? AND batch_id=?').get(taskId, batchId) as { composition_version: number } | undefined
      if (!row) missing()
      return this.page(taskId, { kind: 'batch', composition_version: row.composition_version, batch_id: batchId }, cursor)
    })()
  }

  private remember(value: Cursor): string {
    while (this.cursors.size >= 1024) this.cursors.delete(this.cursors.keys().next().value!)
    const token = `idx_${randomUUID()}`
    this.cursors.set(token, value)
    return token
  }

  private page(taskId: string, branch: Branch, token?: string): ArtifactIndexPage {
    let selected: Cursor
    if (token !== undefined) {
      if (typeof token !== 'string' || token.length !== 40) expired()
      const stored = this.cursors.get(token)
      if (!stored || stored.task_id !== taskId || stored.epoch !== this.epoch || JSON.stringify(stored.branch) !== JSON.stringify(branch)) expired()
      selected = stored
    } else {
      const row = this.db.prepare('SELECT COALESCE(MAX(rowid),0) watermark FROM runner_artifacts WHERE task_id=?').get(taskId) as { watermark: number }
      selected = { task_id: taskId, epoch: this.epoch, branch, watermark: row.watermark, after: 0 }
    }
    const maxBytes = RUNNER_LIMITS.index.item_bytes
    const payload = `length(CAST(a.payload_json AS BLOB)) bytes,CASE WHEN length(CAST(a.payload_json AS BLOB))<=${maxBytes} THEN a.payload_json END payload_json`
    const rows = branch.kind === 'scope'
      ? this.db.prepare(`SELECT a.rowid position,${payload} FROM runner_artifacts a JOIN runner_scopes s ON s.task_id=a.task_id AND s.composition_version=? WHERE a.task_id=? AND a.rowid>? AND a.rowid<=? AND EXISTS (SELECT 1 FROM json_each(s.payload_json,'$.targets') t WHERE json_extract(t.value,'$.request_id')=json_extract(a.payload_json,'$.request_id') AND json_extract(t.value,'$.intent_revision')=json_extract(a.payload_json,'$.intent_revision')) AND NOT EXISTS (SELECT 1 FROM runner_artifacts newer WHERE newer.task_id=a.task_id AND newer.artifact_id=a.artifact_id AND newer.artifact_revision>a.artifact_revision AND newer.rowid<=?) ORDER BY a.rowid LIMIT ?`).all(branch.composition_version, taskId, selected.after, selected.watermark, selected.watermark, RUNNER_LIMITS.index.page_items + 1) as IndexRow[]
      : this.db.prepare(`SELECT CAST(i.key AS INTEGER)+1 position,${payload} FROM runner_batches b,json_each(b.payload_json,'$.indexes') i LEFT JOIN runner_artifacts a ON a.task_id=b.task_id AND a.artifact_id=json_extract(i.value,'$.artifact_id') AND a.artifact_revision=json_extract(i.value,'$.artifact_revision') WHERE b.task_id=? AND b.batch_id=? AND CAST(i.key AS INTEGER)>=? ORDER BY CAST(i.key AS INTEGER) LIMIT ?`).all(taskId, branch.batch_id, selected.after, RUNNER_LIMITS.index.page_items + 1) as IndexRow[]
    const page: ArtifactIndexPage = { task_id: taskId, composition_version: branch.composition_version, ...(branch.kind === 'batch' ? { batch_id: branch.batch_id } : {}), items: [], next_cursor: null }
    let after = selected.after
    for (let position = 0; position < rows.length && page.items.length < RUNNER_LIMITS.index.page_items; position++) {
      const row = rows[position]!
      if (row.bytes === null || row.payload_json === null) overflow()
      const item = validateRunnerContract('runner_artifact_index', JSON.parse(row.payload_json))
      if (item.task_id !== taskId) throw new ContractError('RUNNER_OWNERSHIP_INVALID', 'Index does not belong to the fixed Task')
      assertIndexBytes(item)
      const candidate = { ...page, items: [...page.items, item], next_cursor: position + 1 < rows.length ? 'x'.repeat(40) : null }
      if (Buffer.byteLength(JSON.stringify(candidate)) > RUNNER_LIMITS.index.page_bytes) break
      page.items.push(item); after = row.position
    }
    if (page.items.length < rows.length) {
      if (page.items.length === 0) overflow()
      page.next_cursor = this.remember({ ...selected, after })
    }
    return page
  }
}
