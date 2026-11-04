import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { modelServer } from '../helpers/model-server'
import { contractScenario } from '../helpers/contract-scenario'

const executablePath: string = createRequire(import.meta.url)('electron')

test('discovers, receives full contract pages, publishes and exports the returned example across isolated restart', async () => {
  test.setTimeout(60000)
  const root = await mkdtemp(join(tmpdir(), 'trellis-contract-desktop-')), target = join(root, 'example.html')
  const scene = contractScenario(), server = await modelServer(scene.handle)
  const launch = () => electron.launch({ executablePath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', TRELLIS_TEST_DATA: root, TRELLIS_ENABLE_VIEW_REPLACEMENT: '1' } })
  let app = await launch(), page = await app.firstWindow()
  const call = async (request: any): Promise<any> => {
    const response = await page.evaluate(request => window.trellis.request(request), request)
    if (!response.ok) throw Error(response.error.code)
    return response.data
  }
  try {
    await call({ type: 'model.configure', configuration: { id: 'contract', base_url: server.url, wire_model_id: 'synthetic-only', context_tokens: 240000, compatibility_profile: 'chat-max-tokens' }, api_key: 'synthetic-only', confirm_memory_only: true, remember_connection: true, confirm_plaintext_storage: true })
    await call({ type: 'model.test', model_id: 'contract', role: 'main', confirm_cost: true })
    const task = (await call({ type: 'task.create', title: 'Contract delivery regression' })).task.id
    await page.reload()
    await page.getByRole('button', { name: /Contract delivery regression/ }).click()
    await call({ type: 'task.submit', task_id: task, text: 'Create the example learning content.', model_config_id: 'contract', attachments: [] })
    await expect.poll(async () => (await call({ type: 'task.snapshot', task_id: task })).runs[0].state).toBe('completed')
    expect(scene.failure).toBeUndefined()
    expect(scene.pages.length).toBeGreaterThan(1)
    expect(Buffer.byteLength(scene.pages[0]!.content)).toBeGreaterThan(4000)
    expect(scene.contract.example.operation).toBe('surface.update')
    await expect(page.locator('.managed').getByText('内容', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '导出', exact: true }).click()
    await page.getByRole('button', { name: '固定快照并预览', exact: true }).click()
    await expect(page.frameLocator('iframe[title="固定快照离线预览"]').getByText('内容', { exact: true })).toBeVisible()
    await app.evaluate(({ dialog }, target) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }) }, target)
    await page.getByRole('button', { name: '选择位置并保存 HTML', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: '导出状态：saved' })).toBeVisible()
    const html = await readFile(target, 'utf8')
    expect(html).toContain('内容'); expect(html).not.toContain('此区域未导出')
    expect(html).not.toMatch(/<script|<input|<button|<textarea|<iframe/)
    const snapshot = await call({ type: 'task.snapshot', task_id: task })
    const events = (await call({ type: 'task.query', task_id: task, query: { type: 'list', input: { kind: 'event', limit: 200 } } })).items
    const originals: any[] = []
    for (const event of events) {
      let text = '', cursor: string | undefined
      do {
        const part = await call({ type: 'task.query', task_id: task, query: { type: 'read', input: { target: { kind: 'event', id: event.id }, ...(cursor ? { cursor } : {}) } } })
        if (!part.representation) { originals.push(part.data); break }
        text += part.data.text; cursor = part.next_cursor
        if (!cursor) originals.push(JSON.parse(text))
      } while (cursor)
    }
    for (const entry of scene.pages) {
      const record = originals.find((record: any) => record.kind === 'model.tool_result' && record.payload.message.tool_call_id === entry.id)
      expect(record.payload.message.content).toBe(entry.content)
    }
    for (const body of scene.requests) { expect(body).not.toHaveProperty('max_tokens'); expect(body).not.toHaveProperty('max_completion_tokens') }
    const settings = await readFile(join(root, 'settings.json')), auth = await readFile(join(root, 'auth.json')), network = server.exchanges.length
    await writeFile(join(root, 'synthetic-request-bodies.json'), JSON.stringify(scene.requests, null, 2))
    await app.close(); app = await launch(); page = await app.firstWindow()
    await page.getByRole('button', { name: /Contract delivery regression/ }).click()
    await expect(page.locator('.managed').getByText('内容', { exact: true })).toBeVisible()
    const restored = await call({ type: 'task.snapshot', task_id: task })
    expect(restored.records).toEqual(snapshot.records); expect(restored.views).toEqual(snapshot.views)
    expect(await readFile(join(root, 'settings.json'))).toEqual(settings)
    expect(await readFile(join(root, 'auth.json'))).toEqual(auth)
    expect(await readFile(target, 'utf8')).toBe(html)
    expect(server.exchanges).toHaveLength(network)
    console.log(JSON.stringify({ benchmark: 'contract-desktop-restart', page_bytes: scene.pages.map(page => Buffer.byteLength(page.content)), requests: scene.requests.length, real_api_requests: 0, restart_requests: server.exchanges.length - network }))
    console.log('Preserved fresh synthetic contract regression directory:', root)
  } finally {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy())).catch(() => {})
    await app.close().catch(() => {}); await server.close()
  }
})
