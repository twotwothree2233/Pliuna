import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
const instruction = readFileSync('src/runtime/model/prompts/summary-v0.1.txt', 'utf8')
import { modelServer, synthetic, textStream, hostToolStream } from '../helpers/model-server'
const executablePath: string = createRequire(import.meta.url)('electron')

test('autonomous small reads never expand unread material; exact recent results survive five summaries and restart', async () => {
  test.setTimeout(90000)
  const root = await mkdtemp(join(tmpdir(), 'pliuna-demand-read-desktop-')), data = join(root, '.pliuna')
  const selected = 'SELECTED_' + randomUUID(), unread = 'UNREAD_' + randomUUID()
  const text = selected + '中😀'.repeat(20000) + unread, input = join(root, 'synthetic.txt')
  await writeFile(input, text)
  let resource = '', oldSource: any, summaries = 0, reads = 0
  const server = await modelServer(({ body }, res) => {
    expect(JSON.stringify(body)).not.toContain(unread)
    if (synthetic(body, res)) return
    if (body.messages.at(-1).content === instruction) {
      summaries++
      expect(body.messages.filter((message: any) => message.content?.startsWith('工作摘要：'))).toHaveLength(summaries === 1 ? 0 : 1)
      const reads = body.messages.filter((message: any) => message.role === 'tool' && message.content.includes(selected))
      if (summaries <= 2) expect(reads).toHaveLength(1)
      else expect(reads).toHaveLength(0)
      textStream(res, 'SUMMARY_' + summaries + ': explicit reads retrieve selected text only.'); return
    }
    const host = JSON.parse(body.messages.findLast((m: any) => m.role === 'user').content)
    if (host.request.startsWith('read') && body.messages.at(-1).role !== 'tool') {
      reads++; hostToolStream(res, 'read', { target: { kind: 'resource', id: resource }, content: { max_chars: 1000 } }, '', 'selected-' + reads); return
    }
    if (body.messages.at(-1).role === 'tool') {
      const result = JSON.parse(body.messages.at(-1).content)
      expect(result.data.actual_range.chars).toBe(1000)
      expect(result.data.data.text.startsWith(selected)).toBe(true)
      expect([...result.data.data.text]).toHaveLength(1000)
    }
    textStream(res, 'Navigation retained; explicit reads retrieve selected text only.')
  })
  const launch = () => electron.launch({ executablePath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', PLIUNA_TEST_DATA: data, PLIUNA_ENABLE_VIEW_REPLACEMENT: '1' } })
  let app = await launch(), page = await app.firstWindow()
  const call = async (request: any): Promise<any> => { const r = await page.evaluate(r => window.pliuna.request(r), request); if (!r.ok) throw Error(r.error.code); return r.data }
  try {
    await call({ type: 'model.configure', configuration: { id: 'main', base_url: server.url, wire_model_id: 'synthetic', context_tokens: 240000, max_output_tokens: 128000, compatibility_profile: 'chat-max-tokens' }, api_key: 'synthetic-only', confirm_memory_only: true, remember_connection: true, confirm_plaintext_storage: true })
    await call({ type: 'model.test', model_id: 'main', role: 'main', confirm_cost: true })
    const task = (await call({ type: 'task.create', title: 'Demand read synthetic' })).task.id
    await app.evaluate(({ dialog }, path) => { (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, input)
    const imported = await call({ type: 'material.pick', task_id: task }), operation = imported.items[0].operation_id
    await expect.poll(async () => (await call({ type: 'material.status', task_id: task, operation_id: operation })).state).toBe('success')
    resource = (await call({ type: 'material.status', task_id: task, operation_id: operation })).resource.id
    const until = async (id: string) => { await expect.poll(async () => (await call({ type: 'task.snapshot', task_id: task })).runs.find((r: any) => r.id === id)?.state).toBe('completed') }
    const submit = async (message: string) => until((await call({ type: 'task.submit', task_id: task, text: message, model_config_id: 'main', attachments: [] })).run_id)
    await submit('read selected excerpt only')
    for (let n = 1; n <= 5; n++) {
      if (n > 1) await submit('Continue from navigation without reading')
      await until((await call({ type: 'context.compact', task_id: task, model_config_id: 'main', confirm_cost: true })).run_id)
      const before = server.exchanges.length
      expect((await call({ type: 'context.compact', task_id: task, model_config_id: 'main', confirm_cost: true })).status).toBe('unchanged')
      expect(server.exchanges).toHaveLength(before)
    }
    expect(summaries).toBe(5); expect(reads).toBe(1)
    await submit('read same selected excerpt explicitly again'); expect(reads).toBe(2)
    oldSource = { id: (await call({ type: 'task.snapshot', task_id: task })).records.find((r: any) => r.kind === 'model.tool_result').id }
    const audit = async () => app.evaluate((_electron, { data, task, sourceId }) => {
      const Database = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('better-sqlite3'), db = new Database(data + '/pliuna.sqlite', { readonly: true })
      try {
        const rows = db.prepare('SELECT id,kind,payload_json FROM records WHERE task_id=? ORDER BY sequence').all(task) as any[]
        return { source: rows.find(r => r.id === sourceId), evidence: rows.filter(r => r.kind === 'model.request.evidence').map(r => JSON.parse(r.payload_json)), accounting: rows.filter(r => r.kind === 'model.request.accounting').map(r => JSON.parse(r.payload_json)) }
      } finally { db.close() }
    }, { data, task, sourceId: oldSource.id })
    const recorded = await audit(), exchanges = server.exchanges.filter(e => e.body?.messages.at(-1)?.content === instruction)
    expect(recorded.source.payload_json).toContain(selected)
    for (const [n, exchange] of exchanges.entries()) {
      const evidence = recorded.evidence.filter((e: any) => e.purpose === 'summary')[n]
      const id = evidence.request_id
      expect(evidence.originals.every((original: any) => original.representation === 'recorded-message')).toBe(true)
      expect(evidence.supplements).toEqual([])
      const accounting = recorded.accounting.find((e: any) => e.request_id === id && e.phase === 'completed')
      expect(accounting.input_bytes).toBe(Buffer.byteLength(JSON.stringify({ messages: exchange.body.messages })))
      expect(exchange.body.max_tokens).toBe(128000)
    }
    const beforeSummary = await call({ type: 'context.status', task_id: task }), count = server.exchanges.length
    const settings = await readFile(join(data, 'settings.json')), auth = await readFile(join(data, 'auth.json')), bytes = await readFile(join(data, 'resources', resource))
    expect(bytes.toString()).toBe(text)
    await app.close(); app = await launch(); page = await app.firstWindow(); await page.waitForFunction(() => !!window.pliuna)
    expect(await call({ type: 'context.status', task_id: task })).toEqual(beforeSummary)
    expect(await readFile(join(data, 'settings.json'))).toEqual(settings); expect(await readFile(join(data, 'auth.json'))).toEqual(auth)
    expect(await readFile(join(data, 'resources', resource))).toEqual(bytes); expect(server.exchanges).toHaveLength(count)
    expect(await audit()).toEqual(recorded)
  } finally { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.destroy())).catch(() => {}); await app.close().catch(() => {}); await server.close() }
})
