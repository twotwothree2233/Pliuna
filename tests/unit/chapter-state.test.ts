import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { ChapterState, installChapterSchema } from '../../src/runtime/runner/chapter-state'
import { chapterManifest, chapterProposal, chapterPublication, chapterSource, chapterUpdate } from '../helpers/chapters'

const core = readFileSync(new URL('../../src/shared/contracts/001-core.sql', import.meta.url), 'utf8')
const runner = readFileSync(new URL('../../src/shared/contracts/002-runner.sql', import.meta.url), 'utf8')
const databases: Database.Database[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
function setup() {
  const db = new Database(':memory:'); databases.push(db); db.pragma('foreign_keys=ON'); db.exec(core); db.exec(runner)
  db.exec("INSERT INTO tasks(id,title,state,revision) VALUES ('task','Task','active',1); INSERT INTO requests VALUES ('goal','task','started','{}','{}','time'); INSERT INTO records VALUES ('record','task',1,'message.user','{}','time'); INSERT INTO runner_inputs VALUES ('input','task','record','request','{}','time')")
  const goal = { task_id: 'task', request_id: 'goal', intent_revision: 1, input_event_id: 'input', state: 'active', requirements: [] }
  db.prepare('INSERT INTO runner_goal_revisions VALUES (?,?,?,?,?)').run('task', 'goal', 1, 'input', JSON.stringify(goal)); db.exec("INSERT INTO runner_goal_heads VALUES ('task','goal',1)")
  for (const id of ['original', 'candidate', 'assembled', 'published-2']) {
    db.prepare("INSERT INTO resources VALUES (?,?,'fixture',0,'application/json','Body','time')").run(id, id)
    db.prepare("INSERT INTO task_resources VALUES ('task',?)").run(id)
  }
  db.exec("INSERT INTO surfaces VALUES ('surface','task',1,'{}'); INSERT INTO views(id,surface_id,revision,bundle_resource_id,state_revision,draft_json,compatibility_version) VALUES ('view','surface',1,'original',1,'{}','v1')")
  const state = new ChapterState(db); state.installManifest(chapterManifest(), null)
  return { db, state }
}

describe('durable chapter update state', () => {
  it('upgrades an existing runner database idempotently without inventing prior update ownership', () => {
    const { db } = setup()
    db.exec("INSERT INTO runs(id,task_id,request_id,state,runtime_epoch,limits_json,budget_json,created_at) VALUES ('old','task','goal','completed','epoch','{}','{}','time')")
    installChapterSchema(db); installChapterSchema(db)
    expect(db.prepare("SELECT chapter_update_id FROM runs WHERE id='old'").get()).toEqual({ chapter_update_id: null })
    expect(db.prepare("SELECT COUNT(*) n FROM runner_chapter_updates").get()).toEqual({ n: 0 })
    expect(db.pragma('foreign_key_check')).toEqual([])
  })
  it('permits distinct local Runs for the same goal while retaining a unique ordinary Run', () => {
    const { db } = setup()
    const insert = db.prepare("INSERT INTO runs(id,task_id,request_id,state,runtime_epoch,limits_json,budget_json,created_at,chapter_update_id) VALUES (?,'task','goal','running','epoch','{}','{}','time',?)")
    insert.run('ordinary', null); insert.run('a', 'update-a'); insert.run('b', 'update-b')
    expect(() => insert.run('duplicate-a', 'update-a')).toThrow()
    expect(() => insert.run('duplicate-ordinary', null)).toThrow()
  })
  it('keeps exact input identity and isolates independent chapter intents', () => {
    const { state } = setup()
    const a = state.start(chapterUpdate()), b = state.start(chapterUpdate('update-b', ['b']))
    expect(state.start(chapterUpdate())).toEqual(a)
    expect(state.assertCurrent('task', a.update_id)).toEqual(a)
    expect(state.assertCurrent('task', b.update_id)).toEqual(b)
    expect(() => state.start({ ...chapterUpdate(), text: 'different' })).toThrow()
    const next = state.start(chapterUpdate('next-a', ['a']))
    expect(next.region_intents).toEqual([{ region_id: 'a', intent_revision: 2 }])
    expect(next.previous_update_ids).toEqual(['update-a'])
    expect(state.update('task', 'update-a')!.state).toBe('superseded')
    expect(() => state.assertCurrent('task', 'update-a')).toThrow()
    expect(state.assertCurrent('task', 'update-b').state).toBe('queued')
  })
  it('rejects stale chapter mappings without changing the installed source', () => {
    const { db, state } = setup(), before = chapterManifest()
    db.exec("UPDATE views SET revision=2,bundle_resource_id='published-2' WHERE id='view'")
    expect(() => state.installManifest({ ...before, manifest_revision: 2 }, 1)).toThrow()
    expect(state.manifest('task', 'view')).toEqual(before)
    expect(state.manifest('task', 'view', 2)).toBeNull()
  })
  it('checks actual chapter dependencies while preserving unrelated chapter results', () => {
    const { db, state } = setup()
    state.start(chapterUpdate('update-b', ['b']))
    const next = chapterManifest(); next.manifest_revision = 2; next.view_revision = 2; next.bundle_resource_id = 'published-2'; next.chapters[0]!.revision = 2
    db.exec("UPDATE views SET revision=2,bundle_resource_id='published-2' WHERE id='view'")
    state.installManifest(next, 1)
    expect(state.assertCurrent('task', 'update-b').state).toBe('queued')
    expect(state.dependencyCurrent({ kind: 'chapter', task_id: 'task', view_id: 'view', region_id: 'a', revision: 1 })).toBe(false)
    expect(state.dependencyCurrent({ kind: 'chapter', task_id: 'task', view_id: 'view', region_id: 'b', revision: 1 })).toBe(true)
    expect(state.dependencyCurrent({ kind: 'chapter', task_id: 'task', view_id: 'view', revision: 1 })).toBe(true)
  })
  it('rolls back manifest, stage and retained resource records as one transaction', () => {
    const { db, state } = setup(); state.start(chapterUpdate())
    const before = db.prepare('SELECT COUNT(*) n FROM runner_chapter_resources').get()
    expect(() => db.transaction(() => {
      state.stage('task', 'update-a', 'generating', { source: chapterSource() })
      db.exec("UPDATE views SET revision=2,bundle_resource_id='published-2' WHERE id='view'")
      state.installManifest({ ...chapterManifest(), manifest_revision: 2, view_revision: 2, bundle_resource_id: 'published-2' }, 1)
      throw Error('installation fault')
    })()).toThrow('installation fault')
    expect(state.update('task', 'update-a')!.state).toBe('queued')
    expect(state.manifest('task', 'view')!.manifest_revision).toBe(1)
    expect(db.prepare('SELECT COUNT(*) n FROM runner_chapter_resources').get()).toEqual(before)
  })
  it('retains proposals independently from the complete artifact owner', () => {
    const { db, state } = setup(); const update = state.start(chapterUpdate())
    state.stage('task', update.update_id, 'generating', { source: chapterSource(update) })
    const proposal = chapterProposal(update)
    expect(state.recordProposal(proposal)).toEqual(proposal)
    expect(state.recordProposal(proposal)).toEqual(proposal)
    expect(state.update('task', update.update_id)!.state).toBe('assembling')
    expect(db.prepare('SELECT COUNT(*) n FROM runner_artifact_owners').get()).toEqual({ n: 0 })
    expect(db.prepare("SELECT resource_id FROM runner_chapter_resources WHERE owner_kind='proposal'").all()).toEqual([{ resource_id: 'candidate' }])
    expect(() => state.recordProposal({ ...proposal, bundle_resource_id: 'different' })).toThrow()
  })
  it('retains explicit keep source coverage and refuses invalid dependencies', () => {
    const { state } = setup(); state.start(chapterUpdate())
    const keep = { task_id: 'task', update_id: 'update-a', view_id: 'view', region_id: 'b', region_revision: 1, source_bundle_resource_id: 'original', source_manifest_revision: 1, request_id: 'goal', intent_revision: 1, requirement_ids: ['content'], dependencies: [], valid: true }
    expect(state.keep(keep)).toEqual(keep)
    expect(state.inheritance('task', 'update-a')).toEqual([keep])
    expect(() => state.keep({ ...keep, region_id: 'a' })).toThrow()
    expect(() => state.keep({ ...keep, dependencies: [{ kind: 'chapter', task_id: 'task', view_id: 'view', region_id: 'a', revision: 4 }] })).toThrow()
  })
  it('never mutates publication parameters or duplicates an unknown dispatch', () => {
    const { db, state } = setup(); const update = state.start(chapterUpdate()); state.recordProposal(chapterProposal(update))
    const operation = chapterPublication(update); state.registerPublication(operation)
    expect(() => state.registerPublication({ ...operation, expected_view_revision: 2 })).toThrow()
    state.publicationStage('task', operation.operation_id, 'prepared')
    state.publicationStage('task', operation.operation_id, 'dispatched')
    state.publicationStage('task', operation.operation_id, 'unknown', { code: 'OPERATION_UNKNOWN' })
    expect(() => state.registerPublication({ ...operation, operation_id: 'duplicate', previous_operation_id: operation.operation_id })).toThrow()
    expect(state.publication('task', operation.operation_id)!.operation.state).toBe('unknown')
    expect(state.publication('task', operation.operation_id)!.result).toBeNull()
    state.publicationStage('task', operation.operation_id, 'published', { state: 'published', view_revision: 2 })
    expect(state.publication('task', operation.operation_id)!.result).toEqual({ state: 'published', view_revision: 2 })
    expect(db.prepare('SELECT state,payload_json FROM runner_chapter_publication_evidence ORDER BY sequence').all()).toEqual([{ state: 'unknown', payload_json: JSON.stringify({ code: 'OPERATION_UNKNOWN' }) }, { state: 'published', payload_json: JSON.stringify({ state: 'published', view_revision: 2 }) }])
  })
  it('settles a stale undispatched request before creating its successor and preserves denials', () => {
    const { state } = setup(); state.start(chapterUpdate()); state.recordProposal(chapterProposal())
    const operation = chapterPublication(); state.registerPublication(operation)
    state.publicationStage('task', operation.operation_id, 'superseded', { code: 'BASE_CHANGED' })
    const successor = { ...operation, operation_id: 'successor', previous_operation_id: operation.operation_id, expected_view_revision: 2 }
    expect(state.registerPublication(successor)).toEqual(successor)
    state.publicationStage('task', successor.operation_id, 'failure', { code: 'APPROVAL_DENIED' })
    expect(() => state.registerPublication({ ...successor, operation_id: 'bypass', previous_operation_id: successor.operation_id })).toThrow()
  })
  it('does not reactivate terminal work after a restart or late stage notification', () => {
    const { db, state } = setup(); state.start(chapterUpdate()); state.stage('task', 'update-a', 'cancelled')
    const recovered = new ChapterState(db)
    expect(recovered.update('task', 'update-a')!.state).toBe('cancelled')
    expect(() => recovered.stage('task', 'update-a', 'generating')).toThrow()
    expect(() => recovered.assertCurrent('task', 'update-a')).toThrow()
  })
})
