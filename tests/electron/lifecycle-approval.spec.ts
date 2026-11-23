import { openTaskRecords } from '../helpers/workspace-ui'
import { pendingApprovals } from '../helpers/agent-ui'
import { chooseModel, openSettings, configureModel, testRole, closeSettings } from '../helpers/settings-ui'
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { modelServer, synthetic, textStream, hostToolStream } from '../helpers/model-server'
import { readFileSync } from 'node:fs'
const approvalPrompt = readFileSync('src/runtime/model/prompts/approval-v0.1.txt', 'utf8')
const electronPath: string = createRequire(import.meta.url)('electron')
const dataSchema = { type: 'object', properties: { stage: { type: 'string' } }, required: ['stage'], additionalProperties: false }

test('approval settings switch modes and let users choose the approval model', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pliuna-approval-settings-'))
  const app = await electron.launch({ executablePath: electronPath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', PLIUNA_TEST_DATA: directory } })
  try {
    const page = await app.firstWindow()
    const current = () => page.evaluate(async () => {
      const response = await window.pliuna.request({ type: 'model.list' })
      if (!response.ok) throw Error(response.error.code)
      return (response.data as { approval: { mode: string; model_id: string } }).approval
    })
    const manual = page.getByRole('radio', { name: '手动', exact: true })
    const automatic = page.getByRole('radio', { name: '自动', exact: true })
    const model = page.getByLabel('审批模型', { exact: true })
    const consent = page.getByRole('button', { name: '同意并保存', exact: true })
    await openSettings(page, '权限与审批')
    await expect(manual).toBeChecked()
    await expect(model).toBeHidden()
    await manual.press('ArrowRight')
    await expect(automatic).toBeChecked()
    await expect(model).toBeDisabled()
    await expect(consent).toBeDisabled()
    await closeSettings(page)

    for (const id of ['review-a', 'review-b']) {
      await configureModel(page, { id, model: id, url: 'https://example.invalid/v1', key: 'test-key', context: 64000 })
    }
    await openSettings(page, '权限与审批')
    await automatic.check()
    await model.selectOption('review-b')
    expect(await current()).toEqual({ mode: 'manual', model_id: '' })
    await consent.click()
    await expect(consent).toBeHidden()
    expect(await current()).toEqual({ mode: 'assisted', model_id: 'review-b' })
    await page.setViewportSize({ width: 390, height: 650 })
    await model.selectOption('review-a')
    await expect(consent).toBeEnabled()
    expect(await page.locator('.settings-content').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    await consent.click()
    await expect(consent).toBeHidden()
    expect(await current()).toEqual({ mode: 'assisted', model_id: 'review-a' })

    await manual.check()
    await expect(model).toBeHidden()
    expect(await current()).toEqual({ mode: 'assisted', model_id: 'review-a' })
    const save = page.getByRole('button', { name: '保存', exact: true })
    await save.click()
    await expect(save).toBeHidden()
    expect(await current()).toEqual({ mode: 'manual', model_id: '' })
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

async function configure(page: Page, url: string, approval = false) {
  await configureModel(page, { id:'lifecycle-main',url,key:'lifecycle-test-sentinel',model:'wire-model',context:1000000,output:2048 })
  await openSettings(page)
  await testRole(page,'主模型')
  if (approval) {
    await testRole(page,'审批模型')
    await openSettings(page,'权限与审批')
    await page.getByRole('radio', { name: '自动', exact: true }).check()
    await page.getByLabel('审批模型', { exact: true }).selectOption('lifecycle-main')
    await page.getByRole('button', { name: '同意并保存', exact: true }).click()
    await expect(page.getByRole('status', { name: '' }).filter({ hasText: /^已保存$/ })).toBeVisible()
  }
  await closeSettings(page)
}
async function createTask(page: Page, title: string, first = true) {
  await page.getByRole('button', { name: first ? '创建第一个任务' : '＋ 新建任务', exact: true }).click()
  await page.getByLabel('任务名称').fill(title)
  await page.getByRole('button', { name: '创建任务', exact: true }).click()
}
async function send(page: Page, text: string, model = 'lifecycle-main') {
  await chooseModel(page, model)
  await page.getByLabel('想从哪里开始？').fill(text)
  await page.getByRole('button', { name: /发送消息/ }).click()
}

for (const decision of ['approve', 'deny', 'escalate', 'invalid'] as const) test('desktop independent assisted approval: ' + decision, async () => {
  let dataId = '', assessments = 0
  const server = await modelServer(({ body, url }, res) => {
    if (url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"wire-model"}]}'); return }
    if (synthetic(body, res)) return
    if (!body.tools) {
      assessments++
      expect(body.messages).toHaveLength(2)
      const context = JSON.parse(body.messages[1].content)
      expect(context.action).toMatchObject({ type: 'task_data.replace', id: dataId, expected_revision: 1, value: { stage: 'updated' } })
      expect(body.messages[0].content).toBe(approvalPrompt)
      expect(JSON.stringify(body.messages)).not.toContain('PRIVATE_MAIN_HISTORY_SENTINEL')
      textStream(res, decision === 'invalid' ? 'not valid approval JSON' : JSON.stringify({ decision, reason: 'local synthetic assessment only' })); return
    }
    if (body.messages.at(-1).role === 'tool') {
      const result = JSON.parse(body.messages.at(-1).content)
      if (result.data?.id) dataId = result.data.id
      textStream(res, 'SYNTHETIC_RUN_ENDED'); return
    }
    const request = JSON.parse(body.messages.findLast((message: any) => message.role === 'user').content).request
    if (request === 'PRIVATE_MAIN_HISTORY_SENTINEL') hostToolStream(res, 'write', { type: 'task_data.create', data: { schema: dataSchema, value: { stage: 'initial' }, references: [] } })
    else hostToolStream(res, 'write', { type: 'task_data.replace', id: dataId, expected_revision: 1, value: { stage: 'updated' }, references: [] })
  })
  const directory = await mkdtemp(join(tmpdir(), 'pliuna-assisted-desktop-'))
  const app = await electron.launch({ executablePath: electronPath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', PLIUNA_TEST_DATA: directory } })
  try {
    const page = await app.firstWindow(), errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await configure(page, server.url, true)
    await createTask(page, '辅助审批测试')
    await send(page, 'PRIVATE_MAIN_HISTORY_SENTINEL')
    await expect(page.getByText('SYNTHETIC_RUN_ENDED', { exact: true })).toHaveCount(1)
    await send(page, 'update stage')
    if (decision === 'escalate' || decision === 'invalid') {
      await pendingApprovals(page)
      await expect(page.getByRole('button', { name: '批准', exact: true })).toBeVisible()
      await expect(page.locator('.approval-card')).toHaveCount(1)
      await expect(page.locator('.approval-card')).toContainText('更新任务数据')
      await openTaskRecords(page, '任务数据')
      await page.getByRole('button', { name: '刷新全部任务数据', exact: true }).click()
    await page.getByRole('button', { name: new RegExp(dataId) }).click()
      await expect(page.locator('.record-values')).toContainText('initial')
      await pendingApprovals(page)
      await page.getByRole('button', { name: '批准', exact: true }).click()
    }
    await expect(page.locator('.agent-status')).toContainText('已完成');await page.getByRole('tab', { name: /^内容/ }).click();await expect(page.getByText('SYNTHETIC_RUN_ENDED', { exact: true })).toHaveCount(1)
    await expect(page.locator('.agent-status')).toContainText('已完成')
    await expect(page.locator('.approval-card')).toHaveCount(0)
    await openTaskRecords(page, '执行记录')
    await page.locator('.execution-category > summary').filter({ hasText: /^原审批$/ }).click()
    await expect(page.getByRole('region', { name: '原审批分页浏览' })).toContainText(decision === 'deny' ? '已拒绝' : '已批准')
    await expect(page.getByRole('button', { name: '批准', exact: true })).toHaveCount(0)
    await openTaskRecords(page, '任务数据')
    await page.getByRole('button', { name: '刷新全部任务数据', exact: true }).click()
    await page.getByRole('button', { name: new RegExp(dataId) }).click()
    await expect(page.locator('.record-detail')).toContainText('数据值 · r' + (decision === 'deny' ? '1' : '2'))
    await expect(page.locator('.record-values')).toContainText(decision === 'deny' ? 'initial' : 'updated')
    expect(assessments).toBe(1)
    expect(errors).toEqual([])
  } finally { await app.close(); await server.close(); await rm(directory, { recursive: true, force: true }) }
})

test('task switching, occupied configuration, stop/save/submit, restart and explicit data-only resume', async () => {
  let dataId = ''
  const server = await modelServer(({ body, url }, res) => {
    if (url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"wire-model"}]}'); return }
    if (synthetic(body, res)) return
    if (body.messages.at(-1).role === 'tool') {
      const result = JSON.parse(body.messages.at(-1).content)
      if (result.data?.id) dataId = result.data.id
      textStream(res, 'LIFECYCLE_RUN_ENDED'); return
    }
    const request = JSON.parse(body.messages.findLast((message: any) => message.role === 'user').content).request
    if (request === 'create data') hostToolStream(res, 'write', { type: 'task_data.create', data: { schema: dataSchema, value: { stage: 'initial' }, references: [] } })
    else hostToolStream(res, 'write', { type: 'task_data.replace', id: dataId, expected_revision: 1, value: { stage: 'must-not-commit' }, references: [] })
  })
  const directory = await mkdtemp(join(tmpdir(), 'pliuna-stop-desktop-'))
  const launch = () => electron.launch({ executablePath: electronPath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', PLIUNA_TEST_DATA: directory } })
  let app = await launch()
  try {
    let page = await app.firstWindow()
    await configure(page, server.url)
    await createTask(page, '停止恢复测试')
    await send(page, 'fixture form', 'fixture')
    await expect(page.getByLabel('你的想法')).toBeVisible()
    await send(page, 'create data')
    await expect(page.getByText('LIFECYCLE_RUN_ENDED', { exact: true })).toHaveCount(1)
    await createTask(page, '独立任务', false)
    await page.getByRole('button', { name: /停止恢复测试/ }).click()
    await send(page, 'replace data')
    await pendingApprovals(page)
    await expect(page.getByRole('button', { name: '批准', exact: true })).toBeVisible()
    await page.getByRole('button', { name: /独立任务/ }).click()
    await expect(page.getByRole('button', { name: '批准', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: /停止恢复测试/ }).click()
    await pendingApprovals(page)
    await expect(page.getByRole('button', { name: '批准', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /发送消息/ })).toBeDisabled()
    const occupied = await page.evaluate(async () => window.pliuna.request({ type: 'model.list' }))
    expect(occupied).toMatchObject({ ok: true, data: { models: [{ id: 'lifecycle-main', occupied: true }] } })
    await openSettings(page, '模型服务')
    await expect(page.locator('.channel-model')).toContainText('使用中')
    for (const name of ['渠道设置', '测试连接', '移除']) await expect(page.getByRole('button', { name, exact: true })).toBeDisabled()
    const locked = await page.evaluate(async () => window.pliuna.request({ type: 'model.credential.delete', model_id: 'lifecycle-main', confirm: true }))
    expect(locked).toMatchObject({ ok: false, error: { code: 'CONFIGURATION_BUSY' } })
    await closeSettings(page)
    await page.getByLabel('任务管理', { exact: true }).click()
    await page.getByRole('button', { name: '停止任务', exact: true }).click()
    await expect(page.getByRole('button', { name: '恢复任务', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '批准', exact: true })).toHaveCount(0)
    await expect(page.getByLabel('想从哪里开始？')).toBeDisabled()
    await openTaskRecords(page, '任务数据')
    await page.getByRole('button', { name: '刷新全部任务数据', exact: true }).click()
    await page.getByRole('button', { name: new RegExp(dataId) }).click()
    await expect(page.locator('.record-detail')).toContainText('数据值 · r1')
    await expect(page.locator('.record-values')).toContainText('initial')
    const stoppedRequests = server.exchanges.length
    await page.getByRole('tab', { name: /^内容/ }).click()
    await page.getByLabel('你的想法').fill('停止后仍可保存的答案')
    await expect(page.getByRole('status').filter({ hasText: /^已保存$/ })).toBeVisible()
    await page.getByRole('button', { name: '提交答案', exact: true }).click()
    await openTaskRecords(page, '作答记录')
    await expect(page.getByText('第 1 次提交', { exact: false })).toBeVisible()
    expect(server.exchanges).toHaveLength(stoppedRequests)
    await openSettings(page, '模型服务')
    await expect(page.getByRole('button', { name: '渠道设置', exact: true })).toBeEnabled()
    await closeSettings(page)
    await app.close(); app = await launch(); page = await app.firstWindow()
    await page.getByRole('button', { name: /停止恢复测试/ }).click()
    await page.getByLabel('任务管理', { exact: true }).click()
    await expect(page.getByRole('button', { name: '恢复任务', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '批准', exact: true })).toHaveCount(0)
    await expect(page.getByLabel('你的想法')).toHaveValue('停止后仍可保存的答案')
    expect(server.exchanges).toHaveLength(stoppedRequests)
    await page.getByRole('button', { name: '恢复任务', exact: true }).click()
    await expect(page.getByRole('button', { name: '停止任务', exact: true })).toBeVisible()
    await expect(page.getByLabel('想从哪里开始？')).toBeEnabled()
    await expect(page.getByRole('button', { name: /发送消息/ })).toBeDisabled()
    expect(server.exchanges).toHaveLength(stoppedRequests)
    await openTaskRecords(page, '作答记录')
    await expect(page.getByText('第 1 次提交', { exact: false })).toBeVisible()
  } finally { await app.close(); await server.close(); await rm(directory, { recursive: true, force: true }) }
})
