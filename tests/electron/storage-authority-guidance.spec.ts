import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
const instruction = readFileSync('src/runtime/model/prompts/summary-v0.1.txt', 'utf8')
import { modelServer, synthetic, textStream, hostToolStream } from '../helpers/model-server'
const executablePath: string = createRequire(import.meta.url)('electron')

test('saved messages, authority guidance and original sources survive three summaries and an isolated restart', async () => {
  test.setTimeout(90000)
  const root = await mkdtemp(join(tmpdir(), 'pliuna-storage-authority-desktop-'))
  let summaries = 0
  const server = await modelServer(({ body }, response) => {
    if (synthetic(body, response)) return
    expect(body).not.toHaveProperty('max_tokens'); expect(body).not.toHaveProperty('max_completion_tokens')
    if (body.messages.at(-1).content === instruction) {
      summaries++
      if (summaries > 1) expect(body.messages.some((message: any) => message.content === '工作摘要：\nKeep destination Cedar; verification remains pending.')).toBe(true)
      textStream(response, 'Keep destination Cedar; verification remains pending.'); return
    }
    const input = JSON.parse(body.messages.findLast((message: any) => message.role === 'user').content)
    expect(Object.keys(input)).toEqual(['request'])
    if (input.request === 'Create structured state' && body.messages.at(-1).role !== 'tool') {
      hostToolStream(response, 'write', { type: 'task_data.create', data: { schema: { type: 'object', properties: { destination: { type: 'string' } }, required: ['destination'], additionalProperties: false }, value: { destination: 'Cedar' }, references: [] } }); return
    }
    textStream(response, 'Accepted message saved as a task record; structured object creation is separate. No historical approval grants current permission.')
  })
  const launch = () => electron.launch({ executablePath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', PLIUNA_TEST_DATA: root, PLIUNA_ENABLE_VIEW_REPLACEMENT: '1' } })
  let app = await launch(), page = await app.firstWindow()
  const call = async (request: any): Promise<any> => { const reply = await page.evaluate(q => window.pliuna.request(q), request); if (!reply.ok) throw Error(reply.error.code); return reply.data }
  try {
    await call({ type: 'model.configure', configuration: { id: 'isolated', base_url: server.url, wire_model_id: 'synthetic', context_tokens: 1000000, compatibility_profile: 'chat-max-tokens' }, api_key: 'synthetic-only', remember_connection: true, confirm_plaintext_storage: true, confirm_memory_only: true })
    await call({ type: 'model.test', model_id: 'isolated', role: 'main', confirm_cost: true })
    const task = (await call({ type: 'task.create', title: 'Storage and authority isolated' })).task.id
    const submit = async (text: string) => { const job = await call({ type: 'task.submit', task_id: task, text, model_config_id: 'isolated', attachments: [] }); await expect.poll(async () => (await call({ type: 'task.snapshot', task_id: task })).runs.find((run: any) => run.id === job.run_id)?.state).toBe('completed') }
    const list = async (kind: string) => (await call({ type: 'task.query', task_id: task, query: { type: 'list', input: { kind } } })).items
    await submit('Remember destination Cedar; verification pending. Only create; do not change layout.')
    expect(await list('task_data')).toHaveLength(0)
    const originals = await list('message'); expect(originals.length).toBeGreaterThanOrEqual(2)
    for (let n = 1; n <= 3; n++) {
      if (n > 1) await submit('Clarification: no layout changes; this does not establish a previous grant.')
      const job = await call({ type: 'context.compact', task_id: task, model_config_id: 'isolated', confirm_cost: true })
      await expect.poll(async () => (await call({ type: 'task.snapshot', task_id: task })).runs.find((run: any) => run.id === job.run_id)?.state).toBe('completed')
      expect((await call({ type: 'context.status', task_id: task })).current.version).toBe(2)
      expect(await list('task_data')).toHaveLength(0)
    }
    expect(summaries).toBe(3)
    await submit('Create structured state')
    expect(await list('task_data')).toHaveLength(1)
    const summary = await call({ type: 'context.status', task_id: task }), messages = await list('message'), objects = await list('task_data')
    const settings = await readFile(join(root, 'settings.json')), auth = await readFile(join(root, 'auth.json')), count = server.exchanges.length
    await app.close(); app = await launch(); page = await app.firstWindow(); await page.waitForFunction(() => !!window.pliuna)
    expect(await call({ type: 'context.status', task_id: task })).toEqual(summary)
    expect(await list('message')).toEqual(messages); expect(await list('task_data')).toEqual(objects)
    expect(await readFile(join(root, 'settings.json'))).toEqual(settings); expect(await readFile(join(root, 'auth.json'))).toEqual(auth)
    expect(server.exchanges).toHaveLength(count)
  } finally { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy())).catch(() => {}); await app.close().catch(() => {}); await server.close() }
})
