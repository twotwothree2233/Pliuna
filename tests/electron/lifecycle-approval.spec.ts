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

async function configure(page: Page, url: string, approval = false) {
  await page.getByRole('button', { name: '模型与审批', exact: true }).click()
  await page.getByLabel('配置标识', { exact: true }).fill('lifecycle-main')
  await page.getByLabel('服务 Base URL').fill(url)
  await page.getByLabel('API Key', { exact: true }).fill('lifecycle-test-sentinel')
  await page.getByLabel('精确模型标识').fill('wire-model')
  await page.getByLabel('已知上下文容量').fill('1000000')
  await page.getByLabel('输出上限', { exact: true }).fill('2048')
  await page.getByRole('checkbox', { name: /^我确认连接凭据/ }).check()
  await page.getByRole('checkbox', { name: /^记住连接/ }).uncheck()
  await page.getByRole('button', { name: '保存内存配置并查询', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('查询到 1 个服务候选')
  await page.getByRole('button', { name: '测试并启用主模型', exact: true }).click(); await page.getByRole('dialog', { name: '确认模型角色测试' }).getByRole('button', { name: '确认费用并开始测试', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('main 合成验证通过')
  if (approval) {
    await page.getByRole('button', { name: '测试并启用审批模型', exact: true }).click(); await page.getByRole('dialog', { name: '确认模型角色测试' }).getByRole('button', { name: '确认费用并开始测试', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('approval 合成验证通过')
    await page.getByLabel('独立辅助审批模型').selectOption('lifecycle-main')
    await page.getByRole('checkbox', { name: /我知晓具体操作/ }).check()
    await page.getByRole('button', { name: '启用独立辅助审批', exact: true }).click()
    await expect(page.getByText('当前模式：assisted。执行期间不能修改模式或占用配置。')).toBeVisible()
  }
  await page.getByRole('button', { name: '关闭', exact: true }).click()
}
async function createTask(page: Page, title: string, first = true) {
  await page.getByRole('button', { name: first ? '创建第一个任务' : '＋ 新建', exact: true }).click()
  await page.getByLabel('任务名称').fill(title)
  await page.getByRole('button', { name: '创建任务', exact: true }).click()
}
async function send(page: Page, text: string, model = 'lifecycle-main') {
  await page.getByLabel('本次模型', { exact: true }).selectOption(model)
  await page.getByLabel('想从哪里开始？').fill(text)
  await page.getByRole('button', { name: /发送 · 新 Run/ }).click()
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
  const directory = await mkdtemp(join(tmpdir(), 'trellis-assisted-desktop-'))
  const app = await electron.launch({ executablePath: electronPath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', TRELLIS_TEST_DATA: directory } })
  try {
    const page = await app.firstWindow(), errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await configure(page, server.url, true)
    await createTask(page, '辅助审批测试')
    await send(page, 'PRIVATE_MAIN_HISTORY_SENTINEL')
    await expect(page.getByText('SYNTHETIC_RUN_ENDED', { exact: true })).toHaveCount(1)
    await send(page, 'update stage')
    if (decision === 'escalate' || decision === 'invalid') {
      await expect(page.getByRole('button', { name: '批准本次动作', exact: true })).toBeVisible()
      await expect(page.locator('.approval-card')).toHaveCount(1)
      await expect(page.locator('.approval-card')).toContainText('awaiting_human')
      await page.getByRole('tab', { name: /任务数据/ }).click()
      await page.getByRole('button', { name: new RegExp(dataId) }).click()
      await expect(page.locator('.data-detail>pre')).toContainText('initial')
      await page.getByRole('button', { name: '批准本次动作', exact: true }).click()
    }
    await expect(page.getByText('SYNTHETIC_RUN_ENDED', { exact: true })).toHaveCount(2)
    await expect(page.getByLabel('最近 Run 结果')).toContainText('completed')
    await expect(page.locator('.approval-card')).toHaveCount(1)
    await expect(page.locator('.approval-card')).toContainText((decision === 'deny' ? 'deny' : 'approve') + ' / revoked / resolved')
    await expect(page.getByRole('button', { name: '批准本次动作', exact: true })).toHaveCount(0)
    await page.getByRole('tab', { name: /任务数据/ }).click()
    await page.getByRole('button', { name: new RegExp(dataId) }).click()
    await expect(page.locator('.data-detail')).toContainText('数据值 · r' + (decision === 'deny' ? '1' : '2'))
    await expect(page.locator('.data-detail>pre')).toContainText(decision === 'deny' ? 'initial' : 'updated')
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
  const directory = await mkdtemp(join(tmpdir(), 'trellis-stop-desktop-'))
  const launch = () => electron.launch({ executablePath: electronPath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', TRELLIS_TEST_DATA: directory } })
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
    await expect(page.getByRole('button', { name: '批准本次动作', exact: true })).toBeVisible()
    await page.getByRole('button', { name: /独立任务/ }).click()
    await expect(page.getByRole('button', { name: '批准本次动作', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: /停止恢复测试/ }).click()
    await expect(page.getByRole('button', { name: '批准本次动作', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /发送 · 新 Run/ })).toBeDisabled()
    const occupied = await page.evaluate(async () => window.trellis.request({ type: 'model.list' }))
    expect(occupied).toMatchObject({ ok: true, data: { models: [{ id: 'lifecycle-main', occupied: true }] } })
    await page.getByRole('button', { name: '模型与审批', exact: true }).click()
    await expect(page.locator('.model-entry')).toContainText('执行占用，配置锁定')
    for (const name of ['编辑连接', '记住此连接', '删除凭据', '测试并启用主模型', '移除']) await expect(page.getByRole('button', { name, exact: true })).toBeDisabled()
    const locked = await page.evaluate(async () => window.trellis.request({ type: 'model.credential.delete', model_id: 'lifecycle-main', confirm: true }))
    expect(locked).toMatchObject({ ok: false, error: { code: 'CONFIGURATION_BUSY' } })
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByRole('button', { name: '停止任务', exact: true }).click()
    await expect(page.getByRole('button', { name: '恢复任务', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '批准本次动作', exact: true })).toHaveCount(0)
    await expect(page.getByLabel('想从哪里开始？')).toBeDisabled()
    await page.getByRole('tab', { name: /任务数据/ }).click()
    await page.getByRole('button', { name: new RegExp(dataId) }).click()
    await expect(page.locator('.data-detail')).toContainText('数据值 · r1')
    await expect(page.locator('.data-detail>pre')).toContainText('initial')
    const stoppedRequests = server.exchanges.length
    await page.getByRole('tab', { name: /^内容/ }).click()
    await page.getByLabel('你的想法').fill('停止后仍可保存的答案')
    await expect(page.getByRole('status').filter({ hasText: /^已保存$/ })).toBeVisible()
    await page.getByRole('button', { name: '提交答案', exact: true }).click()
    await page.getByRole('tab', { name: /作答记录/ }).click()
    await expect(page.getByText('第 1 次提交', { exact: false })).toBeVisible()
    expect(server.exchanges).toHaveLength(stoppedRequests)
    await page.getByRole('button', { name: '模型与审批', exact: true }).click()
    await expect(page.getByRole('button', { name: '编辑连接', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    await app.close(); app = await launch(); page = await app.firstWindow()
    await page.getByRole('button', { name: /停止恢复测试/ }).click()
    await expect(page.getByRole('button', { name: '恢复任务', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '批准本次动作', exact: true })).toHaveCount(0)
    await expect(page.getByLabel('你的想法')).toHaveValue('停止后仍可保存的答案')
    expect(server.exchanges).toHaveLength(stoppedRequests)
    await page.getByRole('button', { name: '恢复任务', exact: true }).click()
    await expect(page.getByRole('button', { name: '停止任务', exact: true })).toBeVisible()
    await expect(page.getByLabel('想从哪里开始？')).toBeEnabled()
    await expect(page.getByRole('button', { name: /发送 · 新 Run/ })).toBeDisabled()
    expect(server.exchanges).toHaveLength(stoppedRequests)
    await page.getByRole('tab', { name: /作答记录/ }).click()
    await expect(page.getByText('第 1 次提交', { exact: false })).toBeVisible()
  } finally { await app.close(); await server.close(); await rm(directory, { recursive: true, force: true }) }
})
