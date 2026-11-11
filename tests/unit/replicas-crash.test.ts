import { beforeAll, afterAll, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import Database from 'better-sqlite3'
import { RuntimeStore } from '../../src/runtime/store'
let working: string, executable: string
beforeAll(async () => {
  working = mkdtempSync(join(tmpdir(), 'pliuna-replicas-crash-')); executable = join(working, 'crash.cjs')
  const req = createRequire(import.meta.url), esbuild = createRequire(req.resolve('vite'))('esbuild')
  await esbuild.build({ entryPoints: ['tests/helpers/replicas-crash.ts'], outfile: executable, bundle: true, platform: 'node', format: 'cjs', packages: 'external', loader: { '.txt': 'text', '.sql': 'text' } })
})
afterAll(() => rmSync(working, { recursive: true, force: true }))
for (const point of ['retired', 'intent', 'main_unlinked', 'partial', 'aux_unlinked', 'all_unlinked', 'group_deleted', 'released']) it('preserves retirement and protection at real SIGKILL: ' + point, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pliuna-replicas-crash-data-'))
  let store: RuntimeStore | undefined = new RuntimeStore(directory)
  const task = store.create('隔离故障'), begin = () => (store!.handle({ type: 'maintenance.begin' }) as any).reservation.token
  const old = (await store.handle({ type: 'maintenance.create', token: begin(), inputs_saved: true, replace_id: null }) as any).active
  const active = (await store.handle({ type: 'maintenance.create', token: begin(), inputs_saved: true, replace_id: old.id }) as any).active
  const file = 'recovery/' + old.id + '.sqlite'; store.close(); store = undefined
  writeFileSync(join(directory, file + '-journal'), Buffer.alloc(512))
  const child = fork(executable, [directory, point, file], { env: { ...process.env, NODE_PATH: join(process.cwd(), 'node_modules') }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let errors = ''; child.stderr!.on('data', data => { errors += data.toString() }); const exit = once(child, 'exit')
  try {
    await new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(new Error('Fault timeout: ' + errors)), 10000); child.once('message', () => { clearTimeout(timeout); resolve() }); child.once('exit', () => { clearTimeout(timeout); reject(new Error(errors)) }) })
    child.kill('SIGKILL'); await exit
    const before = readdirSync(join(directory, 'recovery')); store = new RuntimeStore(directory)
    expect(readdirSync(join(directory, 'recovery'))).toEqual(before); expect(store.tasks().map(t => t.id)).toEqual([task.task.id]); expect((store.handle({ type: 'maintenance.status' }) as any).active.id).toBe(active.id)
    const db = new Database(join(directory, 'restore-control.sqlite')), r = JSON.parse((db.prepare('SELECT manifest FROM restore_control').get() as any).manifest).retirements.at(-1); db.close()
    const outcome = store.handle({ type: 'maintenance.replica.status', operation_id: r.id }) as any
    expect(outcome.protection_released).toBe(point === 'released'); expect(outcome.phase).toBe(point === 'released' ? 'released' : point === 'group_deleted' ? 'group_deleted' : 'retired')
    if (point !== 'released') {
      const result = store.handle({ type: 'maintenance.replica.retry', token: begin(), operation_id: r.id, inputs_saved: true, confirm_retire_replica: true }) as any
      expect(result).toMatchObject({ phase: 'released', protection_released: true, formal_resources_deleted: 0 })
    }
    expect(existsSync(join(directory, file))).toBe(false); expect(existsSync(join(directory, file + '-journal'))).toBe(false); expect(existsSync(join(directory, 'recovery', active.id + '.sqlite'))).toBe(true)
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit }; store?.close(); rmSync(directory, { recursive: true, force: true }) }
}, 15000)
