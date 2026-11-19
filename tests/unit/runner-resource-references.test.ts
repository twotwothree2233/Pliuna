import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, it } from 'vitest'
import coreSql from '../../src/shared/contracts/001-core.sql?raw'
import runnerSql from '../../src/shared/contracts/002-runner.sql?raw'
import { upgradeCandidate } from '../../src/runtime/schema-upgrade'
import { registerRunnerResources, runnerResourceReferences, validateRunnerResourceReferences } from '../../src/runtime/runner/resource-references'
import { ChapterState } from '../../src/runtime/runner/chapter-state'

let db: Database.Database
const task = 'task', other = 'other-task'
beforeEach(() => {
  db = new Database(':memory:'); db.exec(coreSql); upgradeCandidate(db)
  for (const id of [task, other]) db.prepare("INSERT INTO tasks(id,title,state,revision) VALUES (?,?,'active',1)").run(id, id)
})
afterEach(() => db.close())
function resource(id: string, owner = task): void {
  db.prepare("INSERT INTO resources VALUES (?,?,?,0,'application/json',?,'now')").run(id, id, 'a'.repeat(64), id)
  db.prepare('INSERT INTO task_resources VALUES (?,?)').run(owner, id)
}
function history(id: string, revision: number, payload: unknown): void {
  const action = `${id}-action`
  db.prepare("INSERT INTO actions(id,task_id,kind,state,result,source_json,request_json,commit_valid,created_at) VALUES (?,?,'mutation','ended','success','{}','{}',0,'now')").run(action, task)
  db.prepare('INSERT INTO runner_surface_history VALUES (?,?,?,?,?,?)').run(id, task, 'surface', revision, action, JSON.stringify(payload))
}

it('installs task-associated protection with its owning transaction and retries idempotently', () => {
  resource('bundle')
  expect(() => registerRunnerResources(db, task, 'runner_artifact', 'artifact', ['bundle'])).toThrow(/installation transaction/)
  db.transaction(() => {
    registerRunnerResources(db, task, 'runner_artifact', 'artifact', ['bundle', 'bundle'])
    registerRunnerResources(db, task, 'runner_artifact', 'artifact', ['bundle'])
  })()
  expect(db.prepare('SELECT * FROM object_references').all()).toEqual([{
    task_id: task, source_kind: 'runner_artifact', source_id: 'artifact', name: 'bundle', target_kind: 'resource', target_id: 'bundle', expected_revision: null, protects_resource: 1, blocks_remove: 0
  }])
})

it('rejects foreign resources and rolls back the complete business installation', () => {
  resource('local'); resource('foreign', other)
  expect(db.transaction(() => {
    history('history', 1, { bundle_resource_id: 'local' })
    registerRunnerResources(db, task, 'runner_surface_history', 'history', ['local', 'foreign'])
  })).toThrow(/dependencies require inspection/)
  expect(db.prepare('SELECT * FROM object_references').all()).toEqual([])
  expect(db.prepare('SELECT * FROM runner_surface_history').all()).toEqual([])
})

it('does not redirect an existing source identity to another task', () => {
  resource('shared'); db.prepare('INSERT INTO task_resources VALUES (?,?)').run(other, 'shared')
  db.transaction(() => registerRunnerResources(db, task, 'runner_artifact', 'artifact', ['shared']))()
  expect(db.transaction(() => registerRunnerResources(db, other, 'runner_artifact', 'artifact', ['shared']))).toThrow(/dependencies require inspection/)
  expect(db.prepare('SELECT task_id FROM object_references').all()).toEqual([{ task_id: task }])
})

it('keeps every frozen resource after pointer changes even without current Views or projected references', () => {
  for (const id of ['old', 'current', 'source', 'published', 'evidence']) resource(id)
  history('old-history', 1, { views: [{ bundle_resource_id: 'old' }], evidence: { kind: 'resource', id: 'evidence' } })
  history('current-history', 2, { views: [{ bundle_resource_id: 'current' }], entries: [{ source_bundle_resource_id: 'source', published_bundle_resource_id: 'published' }] })
  expect(db.prepare('SELECT * FROM views').all()).toEqual([])
  expect(db.prepare('SELECT * FROM object_references').all()).toEqual([])
  expect(new Set(runnerResourceReferences(db).map(reference => reference.resource_id))).toEqual(new Set(['old', 'current', 'source', 'published', 'evidence']))
  expect(() => validateRunnerResourceReferences(db)).not.toThrow()
  db.prepare("DELETE FROM task_resources WHERE resource_id='old'").run()
  expect(() => validateRunnerResourceReferences(db)).toThrow(/dependencies require inspection/)
})

it('includes prepared publication resources before a Surface is installed', () => {
  resource('source'); resource('published')
  db.prepare("INSERT INTO runner_scopes VALUES (?,1,'{}')").run(task)
  db.prepare("INSERT INTO runner_batches VALUES ('batch',?,1,'{}')").run(task)
  db.prepare("INSERT INTO runner_publications VALUES ('operation',?,'batch',NULL,'prepared',?,NULL)").run(task, JSON.stringify({ preparation: { resources: [{ source_bundle_resource_id: 'source', published_bundle_resource_id: 'published' }] } }))
  expect(new Set(runnerResourceReferences(db).map(reference => reference.resource_id))).toEqual(new Set(['source', 'published']))
})

