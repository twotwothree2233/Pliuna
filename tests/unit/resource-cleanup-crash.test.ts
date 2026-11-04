import { beforeAll, afterAll, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import Database from 'better-sqlite3'
import { RuntimeStore } from '../../src/runtime/store'
import { digest } from '../../src/runtime/resources'
let working: string, executable: string
beforeAll(async () => {
  working = mkdtempSync(join(tmpdir(), 'trellis-resource-crash-')); executable = join(working, 'crash.cjs')
  const req = createRequire(import.meta.url), esbuild = createRequire(req.resolve('vite'))('esbuild')
  await esbuild.build({ entryPoints: ['tests/helpers/resource-cleanup-crash.ts'], outfile: executable, bundle: true, platform: 'node', format: 'cjs', packages: 'external', loader: { '.txt': 'text', '.sql': 'text' } })
})
afterAll(() => rmSync(working, { recursive: true, force: true }))
for (const point of ['source', 'retired', 'intent', 'unlinked', 'file_deleted', 'metadata', 'complete']) it('formal cleanup real SIGKILL boundary: ' + point, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'trellis-resource-crash-data-'))
  let store: RuntimeStore | undefined = new RuntimeStore(directory)
  const task = store.create('隔离故障').task.id, resource = randomUUID(), db = new Database(join(directory, 'trellis.sqlite'))
  db.prepare('INSERT INTO resources VALUES (?,?,?,?,?,?,?)').run(resource, resource, digest(Buffer.from('keep')), 4, 'text/plain', '故障材料', 'now'); db.prepare('INSERT INTO task_resources VALUES (?,?)').run(task, resource); db.close(); writeFileSync(join(directory, 'resources', resource), 'keep'); store.close(); store = undefined
  const child = fork(executable, [directory, point, task], { env: { ...process.env, NODE_PATH: join(process.cwd(), 'node_modules') }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let errors = ''; child.stderr!.on('data', data => { errors += data.toString() }); const exit = once(child, 'exit')
  try {
    await new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(new Error('Fault timeout: ' + errors)), 10000); child.once('message', () => { clearTimeout(timeout); resolve() }); child.once('exit', () => { clearTimeout(timeout); reject(new Error(errors)) }) })
    child.kill('SIGKILL'); await exit
    const before = readdirSync(join(directory, 'resources')); store = new RuntimeStore(directory)
    expect(readdirSync(join(directory, 'resources'))).toEqual(before); expect(store.tasks()).toEqual([])
    const op = (store.handle({ type: 'maintenance.resource.list' }) as any).items[0]
    expect(op.phase).toBe(point === 'source' ? 'candidate' : point === 'retired' ? 'retired' : ['intent', 'unlinked'].includes(point) ? 'deleting' : point === 'complete' ? 'complete' : 'file_deleted')
    if (point !== 'complete') {
      const token = (store.handle({ type: 'maintenance.begin' }) as any).reservation.token
      if (point === 'source') store.handle({ type: 'maintenance.resource.preview', token, operation_id: op.id, inputs_saved: true })
      expect(store.handle({ type: point === 'source' ? 'maintenance.resource.execute' : 'maintenance.resource.retry', token, operation_id: op.id, inputs_saved: true, confirm_retire_resource: true })).toMatchObject({ phase: 'complete', metadata_cleaned: true })
    }
    expect(existsSync(join(directory, 'resources', resource))).toBe(false)
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit }; store?.close(); rmSync(directory, { recursive: true, force: true }) }
}, 15000)
