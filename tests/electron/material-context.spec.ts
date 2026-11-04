import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
const instruction = readFileSync('src/runtime/model/prompts/summary-v0.1.txt', 'utf8')
import { modelServer, synthetic, textStream, hostToolStream } from '../helpers/model-server'
const electronPath: string = createRequire(import.meta.url)('electron')

test('isolated material context: complete repeated reads, compaction, three summaries and restart', async () => {
  test.setTimeout(90000)
  const root = await mkdtemp(join(tmpdir(), 'trellis-context-repair-desktop-')), data = join(root, '.trellis'), marker = randomUUID(), text = '中😀'.repeat(15980) + marker
  const input = join(root, 'synthetic.txt'); await writeFile(input, text)
  let resource = '', summaries = 0, corrections = 0, phase = '', turn = 0
  const server = await modelServer(({ body }, res) => {
    if (synthetic(body, res)) return
    if (body.messages.at(-1).content === instruction) {
      summaries++
      const latest = JSON.parse(body.messages.findLast((message: any) => message.role === 'user' && message.content.startsWith('{"request"')).content)
      if (latest.request.startsWith('correction')) corrections++
      textStream(res, 'Current city ' + corrections + '; verification pending.'); return
    }
    const host = JSON.parse(body.messages.findLast((m: any) => m.role === 'user').content)
    expect(host).not.toHaveProperty('host_context')
    if (host.request.startsWith('correction')) { textStream(res, 'Current correction noted; verification remains pending.'); return }
    const nextPhase = host.request.startsWith('repeat') ? 'repeat' : host.request.startsWith('capacity') ? 'capacity' : 'restored'
    if (phase !== nextPhase) { phase = nextPhase; turn = 0 }
    turn++
    if (phase === 'restored') { expect(body.messages.some((m: any) => m.content?.includes('Current city 3'))).toBe(true); textStream(res, 'Application records are local; model input is partial; restart does not resume. Current city 3, verification pending.'); return }
    if (turn === 1) { hostToolStream(res, 'read', { target: { kind: 'resource', id: resource }, content: { max_chars: 32000 } }, '', phase + '-first'); return }
    const result = body.messages.at(-1).role === 'tool' ? JSON.parse(body.messages.at(-1).content) : null
    if (phase === 'repeat') {
      if (turn === 2) { expect(result.data.data.text).toBe(text); hostToolStream(res, 'read', { target: { kind: 'resource', id: resource }, content: { max_chars: 32000 } }, '', 'repeat-second'); return }
      expect(result.data.data.text).toBe(text)
      expect(body.messages.filter((m: any) => m.role === 'tool' && m.content.includes(marker))).toHaveLength(2)
    } else {
      if (turn === 2) { expect(result.data.data.text).toBe(text); expect(JSON.stringify(body.messages)).toContain('工作摘要：'); hostToolStream(res, 'read', { target: { kind: 'resource', id: resource }, content: { max_chars: 1000 } }, '', 'capacity-small'); return }
      expect(result.data.actual_range.chars).toBe(1000)
    }
    expect(turn).toBe(3); textStream(res, 'Read evidence checked; application retains accepted task records. No business write was performed.')
  })
  const launch = () => electron.launch({ executablePath: electronPath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', TRELLIS_TEST_DATA: data, TRELLIS_ENABLE_VIEW_REPLACEMENT: '1' } })
  let app = await launch(), page = await app.firstWindow()
  const call = async (request: any): Promise<any> => { const response = await page.evaluate(r => window.trellis.request(r), request); if (!response.ok) throw Error(response.error.code); return response.data }
  try {
    for (const [id, capacity] of [['wide', 1000000], ['narrow', 125000]] as const) {
      await call({ type: 'model.configure', configuration: { id, base_url: server.url, wire_model_id: 'synthetic', context_tokens: capacity, max_output_tokens: 8192, compatibility_profile: 'chat-max-tokens' }, api_key: 'synthetic-only', confirm_memory_only: true, remember_connection: true, confirm_plaintext_storage: true })
      await call({ type: 'model.test', model_id: id, role: 'main', confirm_cost: true })
    }
    const task = (await call({ type: 'task.create', title: 'Context repair synthetic' })).task.id
    await app.evaluate(({ dialog }, path) => { (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, input)
    const imported = await call({ type: 'material.pick', task_id: task }); await expect.poll(async () => (await call({ type: 'material.status', task_id: task, operation_id: imported.items[0].operation_id })).state).toBe('success')
    resource = (await call({ type: 'material.status', task_id: task, operation_id: imported.items[0].operation_id })).resource.id
    const submit = async (owner: string, request: string, model = 'wide') => { const r = await call({ type: 'task.submit', task_id: owner, text: request, model_config_id: model, attachments: [] }); await expect.poll(async () => (await call({ type: 'task.snapshot', task_id: owner })).runs.find((run: any) => run.id === r.run_id)?.state).toBe('completed'); return r.run_id }
    await submit(task, 'repeat exact material')
    const events = (await call({ type: 'task.query', task_id: task, query: { type: 'list', input: { kind: 'event', limit: 200 } } })).items
    let originals = 0
    for (const event of events) if (event.kind === 'model.tool_result') {
      // Read original event fragments, not recent snapshot previews.
      let cursor: string | null = null, whole = '', original: any
      do { const part = await call({ type: 'task.query', task_id: task, query: { type: 'read', input: { target: { kind: 'event', id: event.id }, ...(cursor ? { cursor } : {}) } } }); if (!part.representation) { original = part.data; break }; whole += part.data.text; cursor = part.next_cursor; if (!cursor) original = JSON.parse(whole) } while (cursor)
      expect(JSON.parse(original.payload.message.content).data.data.text).toBe(text); originals++
    }
    expect(originals).toBe(2)
    // Use a separate task, so historical large excerpts do not confound the request-compaction scenario.
    const narrow = (await call({ type: 'task.create', title: 'Capacity feedback synthetic' })).task.id
    const batch = await call({ type: 'material.pick', task_id: narrow }); await expect.poll(async () => (await call({ type: 'material.status', task_id: narrow, operation_id: batch.items[0].operation_id })).state).toBe('success')
    const wideResource = resource; resource = (await call({ type: 'material.status', task_id: narrow, operation_id: batch.items[0].operation_id })).resource.id
    await submit(narrow, 'capacity explicit smaller read', 'narrow'); resource = wideResource
    for (let n = 1; n <= 3; n++) { await submit(task, 'correction Current city ' + n + '; verification pending'); await call({ type: 'context.compact', task_id: task, model_config_id: 'wide', confirm_cost: true }); await expect.poll(async () => (await call({ type: 'task.snapshot', task_id: task })).runs[0].state).toBe('completed'); expect((await call({ type: 'context.status', task_id: task })).current.text).toBe('Current city ' + n + '; verification pending.') }
    expect(summaries).toBeGreaterThanOrEqual(4); expect(corrections).toBe(3)
    await page.reload(); await page.getByRole('button', { name: /Context repair synthetic/ }).click()
    const panel = page.getByRole('region', { name: '上下文管理' })
    await panel.locator('details > summary').first().click()
    const beforeSourceRead = server.exchanges.length
    await panel.getByRole('button', { name: /查看保留原记录/ }).first().click()
    const selectedSource = panel.getByRole('region', { name: '选定摘要来源分页浏览' })
    await expect(selectedSource.getByRole('article')).toContainText('message.user')
    await expect(selectedSource.getByRole('article')).toContainText('correction Current city 3')
    expect(server.exchanges).toHaveLength(beforeSourceRead)
    const settings = await readFile(join(data, 'settings.json'), 'utf8'), auth = await readFile(join(data, 'auth.json'), 'utf8'), count = server.exchanges.length
    const beforeSummary = await call({ type: 'context.status', task_id: task }), beforeResource = await readFile(join(data, 'resources', resource))
    await app.close(); app = await launch(); page = await app.firstWindow(); await page.waitForFunction(() => !!window.trellis)
    expect(await call({ type: 'context.status', task_id: task })).toEqual(beforeSummary); expect(server.exchanges).toHaveLength(count)
    expect(await readFile(join(data, 'settings.json'), 'utf8')).toBe(settings); expect(await readFile(join(data, 'auth.json'), 'utf8')).toBe(auth); expect(await readFile(join(data, 'resources', resource))).toEqual(beforeResource)
    await submit(task, 'restored fact check')
    expect((await call({ type: 'task.query', task_id: task, query: { type: 'list', input: { kind: 'call' } } })).items).toHaveLength(0)
  } finally { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.destroy())).catch(() => {}); await app.close().catch(() => {}); await server.close() }
})
