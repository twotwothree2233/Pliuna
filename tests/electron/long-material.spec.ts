import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { modelServer, synthetic, hostToolStream, toolStream, frame } from '../helpers/model-server'
const electronPath: string = createRequire(import.meta.url)('electron')

test('long plaintext selection, independent tail evidence, request accounting and isolated restart reuse', async () => {
  test.setTimeout(90000)
  const root = await mkdtemp(join(tmpdir(), 'trellis-long-material-desktop-')), marker = randomUUID(), text = 'a'.repeat(32999) + '\n' + marker
  const input = join(root, 'synthetic-long.txt'); await writeFile(input, text)
  let resource = '', business = 0, firstRun = true
  const server = await modelServer(({ body }, res) => {
    if (synthetic(body, res)) return
    business++
    const last = body.messages.at(-1)
    if (last.role !== 'tool') {
      if (firstRun) expect(JSON.stringify(body.messages)).not.toContain(marker)
      toolStream(res, 'read', { kind: 'resource', id: resource, max_chars: 32000, selection: firstRun ? { view: 'text' } : { view: 'text', find: marker } })
      return
    }
    const result = JSON.parse(last.content).data
    expect(result.content_selection).toBe(true)
    if (!firstRun) {
      expect(result.completion.search_complete).toBe(true)
      expect(result.data.matches).toHaveLength(1)
      expect(result.data.matches[0].text).toContain(marker)
    }
    if (result.next_cursor) {
      expect(result.actual_range.chars).toBe(32000); expect(result.data.text).toHaveLength(32000)
      hostToolStream(res, 'read', { target: { kind: 'resource', id: resource }, cursor: result.next_cursor }, '', 'tail-call')
      return
    }
    if (firstRun) expect(result.data.text).toContain(marker)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(frame({ role: 'assistant', content: 'Read tail evidence: ' + marker }) + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 123, completion_tokens: 7 } })}\n\n` + 'data: [DONE]\n\n')
  })
  const launch = () => electron.launch({ executablePath: electronPath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', TRELLIS_TEST_DATA: root, TRELLIS_ENABLE_VIEW_REPLACEMENT: '1' } })
  let app = await launch(), page = await app.firstWindow()
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  const call = async (request: any): Promise<any> => {
    const response = await page.evaluate(r => window.trellis.request(r), request)
    if (!response.ok) throw Error(response.error.code)
    return response.data
  }
  try {
    await call({ type: 'model.configure', configuration: { id: 'long-fixture', base_url: server.url, wire_model_id: 'synthetic', context_tokens: 1000000, max_output_tokens: 1024, compatibility_profile: 'chat-max-tokens' }, api_key: 'synthetic-only', confirm_memory_only: true, remember_connection: true, confirm_plaintext_storage: true })
    await call({ type: 'model.test', model_id: 'long-fixture', role: 'main', confirm_cost: true })
    await page.getByRole('button', { name: '创建第一个任务', exact: true }).click(); await page.getByLabel('任务名称').fill('Long material fixture'); await page.getByRole('button', { name: '创建任务', exact: true }).click()
    const task = (await call({ type: 'host.tasks' }))[0].id
    await app.evaluate(({ dialog }, path) => { (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, input)
    const imported = await call({ type: 'material.pick', task_id: task })
    await expect.poll(async () => (await call({ type: 'material.status', task_id: task, operation_id: imported.items[0].operation_id })).state).toBe('success')
    resource = (await call({ type: 'material.status', task_id: task, operation_id: imported.items[0].operation_id })).resource.id
    const request = await call({ type: 'request.submit', task_id: task, text: 'Read the tail marker from the selected long resource; never infer it from history.', model_config_id: 'long-fixture', resource_ids: [resource], import_ids: [] })
    await expect.poll(async () => (await call({ type: 'request.status', task_id: task, request_id: request.request_id })).run_state).toBe('completed')
    expect(business).toBe(3)
    const snapshot = await call({ type: 'task.snapshot', task_id: task }), run = snapshot.runs[0].id
    const before = server.exchanges.length
    const usage = page.getByRole('region', { name: '单次请求用量', exact: true }).first()
    await usage.getByRole('button', { name: '查询单次请求用量', exact: true }).click()
    await expect(usage.locator('details')).toHaveCount(3)
    await usage.locator('summary').last().click(); await expect(usage).toContainText('输入 123 / 输出 7 token')
    await usage.getByRole('button', { name: '查看此请求原用量事件', exact: true }).last().click(); await expect(usage.getByLabel('原用量事件')).toContainText('model.request.accounting')
    await page.getByRole('tab', { name: '资源', exact: true }).click()
    const browser = page.getByRole('region', { name: '全部资源分页浏览', exact: true })
    await browser.getByRole('button', { name: '刷新全部资源', exact: true }).click(); await browser.getByRole('button').filter({ hasText: resource }).click()
    await browser.locator('summary').filter({ hasText: /^正文分段读取$/ }).click()
    const reader = browser.getByRole('region', { name: '正文分段读取', exact: true })
    await reader.getByLabel('每段字符数').fill('32000'); await reader.getByRole('button', { name: '读取选定正文', exact: true }).click(); await expect(reader.getByRole('status')).toContainText('32000 字符')
    await reader.getByRole('button', { name: '读取下一段正文', exact: true }).click(); await expect(reader.locator('pre')).toContainText(marker)
    await reader.getByLabel('每段字符数').fill('32001'); await reader.getByRole('button', { name: '读取选定正文', exact: true }).click(); await expect(reader.getByRole('alert')).toContainText('1–32000')
    expect(server.exchanges).toHaveLength(before)
    await app.close(); app = await launch(); page = await app.firstWindow(); await page.getByRole('button', { name: /Long material fixture/ }).click()
    expect(server.exchanges).toHaveLength(before)
    const restored = await call({ type: 'task.query', task_id: task, query: { type: 'read', input: { target: { kind: 'run', id: run } } } })
    expect(restored.data.accounting.requests).toHaveLength(3); expect(restored.data.accounting.requests.at(-1).usage).toEqual({ prompt_tokens: 123, completion_tokens: 7 })
    firstRun = false
    const reuse = await call({ type: 'request.submit', task_id: task, text: 'Read the same existing resource tail again without creating or extracting anything.', model_config_id: 'long-fixture', resource_ids: [resource], import_ids: [] })
    await expect.poll(async () => (await call({ type: 'request.status', task_id: task, request_id: reuse.request_id })).run_state).toBe('completed')
    expect(business).toBe(5)
    expect((await call({ type: 'task.query', task_id: task, query: { type: 'list', input: { kind: 'call' } } })).items).toHaveLength(0)
    expect((await call({ type: 'task.query', task_id: task, query: { type: 'list', input: { kind: 'resource' } } })).items).toHaveLength(1)
    expect(errors).toEqual([])
  } finally { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.destroy())).catch(() => {}); await app.close().catch(() => {}); await server.close() }
})
