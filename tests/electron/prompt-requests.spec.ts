import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
const instruction = readFileSync('src/runtime/model/prompts/summary-v0.1.txt', 'utf8')
import { modelServer, synthetic, textStream, toolStream } from '../helpers/model-server'

const executablePath: string = createRequire(import.meta.url)('electron')
const schema = { type: 'object', properties: { stage: { type: 'string' } }, required: ['stage'], additionalProperties: false }

test('approved prompts, assisted replacement and text summary survive isolated restart with saved role settings', async () => {
  test.setTimeout(90000)
  const root = await mkdtemp(join(tmpdir(), 'pliuna-approved-prompts-desktop-'))
  const captured: { label: string; body: any }[] = []
  const server = await modelServer(({ body }, res) => {
    if (synthetic(body, res)) return
    const prompt = body.messages[0].content
    if (prompt.startsWith('你是 Pliuna 的单次动作辅助审批评估器。')) {
      captured.push({ label: 'approval', body })
      expect(body).not.toHaveProperty('max_tokens'); expect(body).not.toHaveProperty('max_completion_tokens')
      const input = JSON.parse(body.messages[1].content)
      expect(input.action).toMatchObject({ type: 'task_data.replace', expected_revision: 1, value: { stage: 'updated' } })
      textStream(res, '{"decision":"approve","reason":"The exact stage replacement matches the user request."}'); return
    }
    expect(body.max_tokens).toBe(7777)
    if (body.messages.at(-1).content === instruction) {
      captured.push({ label: 'summary', body }); expect(body.tools).toBeUndefined()
      textStream(res, 'Keep the updated stage.'); return
    }
    const input = JSON.parse(body.messages.findLast((message: any) => message.role === 'user' && !message.content.startsWith('工作摘要：')).content)
    captured.push({ label: 'main', body })
    expect(Object.keys(input)).toEqual(['request'])
    expect(body.tools.map((tool: any) => tool.function.name)).toEqual(['list', 'read', 'write', 'call'])
    expect(Buffer.byteLength(JSON.stringify(body.tools))).toBeLessThan(4000)
    for (const tool of body.tools) { expect(tool.function.description).toContain('示例：'); expect(JSON.stringify(tool.function.parameters)).not.toMatch(/oneOf|\$defs/) }
    if (body.messages.at(-1).role === 'tool') { textStream(res, 'The stage result is recorded.'); return }
    if (input.request.startsWith('replace ')) toolStream(res, 'write', { operation: 'task_data.replace', input_json: JSON.stringify({ id: input.request.slice(8), expected_revision: 1, value: { stage: 'updated' }, references: [] }) })
    else toolStream(res, 'write', { operation: 'task_data.create', input_json: JSON.stringify({ data: { schema, value: { stage: 'initial' }, references: [] } }) })
  })
  const launch = () => electron.launch({ executablePath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', PLIUNA_TEST_DATA: root, PLIUNA_ENABLE_VIEW_REPLACEMENT: '1' } })
  let app = await launch(), page = await app.firstWindow()
  const call = async (request: any): Promise<any> => {
    const result = await page.evaluate(request => window.pliuna.request(request), request)
    if (!result.ok) throw Error(result.error.code)
    return result.data
  }
  try {
    for (const id of ['main', 'approval']) {
      await call({ type: 'model.configure', configuration: { id, base_url: server.url, wire_model_id: 'synthetic-only', context_tokens: 240000, ...(id === 'main' ? { max_output_tokens: 7777 } : {}), compatibility_profile: 'chat-max-tokens' }, api_key: 'synthetic-only', confirm_memory_only: true, remember_connection: true, confirm_plaintext_storage: true })
      await call({ type: 'model.test', model_id: id, role: id, confirm_cost: true })
    }
    await call({ type: 'approval.configure', mode: 'assisted', model_id: 'approval', confirm_external_processing: true })
    const task = (await call({ type: 'task.create', title: 'Approved prompt restart' })).task.id
    const wait = async (run: string) => expect.poll(async () => (await call({ type: 'task.snapshot', task_id: task })).runs.find((item: any) => item.id === run)?.state).toBe('completed')
    const submit = async (text: string) => wait((await call({ type: 'task.submit', task_id: task, text, model_config_id: 'main', attachments: [] })).run_id)
    await submit('create stage')
    const id = (await call({ type: 'task.snapshot', task_id: task })).task_data.items[0].id
    await submit('replace ' + id)
    expect(await call({ type: 'task.data.read', task_id: task, id, expected_revision: 2 })).toMatchObject({ value: { stage: 'updated' } })
    const compact = await call({ type: 'context.compact', task_id: task, model_config_id: 'main', confirm_cost: true })
    await wait(compact.run_id)
    expect(captured.map(item => item.label)).toEqual(['main', 'main', 'main', 'approval', 'main', 'summary'])
    const snapshot = await call({ type: 'task.snapshot', task_id: task }), summary = await call({ type: 'context.status', task_id: task })
    const settings = await readFile(join(root, 'settings.json')), auth = await readFile(join(root, 'auth.json')), network = server.exchanges.length
    await app.close(); app = await launch(); page = await app.firstWindow(); await page.waitForFunction(() => !!window.pliuna)
    expect((await call({ type: 'task.snapshot', task_id: task })).records).toEqual(snapshot.records)
    expect(await call({ type: 'task.data.read', task_id: task, id, expected_revision: 2 })).toMatchObject({ value: { stage: 'updated' } })
    expect(await call({ type: 'context.status', task_id: task })).toEqual(summary)
    expect(await readFile(join(root, 'settings.json'))).toEqual(settings); expect(await readFile(join(root, 'auth.json'))).toEqual(auth)
    expect(server.exchanges).toHaveLength(network)
    expect(await call({ type: 'context.compact', task_id: task, model_config_id: 'main', confirm_cost: true })).toMatchObject({ status: 'unchanged', reason: 'no_new_history' })
    expect(server.exchanges).toHaveLength(network)
    await submit('create stage after restart')
    expect(captured.at(-1)!.body.max_tokens).toBe(7777)
    await writeFile(join(root, 'synthetic-request-bodies.json'), JSON.stringify(captured, null, 2))
    console.log('Preserved fresh synthetic prompt regression directory:', root)
  } finally {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy())).catch(() => {})
    await app.close().catch(() => {}); await server.close()
  }
})
