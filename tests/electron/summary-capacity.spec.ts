import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { modelServer, synthetic, textStream } from '../helpers/model-server'
const executablePath: string = createRequire(import.meta.url)('electron')
for (const failure of ['input', 'installation'] as const) test(`exact context capacity failure preserves records and checkpoint on restart: ${failure}`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'trellis-exact-capacity-v2-'))
  let summaries = 0
  const server = await modelServer(({ body }, response) => {
    if (synthetic(body, response)) return
    if (body.messages.at(-1).role === 'system') { summaries++; textStream(response, summaries === 1 ? 'Saved checkpoint' : 'x'.repeat(50000)); return }
    textStream(response, 'Business done')
  })
  const launch = () => electron.launch({ executablePath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', TRELLIS_TEST_DATA: root } })
  let app = await launch(), page = await app.firstWindow()
  const call = async (q: any): Promise<any> => { const r = await page.evaluate(q => window.trellis.request(q), q); if (!r.ok) throw Error(r.error.code); return r.data }
  try {
    await call({ type: 'model.configure', configuration: { id: 'main', base_url: server.url, wire_model_id: 'synthetic', context_tokens: 30000, max_output_tokens: 128000, compatibility_profile: 'chat-max-tokens' }, api_key: 'synthetic-only', remember_connection: true, confirm_plaintext_storage: true, confirm_memory_only: true })
    await call({ type: 'model.test', model_id: 'main', role: 'main', confirm_cost: true })
    const task = (await call({ type: 'task.create', title: 'Capacity failure v2' })).task.id
    const wait = async (id: string, state: string) => expect.poll(async () => (await call({ type: 'task.snapshot', task_id: task })).runs.find((r: any) => r.id === id)?.state).toBe(state)
    await wait((await call({ type: 'task.submit', task_id: task, text: 'Goal', model_config_id: 'main', attachments: [] })).run_id, 'completed')
    await wait((await call({ type: 'context.compact', task_id: task, model_config_id: 'main', confirm_cost: true })).run_id, 'completed')
    const old = await call({ type: 'context.status', task_id: task })
    await app.evaluate((_electron, { root, task, size }) => {
      const require = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json'), db = new (require('better-sqlite3'))(root + '/trellis.sqlite')
      try { db.transaction(() => { const sequence = db.prepare('SELECT next_sequence FROM tasks WHERE id=?').get(task).next_sequence
        db.prepare('INSERT INTO records VALUES (?,?,?,?,?,?)').run(require('node:crypto').randomUUID(), task, sequence, 'message.assistant', JSON.stringify({ run_id: 'synthetic', model_config_id: 'fixture', text: 'PRIVATE_' + 'x'.repeat(size) }), new Date().toISOString())
        db.prepare('UPDATE tasks SET next_sequence=? WHERE id=?').run(sequence + 1, task)
      })() } finally { db.close() }
    }, { root, task, size: failure === 'input' ? 40000 : 1000 })
    const before = server.exchanges.length
    await wait((await call({ type: 'context.compact', task_id: task, model_config_id: 'main', confirm_cost: true })).run_id, 'failed')
    expect(server.exchanges).toHaveLength(before + 1)
    expect(await call({ type: 'context.status', task_id: task })).toEqual(old)
    const snapshot = await call({ type: 'task.snapshot', task_id: task }), rejection = snapshot.records.find((record: any) => record.kind === 'model.context.rejected')
    if (failure === 'input') expect(snapshot.runs[0].primary_reason).toBe('CONTEXT_RECOVERY_NO_PROGRESS')
    else { expect(rejection.payload.stage).toBe('summary-install'); expect(JSON.stringify(rejection)).not.toContain('PRIVATE_') }
    const count = server.exchanges.length, settings = await readFile(join(root, 'settings.json')), auth = await readFile(join(root, 'auth.json'))
    await app.close(); app = await launch(); page = await app.firstWindow()
    expect(await call({ type: 'context.status', task_id: task })).toEqual(old)
    expect((await call({ type: 'task.snapshot', task_id: task })).records).toEqual(snapshot.records)
    expect(await readFile(join(root, 'settings.json'))).toEqual(settings); expect(await readFile(join(root, 'auth.json'))).toEqual(auth)
    expect(server.exchanges).toHaveLength(count)
  } finally { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.destroy())).catch(() => {}); await app.close().catch(() => {}); await server.close() }
})
