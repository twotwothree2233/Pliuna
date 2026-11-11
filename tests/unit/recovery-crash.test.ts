import { afterAll, beforeAll, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import Database from 'better-sqlite3'
import { RuntimeStore } from '../../src/runtime/store'
let working: string, executable: string
beforeAll(async () => {
  working = mkdtempSync(join(tmpdir(), 'pliuna-recovery-crash-')); executable = join(working, 'crash.cjs')
  const req = createRequire(import.meta.url), esbuild = createRequire(req.resolve('vite'))('esbuild')
  await esbuild.build({ entryPoints: ['tests/helpers/recovery-crash.ts'], outfile: executable, bundle: true, platform: 'node', format: 'cjs', packages: 'external', loader: { '.txt': 'text', '.sql': 'text' } })
})
afterAll(() => rmSync(working, { recursive: true, force: true }))
for (const point of ['candidate', 'switched', 'invalidated']) it('reconciles actual SIGKILL after independent ' + point + ' commit without replay', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pliuna-recovery-crash-data-'))
  let store = new RuntimeStore(directory); const task = store.create('崩溃恢复点'), prep = store.handle({ type: 'maintenance.begin' }) as any
  const old = await store.handle({ type: 'maintenance.create', token: prep.reservation.token, inputs_saved: true, replace_id: null }) as any
  store.close()
  const child = fork(executable, [directory, point, task.task.id], { env: { ...process.env, NODE_PATH: join(process.cwd(), 'node_modules') }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let errors = ''; child.stderr!.on('data', data => { errors += data.toString() }); const exit = once(child, 'exit')
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Fault timeout ' + errors)), 10000)
      child.once('message', () => { clearTimeout(timeout); resolve() }); child.once('exit', () => { clearTimeout(timeout); reject(new Error(errors)) })
    })
    child.kill('SIGKILL'); await exit
    store = new RuntimeStore(directory)
    const status = store.handle({ type: 'maintenance.status' }) as any
    expect(status.phase).toBe('idle'); expect(store.tasks()).toHaveLength(1)
    if (point === 'candidate') { expect(status.active.id).toBe(old.active.id); expect(status.retained_candidates).toBe(1) }
    if (point === 'switched') expect(status.active.id).not.toBe(old.active.id)
    if (point === 'invalidated') {
      expect(status.active).toBeNull()
      // Deletion never began before durable invalidation; a new explicit delete is still required.
      store.handle({ type: 'task.delete', task_id: task.task.id }); expect(store.tasks()).toEqual([])
    }
    const db = new Database(join(directory, 'pliuna.sqlite'))
    expect(db.prepare('SELECT count(*) n FROM runs').get()).toEqual({ n: 0 }); db.close()
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit }; store.close(); rmSync(directory, { recursive: true, force: true }) }
}, 15000)
