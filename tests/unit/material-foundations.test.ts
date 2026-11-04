import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, symlink, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import sql from '../../src/shared/contracts/001-core.sql?raw'
import { readPluginBytes } from '../../src/runtime/plugins/resource-reader'
import { PluginDerivations } from '../../src/runtime/plugins/derivations'
import { assertContract } from '../../src/shared/validation'

let root: string, db: Database.Database, derived: PluginDerivations
const hash = (body: Buffer) => createHash('sha256').update(body).digest('hex')
const source = Buffer.from([0, 255, 128, 1]), output = Buffer.from('Page one\nPage two\n')
const resource = (id = 'input', bytes = source) => ({ id, storage_key: id, byte_length: bytes.length, sha256: hash(bytes) })
const proposal = () => ({ task_id: 'task', input_resource_id: 'input', output_resource_id: 'output', pages: [{ page: 1, start: 0, end: 9 }, { page: 2, start: 9, end: output.length }], partial: false, notice: '' })
const record = (task: string, kind: string, payload: unknown) => db.prepare('INSERT INTO records VALUES (?, ?, 1, ?, ?, ?)').run('event', task, kind, JSON.stringify(payload), 'now')
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'trellis-material-foundations-')); await mkdir(join(root, 'resources'))
  db = new Database(join(root, 'trellis.sqlite')); db.exec(sql)
  db.prepare("INSERT INTO tasks VALUES ('task','synthetic','active',1,1)").run()
  db.prepare("INSERT INTO tasks VALUES ('other','synthetic','active',1,1)").run()
  for (const [id, bytes] of [['input', source], ['output', output]] as const) {
    await writeFile(join(root, 'resources', id), bytes)
    db.prepare('INSERT INTO resources VALUES (?,?,?,?,?,?,?)').run(id, id, hash(bytes), bytes.length, 'text/plain', id, 'now')
    db.prepare('INSERT INTO task_resources VALUES (?,?)').run('task', id)
  }
  db.prepare("INSERT INTO calls (id,task_id,capability_id,state,dispatch,delivery,input_json,limits_json,commit_valid,created_at) VALUES ('call','task','pdf','finalizing','sent','pending',?,?,1,'now')").run(JSON.stringify({ arguments: { resource_id: 'input' } }), JSON.stringify({ package_digest: 'a'.repeat(64), plugin_version: '1.0.0' }))
  derived = new PluginDerivations(db, root)
})
afterEach(() => { db.close() }) // Retain isolated fault scenes for inspection.
it('reads binary bytes only in bounded chunks without exposing a host path', async () => {
  const body = Buffer.alloc(300000, 255), row = resource('large', body); await writeFile(join(root, 'resources', row.id), body)
  const first = await readPluginBytes(root, row, 0, 262144, () => {})
  expect(Buffer.from(first.base64, 'base64')).toEqual(body.subarray(0, 262144)); expect(first.next_offset).toBe(262144)
  expect(await readPluginBytes(root, row, 262144, 262144, () => {})).toMatchObject({ next_offset: null, byte_length: body.length })
  expect(JSON.stringify(first)).not.toContain(root)
  await expect(readPluginBytes(root, row, 0, 262145, () => {})).rejects.toMatchObject({ code: 'RESOURCE_RANGE_INVALID' })
  await expect(readPluginBytes(root, row, -1, 1, () => {})).rejects.toThrow()
})
it('rejects same-length mutation, hard links and symbolic links without repair', async () => {
  const row = resource(); await writeFile(join(root, 'resources', 'input'), Buffer.from([1, 2, 3, 4]))
  await expect(readPluginBytes(root, row, 0, 4, () => {})).rejects.toMatchObject({ code: 'RESOURCE_CORRUPT' })
  expect(await readFile(join(root, 'resources', 'input'))).toEqual(Buffer.from([1, 2, 3, 4]))
  await writeFile(join(root, 'resources', 'input'), source); await link(join(root, 'resources', 'input'), join(root, 'resources', 'hard'))
  await expect(readPluginBytes(root, row, 0, 4, () => {})).rejects.toThrow()
  await symlink(join(root, 'resources', 'input'), join(root, 'resources', 'symbolic'))
  await expect(readPluginBytes(root, { ...row, storage_key: 'symbolic' }, 0, 4, () => {})).rejects.toThrow()
})
it('rechecks qualification after asynchronous verification', async () => {
  let live = true
  const pending = readPluginBytes(root, resource(), 0, 4, () => { if (!live) throw Error('cancelled') })
  live = false; await expect(pending).rejects.toThrow('cancelled')
})
it('only accepts the strict app runtime declaration or the existing external declaration', () => {
  const base = { manifest_version: '0.1', protocol_version: '0.1', id: 'fixture', version: '1.0.0', access_level: 'task', contributes: [{ id: 'tool', kind: 'tool', entry: 'tool.json', description: 'fixture' }] }
  expect(() => assertContract('manifest', { ...base, backend: { runtime: 'app-node', entry: 'backend.mjs' } })).not.toThrow()
  expect(() => assertContract('manifest', { ...base, backend: { command: 'node', args: ['backend.mjs'], entry: 'backend.mjs' } })).not.toThrow()
  expect(() => assertContract('manifest', { ...base, backend: { runtime: 'app-node', command: '/tmp/fake', entry: 'backend.mjs' } })).toThrow()
})
it('binds provenance to real Call facts and survives restart without replay', async () => {
  derived.read('call', resource()); derived.propose('call', proposal()); await derived.prepare('call', () => {})
  db.transaction(() => {
    derived.commit('call', [resource('output', output)], record, '1.0.0')
    db.prepare("UPDATE calls SET state='ended',execution='success',delivery='delivered',commit_valid=0,result_json=? WHERE id='call'").run(JSON.stringify({ resources: [resource('output', output)] }))
  })()
  derived.settled('call'); const restarted = new PluginDerivations(db, root); restarted.validateStored()
  expect(restarted.forOutput('task', 'output')).toMatchObject({ version: 1, capability_id: 'pdf', input: { id: 'input' }, output: { id: 'output' }, location_verification: 'tool_reported' })
  expect(restarted.forOutput('other', 'output')).toBeNull()
  expect(db.prepare('SELECT count(*) n FROM records').get()).toEqual({ n: 1 })
})
it('rejects unobserved input, cross-task claims and non-new output', async () => {
  expect(() => derived.propose('call', proposal())).toThrow()
  derived.read('call', resource()); derived.propose('call', { ...proposal(), task_id: 'other' })
  await expect(derived.prepare('call', () => {})).rejects.toThrow()
  expect(() => db.transaction(() => derived.commit('call', [], record, '1.0.0'))()).toThrow()
})
it('rolls back publication and source events together on invalid page range', async () => {
  derived.read('call', resource()); derived.propose('call', { ...proposal(), pages: [{ page: 1, start: 0, end: output.length + 1 }] }); await derived.prepare('call', () => {})
  expect(() => db.transaction(() => {
    db.prepare("UPDATE calls SET execution='success' WHERE id='call'").run()
    derived.commit('call', [resource('output', output)], record, '1.0.0')
  })()).toThrow()
  expect(db.prepare('SELECT execution FROM calls').get()).toEqual({ execution: null }); expect(db.prepare('SELECT * FROM records').all()).toEqual([])
})
it('rejects changed persisted identity and unsupported versions on restart', async () => {
  derived.read('call', resource()); derived.propose('call', proposal()); await derived.prepare('call', () => {})
  db.transaction(() => { derived.commit('call', [resource('output', output)], record, '1.0.0'); db.prepare("UPDATE calls SET state='ended',execution='success',delivery='delivered',result_json=? WHERE id='call'").run(JSON.stringify({ resources: [resource('output', output)] })) })()
  db.prepare("UPDATE resources SET sha256=? WHERE id='input'").run('b'.repeat(64)); expect(() => derived.validateStored()).toThrow()
  db.prepare("UPDATE resources SET sha256=? WHERE id='input'").run(hash(source))
  db.prepare("UPDATE records SET payload_json=json_set(payload_json,'$.version',2)").run(); expect(() => derived.validateStored()).toThrow()
})
