import type Database from 'better-sqlite3'
import defaults from '../shared/contracts/development-defaults.json'
import { ContractError } from '../shared/validation'
import { resourceBody } from './resources'
import type { ExportResource } from './export-control'

type Row = Record<string, any>
type Target = { kind: string; id: string; expected_revision?: number }
export type Evidence = { version: 1; sources: Row[] }
const fail = (code: string, message: string): never => { throw new ContractError(code, message) }

export function captureEvidence(db: Database.Database, root: string, taskId: string, targets: Target[] = [], verifyFiles = true): Evidence {
  if (targets.length > defaults.evidence.max_sources) fail('SNAPSHOT_LIMIT', 'Too many evidence sources')
  const seen = new Set<string>()
  const sources = targets.map(target => {
    if (target.kind !== 'task_data' || !Number.isInteger(target.expected_revision) || target.expected_revision! < 1) fail('INVALID_SNAPSHOT', 'Evidence requires task_data with exact expected_revision')
    if (seen.has(target.id)) fail('INVALID_SNAPSHOT', 'Duplicate evidence source')
    seen.add(target.id)
    const row = db.prepare('SELECT * FROM task_data WHERE id=? AND task_id=?').get(target.id, taskId) as Row | undefined
    if (!row) fail('SNAPSHOT_SOURCE_MISSING', 'Evidence source unavailable in this task')
    if (row!.revision !== target.expected_revision) fail('VERSION_CONFLICT', 'Evidence source revision changed; submit a new action')
    const references = JSON.parse(row!.references_json)
    // Mutable references remain declarations. Only directly referenced immutable files are protected.
    const resources = references.filter((ref: Row) => ref.target.kind === 'resource').map((ref: Row) => {
      const resource = db.prepare('SELECT r.* FROM resources r JOIN task_resources t ON t.resource_id=r.id WHERE r.id=? AND t.task_id=?').get(ref.target.id, taskId) as Row | undefined
      if (!resource) fail('RESOURCE_MISSING', 'Evidence resource unavailable in this task')
      if (verifyFiles) resourceBody(root, resource as Parameters<typeof resourceBody>[1])
      return { id: resource!.id, sha256: resource!.sha256, byte_length: resource!.byte_length, media_type: resource!.media_type, display_name: resource!.display_name }
    })
    return { kind: 'task_data', id: row!.id, revision: row!.revision, schema: JSON.parse(row!.schema_json), value: JSON.parse(row!.value_json), references, resources }
  })
  const evidence: Evidence = { version: 1, sources }
  if (Buffer.byteLength(JSON.stringify(evidence)) > defaults.evidence.snapshot_bytes) fail('SNAPSHOT_LIMIT', 'Evidence snapshot exceeds byte limit; reduce declared sources')
  return evidence
}

export function checkEvidence(db: Database.Database, root: string, taskId: string, evidence: Evidence, verifyFiles = true): void {
  const current = captureEvidence(db, root, taskId, evidence.sources.map(source => ({ kind: 'task_data', id: source.id, expected_revision: source.revision })), verifyFiles)
  if (JSON.stringify(current) !== JSON.stringify(evidence)) fail('VERSION_CONFLICT', 'Evidence content changed; submit a new action')
}

export function saveHistory(db: Database.Database, historyId: string, taskId: string, viewId: string, revision: number, bundleId: string, initial: unknown, evidence: Evidence, directResources: ExportResource[] = []): void {
  db.prepare('INSERT INTO view_history VALUES (?,?,?,?,?,?)').run(historyId, taskId, viewId, revision, bundleId, JSON.stringify({ initial, evidence, ...(directResources.length ? { resources: directResources } : {}) }))
  const resources = new Set<string>([bundleId, ...directResources.map(r => r.id), ...evidence.sources.flatMap(source => source.resources.map((resource: Row) => resource.id))])
  for (const resourceId of resources) db.prepare("INSERT INTO object_references VALUES (?,'view_history',?,?,'resource',?,NULL,1,0)").run(taskId, historyId, resourceId, resourceId)
}

export function historyValue(db: Database.Database, root: string, row: Row): Row {
  const saved = JSON.parse(row.evidence_snapshot_json)
  const evidence: Evidence = saved.evidence ?? { version: 1, sources: [] }
  const direct: ExportResource[] = saved.resources ?? []
  const frozenResources = new Map<string, Row>([...direct.map((r): [string, Row] => [r.id, r]), ...evidence.sources.flatMap(source => (source.resources ?? []).map((resource: Row): [string, Row] => [resource.id, resource]))])
  const ids = new Set<string>([row.bundle_resource_id, ...direct.map(r => r.id), ...evidence.sources.flatMap(source => (source.resources ?? []).map((resource: Row) => resource.id))])
  const resource_status = [...ids].map(id => {
    const resource = db.prepare('SELECT r.* FROM resources r JOIN task_resources t ON t.resource_id=r.id WHERE r.id=? AND t.task_id=?').get(id, row.task_id) as Row | undefined
    try {
      if (!resource) fail('RESOURCE_MISSING', 'Historical resource unavailable')
      const frozen = frozenResources.get(id)
      if (frozen && (frozen.sha256 !== resource!.sha256 || frozen.byte_length !== resource!.byte_length || frozen.media_type !== resource!.media_type)) fail('RESOURCE_CORRUPT', 'Historical resource metadata changed')
      resourceBody(root, resource as Parameters<typeof resourceBody>[1])
      return { id, integrity: 'verified' }
    } catch (error) {
      if (!(error instanceof ContractError)) throw error
      return { id, integrity: 'unavailable', reason: error.code }
    }
  })
  return { id: row.id, view_id: row.view_id, revision: row.view_revision, bundle_resource_id: row.bundle_resource_id, initial: saved.initial, evidence, resource_status, notice: 'Saved evidence is not verified truth; mutable references are not recursively frozen.' }
}
