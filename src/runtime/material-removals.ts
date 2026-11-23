import type Database from 'better-sqlite3'

// A removal changes the active library, while the original association remains
// readable by ID for existing requests, provenance and published content.
export function materialRemoved(task: string, resource: string): string {
  return `EXISTS (SELECT 1 FROM records removal WHERE removal.task_id=${task} AND removal.kind='material.removed' AND json_extract(removal.payload_json,'$.resource_id')=${resource})`
}

export function isMaterialRemoved(db: Database.Database, task: string, resource: string): boolean {
  return db.prepare(`SELECT ${materialRemoved('?', '?')}`).pluck().get(task, resource) === 1
}
