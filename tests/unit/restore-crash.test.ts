import { beforeAll, afterAll, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import Database from 'better-sqlite3'
import { RuntimeStore } from '../../src/runtime/store'
let working: string, executable: string
beforeAll(async () => {
  working = mkdtempSync(join(tmpdir(), 'trellis-restore-crash-')); executable = join(working, 'crash.cjs')
  const req = createRequire(import.meta.url), esbuild = createRequire(req.resolve('vite'))('esbuild')
  await esbuild.build({ entryPoints: ['tests/helpers/restore-crash.ts'], outfile: executable, bundle: true, platform: 'node', format: 'cjs', packages: 'external', loader: { '.txt': 'text', '.sql': 'text' } })
})
afterAll(() => rmSync(working, { recursive: true, force: true }))
for (const point of ['registered', 'rollback_ready', 'sealed', 'selected', 'selected-corrupt', 'selected-both-corrupt', 'completed', 'delete_intent']) it('reconciles actual SIGKILL after restore ' + point + ' without replay or partial business access', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'trellis-restore-crash-data-'))
  let store = new RuntimeStore(directory), storeOpen = true
  const task = store.create('点内任务'), prep = store.handle({ type: 'maintenance.begin' }) as any
  await store.handle({ type: 'maintenance.create', token: prep.reservation.token, inputs_saved: true, replace_id: null })
  const newer = store.create('较新任务'); store.close(); storeOpen = false
  const child = fork(executable, [directory, point, task.task.id], { env: { ...process.env, NODE_PATH: join(process.cwd(), 'node_modules') }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let errors = ''; child.stderr!.on('data', data => { errors += data.toString() }); const exit = once(child, 'exit')
  try {
    await new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(new Error('Fault timeout: ' + errors)), 10000); child.once('message', () => { clearTimeout(timeout); resolve() }); child.once('exit', () => { clearTimeout(timeout); reject(new Error(errors)) }) })
    child.kill('SIGKILL'); await exit
    if (point.includes('corrupt')) {
      const db = new Database(join(directory, 'restore-control.sqlite')), value = JSON.parse((db.prepare('SELECT manifest FROM restore_control').get() as any).manifest); db.close()
      writeFileSync(join(directory, value.operations[0].target.file), 'corrupt')
      if (point === 'selected-both-corrupt') writeFileSync(join(directory, value.operations[0].rollback.file), 'corrupt')
    }
    if (point === 'selected-both-corrupt') { expect(() => new RuntimeStore(directory)).toThrow(/journal/); return }
    store = new RuntimeStore(directory); storeOpen = true
    const status = store.handle({ type: 'maintenance.status' }) as any
    expect(status.phase).toBe('idle')
    if (['registered', 'rollback_ready', 'sealed', 'selected-corrupt'].includes(point)) { expect(store.snapshot(newer.task.id)).toBeTruthy(); expect(status.restore.last.phase).toBe('rolled_back') }
    if (['selected', 'completed'].includes(point)) { expect(store.tasks().map(t => t.id)).toEqual([task.task.id]); expect(status.restore.last.phase).toBe('completed') }
    if (point === 'delete_intent') { expect(store.tasks().map(t => t.id)).toEqual([newer.task.id]); expect(status.active).toBeNull() }
    const tasks = store.tasks(); for (const item of tasks) expect(store.snapshot(item.id).runs).toEqual([])
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit }; if (storeOpen) store.close(); rmSync(directory, { recursive: true, force: true }) }
}, 15000)
