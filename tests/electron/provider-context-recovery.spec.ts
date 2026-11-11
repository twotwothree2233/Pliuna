import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { modelServer, synthetic, textStream, frame } from '../helpers/model-server'
import { readFileSync } from 'node:fs'
const instruction = readFileSync('src/runtime/model/prompts/summary-v0.1.txt', 'utf8')
const executablePath: string = createRequire(import.meta.url)('electron')

test('uses provider tokens, cancels overflow, compacts and resumes exact batches without replay after restart', async () => {
  test.setTimeout(60000)
  const root = await mkdtemp(join(tmpdir(), 'pliuna-provider-recovery-'))
  let requests = 0, summaries = 0
  const inputs: any[] = [], summaryInputs: any[] = []
  const server = await modelServer(({ body }, response) => {
    if (synthetic(body, response)) return
    if (body.messages[0].content.startsWith('Synthetic compaction')) { textStream(response, 'summary test'); return }
    expect(body.stream_options).toEqual({ include_usage: true })
    if (body.messages.at(-1).content === instruction) {
      summaries++; summaryInputs.push(body.messages)
      expect(requests).toBe(4)
      expect(body.messages.some((m: any) => m.content?.startsWith('ROUND_3'))).toBe(false)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(frame({ content: 'Summary of prior work' }) + frame({}, 'stop') + 'data: {"choices":[],"usage":{"prompt_tokens":3000,"completion_tokens":20}}\n\ndata: [DONE]\n\n'); return
    }
    requests++; inputs.push(body.messages)
    if (requests === 4) {
      expect(summaries).toBe(0)
      expect(Buffer.byteLength(JSON.stringify(body.messages))).toBeGreaterThan(30000)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(frame({ content: 'PARTIAL_NOT_FINAL' }) + 'data: {"error":{"code":"context_length_exceeded"}}\n\n'); return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (requests <= 3) response.end(frame({ content: 'ROUND_' + requests + ':' + '中'.repeat(5000), tool_calls: [{ index: 0, id: 'list-' + requests, type: 'function', function: { name: 'list', arguments: '{"kind":"capability"}' } }] }) + frame({}, 'tool_calls') + 'data: {"choices":[],"usage":{"prompt_tokens":2000,"completion_tokens":100}}\n\ndata: [DONE]\n\n')
    else response.end(frame({ content: 'FINAL_COMPLETED' }) + frame({}, 'stop') + 'data: {"choices":[],"usage":{"prompt_tokens":3000,"completion_tokens":10}}\n\ndata: [DONE]\n\n')
  })
  const launch = () => electron.launch({ executablePath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', PLIUNA_TEST_DATA: root } })
  let app = await launch(), page = await app.firstWindow()
  const call = async (q: any): Promise<any> => { const r = await page.evaluate(q => window.pliuna.request(q), q); if (!r.ok) throw Error(r.error.code); return r.data }
  try {
    await call({ type: 'model.configure', configuration: { id: 'main', base_url: server.url, wire_model_id: 'synthetic', context_tokens: 30000, max_output_tokens: 128000, compatibility_profile: 'chat-max-tokens' }, api_key: 'synthetic-only', remember_connection: true, confirm_plaintext_storage: true, confirm_memory_only: true })
    await call({ type: 'model.test', model_id: 'main', role: 'main', confirm_cost: true })
    const task = (await call({ type: 'task.create', title: 'Provider context recovery' })).task.id
    const run = await call({ type: 'task.submit', task_id: task, text: 'Continue the isolated task', model_config_id: 'main', attachments: [] })
    await expect.poll(async () => { const r = (await call({ type: 'task.snapshot', task_id: task })).runs.find((r: any) => r.id === run.run_id); if (r?.state === 'failed') throw Error(r.primary_reason); return r?.state }).toBe('completed')
    expect(requests).toBe(5); expect(summaries).toBe(1)
    const resumed = inputs[4]
    expect(resumed[1].content).toContain('处理到一半')
    expect(resumed[1].content).toContain('PARTIAL_NOT_FINAL')
    expect(resumed.slice(-4)).toEqual(inputs[3].slice(-4))
    expect(resumed.filter((m: any) => m.content === '{"request":"Continue the isolated task"}')).toHaveLength(1)
    const snapshot = await call({ type: 'task.snapshot', task_id: task }), status = await call({ type: 'context.status', task_id: task })
    expect(snapshot.records.filter((r: any) => r.kind === 'model.tool_result')).toHaveLength(3)
    expect(snapshot.records.filter((r: any) => r.kind === 'model.response')).toHaveLength(4)
    expect(snapshot.records.find((r: any) => r.kind === 'message.assistant.partial').payload.text).toBe('PARTIAL_NOT_FINAL')
    const count = server.exchanges.length, settings = await readFile(join(root, 'settings.json')), auth = await readFile(join(root, 'auth.json'))
    await app.close(); app = await launch(); page = await app.firstWindow()
    expect(await call({ type: 'context.status', task_id: task })).toEqual(status)
    expect((await call({ type: 'task.snapshot', task_id: task })).records).toEqual(snapshot.records)
    expect(await readFile(join(root, 'settings.json'))).toEqual(settings); expect(await readFile(join(root, 'auth.json'))).toEqual(auth)
    expect(server.exchanges).toHaveLength(count)
    const continued = await call({ type: 'task.submit', task_id: task, text: 'Continue after restart', model_config_id: 'main', attachments: [] })
    await expect.poll(async () => { const r = (await call({ type: 'task.snapshot', task_id: task })).runs.find((r: any) => r.id === continued.run_id); if (r?.state === 'failed') throw Error(r.primary_reason); return r?.state }).toBe('completed')
    expect(requests).toBe(6); expect(summaries).toBe(1)
  } finally { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.destroy())).catch(() => {}); await app.close().catch(() => {}); await server.close() }
})
