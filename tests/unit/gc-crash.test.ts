import { beforeAll, afterAll, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import Database from 'better-sqlite3'
import { RuntimeStore } from '../../src/runtime/store'
import { digest } from '../../src/runtime/resources'
let working: string, executable: string
beforeAll(async () => {
  working = mkdtempSync(join(tmpdir(), 'pliuna-gc-crash-')); executable = join(working, 'crash.cjs')
  const req = createRequire(import.meta.url), esbuild = createRequire(req.resolve('vite'))('esbuild')
  await esbuild.build({ entryPoints: ['tests/helpers/gc-crash.ts'], outfile: executable, bundle: true, platform: 'node', format: 'cjs', packages: 'external', loader: { '.txt': 'text', '.sql': 'text' } })
})
afterAll(() => rmSync(working, { recursive: true, force: true }))
for (const point of ['preview', 'authorized', 'intent', 'unlinked', 'partial', 'settled']) it('reconciles SIGKILL at GC ' + point + ' without implicit deletion or lost business', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pliuna-gc-crash-data-'))
  let store: RuntimeStore | undefined = new RuntimeStore(directory)
  const task = store.create('隔离故障'), db = new Database(join(directory, 'pliuna.sqlite'))
  db.prepare("INSERT INTO actions (id,task_id,kind,state,result,source_json,request_json,commit_valid,created_at) VALUES ('owner',?,'mutation','ended','not_executed','{}','{}',0,'now')").run(task.task.id)
  db.prepare("INSERT INTO staging (id,task_id,owner_kind,owner_id,runtime_epoch,state,storage_key,expected_bytes,sha256,created_at) VALUES ('stage',?,'action','owner','old','invalid','orphan',8,?,'now')").run(task.task.id, digest(Buffer.from('original')))
  db.close(); writeFileSync(join(directory, 'resources', 'orphan'), 'original'); writeFileSync(join(directory, 'resources', 'orphan.tmp'), 'part'); store.close(); store = undefined
  const child = fork(executable, [directory, point], { env: { ...process.env, NODE_PATH: join(process.cwd(), 'node_modules') }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let errors = ''; child.stderr!.on('data', data => { errors += data.toString() }); const exit = once(child, 'exit')
  try {
    await new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(new Error('Fault timeout: ' + errors)), 10000); child.once('message', () => { clearTimeout(timeout); resolve() }); child.once('exit', () => { clearTimeout(timeout); reject(new Error(errors)) }) })
    child.kill('SIGKILL'); await exit
    const before = readdirSync(join(directory, 'resources')); store = new RuntimeStore(directory)
    const state = store.handle({ type: 'maintenance.gc.status' }) as any
    expect(state.enabled).toBe(true); expect(readdirSync(join(directory, 'resources'))).toEqual(before); expect(store.tasks().map(t => t.id)).toEqual([task.task.id]); expect(store.snapshot(task.task.id).runs).toEqual([])
    if (point === 'preview') expect(state.last.authorized).toBe(false)
    else {
      expect(state.last.phase).toBe('settled')
      if (point === 'unlinked') { expect(state.last.files_deleted).toBe(0); expect(state.last.items[0].state).toBe('absent') }
      const token = (store.handle({ type: 'maintenance.begin' }) as any).reservation.token
      const result = store.handle({ type: 'maintenance.gc.retry', token, operation_id: state.last.id, inputs_saved: true, confirm_delete_orphans: true }) as any
      expect(result.items.every((i: any) => ['absent', 'deleted'].includes(i.state))).toBe(true); expect(readdirSync(join(directory, 'resources'))).toEqual([])
    }
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit }; store?.close(); rmSync(directory, { recursive: true, force: true }) }
}, 15000)
