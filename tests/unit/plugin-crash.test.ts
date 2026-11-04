import { beforeAll, afterAll, it, expect } from 'vitest'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import Database from 'better-sqlite3'
import { RuntimeStore } from '../../src/runtime/store'
let working: string, executable: string
beforeAll(async () => {
  working = fs.mkdtempSync(join(tmpdir(), 'trellis-plugin-crash-build-')); executable = join(working, 'crash.cjs')
  const req = createRequire(import.meta.url), esbuild = createRequire(req.resolve('vite'))('esbuild')
  await esbuild.build({ entryPoints: ['tests/helpers/plugin-crash.ts'], outfile: executable, bundle: true, platform: 'node', format: 'cjs', packages: 'external', loader: { '.txt': 'text', '.sql': 'text' } })
})
afterAll(() => fs.rmSync(working, { recursive: true, force: true }))
for (const boundary of ['sent', 'prepared', 'committed']) it('plugin SIGKILL at ' + boundary + ' retains facts without replay or file deletion', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'trellis-plugin-crash-'))
  let store: RuntimeStore | undefined = new RuntimeStore(root); const task = store.create('isolated').task.id; store.close(); store = undefined
  const child = fork(executable, [root, task, boundary], { env: { ...process.env, NODE_PATH: join(process.cwd(), 'node_modules') }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }), exit = once(child, 'exit')
  try {
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(Error('Boundary timeout')), 10000); child.once('message', () => { clearTimeout(timer); resolve() }); child.once('exit', () => { clearTimeout(timer); reject(Error('Fixture exited before boundary')) }) })
    child.kill('SIGKILL'); await exit
    const files = fs.readdirSync(join(root, 'resources')); store = new RuntimeStore(root)
    expect(fs.readdirSync(join(root, 'resources'))).toEqual(files)
    const db = new Database(join(root, 'trellis.sqlite'))
    try {
      expect(db.prepare('SELECT state,dispatch,execution,commit_valid FROM calls').all()).toEqual([{ state: 'ended', dispatch: 'sent', execution: boundary === 'committed' ? 'success' : 'unknown', commit_valid: 0 }])
      expect(db.prepare('SELECT id FROM resources').all()).toHaveLength(boundary === 'committed' ? 1 : 0)
      expect(db.prepare('SELECT id FROM runs').all()).toHaveLength(1)
      if (boundary === 'prepared') { expect(db.prepare('SELECT state FROM staging').get()).toEqual({ state: 'invalid' }); expect(JSON.parse((db.prepare("SELECT detail_json FROM cleanup_jobs WHERE owner_kind='staging'").get() as any).detail_json).assessment).toBe('candidate') }
    } finally { db.close() }
    await new Promise(resolve => setTimeout(resolve, 50))
    expect((await store.handle({ type: 'plugin.list', task_id: task }) as any).items[0].instances).toEqual([])
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit }
    store?.close(); fs.rmSync(root, { recursive: true, force: true })
  }
}, 15000)