it('installs chapter protection in the common reference graph atomically', () => {
  resource('chapter'); resource('foreign', other)
  const chapters = new ChapterState(db)
  expect(() => chapters.protect(task, 'publication', 'operation', ['chapter', 'foreign'])).toThrow(/dependencies require inspection/)
  expect(db.prepare('SELECT * FROM runner_chapter_resources').all()).toEqual([])
  expect(db.prepare('SELECT * FROM object_references').all()).toEqual([])
  chapters.protect(task, 'publication', 'operation', ['chapter', 'chapter'])
  chapters.protect(task, 'publication', 'operation', ['chapter'])
  expect(db.prepare('SELECT task_id,target_id,protects_resource FROM object_references').all()).toEqual([{ task_id: task, target_id: 'chapter', protects_resource: 1 }])
  expect(db.prepare('SELECT resource_id FROM runner_chapter_resources').all()).toEqual([{ resource_id: 'chapter' }])
})

it('retains chapter baselines, proposals, assembly inputs and detached evidence without their projections', () => {
  for (const id of ['baseline', 'candidate', 'kept', 'assembled', 'source', 'evidence']) resource(id)
  db.prepare("INSERT INTO requests VALUES ('goal',?,'started','{}','{}','time')").run(task)
  db.prepare("INSERT INTO runner_chapter_updates VALUES (?,'update','input','goal',1,'view','unknown','{}','{}','time')").run(task)
  db.prepare("INSERT INTO runner_chapter_manifests VALUES (?,'view',1,1,'baseline','{}','time')").run(task)
  db.prepare("INSERT INTO runner_chapter_proposals VALUES (?,'proposal','update','candidate','{}')").run(task)
  db.prepare("INSERT INTO runner_chapter_inheritance VALUES (?,'update','region',?)").run(task, JSON.stringify({ source_bundle_resource_id: 'kept' }))
  db.prepare("INSERT INTO runner_chapter_publications VALUES (?,'operation','update',NULL,'unknown',?,NULL)").run(task, JSON.stringify({ assembled_bundle_resource_id: 'assembled', source_bundle_resource_ids: ['source'] }))
  new ChapterState(db).protect(task, 'publication', 'operation', ['evidence'])
  db.prepare('DELETE FROM object_references').run()
  expect(db.prepare('SELECT * FROM views').all()).toEqual([])
  expect(new Set(runnerResourceReferences(db).map(reference => reference.resource_id))).toEqual(new Set(['baseline', 'candidate', 'kept', 'assembled', 'source', 'evidence']))
  expect(() => validateRunnerResourceReferences(db)).not.toThrow()
  db.prepare("DELETE FROM task_resources WHERE resource_id='source'").run()
  expect(() => validateRunnerResourceReferences(db)).toThrow(/dependencies require inspection/)
})

it('protects resource dependencies that use resource_id and provenance that uses id', () => {
  resource('dependency'); resource('provenance')
  history('history', 1, { dependencies: [{ kind: 'resource', task_id: task, resource_id: 'dependency' }], provenance_ref: { kind: 'resource', task_id: task, id: 'provenance' } })
  expect(new Set(runnerResourceReferences(db).map(reference => reference.resource_id))).toEqual(new Set(['dependency', 'provenance']))
  expect(() => validateRunnerResourceReferences(db)).not.toThrow()
})

it('does not make rejected or cross-task candidates into resource protection roots', () => {
  db.prepare("INSERT INTO runner_candidates VALUES ('candidate',?,'artifact',?,?)").run(task, JSON.stringify({ bundle_resource_id: 'foreign-or-missing' }), JSON.stringify({ state: 'rejected', code: 'RUNNER_RESOURCE_INVALID' }))
  expect(runnerResourceReferences(db)).toEqual([])
  expect(() => validateRunnerResourceReferences(db)).not.toThrow()
})

it('closes recovery validation on malformed resource facts without exposing payloads', () => {
  history('history', 1, { source_bundle_resource_id: { body: 'private body' } })
  expect(() => runnerResourceReferences(db)).toThrow(/^Runner resource dependencies require inspection; resources are retained$/)
})

it('reads v1 replicas using their own format and requires no runner tables', () => {
  const legacy = new Database(':memory:')
  try {
    legacy.exec(coreSql)
    expect(runnerResourceReferences(legacy)).toEqual([])
    expect(() => validateRunnerResourceReferences(legacy)).not.toThrow()
  } finally { legacy.close() }
})

it('reads older v2 replicas before chapter tables have been installed', () => {
  const older = new Database(':memory:')
  try {
    older.exec(coreSql); older.exec(runnerSql); older.exec('UPDATE schema_version SET version=2')
    expect(runnerResourceReferences(older)).toEqual([])
    expect(() => validateRunnerResourceReferences(older)).not.toThrow()
  } finally { older.close() }
})
