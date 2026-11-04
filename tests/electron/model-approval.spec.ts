import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { modelServer, synthetic, textStream, hostToolStream } from '../helpers/model-server'
const electronPath: string = createRequire(import.meta.url)('electron')

test('desktop model test gate, general loop, manual approval, memory-only credentials', async () => {
  let dataId = ''
  let correctedInvalidValue = false
  const server = await modelServer(({ body, url }, res) => {
    if (url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"wire-model"}]}'); return }
    if (synthetic(body, res)) return
    if (body.messages.at(-1).role === 'tool') {
      const result = JSON.parse(body.messages.at(-1).content)
      if (result.error?.code === 'INVALID_DATA') {
        expect(result.error.message).toContain('expected object, received string')
        correctedInvalidValue = true
        hostToolStream(res, 'write', { type: 'task_data.replace', id: dataId, expected_revision: 1, value: { stage: 'updated' }, references: [] }, '', 'corrected-value')
        return
      }
      if (result.data?.id) dataId = result.data.id
      textStream(res, '本机合成模型完成，无真实服务调用。'); return
    }
    const request = JSON.parse(body.messages.findLast((m: any) => m.role === 'user').content).request as string
    if (request === '创建学习进度') hostToolStream(res, 'write', { type: 'task_data.create', data: { schema: { type: 'object', properties: { stage: { type: 'string' } }, required: ['stage'], additionalProperties: false }, value: { stage: 'initial' }, references: [] } })
    else hostToolStream(res, 'write', { type: 'task_data.replace', id: dataId, expected_revision: 1, value: '{"stage":"updated"}', references: [] })
  })
  const directory = await mkdtemp(join(tmpdir(), 'trellis-model-desktop-'))
  const launch = () => electron.launch({ executablePath: electronPath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', TRELLIS_TEST_DATA: directory } })
  let app = await launch()
  try {
    let page = await app.firstWindow()
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message))
    await page.getByRole('button', { name: '模型与审批', exact: true }).click()
    await page.getByLabel('配置标识').fill('desktop-main')
    await page.getByLabel('服务 Base URL').fill(server.url)
    await page.getByLabel('API Key', { exact: true }).fill('desktop-secret-sentinel')
    await page.getByRole('checkbox', { name: /我确认连接凭据/ }).check()
    await page.getByRole('button', { name: '先查询服务模型（无需容量）' }).click()
    await expect(page.getByText(/未保存模型或启用角色/)).toBeVisible()
    await expect(page.locator('#service-models option')).toHaveCount(1)
    await expect(page.getByLabel('服务可用模型', { exact: true })).toBeVisible()
    await page.getByLabel('服务可用模型', { exact: true }).selectOption('wire-model')
    await expect(page.getByLabel('精确模型标识')).toHaveValue('wire-model')
    expect(server.exchanges).toHaveLength(1)
    expect(server.exchanges[0]!.body).toBeNull()
    await page.getByLabel('精确模型标识').fill('wire-model')
    await page.getByLabel('已知上下文容量').fill('1000000')
    await page.getByLabel('输出上限', { exact: true }).fill('1024')
    await page.getByRole('checkbox', { name: /我确认连接凭据/ }).check()
    await page.getByRole('checkbox', { name: /^记住连接/ }).uncheck()
    await page.getByRole('button', { name: '保存内存配置并查询' }).click()
    await expect(page.getByText(/查询到 1 个服务候选/)).toBeVisible()
    expect(await page.getByLabel('API Key', { exact: true }).inputValue()).toBe('')
    const beforeRefresh = server.exchanges.length
    await page.getByRole('button', { name: '先查询服务模型（无需容量）' }).click()
    await expect(page.getByRole('status')).toContainText('未保存模型或启用角色')
    expect(server.exchanges).toHaveLength(beforeRefresh + 1)
    expect(server.exchanges.at(-1)!.authorization).toBe('Bearer desktop-secret-sentinel')
    await page.getByRole('button', { name: '测试并启用主模型', exact: true }).click(); await page.getByRole('dialog', { name: '确认模型角色测试' }).getByRole('button', { name: '确认费用并开始测试', exact: true }).click()
    await expect(page.getByText(/main 合成验证通过/)).toBeVisible()
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByRole('button', { name: '创建第一个任务' }).click()
    await page.getByLabel('任务名称').fill('模型审批任务')
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    await page.getByLabel('本次模型', { exact: true }).selectOption('desktop-main')
    await page.getByLabel('想从哪里开始？').fill('创建学习进度')
    await page.getByRole('button', { name: /发送 · 新 Run/ }).click()
    await expect(page.getByText('本机合成模型完成，无真实服务调用。', { exact: true })).toHaveCount(1)
    await expect(page.getByLabel('最近 Run 结果')).toContainText('completed')
    expect(dataId).not.toBe('')
    await page.getByRole('tab', { name: /任务数据/ }).click()
    await page.getByRole('button', { name: new RegExp(dataId) }).click()
    await expect(page.locator('.data-detail>pre')).toContainText('initial')
    await page.getByLabel('想从哪里开始？').fill('更新已有进度')
    await page.getByRole('button', { name: /发送 · 新 Run/ }).click()
    await expect(page.getByRole('button', { name: '批准本次动作' })).toBeVisible()
    expect(correctedInvalidValue).toBe(true)
    await page.getByText('具体参数与版本').click()
    await expect(page.locator('.approval-card pre').first()).toContainText('expected_revision')
    await page.getByRole('button', { name: '批准本次动作' }).click()
    await expect(page.getByText('本机合成模型完成，无真实服务调用。', { exact: true })).toHaveCount(2)
    await expect(page.getByText('approve / revoked / resolved', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: new RegExp(dataId) }).click()
    await expect(page.locator('.data-detail>pre')).toContainText('updated')
    await page.getByRole('tab', { name: /执行记录/ }).click()
    await expect(page.getByLabel('执行记录查看器')).toContainText('success')
    expect(errors).toEqual([])
    await app.close()
    const dbBytes = await readFile(join(directory, 'trellis.sqlite'))
    expect(dbBytes.includes(Buffer.from('desktop-secret-sentinel'))).toBe(false)
    app = await launch(); page = await app.firstWindow()
    await page.getByRole('button', { name: /模型审批任务/ }).click()
    await expect(page.getByLabel('本次模型', { exact: true }).locator('option')).toHaveCount(2)
    await expect(page.getByLabel('本次模型', { exact: true })).toHaveValue('')
    await expect(page.getByText('approve / revoked / resolved', { exact: true })).toBeVisible()
    expect(server.exchanges.every(e => e.authorization === 'Bearer desktop-secret-sentinel')).toBe(true)
  } finally { await app.close(); await server.close(); await rm(directory, { recursive: true, force: true }) }
})

