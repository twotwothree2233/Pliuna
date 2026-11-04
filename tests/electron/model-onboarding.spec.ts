import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { modelServer, synthetic } from '../helpers/model-server'
const electronPath: string = createRequire(import.meta.url)('electron')

for (const scenario of ['connection-confirmation', 'service-metadata', 'saved-connection-discovery', 'visible-role-confirmation'] as const) test(`model onboarding: ${scenario}`, async () => {
  const server = await modelServer(({ body, url }, response) => {
    if (url === '/v1/models') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: 'onboarding-wire', context_length: 240000, max_output_tokens: 8192 }] })); return }
    if (synthetic(body, response)) return
    response.writeHead(500); response.end()
  })
  const root = await mkdtemp(join(tmpdir(), 'trellis-onboarding-'))
  const app = await electron.launch({ executablePath: electronPath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', TRELLIS_TEST_DATA: root } })
  try {
    const page = await app.firstWindow()
    await page.getByRole('button', { name: '模型与审批', exact: true }).click()
    await page.getByLabel('服务 Base URL').fill(server.url)
    await page.getByLabel('API Key', { exact: true }).fill('synthetic-key')
    await page.getByRole('checkbox', { name: /^我确认连接凭据/ }).check()
    await expect(page.getByLabel('服务可用模型')).toContainText('onboarding-wire')
    if (scenario === 'connection-confirmation') {
      const count = server.exchanges.length
      await page.getByLabel('配置标识').fill('changed-name')
      await page.getByLabel('显式兼容 Profile').selectOption('chat-max-completion-tokens')
      await expect(page.getByRole('checkbox', { name: /^我确认连接凭据/ })).toBeChecked()
      await expect(page.getByLabel('服务可用模型')).toContainText('onboarding-wire')
      expect(server.exchanges).toHaveLength(count)
      await page.getByLabel('API Key', { exact: true }).fill('changed-synthetic-key')
      await expect(page.getByRole('checkbox', { name: /^我确认连接凭据/ })).not.toBeChecked()
      await expect(page.getByLabel('服务可用模型')).not.toContainText('onboarding-wire')
      return
    }
    await page.getByLabel('服务可用模型').selectOption('onboarding-wire')
    if (scenario === 'service-metadata') {
      await expect(page.getByLabel('已知上下文容量')).toHaveValue('240000')
      await expect(page.getByLabel('输出上限', { exact: true })).toHaveValue('8192')
      await expect(page.getByText(/参数来源：当前服务/)).toBeVisible()
      await page.getByLabel('输出上限', { exact: true }).fill('2048')
      await page.getByRole('button', { name: '先查询服务模型（无需容量）' }).click()
      await expect(page.getByRole('status')).toContainText('查询到 1 个')
      await expect(page.getByLabel('输出上限', { exact: true })).toHaveValue('2048')
      return
    }
    await page.getByLabel('配置标识').fill('onboarding')
    await page.getByLabel('精确模型标识').fill('onboarding-wire')
    await page.getByLabel('已知上下文容量').fill('240000')
    await page.getByLabel('输出上限', { exact: true }).fill('8192')
    await page.getByRole('checkbox', { name: /^我确认连接凭据/ }).check()
    await page.getByRole('checkbox', { name: /^记住连接/ }).uncheck()
    await page.getByRole('button', { name: '保存内存配置并查询' }).click()
    await expect(page.locator('.model-entry')).toContainText('onboarding')
    await expect(page.getByRole('status')).toContainText('查询到 1 个')
    if (scenario === 'saved-connection-discovery') {
      const count = server.exchanges.length
      await page.getByRole('button', { name: '编辑连接', exact: true }).click()
      await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('')
      await page.getByRole('checkbox', { name: /^我确认连接凭据/ }).check()
      await expect.poll(() => server.exchanges.length).toBe(count + 1)
      await expect(page.getByLabel('服务可用模型')).toContainText('onboarding-wire')
      expect(server.exchanges.at(-1)?.authorization).toBe('Bearer synthetic-key')
      return
    }
    const count = server.exchanges.length
    await page.getByRole('button', { name: '测试并启用主模型', exact: true }).click()
    const confirmation = page.getByRole('dialog', { name: '确认模型角色测试' })
    await expect(confirmation).toBeVisible()
    expect(server.exchanges).toHaveLength(count)
    await confirmation.getByRole('button', { name: '取消', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('已取消角色测试，未发送请求')
    expect(server.exchanges).toHaveLength(count)
    await page.getByRole('button', { name: '测试并启用主模型', exact: true }).click()
    await confirmation.getByRole('button', { name: '确认费用并开始测试', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('main 合成验证通过')
    expect(server.exchanges.filter(exchange => exchange.body)).toHaveLength(2)
    await expect(page.locator('.model-entry')).toContainText('已验证：main')
  } finally { await app.close(); await server.close(); await rm(root, { recursive: true, force: true }) }
})


test('offline file settings save makes no request and restart restores without credentials echo', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trellis-offline-settings-'))
  const launch = () => electron.launch({ executablePath: electronPath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', TRELLIS_TEST_DATA: join(root, '.trellis') } })
  let app = await launch()
  try {
    let page = await app.firstWindow()
    await page.getByRole('button', { name: '模型与审批', exact: true }).click()
    await page.getByLabel('配置标识').fill('offline-settings')
    await page.getByLabel('服务 Base URL').fill('https://example.invalid/v1')
    await page.getByLabel('API Key', { exact: true }).fill('offline-synthetic-key')
    await page.getByLabel('精确模型标识').fill('offline-model')
    await page.getByLabel('已知上下文容量').fill('100000')
    await page.getByLabel('输出上限', { exact: true }).fill('1024')
    await page.getByRole('button', { name: '仅保存配置（不联网）', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('未联网')
    await expect(page.locator('.model-entry')).toContainText('已记住连接')
    await app.close(); app = await launch(); page = await app.firstWindow()
    await page.getByRole('button', { name: '模型与审批', exact: true }).click()
    await expect(page.locator('.model-entry')).toContainText('offline-settings')
    await expect(page.locator('.model-entry')).toContainText('已验证：无')
    await page.getByRole('button', { name: '编辑连接', exact: true }).click()
    await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('')
    await expect(page.getByLabel('服务 Base URL')).toHaveValue('https://example.invalid/v1')
  } finally { await app.close().catch(() => {}); await rm(root, { recursive: true, force: true }) }
})
