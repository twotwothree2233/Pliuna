import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { modelServer } from '../helpers/model-server'
import { exportCheckScenario } from '../helpers/export-check-scenario'

const executablePath: string = createRequire(import.meta.url)('electron')
test('delivers paged export diagnosis, repairs classification and preserves full HTML across isolated restart', async () => {
  test.setTimeout(90000)
  const root = await mkdtemp(join(tmpdir(), 'pliuna-export-check-desktop-')), target = join(root, 'complete.html')
  const scene = exportCheckScenario(), server = await modelServer(scene.handle)
  const launch = () => electron.launch({ executablePath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', PLIUNA_TEST_DATA: root, PLIUNA_ENABLE_VIEW_REPLACEMENT: '1' } })
  let app = await launch(), page = await app.firstWindow()
  const call = async (request: any): Promise<any> => {
    const response = await page.evaluate(request => window.pliuna.request(request), request)
    if (!response.ok) throw Error(response.error.code)
    return response.data
  }
  try {
    await call({ type: 'model.configure', configuration: { id: 'export-check', base_url: server.url, wire_model_id: 'synthetic', context_tokens: 240000, compatibility_profile: 'chat-max-tokens' }, api_key: 'synthetic-only', confirm_memory_only: true, remember_connection: true, confirm_plaintext_storage: true })
    await call({ type: 'model.test', model_id: 'export-check', role: 'main', confirm_cost: true })
    const task = (await call({ type: 'task.create', title: 'Export diagnosis regression' })).task.id
    await page.reload(); await page.getByRole('button', { name: /Export diagnosis regression/ }).click()
    const run = await call({ type: 'task.submit', task_id: task, text: 'Publish a complete non-personal verification table.', model_config_id: 'export-check', attachments: [] })
    await expect.poll(async () => {
      const snapshot = await call({ type: 'task.snapshot', task_id: task })
      for (const update of snapshot.surface_updates ?? []) await call({ type: 'surface.respond', task_id: task, action_id: update.action_id, proceed: true, confirm_discard: false })
      return snapshot.runs.find((item: any) => item.id === run.run_id)?.state
    }, { timeout: 40000 }).toBe('completed')
    expect(scene.failure).toBeUndefined(); expect(scene.checks.map(c => c.complete)).toEqual([false, true]); expect(scene.pages.length).toBeGreaterThan(1)
    await expect(page.locator('.managed').getByText('ROW-1', { exact: true })).toBeVisible()
    await expect(page.locator('.managed').getByText('必须交付的口径说明', { exact: true })).toBeVisible()
    const before = await call({ type: 'task.snapshot', task_id: task })
    expect(before.views[0].revision).toBe(2)
    expect(await call({ type: 'export.list', task_id: task })).toEqual([])
    await page.getByRole('button', { name: '导出', exact: true }).click()
    await page.getByRole('button', { name: '检查当前导出选择', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: '完整性检查通过' })).toBeVisible()
    expect(await call({ type: 'export.list', task_id: task })).toEqual([])
    await page.getByRole('button', { name: '固定快照并预览', exact: true }).click()
    await expect(page.frameLocator('iframe[title="固定快照离线预览"]').getByText('ROW-2', { exact: true })).toBeVisible()
    await app.evaluate(({ dialog }, target) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }) }, target)
    await page.getByRole('button', { name: '选择位置并保存 HTML', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: '导出状态：saved' })).toBeVisible()
    const html = await readFile(target, 'utf8')
    for (const text of ['ROW-1', 'ROW-2', '合计30', '必须交付的口径说明']) expect(html).toContain(text)
    expect(html).not.toContain('此区域未导出'); expect(html).not.toMatch(/<script|<input|<button|<iframe/)
    const originals: any[] = [], events = (await call({ type: 'task.query', task_id: task, query: { type: 'list', input: { kind: 'event', limit: 200 } } })).items
    for (const event of events.filter((e: any) => e.kind === 'model.tool_result')) {
      let text = '', cursor: string | undefined
      do {
        const part = await call({ type: 'task.query', task_id: task, query: { type: 'read', input: { target: { kind: 'event', id: event.id }, ...(cursor ? { cursor } : {}) } } })
        if (!part.representation) { originals.push(part.data); break }
        text += part.data.text; cursor = part.next_cursor
        if (!cursor) originals.push(JSON.parse(text))
      } while (cursor)
    }
    for (const diagnostic of scene.pages) expect(originals.find(record => record.payload.message.tool_call_id === diagnostic.id).payload.message.content).toBe(diagnostic.content)
    const settings = await readFile(join(root, 'settings.json')), auth = await readFile(join(root, 'auth.json')), network = server.exchanges.length
    await app.close(); app = await launch(); page = await app.firstWindow()
    await page.getByRole('button', { name: /Export diagnosis regression/ }).click()
    await expect(page.locator('.managed').getByText('ROW-2', { exact: true })).toBeVisible()
    const restored = await call({ type: 'task.snapshot', task_id: task })
    expect(restored.records).toEqual(before.records); expect(restored.views).toEqual(before.views)
    expect(await readFile(join(root, 'settings.json'))).toEqual(settings); expect(await readFile(join(root, 'auth.json'))).toEqual(auth)
    expect(await readFile(target, 'utf8')).toBe(html); expect(server.exchanges).toHaveLength(network)
    await writeFile(join(root, 'synthetic-export-check-evidence.json'), JSON.stringify({ requests: scene.requests, checks: scene.checks, diagnostic_pages: scene.pages.length, real_api_requests: 0, restart_requests: 0 }, null, 2))
    console.log(JSON.stringify({ benchmark: 'export-check-restart', requests: scene.requests.length, diagnostic_pages: scene.pages.length, real_api_requests: 0, restart_requests: 0 }))
    console.log('Preserved fresh synthetic export-check directory:', root)
  } finally {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy())).catch(() => {})
    await app.close().catch(() => {}); await server.close()
  }
})
