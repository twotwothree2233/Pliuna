import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { modelServer, synthetic, textStream, frame } from '../helpers/model-server'
import { readFileSync } from 'node:fs'
const instruction = readFileSync('src/runtime/model/prompts/summary-v0.1.txt', 'utf8')
const executablePath: string = createRequire(import.meta.url)('electron')

test('request-boundary compaction retains latest user and two complete batches across consecutive summaries and restart', async () => {
  test.setTimeout(60000)
  const root = await mkdtemp(join(tmpdir(), 'pliuna-request-window-v2-'))
  let requests = 0, summaries = 0
  const mainInputs: any[] = [], summaryInputs: any[] = []
  const server = await modelServer(({ body }, res) => {
    if (synthetic(body, res)) return
    if (body.messages[0].content.startsWith('Synthetic compaction')) { textStream(res, 'Continue synthetic task'); return }
    expect(body.max_tokens).toBe(128000)
    if (body.messages.at(-1).content === instruction) {
      summaries++; summaryInputs.push(body.messages)
      expect(body.tools).toBeUndefined()
      expect(body.messages.filter((message: any) => message.content?.startsWith('工作摘要：'))).toHaveLength(summaries === 1 ? 0 : 1)
      expect(body.messages.at(-2).role).toBe(summaries === 3 ? 'assistant' : 'tool')
      textStream(res, 'SUMMARY_' + summaries); return
    }
    requests++; mainInputs.push(body.messages)
    const assistants = body.messages.filter((message: any) => message.role === 'assistant')
    if (requests > 3) expect(assistants).toHaveLength(2)
    expect(body.messages.filter((message: any) => message.content === '{"request":"Complete the isolated request"}')).toHaveLength(1)
    if (requests <= 4) {
      const id = 'round-' + requests
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(frame({ role: 'assistant', content: id + ':' + 'x'.repeat(18500), tool_calls: ['a','b'].map((suffix, index) => ({ index, id: id + suffix, type: 'function', function: { name: 'list', arguments: '{"kind":"capability"}' } })) }) + frame({}, 'tool_calls') + 'data: [DONE]\n\n'); return
    }
    expect(requests).toBe(5)
    textStream(res, 'FINAL_' + 'z'.repeat(18500))
  })
  const launch = () => electron.launch({ executablePath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', PLIUNA_TEST_DATA: root } })
  let app = await launch(), page = await app.firstWindow()
  const call = async (request: any): Promise<any> => { const reply = await page.evaluate(value => window.pliuna.request(value), request); if (!reply.ok) throw Error(reply.error.code); return reply.data }
  try {
    await call({ type: 'model.configure', configuration: { id: 'summary', base_url: server.url, wire_model_id: 'synthetic', context_tokens: 240000, max_output_tokens: 128000, compatibility_profile: 'chat-max-tokens' }, api_key: 'synthetic-only', remember_connection: true, confirm_plaintext_storage: true, confirm_memory_only: true })
    await call({ type: 'model.test', model_id: 'summary', role: 'compaction', confirm_cost: true })
    await call({ type: 'model.configure', configuration: { id: 'main', base_url: server.url, wire_model_id: 'synthetic', context_tokens: 65000, max_output_tokens: 128000, compaction_model_id: 'summary', compatibility_profile: 'chat-max-tokens' }, api_key: 'synthetic-only', remember_connection: true, confirm_plaintext_storage: true, confirm_memory_only: true, confirm_history_processing: true })
    await call({ type: 'model.test', model_id: 'main', role: 'main', confirm_cost: true })
    const task = (await call({ type: 'task.create', title: 'Request window acceptance' })).task.id
    const run = await call({ type: 'task.submit', task_id: task, text: 'Complete the isolated request', model_config_id: 'main', attachments: [] })
    await expect.poll(async () => { const r = (await call({ type: 'task.snapshot', task_id: task })).runs.find((r: any) => r.id === run.run_id); if (r?.state === 'failed') throw Error(r.primary_reason); return r?.state }).toBe('completed')
    expect(requests).toBe(5); expect(summaries).toBe(3)
    const snapshot = await call({ type: 'task.snapshot', task_id: task }), status = await call({ type: 'context.status', task_id: task })
    const originals = await app.evaluate((_electron, { root, task }) => {
      const require = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json'), db = new (require('better-sqlite3'))(root + '/pliuna.sqlite', { readonly: true })
      try { return db.prepare('SELECT id,kind,payload_json FROM records WHERE task_id=? ORDER BY sequence').all(task).map((row: any) => ({ ...row, payload: JSON.parse(row.payload_json) })) } finally { db.close() }
    }, { root, task })
    const results = originals.filter((r: any) => r.kind === 'model.tool_result'), responses = originals.filter((r: any) => r.kind === 'model.response')
    expect(results).toHaveLength(8); expect(responses).toHaveLength(5)
    expect(results.every((r: any) => JSON.parse(r.payload.message.content).execution === 'success')).toBe(true)
    expect(status.current.retained_interactions.map((group: string[]) => group.length)).toEqual([3, 1])
    for (const [index, sent] of summaryInputs.entries()) {
      const count = index + 3, through = responses.slice(0, count)
      expect(sent.some((message: any) => message.content === through.at(-1).payload.message.content)).toBe(true)
      const relevant = results.filter((r: any) => r.payload.message.tool_call_id.startsWith('round-' + count))
      for (const result of relevant) expect(sent).toContainEqual(result.payload.message)
    }
    // The first summary sees exactly what the previous main request saw, plus its complete response/results.
    expect(summaryInputs[0].slice(0, mainInputs[2].length)).toEqual(mainInputs[2])
    const installations = snapshot.records.filter((r: any) => r.kind === 'context.summary.installed')
    expect(installations).toHaveLength(3)
    expect(installations[2].payload.through_sequence).toBeGreaterThan(installations[1].payload.through_sequence)
    const count = server.exchanges.length, settings = await readFile(join(root, 'settings.json')), auth = await readFile(join(root, 'auth.json'))
    await app.close(); app = await launch(); page = await app.firstWindow()
    expect(await call({ type: 'context.status', task_id: task })).toEqual(status)
    expect((await call({ type: 'task.snapshot', task_id: task })).records).toEqual(snapshot.records)
    expect(await readFile(join(root, 'settings.json'))).toEqual(settings); expect(await readFile(join(root, 'auth.json'))).toEqual(auth)
    expect(await call({ type: 'context.compact', task_id: task, model_config_id: 'main', confirm_cost: true })).toMatchObject({ status: 'unchanged', model_requests: 0 })
    expect(server.exchanges).toHaveLength(count)
    await page.getByRole('button', { name: /Request window acceptance/ }).click()
    const panel = page.getByRole('region', { name: '上下文管理' })
    await panel.locator('details > summary').first().click()
    await expect(panel.locator('pre').first()).toHaveText('SUMMARY_3')
    await panel.getByRole('button', { name: /查看保留原记录/ }).first().click()
    await expect(panel.getByRole('region', { name: '选定摘要来源分页浏览' }).getByRole('article')).toContainText('Complete the isolated request')
    expect(server.exchanges).toHaveLength(count)
  } finally { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.destroy())).catch(() => {}); await app.close().catch(() => {}); await server.close() }
})
