import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { afterEach, expect, it } from 'vitest'
import type { ArtifactIndex, CompositionScope } from '../../src/shared/contracts.generated'
import { validateRunnerContract } from '../../src/shared/runner-validation'
import { RunnerIndexPages, type ArtifactIndexPage } from '../../src/runtime/runner/index-pages'
import { RUNNER_LIMITS } from '../../src/runtime/runner/limits'

const coreSql = readFileSync(new URL('../../src/shared/contracts/001-core.sql', import.meta.url), 'utf8')
const runnerSql = readFileSync(new URL('../../src/shared/contracts/002-runner.sql', import.meta.url), 'utf8')
const databases: Database.Database[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
const padded = (value: string): string => value.padEnd(128, 'x')
function index(position: number, wide = false): ArtifactIndex {
  const id = (value: string): string => wide ? padded(value) : value
  return { task_id: id('task'), request_id: id('goal'), run_id: id('run'), work_id: id('work'), attempt_id: id('attempt'), intent_revision: 1, artifact_id: id(`artifact-${position}`), artifact_revision: 1, bundle_resource_id: id(`body-${position}`), section_id: id('section'), order_key: id('order'), presentation_kind: 'managed-v1', width_constraint: 'full', interaction_kind: 'none', provenance_ref: { task_id: id('task'), kind: 'record', id: id('record') }, acceptance_state: 'accepted', ...(wide ? { title: '\\'.repeat(256) } : {}) }
}
function sizedIndex(position: number, bytes: number): ArtifactIndex {
  const value = { ...index(position, true), order_key: '\0'.repeat(128), section_id: '\0'.repeat(128), title: '' }
  const remaining = bytes - Buffer.byteLength(JSON.stringify(value))
  value.title = '\0'.repeat(Math.floor(remaining / 6)) + 'x'.repeat(remaining % 6)
  expect(Buffer.byteLength(JSON.stringify(value))).toBe(bytes)
  return value
}
function store(db: Database.Database, value: ArtifactIndex): void {
  db.prepare('INSERT INTO runner_artifacts(task_id,artifact_id,artifact_revision,candidate_id,bundle_resource_id,payload_json) VALUES (?,?,?,?,?,?)').run(value.task_id, value.artifact_id, value.artifact_revision, `candidate-${value.artifact_id}-${value.artifact_revision}`, value.bundle_resource_id, JSON.stringify(value))
}
function addScope(db: Database.Database, task: string, request: string, version = 1): void {
  const value: CompositionScope = { task_id: task, composition_version: version, ...(version > 1 ? { previous_version: version - 1 } : {}), targets: [{ request_id: request, intent_revision: 1, required: true, requirement_ids: ['content'] }], state: 'working', unresolved: [] }
  db.prepare('INSERT INTO runner_scopes(task_id,composition_version,payload_json) VALUES (?,?,?)').run(task, version, JSON.stringify(value))
}
function setup(wide = false) {
  const db = new Database(':memory:'); databases.push(db)
  db.exec(coreSql); db.exec(runnerSql)
  // Seed immutable accepted metadata directly. Ownership and write-side foreign
  // keys are exercised through the real host in the artifact/composition suites.
  db.pragma('foreign_keys=OFF')
  const sample = index(0, wide)
  addScope(db, sample.task_id, sample.request_id)
  return { db, reader: new RunnerIndexPages(db, 'epoch'), task: sample.task_id, request: sample.request_id }
}
function all(first: ArtifactIndexPage, next: (cursor: string) => ArtifactIndexPage): ArtifactIndex[] {
  const result = [...first.items]
  for (let page = first; page.next_cursor;) { page = next(page.next_cursor); result.push(...page.items) }
  return result
}

it('keeps one scope read at its initial watermark while new and superseding indexes arrive', () => {
  const { db, reader, task } = setup()
  for (let position = 0; position < 40; position++) store(db, index(position))
  store(db, { ...index(99), request_id: 'outside-scope' })
  const first = reader.scope(task, 1)
  expect(first.items).toHaveLength(32)
  store(db, index(40)); store(db, { ...index(39), artifact_revision: 2, bundle_resource_id: 'replacement' })
  const fixed = all(first, cursor => reader.scope(task, 1, cursor))
  expect(fixed).toHaveLength(40)
  expect(fixed.at(-1)).toMatchObject({ artifact_id: 'artifact-39', artifact_revision: 1 })
  expect(fixed.some(item => item.artifact_id === 'artifact-40' || item.artifact_id === 'artifact-99')).toBe(false)
  const fresh = all(reader.scope(task, 1), cursor => reader.scope(task, 1, cursor))
  expect(fresh).toHaveLength(41)
  expect(fresh.filter(item => item.artifact_id === 'artifact-39')).toMatchObject([{ artifact_revision: 2 }])
})

it('binds opaque cursors to the exact Task, scope, reader and runtime epoch', () => {
  const { db, reader, task, request } = setup()
  for (let position = 0; position < 33; position++) store(db, index(position))
  const cursor = reader.scope(task, 1).next_cursor!
  addScope(db, task, request, 2); addScope(db, 'other', request)
  expect(() => reader.scope(task, 2, cursor)).toThrow(/cursor expired/)
  expect(() => reader.scope('other', 1, cursor)).toThrow(/cursor expired/)
  expect(() => reader.scope(task, 1, 'idx_00000000-0000-0000-0000-000000000000')).toThrow(/cursor expired/)
  expect(() => new RunnerIndexPages(db, 'epoch').scope(task, 1, cursor)).toThrow(/cursor expired/)
  expect(() => new RunnerIndexPages(db, 'new-epoch').scope(task, 1, cursor)).toThrow(/cursor expired/)
  expect(reader.scope(task, 1, cursor).items).toHaveLength(1)
})

it('counts JSON escaping, the full envelope and the cursor within the page byte limit', () => {
  const { db, reader, task } = setup(true)
  for (let position = 0; position < 40; position++) store(db, validateRunnerContract('runner_artifact_index', index(position, true)))
  const first = reader.scope(task, 1), sizes: number[] = []
  const result = all(first, cursor => {
    const page = reader.scope(task, 1, cursor)
    sizes.push(Buffer.byteLength(JSON.stringify(page)))
    return page
  })
  expect(first.items.length).toBeLessThan(RUNNER_LIMITS.index.page_items)
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(RUNNER_LIMITS.index.page_bytes)
  expect(sizes.every(size => size <= RUNNER_LIMITS.index.page_bytes)).toBe(true)
  expect(result).toHaveLength(40)
})

it('accepts an exact 4 KiB index and rejects a larger row without returning its value', () => {
  const { db, reader, task } = setup(true)
  const exact = validateRunnerContract('runner_artifact_index', sizedIndex(0, 4096))
  store(db, exact)
  expect(reader.scope(task, 1).items).toEqual([exact])
  store(db, sizedIndex(1, 4097))
  expect(() => reader.scope(task, 1)).toThrow(/bounded item or page size/)
})

it('rejects unknown or oversized fields without including body text in its error', () => {
  const { db, reader, task } = setup()
  store(db, { ...index(0), body: 'private-body-marker' } as ArtifactIndex)
  expect(() => reader.scope(task, 1)).toThrow('Invalid runner_artifact_index structure')
  try { reader.scope(task, 1) } catch (error) { expect(String(error)).not.toContain('private-body-marker') }
})

it('pages a batch through its exact versions and ignores later scope additions', () => {
  const { db, reader, task, request } = setup(true), indexes: ArtifactIndex[] = []
  for (let position = 0; position < 16; position++) { const value = sizedIndex(position, 4096); store(db, value); indexes.push(value) }
  const batch = validateRunnerContract('runner_composition_batch', { task_id: task, batch_id: 'batch', composition_version: 1, run_id: 'composition', trigger_request_id: request, model_config_id: 'model', model_config_revision: 1, state: 'prepared', targets: [{ task_id: task, request_id: request, intent_revision: 1 }], indexes: indexes.map(({ artifact_id, artifact_revision }) => ({ task_id: task, artifact_id, artifact_revision })), sections: [{ section_id: indexes[0]!.section_id, order_key: indexes[0]!.order_key, position_revision: 1 }] })
  db.prepare('INSERT INTO runner_batches(batch_id,task_id,composition_version,payload_json) VALUES (?,?,?,?)').run('batch', task, 1, JSON.stringify(batch))
  const first = reader.batch(task, 'batch')
  expect(first.items).toHaveLength(15)
  store(db, index(100, true)); store(db, { ...indexes[15]!, artifact_revision: 2 })
  const fixed = all(first, cursor => reader.batch(task, 'batch', cursor))
  expect(fixed).toEqual(indexes)
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(RUNNER_LIMITS.index.page_bytes)
  expect(() => reader.scope(task, 1, first.next_cursor!)).toThrow(/cursor expired/)
})
