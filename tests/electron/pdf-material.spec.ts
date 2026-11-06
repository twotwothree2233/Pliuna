import { openSettings } from '../helpers/settings-ui'
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { modelServer, synthetic, textStream, hostToolStream } from '../helpers/model-server'
import { pdfFixture } from '../helpers/pdf-fixture'
const electronPath: string = process.env.TRELLIS_CANDIDATE_EXECUTABLE || createRequire(import.meta.url)('electron')
test('PDF bundled runtime with empty PATH, source navigation and isolated restart without replay', async () => {
  test.setTimeout(90000)
  const root = await mkdtemp(join(tmpdir(), 'trellis-pdf-desktop-')), source = join(root, 'synthetic.pdf'), plugin = process.env.TRELLIS_CANDIDATE_PLUGIN || resolve('reference-plugins/pdf-text')
  await writeFile(source, pdfFixture())
  let resourceId = '', capability = '', business = 0
  const server = await modelServer(({ body }, res) => {
    if (synthetic(body, res)) return
    business++
    if (body.messages.at(-1).role === 'tool') return textStream(res, 'PDF_DESKTOP_DONE')
    hostToolStream(res, 'call', { capability, arguments: { resource_id: resourceId }, references: [] })
  })
  const launch = () => electron.launch({ executablePath: electronPath, args: process.env.TRELLIS_CANDIDATE_EXECUTABLE ? [] : ['.'], env: { ...Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !['TRELLIS_ENABLE_MONTY', 'TRELLIS_ENABLE_VIEW_REPLACEMENT'].includes(key))) as Record<string, string>, PATH: '', ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', TRELLIS_TEST_DATA: root } })
  let app = await launch(), page = await app.firstWindow()
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  const call = async (request: any): Promise<any> => { const response = await page.evaluate(r => window.trellis.request(r), request); if (!response.ok) throw Error(response.error.code); return response.data }
  try {
    await call({ type: 'model.configure', configuration: { id: 'pdf-fixture', base_url: server.url, wire_model_id: 'synthetic', context_tokens: 1000000, max_output_tokens: 4096, compatibility_profile: 'chat-max-tokens' }, api_key: 'synthetic-only', confirm_memory_only: true })
    await call({ type: 'model.test', model_id: 'pdf-fixture', role: 'main', confirm_cost: true })
    await page.getByRole('button', { name: '创建第一个任务', exact: true }).click(); await page.getByLabel('任务名称').fill('PDF material fixture'); await page.getByRole('button', { name: '创建任务', exact: true }).click()
    const task = (await call({ type: 'host.tasks' }))[0].id
    await app.evaluate(({ dialog }, path) => { (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, source)
    const imported = await call({ type: 'material.pick', task_id: task })
    await expect.poll(async () => (await call({ type: 'material.status', task_id: task, operation_id: imported.items[0].operation_id })).state).toBe('success')
    resourceId = (await call({ type: 'material.status', task_id: task, operation_id: imported.items[0].operation_id })).resource.id
    expect((await call({ type: 'task.query', task_id: task, query: { type: 'list', input: { kind: 'call' } } })).items).toHaveLength(0)
    await app.evaluate(({ dialog }, path) => { (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, plugin)
    await openSettings(page, '插件与主流程'); const panel = page.getByRole('dialog', { name: '应用设置', exact: true })
    await panel.getByRole('button', { name: '从文件夹导入固定包' }).click(); await expect(panel).toContainText('trellis.pdf-text')
    await panel.getByRole('button', { name: '核对代码信任' }).click(); await panel.getByRole('checkbox', { name: /我已核对固定包代码/ }).check(); await panel.getByRole('button', { name: '确认代码信任', exact: true }).click()
    await panel.getByRole('button', { name: '核对启用依赖' }).click(); await panel.getByRole('button', { name: '确认共同启用' }).click(); await expect(panel).toContainText('当前可用'); await panel.getByRole('button', { name: /^返回工作区/ }).click()
    capability = (await call({ type: 'task.query', task_id: task, query: { type: 'list', input: { kind: 'capability' } } })).items.find((item: any) => !item.id.startsWith('builtin:')).id
    const request = await call({ type: 'request.submit', task_id: task, text: 'Explicitly extract the synthetic PDF as pure text.', model_config_id: 'pdf-fixture', resource_ids: [resourceId], import_ids: [] })
    await expect.poll(async () => (await call({ type: 'request.status', task_id: task, request_id: request.request_id })).run_state).toBe('completed')
    const calls = await call({ type: 'task.query', task_id: task, query: { type: 'list', input: { kind: 'call' } } }); expect(calls.items).toHaveLength(1)
    const original = await call({ type: 'task.query', task_id: task, query: { type: 'read', input: { target: { kind: 'call', id: calls.items[0].id } } } }); expect(original.data.result_data).toMatchObject({ execution: 'success', delivery: 'delivered', data: { extracted_pages: 2, partial: false } })
    const output = original.data.result_data.data.resource_id
    expect(await readFile(join(root, 'resources', output), 'utf8')).toContain('Trellis PDF text two'); expect(business).toBe(2)
    const beforeNavigation = server.exchanges.length
    await page.getByRole('tab', { name: '资源', exact: true }).click()
    const browser = page.getByRole('region', { name: '全部资源分页浏览', exact: true }); await browser.getByRole('button', { name: '刷新全部资源', exact: true }).click(); await browser.getByRole('button').filter({ hasText: output }).click()
    await expect(browser.getByRole('region', { name: '派生材料来源', exact: true })).toContainText('页码和提取文字由工具报告')
    const sourcePanel = browser.getByRole('region', { name: '派生材料来源', exact: true })
    await expect(sourcePanel).toContainText('不代表语义完整或没有遗漏')
    await sourcePanel.getByText('宿主登记的来源事实', { exact: true }).click()
    await expect(sourcePanel).toContainText(capability)
    await expect(sourcePanel).toContainText(original.data.id)
    await expect(sourcePanel).toContainText(original.data.result_data.resources[0].sha256)
    await sourcePanel.getByText('各项来源字段在哪里', { exact: true }).click()
    await expect(sourcePanel).toContainText('原 Call 公开字段不包含原件身份')
    await expect(sourcePanel).toContainText('当前来源导航不返回参数，不表示参数为空')
    await browser.locator('summary').filter({ hasText: /^正文分段读取$/ }).click()
    const reader = browser.getByRole('region', { name: '正文分段读取', exact: true })
    await reader.getByRole('checkbox', { name: '按工具报告的页索引选择' }).check()
    await reader.getByLabel('起始页', { exact: true }).fill('2'); await reader.getByLabel('结束页', { exact: true }).fill('2')
    await reader.getByRole('button', { name: '读取选定正文', exact: true }).click()
    await expect(reader.locator('pre')).toContainText('Trellis PDF text two'); await expect(reader.locator('pre')).not.toContainText('Trellis PDF text one')
    await expect(reader).toContainText('不保证语义完整'); await expect(reader).toContainText('tool_reported')
    await browser.getByRole('button', { name: '查看派生原件', exact: true }).click(); await expect(browser.getByRole('region', { name: '引用资源分页浏览', exact: true })).toContainText(resourceId)
    await browser.getByRole('button', { name: '查看派生原 Call', exact: true }).click(); await expect(browser.getByRole('region', { name: '派生原 Call分页浏览', exact: true })).toContainText(calls.items[0].id)
    expect(server.exchanges).toHaveLength(beforeNavigation)
    expect((await call({ type: 'task.query', task_id: task, query: { type: 'list', input: { kind: 'call' } } })).items).toHaveLength(1)
    const count = server.exchanges.length; await app.close(); app = await launch(); page = await app.firstWindow(); await page.getByRole('button', { name: /PDF material fixture/ }).click()
    const restored = await call({ type: 'task.query', task_id: task, query: { type: 'read', input: { target: { kind: 'resource', id: output } } } }); expect(restored.data.provenance.input.id).toBe(resourceId); expect(server.exchanges).toHaveLength(count); expect(await readFile(source)).toEqual(pdfFixture()); expect(errors).toEqual([])
    console.log(JSON.stringify({ isolated_profile: root, packaged: Boolean(process.env.TRELLIS_CANDIDATE_EXECUTABLE), pdf_extracted_and_source_restored: true, restart_requests: server.exchanges.length - count, real_api_requests: 0 }))
  } finally { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.destroy())).catch(() => {}); await app.close().catch(() => {}); await server.close() }
})
