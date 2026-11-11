import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { modelServer, synthetic, textStream, frame } from '../helpers/model-server'

const executablePath: string = createRequire(import.meta.url)('electron')
const instruction = readFileSync('src/runtime/model/prompts/summary-v0.1.txt', 'utf8')

test('compacts three completed request boundaries, preserves exact rounds, and rejects stale-usage installation across restart', async () => {
  test.setTimeout(90000)
  const root = await mkdtemp(join(tmpdir(), 'pliuna-capacity-closure-'))
  const mainInputs: any[][] = [], summaryInputs: any[][] = []
  let oversized = false, resource = ''
  const server = await modelServer(({ body }, response) => {
    if (synthetic(body, response)) return
    if (body.messages[0].content.startsWith('Synthetic compaction')) { textStream(response, 'summary verification'); return }
    expect(body.max_tokens).toBe(128000)
    expect(body.stream_options).toEqual({ include_usage: true })
    if (body.messages.at(-1).content === instruction) {
      summaryInputs.push(body.messages)
      textStream(response, oversized ? 'x'.repeat(245000) : 'CHECKPOINT_' + summaryInputs.length)
      return
    }
    mainInputs.push(body.messages)
    const number = mainInputs.length
    if (number === 3) {
      const listed = JSON.parse(body.messages.at(-1).content)
      resource = listed.data.items.find((item: any) => item.display_name === 'Exactly once').id
    }
    const args = number === 1
      ? { name: 'write', arguments: { operation: 'resource.create', input_json: JSON.stringify({ display_name: 'Exactly once', content: { type: 'text', text: 'FULL_ORIGINAL_中😀' } }) } }
      : number === 2 ? { name: 'list', arguments: { kind: 'resource' } }
      : { name: 'read', arguments: { kind: 'resource', id: resource } }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(frame(number <= 3 ? {
      content: 'ROUND_' + number,
      tool_calls: [{ index: 0, id: 'boundary-' + number, type: 'function', function: { name: args.name, arguments: JSON.stringify(args.arguments) } }]
    } : { content: 'FINAL_DELIVERED' }) + frame({}, number <= 3 ? 'tool_calls' : 'stop') +
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: number <= 3 ? 216000 : 3000, completion_tokens: 100 } })}\n\ndata: [DONE]\n\n`)
  })
  const launch = () => electron.launch({ executablePath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', PLIUNA_TEST_DATA: root } })
  let app = await launch(), page = await app.firstWindow()
  const call = async (q: any): Promise<any> => {
    const r = await page.evaluate(q => window.pliuna.request(q), q)
    if (!r.ok) throw Error(r.error.code)
    return r.data
  }
  try {
    await call({ type: 'model.configure', configuration: { id: 'closure', base_url: server.url, wire_model_id: 'synthetic', context_tokens: 240000, max_output_tokens: 128000, compatibility_profile: 'chat-max-tokens' }, api_key: 'synthetic-only', remember_connection: true, confirm_plaintext_storage: true, confirm_memory_only: true })
    await call({ type: 'model.test', model_id: 'closure', role: 'main', confirm_cost: true })
    const task = (await call({ type: 'task.create', title: 'Capacity closure synthetic' })).task.id
    const wait = async (id: string, state: string) => expect.poll(async () => (await call({ type: 'task.snapshot', task_id: task })).runs.find((r: any) => r.id === id)?.state).toBe(state)
    await wait((await call({ type: 'task.submit', task_id: task, text: 'Retain this exact goal 中😀; create one result and finish.', model_config_id: 'closure', attachments: [] })).run_id, 'completed')
    expect(mainInputs).toHaveLength(4)
    expect(summaryInputs).toHaveLength(3)
    for (let index = 0; index < 3; index++) {
      const sent = summaryInputs[index]!.slice(0, -1)
      expect(sent.slice(0, mainInputs[index]!.length)).toEqual(mainInputs[index])
      expect(sent.slice(-2)).toMatchObject([{ role: 'assistant', content: 'ROUND_' + (index + 1) }, { role: 'tool', tool_call_id: 'boundary-' + (index + 1) }])
      const rounds = sent.slice(3).filter((m: any) => m.role === 'assistant' || m.role === 'tool')
      expect(mainInputs[index + 1]!.slice(-Math.min(rounds.length, 4))).toEqual(sent.slice(-Math.min(rounds.length, 4)))
      expect(mainInputs[index + 1]!.filter((m: any) => m.content?.startsWith('工作摘要：'))).toHaveLength(1)
      expect(mainInputs[index + 1]!.filter((m: any) => m.content?.includes('Retain this exact goal'))).toHaveLength(1)
    }
    const old = await call({ type: 'context.status', task_id: task })
    expect(old.current).toMatchObject({ version: 2, text: 'CHECKPOINT_3' })
    const snapshot = await call({ type: 'task.snapshot', task_id: task })
    expect(snapshot.records.filter((r: any) => r.kind === 'model.tool_result')).toHaveLength(3)
    expect(snapshot.records.filter((r: any) => r.kind === 'model.response')).toHaveLength(4)
    expect(snapshot.records.find((r: any) => r.kind === 'message.assistant' && r.payload.text === 'FINAL_DELIVERED')).toBeTruthy()
    oversized = true
    await wait((await call({ type: 'context.compact', task_id: task, model_config_id: 'closure', confirm_cost: true })).run_id, 'failed')
    expect(summaryInputs).toHaveLength(4)
    expect(await call({ type: 'context.status', task_id: task })).toEqual(old)
    const failed = await call({ type: 'task.snapshot', task_id: task })
    expect(failed.runs[0].primary_reason).toBe('CONTEXT_MINIMUM_TOO_LARGE')
    expect(failed.records.find((r: any) => r.kind === 'model.context.rejected').payload.stage).toBe('summary-install')
    const count = server.exchanges.length, settings = await readFile(join(root, 'settings.json')), auth = await readFile(join(root, 'auth.json'))
    await app.close(); app = await launch(); page = await app.firstWindow()
    expect(await call({ type: 'context.status', task_id: task })).toEqual(old)
    expect((await call({ type: 'task.snapshot', task_id: task })).records).toEqual(failed.records)
    expect(await readFile(join(root, 'settings.json'))).toEqual(settings)
    expect(await readFile(join(root, 'auth.json'))).toEqual(auth)
    expect(server.exchanges).toHaveLength(count)
    const audit = await app.evaluate((_electron, { root, task }) => {
      const require = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')
      const db = new (require('better-sqlite3'))(root + '/pliuna.sqlite', { readonly: true })
      try { return { resources: db.prepare('SELECT count(*) n FROM task_resources WHERE task_id=?').get(task).n, actions: db.prepare('SELECT count(*) n FROM actions WHERE task_id=?').get(task).n } }
      finally { db.close() }
    }, { root, task })
    expect(audit).toEqual({ resources: 1, actions: 1 })
    console.log('CAPACITY_CLOSURE_SCENE', root)
  } finally {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.destroy())).catch(() => {})
    await app.close().catch(() => {}); await server.close()
  }
})
