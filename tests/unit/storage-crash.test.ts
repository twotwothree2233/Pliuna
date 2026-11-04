import { afterAll, beforeAll, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import Database from 'better-sqlite3'
import { RuntimeStore } from '../../src/runtime/store'
let working: string, executable: string
beforeAll(async () => {
  working = mkdtempSync(join(tmpdir(), 'trellis-crash-harness-')); executable = join(working, 'crash.cjs')
  const require = createRequire(import.meta.url), esbuild = createRequire(require.resolve('vite'))('esbuild')
  await esbuild.build({ entryPoints: ['tests/helpers/storage-crash.ts'], outfile: executable, bundle: true, platform: 'node', format: 'cjs', packages: 'external', loader: { '.txt': 'text', '.sql': 'text' } })
})
afterAll(() => rmSync(working, { recursive: true, force: true }))
for (const point of ['pinned', 'partial', 'renamed', 'before_commit', 'after_commit']) it('recovers actual SIGKILL at ' + point + ' without replay or file deletion', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'trellis-crash-data-'))
  const child = fork(executable, [directory, point], { env: { ...process.env, NODE_PATH: join(process.cwd(), 'node_modules') }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let errors = ''; child.stderr!.on('data', data => { errors += data.toString() })
  let store: RuntimeStore | undefined, db: Database.Database | undefined
  const exit = once(child, 'exit')
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Crash point timeout: ' + errors)), 10000)
      child.once('message', message => { clearTimeout(timeout); expect(message).toEqual({ point }); resolve() })
      child.once('exit', () => { clearTimeout(timeout); reject(new Error('Fixture exited before fault: ' + errors)) })
    })
    child.kill('SIGKILL'); await exit
    const files = readdirSync(join(directory, 'resources'))
    db = new Database(join(directory, 'trellis.sqlite')); const actionCount = db.prepare('SELECT count(*) n FROM actions').get()
    store = new RuntimeStore(directory)
    const status: any = store.handle({ type: 'storage.status' })
    expect(status.items).toHaveLength(1)
    expect(status.items[0].assessment).toBe(point === 'after_commit' ? 'committed' : point === 'pinned' ? 'absent' : 'candidate')
    expect(db.prepare('SELECT count(*) n FROM resources').get()).toEqual({ n: point === 'after_commit' ? 1 : 0 })
    expect(db.prepare('SELECT count(*) n FROM actions').get()).toEqual(actionCount)
    expect(db.prepare('SELECT state,commit_valid FROM runs').get()).toEqual({ state: 'interrupted', commit_valid: 0 })
    expect(readdirSync(join(directory, 'resources'))).toEqual(files)
    store.handle({ type: 'storage.retry', job_id: status.items[0].id })
    expect(readdirSync(join(directory, 'resources'))).toEqual(files)
    expect(db.prepare('SELECT result FROM actions').get()).toEqual({ result: point === 'after_commit' ? 'success' : 'not_executed' })
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit }
    store?.close(); db?.close(); rmSync(directory, { recursive: true, force: true })
  }
}, 15000)