test('model catalogue auto-fetches after consent, displays API choices, clears stale results and never auto-retries', async () => {
  let mode: 'ok' | 'auth' | 'empty' = 'ok'
  const server = await modelServer(({ url }, res) => {
    if (url !== '/v1/models') { res.writeHead(404); res.end(); return }
    res.writeHead(mode === 'auth' ? 401 : 200, { 'content-type': 'application/json' })
    res.end(mode === 'auth' ? '{"error":"private-provider-error"}' : mode === 'empty' ? '{"data":[]}' : '{"data":[{"id":"model-a"},{"id":"model-b"}]}')
  })
  const directory = await mkdtemp(join(tmpdir(), 'trellis-catalogue-'))
  const app = await electron.launch({ executablePath: electronPath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', TRELLIS_TEST_DATA: directory } })
  try {
    const page = await app.firstWindow()
    await page.getByRole('button', { name: '模型与审批', exact: true }).click()
    await page.getByLabel('服务 Base URL').fill(server.url)
    await page.getByLabel('API Key', { exact: true }).fill('catalogue-test-key')
    const consent = page.getByRole('checkbox', { name: /我确认连接凭据/ })
    expect(server.exchanges).toHaveLength(0)
    await consent.check()
    await expect(page.getByRole('status')).toContainText('查询到 2 个服务候选')
    const choices = page.getByLabel('服务可用模型', { exact: true })
    await expect(choices.locator('option')).toHaveCount(3)
    expect(server.exchanges).toHaveLength(1)
    expect(server.exchanges[0]).toMatchObject({ url: '/v1/models', authorization: 'Bearer catalogue-test-key', body: null })
    await choices.selectOption('model-b')
    await expect(page.getByLabel('精确模型标识')).toHaveValue('model-b')
    await expect(page.getByLabel('已知上下文容量')).toHaveValue('')
    await expect(page.locator('.model-entry')).toHaveCount(0)
    for (const width of [390, 720, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      await expect(choices).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
    await page.screenshot({ path: join(tmpdir(), 'trellis-model-catalogue.png') })
    await page.waitForTimeout(650)
    expect(server.exchanges).toHaveLength(1)
    mode = 'auth'
    await page.getByRole('button', { name: '先查询服务模型（无需容量）' }).click()
    await expect(page.getByRole('status')).toContainText('MODEL_AUTHENTICATION')
    await expect(choices).toBeDisabled()
    await expect(choices.locator('option')).toHaveCount(1)
    expect(await page.locator('body').innerText()).not.toContain('private-provider-error')
    await page.waitForTimeout(650)
    expect(server.exchanges).toHaveLength(2)
    mode = 'empty'
    await page.getByLabel('API Key', { exact: true }).fill('new-catalogue-key')
    await expect(consent).not.toBeChecked()
    await expect(page.getByLabel('精确模型标识')).toHaveValue('model-b')
    await consent.check()
    await expect(page.getByRole('status')).toContainText('服务返回 0 个可用模型')
    await expect(choices).toBeDisabled()
    expect(server.exchanges).toHaveLength(3)
    expect(server.exchanges.at(-1)!.authorization).toBe('Bearer new-catalogue-key')
  } finally { await app.close(); await server.close(); await rm(directory, { recursive: true, force: true }) }
})

test('desktop real-API onboarding handles authentication, explicit cancellation and retesting', async () => {
  let mode: 'auth' | 'hang' | 'ok' = 'auth'
  let tests = 0
  const server = await modelServer(({ body, url }, res) => {
    if (url === '/v1/models') { res.writeHead(404); res.end('unavailable catalogue'); return }
    tests++
    if (mode === 'auth') { res.writeHead(401); res.end('never-display-provider-secret'); return }
    if (mode === 'hang') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders(); return }
    synthetic(body, res)
  })
  const directory = await mkdtemp(join(tmpdir(), 'trellis-onboarding-'))
  const app = await electron.launch({ executablePath: electronPath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', TRELLIS_TEST_DATA: directory } })
  try {
    const page = await app.firstWindow()
    await page.getByRole('button', { name: '模型与审批', exact: true }).click()
    await page.getByLabel('配置标识').fill('real-ready')
    await page.getByLabel('服务 Base URL').fill(server.url)
    await page.getByLabel('API Key', { exact: true }).fill('onboarding-secret')
    await page.getByRole('checkbox', { name: /我确认连接凭据/ }).check()
    await page.getByRole('button', { name: '先查询服务模型（无需容量）' }).click()
    await expect(page.getByRole('status')).toContainText('MODEL_UNAVAILABLE')
    await page.getByLabel('精确模型标识').fill('wire-model')
    await page.getByLabel('已知上下文容量').fill('1000000')
    await page.getByLabel('输出上限', { exact: true }).fill('1024')
    await page.getByRole('checkbox', { name: /^记住连接/ }).uncheck()
    await page.getByRole('button', { name: '保存内存配置并查询' }).click()
    await expect(page.getByRole('status')).toContainText('连接已保存，目录不代表角色验证')
    const testMain = page.getByRole('button', { name: '测试并启用主模型', exact: true })
    await testMain.click(); await expect(page.getByRole('dialog', { name: '确认模型角色测试' })).toContainText('最多两轮'); await page.getByRole('button', { name: '确认费用并开始测试', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('MODEL_AUTHENTICATION')
    expect(tests).toBe(1)
    await expect(page.locator('.model-entry')).toContainText('已验证：无')
    expect(await page.locator('body').innerText()).not.toContain('never-display-provider-secret')
    mode = 'hang'
    await testMain.click(); await expect(page.getByRole('dialog', { name: '确认模型角色测试' })).toContainText('最多两轮'); await page.getByRole('button', { name: '确认费用并开始测试', exact: true }).click()
    await expect.poll(() => tests).toBe(2)
    await page.getByRole('button', { name: '取消当前连接或测试' }).click()
    await expect(page.getByRole('status')).toContainText('MODEL_CANCELLED')
    await expect(testMain).toBeEnabled()
    await expect(page.locator('.model-entry')).toContainText('已验证：无')
    mode = 'ok'
    await testMain.click(); await expect(page.getByRole('dialog', { name: '确认模型角色测试' })).toContainText('最多两轮'); await page.getByRole('button', { name: '确认费用并开始测试', exact: true }).click()
    await expect(page.getByText(/main 合成验证通过/)).toBeVisible()
    expect(tests).toBe(4)
    for (const width of [390, 720, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
  } finally { await app.close(); await server.close(); await rm(directory, { recursive: true, force: true }) }
})
