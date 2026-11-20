import type Database from 'better-sqlite3'
import { ContractError } from '../../shared/validation'
import { readBusinessSchema } from '../schema-upgrade'
import { assertRunnerId } from './limits'

export interface RunnerResourceReference {
  task_id: string
  resource_id: string
}

const resourceFields = new Set(['bundle_resource_id', 'source_bundle_resource_id', 'published_bundle_resource_id', 'assembled_bundle_resource_id'])
const metadataTables = ['runner_work', 'runner_attempts', 'runner_artifacts', 'runner_work_outputs', 'runner_contribution_inventories', 'runner_batches', 'runner_publications', 'runner_surface_history', 'runner_manifests'] as const
const chapterMetadataTables = ['runner_chapter_manifests', 'runner_chapter_updates', 'runner_chapter_proposals', 'runner_chapter_inheritance', 'runner_chapter_publications', 'runner_chapter_publication_evidence', 'runner_chapter_assemblies'] as const
const contentMetadataTables = ['runner_content_trees'] as const
function fail(): never { throw new ContractError('RUNNER_RESOURCE_FACTS_INVALID', 'Runner resource dependencies require inspection; resources are retained') }

// This projection is installed with the owning business record. It never grants
// deletion authority and is retained until controlled Task deletion.
export function registerRunnerResources(db: Database.Database, taskId: string, sourceKind: string, sourceId: string, resourceIds: readonly string[]): void {
  if (!db.inTransaction) throw new ContractError('RUNNER_TRANSACTION_REQUIRED', 'Resource references must join their owning installation transaction')
  assertRunnerId(taskId, 'task_id')
  if (!/^runner_[a-z_]+$/.test(sourceKind) || typeof sourceId !== 'string' || !sourceId) fail()
  const insert = db.prepare("INSERT OR IGNORE INTO object_references(task_id,source_kind,source_id,name,target_kind,target_id,expected_revision,protects_resource,blocks_remove) VALUES (?,?,?,?,'resource',?,NULL,1,0)")
  for (const resourceId of new Set(resourceIds)) {
    assertRunnerId(resourceId, 'resource_id')
    if (!db.prepare('SELECT 1 FROM resources r JOIN task_resources t ON t.resource_id=r.id WHERE t.task_id=? AND r.id=?').get(taskId, resourceId)) fail()
    const existing = db.prepare('SELECT task_id,target_kind,target_id,protects_resource FROM object_references WHERE source_kind=? AND source_id=? AND name=?').get(sourceKind, sourceId, resourceId) as { task_id: string; target_kind: string; target_id: string; protects_resource: number } | undefined
    if (existing && (existing.task_id !== taskId || existing.target_kind !== 'resource' || existing.target_id !== resourceId || existing.protects_resource !== 1)) fail()
    insert.run(taskId, sourceKind, sourceId, resourceId, resourceId)
  }
}

// Frozen metadata is authoritative even if its reference projection is missing.
// Read both business versions without requiring runner tables in a v1 replica.
export function runnerResourceReferences(db: Database.Database): RunnerResourceReference[] {
  if (readBusinessSchema(db) === 1) return []
  const references = new Map<string, RunnerResourceReference>()
  const collect = (taskId: string, raw: unknown): void => {
    const pending: unknown[] = [raw]
    const add = (value: unknown): void => {
      if (typeof value !== 'string' || !value) fail()
      references.set(JSON.stringify([taskId, value]), { task_id: taskId, resource_id: value as string })
    }
    while (pending.length) {
      const value = pending.pop()
      if (!value || typeof value !== 'object') continue
      if (Array.isArray(value)) { for (const item of value) pending.push(item); continue }
      const object = value as Record<string, unknown>
      if (object.kind === 'resource') add(object.resource_id ?? object.id)
      for (const [key, item] of Object.entries(object)) {
        if (resourceFields.has(key)) add(item)
        else if (key === 'source_bundle_resource_ids') {
          if (!Array.isArray(item)) fail()
          for (const resource of item) add(resource)
        }
        else if (item && typeof item === 'object') pending.push(item)
      }
    }
  }
  try {
    for (const table of metadataTables) {
      for (const row of db.prepare(`SELECT task_id,payload_json FROM ${table}`).iterate() as Iterable<{ task_id: string; payload_json: string }>) collect(row.task_id, JSON.parse(row.payload_json))
    }
    // Older v2 recovery copies predate chapter metadata and remain readable.
    const chapterTables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'runner_chapter_%'").all() as { name: string }[]).map(row => row.name))
    for (const table of chapterMetadataTables) if (chapterTables.has(table)) {
      for (const row of db.prepare(`SELECT task_id,payload_json FROM ${table}`).iterate() as Iterable<{ task_id: string; payload_json: string }>) collect(row.task_id, JSON.parse(row.payload_json))
    }
    const contentTables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'runner_content_%'").all() as { name: string }[]).map(row => row.name))
    for (const table of contentMetadataTables) if (contentTables.has(table)) {
      for (const row of db.prepare(`SELECT task_id,payload_json FROM ${table}`).iterate() as Iterable<{ task_id: string; payload_json: string }>) collect(row.task_id, JSON.parse(row.payload_json))
      for (const row of db.prepare(`SELECT task_id,bundle_resource_id AS resource_id FROM ${table}`).iterate() as Iterable<RunnerResourceReference>) {
        if (typeof row.resource_id !== 'string' || !row.resource_id) fail()
        references.set(JSON.stringify([row.task_id, row.resource_id]), row)
      }
    }
    for (const row of db.prepare("SELECT task_id,payload_json FROM runner_candidates WHERE json_extract(result_json,'$.state')='accepted'").iterate() as Iterable<{ task_id: string; payload_json: string }>) collect(row.task_id, JSON.parse(row.payload_json))
    // Columns remain authoritative when a malformed payload omits a field.
    for (const row of db.prepare('SELECT task_id,bundle_resource_id AS resource_id FROM runner_artifacts UNION SELECT task_id,source_bundle_resource_id FROM runner_view_mappings UNION SELECT task_id,published_bundle_resource_id FROM runner_view_mappings').iterate() as Iterable<RunnerResourceReference>) {
      if (typeof row.resource_id !== 'string' || !row.resource_id) fail()
      references.set(JSON.stringify([row.task_id, row.resource_id]), row)
    }
    const chapterResourceColumns = [['runner_chapter_resources', 'resource_id'], ['runner_chapter_manifests', 'bundle_resource_id'], ['runner_chapter_proposals', 'bundle_resource_id']] as const
    for (const [table, column] of chapterResourceColumns) if (chapterTables.has(table)) {
      for (const row of db.prepare(`SELECT task_id,${column} AS resource_id FROM ${table}`).iterate() as Iterable<RunnerResourceReference>) {
        if (typeof row.resource_id !== 'string' || !row.resource_id) fail()
        references.set(JSON.stringify([row.task_id, row.resource_id]), row)
      }
    }
    return [...references.values()]
  } catch { return fail() }
}

export function validateRunnerResourceReferences(db: Database.Database): void {
  for (const reference of runnerResourceReferences(db)) {
    if (!db.prepare('SELECT 1 FROM resources r JOIN task_resources t ON t.resource_id=r.id WHERE t.task_id=? AND r.id=?').get(reference.task_id, reference.resource_id)) fail()
  }
}
