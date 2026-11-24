import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import type { ServerResponse } from 'node:http'
import { configureModel, chooseModel, chooseTheme } from '../helpers/settings-ui'
import { hostToolStream, modelServer, synthetic, textStream } from '../helpers/model-server'
import type { HostRequest, RunActivity, Snapshot, TaskMessagePage } from '../../src/shared/types'

const executablePath: string = createRequire(import.meta.url)('electron')

test('loading earlier messages and receiving a late reply preserve the reading position', async () => {
  test.setTimeout(90000)
  const first = '先发的请求', late = '先发请求的迟到回复'
  let pending: Parameters<typeof textStream>[0] | undefined
  const server = await modelServer(({ body }, response) => {
    if (synthetic(body, response)) return
    const request = JSON.parse(body.messages.findLast((message: { role: string }) => message.role === 'user').content).request
    if (request === first) { pending = response; return }
    textStream(response, JSON.stringify({ kind: 'reply', text: `答复：${request}。` + '用于保留稳定阅读位置的对话正文。'.repeat(12) }))
  })
  const directory = await mkdtemp(join(tmpdir(), 'pliuna-history-scroll-')), env = { ...process.env }
  delete env.PLIUNA_TEST_RUNNER; delete env.TRELLIS_TEST_RUNNER
  const app = await electron.launch({ executablePath, args: ['.'], env: { ...env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', PLIUNA_TEST_DATA: directory } })
  try {
    const page = await app.firstWindow()
    await page.setViewportSize({ width: 1440, height: 800 })
    const call = async <T,>(request: HostRequest): Promise<T> => page.evaluate(async request => {
      const response = await window.pliuna.request(request)
      if (!response.ok) throw Error(response.error.code)
      return response.data as T
    }, request)
    await configureModel(page, { id: 'history-main', url: server.url, key: 'isolated-history-key', model: 'history-wire', context: 100000, output: 4096 })
    await chooseModel(page, 'history-main')
    const title = '历史阅读定位'
    await page.getByRole('button', { name: '创建第一个任务' }).click()
    await page.getByLabel('任务名称').fill(title)
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    const task = (await call<{ id: string }[]>({ type: 'host.tasks' }))[0]!.id
    const send = (text: string) => call<{ request_id: string }>({ type: 'request.submit', task_id: task, model_config_id: 'history-main', text, resource_ids: [], import_ids: [] })
    const status = (request_id: string) => call<{ run_id: string; run_state: string }>({ type: 'request.status', task_id: task, request_id })
    const original = await send(first)
    await expect.poll(() => !!pending).toBe(true)
    for (let i = 1; i <= 13; i++) {
      const queued = await send(`独立追问 ${i}`)
      await expect.poll(async () => (await status(queued.request_id)).run_state).toBe('completed')
    }
    await page.reload()
    await page.getByRole('button', { name: new RegExp(title) }).click()
    const chat = page.getByRole('region', { name: '任务对话', exact: true }), scroll = page.locator('[data-agent-view=chat]')
    const older = chat.getByRole('button', { name: '加载更早消息' })
    await expect(older).toBeVisible()
    const firstRow = chat.getByRole('article', { name: '你的消息' }).filter({ hasText: first })
    await expect(firstRow).toHaveCount(0)
    await scroll.evaluate(element => { element.scrollTop = 0 })
    const anchor = chat.locator('article').filter({ has: page.getByText('独立追问 3', { exact: true }) })
    const before = (await anchor.boundingBox())!.y
    await older.click()
    await expect(firstRow).toHaveCount(1)
    await expect.poll(async () => Math.abs((await anchor.boundingBox())!.y - before)).toBeLessThan(2)
    const position = await scroll.evaluate(element => element.scrollTop)
    textStream(pending!, JSON.stringify({ kind: 'reply', text: late })); pending = undefined
    await expect(chat).toContainText(late)
    expect(Math.abs(await scroll.evaluate(element => element.scrollTop) - position)).toBeLessThan(2)
    const pageData = await call<TaskMessagePage>({ type: 'host.messages.page', task_id: task })
    const run = (await status(original.request_id)).run_id
    expect(pageData.items.at(-1)).toMatchObject({ text: late, run_id: run })
    const activity = await call<RunActivity>({ type: 'host.run.activity', task_id: task, run_id: run })
    expect(activity.request).toBe(first)
    expect(activity.items.at(-1)).toMatchObject({ id: pageData.items.at(-1)?.id, type: 'reply' })
    await chat.getByRole('button', { name: `回复：${first}`, exact: true }).click()
    await expect(firstRow).toBeFocused()
    await firstRow.getByRole('button', { name: '执行详情' }).click()
    const details = page.getByRole('dialog', { name: '本次请求详情' })
    await details.getByRole('button', { name: '用量', exact: true }).click()
    await details.getByRole('button', { name: '查询单次请求用量' }).click()
    await expect(details.getByRole('status')).toContainText('快照截至记录序号')
    await expect(details.getByText('请求 1 · 主模型 · 请求完成')).toBeVisible()
    await details.getByRole('button', { name: '过程与结果', exact: true }).click()
    const usage = page.locator('.composer-usage')
    const originalUsage = '此任务暂无实报 Token。'
    await expect(usage).toHaveAttribute('title', originalUsage)
    await details.getByRole('button', { name: '查看此执行流程' }).click()
    const flow = page.getByRole('region', { name: '实时执行流程', exact: true })
    await expect(flow.getByText('当前没有正在执行的工作')).toBeVisible()
    await expect(flow.locator('.flow-card')).toHaveCount(0)
    await expect(usage).toHaveAttribute('title', originalUsage)
    await expect(chat).toContainText(late)
  } finally { pending?.destroy(); await app.close(); await server.close(); await rm(directory, { recursive: true, force: true }) }
})
test('Agent sidebar keeps replies on the right and input fixed at the bottom', async () => {
  test.setTimeout(90000)
  const pendingResponse: { current: Parameters<typeof textStream>[0] | null } = { current: null }
  const server = await modelServer(({ body }, res) => {
    if (synthetic(body, res)) return
    const input = JSON.parse(body.messages.findLast((message: any) => message.role === 'user').content).request
    if (input === '读取长回复') { textStream(res, '中文解释'.repeat(1800) + '<script>window.AGENT_EXECUTED=true</script>长回复末尾'); return }
    if (input === '等待回复以检查队列') { pendingResponse.current = res; return }
    textStream(res, '中文回复：原子性关注一起完成，一致性关注业务规则。')
  })
  const directory = await mkdtemp(join(tmpdir(), 'pliuna-agent-conversation-'))
  const app = await electron.launch({ executablePath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', PLIUNA_TEST_DATA: directory } })
  try {
    const page = await app.firstWindow(), errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewportSize({ width: 1440, height: 960 })
    const agent = page.locator('#pane-right'), center = page.getByRole('main')
    const reply = agent.getByRole('region', { name: '任务对话', exact: true })
    const call = async (request: any): Promise<any> => page.evaluate(async request => { const response = await window.pliuna.request(request); if (!response.ok) throw Error(response.error.code); return response.data }, request)
    await configureModel(page, { id: 'conversation-main', url: server.url, key: 'isolated-agent-key', model: 'wire-model', context: 100000, output: 2048 })
    await call({ type: 'model.test', model_id: 'conversation-main', role: 'main', confirm_cost: true })
    await page.getByRole('button', { name: '创建第一个任务' }).click()
    await page.getByLabel('任务名称').fill('Agent 状态栏验收')
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    const task = (await call({ type: 'host.tasks' }))[0].id
    const input = page.getByLabel('想从哪里开始？'), send = page.getByRole('button', { name: '发送消息', exact: true })
    await expect(page.locator('.agent-ready')).toContainText('发送你的第一个请求')
    await expect(page.locator('.agent-state-scroll .run-outcome')).toHaveCount(0)
    await expect(page.getByRole('region', { name: '请求队列', exact: true })).toHaveCount(0)
    await input.fill('中文组合输入')
    await expect(send).toBeEnabled()
    await input.dispatchEvent('compositionstart')
    await input.dispatchEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, keyCode: 229 })
    expect((await call({ type: 'request.list', task_id: task })).items).toHaveLength(0)
    await input.dispatchEvent('compositionend')
    await input.press('Control+Enter')
    await expect(page.locator('.agent-status')).toHaveText('本次执行已完成')
    await expect(reply).toContainText('中文回复：原子性')
    await expect(reply.getByRole('article', { name: '你的消息' })).toContainText('中文组合输入')
    await agent.getByRole('button', { name: '执行记录', exact: true }).click()
    await expect(agent.getByRole('button', { name: '查看执行流程' })).toBeVisible()
    await agent.getByRole('button', { name: '对话', exact: true }).click()
    await expect(reply.getByRole('article', { name: 'Agent的消息' })).toBeVisible()
    await expect(center).not.toContainText('中文回复：原子性')
    await expect(center.locator('.task-reply, .runner-working-copy, .runner-goals')).toHaveCount(0)
    await expect(center.getByRole('heading', { name: '尚无已发布内容', exact: true })).toBeVisible()
    await expect(center.locator('.managed')).toHaveCount(0)
    expect(await page.locator('.agent .message,.agent pre,.agent code').count()).toBe(0)
    const geometry = await page.evaluate(() => {
      const status = document.querySelector('.agent-status')!, heading = document.querySelector('.agent-activity-strip')!, composer = document.querySelector('.agent-composer')!, agent = document.querySelector('.agent')!
      return { sameRow: status.parentElement === heading, headingHeight: heading.getBoundingClientRect().height, composerBottom: composer.getBoundingClientRect().bottom, agentBottom: agent.getBoundingClientRect().bottom, agentWidth: agent.getBoundingClientRect().width }
    })
    expect(geometry.sameRow).toBe(true)
    expect(geometry.composerBottom).toBeCloseTo(geometry.agentBottom, 0)
    expect(geometry.agentWidth).toBeCloseTo(278, 0)
    expect(await page.locator('.agent-state-scroll:not([hidden])').innerText()).not.toContain('本次执行已完成')
    await input.fill('打开工具后保留的中文草稿')
    const beforeTools = server.exchanges.length
    await page.getByRole('button', { name: '更多 Agent 操作' }).click();await page.getByRole('menuitem', { name: '本次请求详情', exact: true }).click()
    const details = page.getByRole('dialog', { name: '本次请求详情', exact: true })
    await expect(details.getByLabel('最近 Run 结果')).toContainText('completed')
    await details.getByRole('button', { name: '用量', exact: true }).click()
    await details.getByRole('button', { name: '查询单次请求用量', exact: true }).click()
    await expect(details.getByRole('status')).toContainText('快照截至记录序号')
    await details.getByRole('button', { name: '原记录', exact: true }).click()
    await expect(details.getByRole('region', { name: '本次运行分页浏览' })).toContainText('本次运行')
    await details.getByRole('button', { name: '关闭弹窗' }).click()
    await page.getByRole('button', { name: '更多 Agent 操作' }).click()
    await page.getByRole('menuitem', { name: '工作摘要与上下文' }).click()
    await expect(page.getByRole('region', { name: '上下文管理' })).toBeVisible()
    await page.getByRole('button', { name: '关闭弹窗' }).click()
    expect(server.exchanges).toHaveLength(beforeTools)
    await expect(input).toHaveValue('打开工具后保留的中文草稿')
    const file = join(directory, '中文材料.txt')
    await writeFile(file, '材料正文只在显式读取时使用')
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, file)
    await page.getByRole('button', { name: /^本次请求材料/ }).click()
    await page.getByRole('button', { name: '选择新文件并绑定请求' }).click()
    await page.getByRole('button', { name: '完成选择', exact: true }).click()
    await expect(page.locator('.composer-materials')).toContainText('中文材料.txt')
    await input.evaluate(el => el.setAttribute('data-agent-editor', 'retained'))
    await page.locator('#toggle-right').click()
    await page.locator('#toggle-right').click()
    await expect(input).toHaveAttribute('data-agent-editor', 'retained')
    await expect(input).toHaveValue('打开工具后保留的中文草稿')
    await expect(page.locator('.composer-materials')).toContainText('中文材料.txt')
    await expect(reply).toContainText('中文回复：原子性')
    const compactHeight = (await input.boundingBox())!.height
    const longDraft = Array.from({ length: 60 }, (_, i) => `草稿第 ${i + 1} 段`).join('\n') + '\n' + '字'.repeat(500)
    await input.fill(longDraft)
    await expect.poll(async () => (await input.boundingBox())!.height).toBeGreaterThan(compactHeight)
    await app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as any)._invokeHandlers, original = handlers.get('pliuna:request')
      const failures = ['INVALID_INPUT', 'UNKNOWN_RESULT']
      handlers.set('pliuna:request', (event: unknown, request: { type: string }) => {
        if (request.type === 'request.submit' && failures.length) return { ok: false, error: { code: failures.shift(), message: '隔离测试的发送结果' } }
        return original(event, request)
      })
    })
    const feedback = page.locator('.composer-feedback')
    await send.click()
    await expect(feedback).toContainText('INVALID_INPUT')
    await expect(send).toBeEnabled()
    await expect(input).toHaveValue(longDraft)
    await send.click()
    await expect(feedback).toContainText('提交结果未知，输入和材料保留')
    await expect(send).toBeDisabled()
    await expect(input).toHaveValue(longDraft)
    await expect(page.locator('.composer-materials')).toContainText('中文材料.txt')
    expect((await call({ type: 'request.list', task_id: task })).items).toHaveLength(1)
    await feedback.getByRole('button', { name: '已核对原结果' }).click()
    await page.getByRole('button', { name: '确认已核对', exact: true }).click()
    await send.click()
    await expect(input).toHaveValue('')
    await expect.poll(async () => (await input.boundingBox())!.height).toBeCloseTo(compactHeight, 0)
    await expect(page.locator('.composer-materials')).toHaveCount(0)
    await expect(page.locator('.agent-status')).toHaveText('本次执行已完成')
    await input.fill('读取长回复');await send.click()
    const longReply = reply.getByRole('article', { name: 'Agent的消息' }).last()
    await expect(longReply.getByRole('button', { name: '展开原文' })).toBeVisible()
    await longReply.getByRole('button', { name: '展开原文' }).click()
    await longReply.getByRole('button', { name: '继续读取' }).click()
    await longReply.getByRole('button', { name: '继续读取' }).click()
    await expect(longReply).toContainText('长回复末尾')
    await expect(reply.getByRole('article', { name: '你的消息' })).toHaveCount(3)
    await expect(reply.getByRole('article', { name: 'Agent的消息' })).toHaveCount(3)
    await expect(reply).toContainText('中文组合输入')
    expect((await call({ type: 'task.snapshot', task_id: task })).records.findLast((record: any) => record.kind === 'message.assistant').payload.truncated).toBe(true)
    expect(await page.evaluate(() => (window as any).AGENT_EXECUTED)).toBeUndefined()
    await expect(reply).toContainText('中文解释')
    await expect(center).not.toContainText('中文解释')
    await expect(center.locator('.task-reply, .runner-working-copy, .runner-goals')).toHaveCount(0)
    await expect(center.getByRole('heading', { name: '尚无已发布内容', exact: true })).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('pliuna-agent-status-implemented.png') })
    for (const theme of ['graphite', 'paper', 'midnight', 'dusk', 'moss', 'blueprint']) {
      await chooseTheme(page, theme)
      for (const width of [1440, 720, 390]) {
        await page.setViewportSize({ width, height: 850 })
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
        if (await page.locator('#pane-right').isHidden()) await page.getByRole('navigation', { name: '工作区视图' }).getByRole('button', { name: 'Agent', exact: true }).click()
        await expect(page.locator('#pane-right')).toBeVisible()
        await expect(reply).toContainText('长回复末尾')
        await expect(center.locator('.task-reply, .runner-working-copy, .runner-goals')).toHaveCount(0)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        expect(await page.locator('.agent').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
        await expect(send).toBeVisible()
      }
      await page.setViewportSize({ width: 1440, height: 960 }); await expect(page.locator('#pane-right')).toBeVisible()
    }
    await chooseTheme(page, 'graphite')
    for (const size of ['90', '100', '110', '125', '140']) {
      await page.evaluate(value => { document.documentElement.style.setProperty('--text-scale', String(Number(value)/100)) }, size)
      await page.setViewportSize({ width: 1440, height: 960 })
      expect(await page.locator('.agent').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
      const bounds = await page.locator('.agent').boundingBox(), box = await page.locator('.agent-composer').boundingBox()
      expect(box!.y + box!.height).toBeCloseTo(bounds!.y + bounds!.height, 0)
      await expect(send).toBeVisible()
    }
    await page.evaluate(() => document.documentElement.style.setProperty('--text-scale', '1'))
    await input.fill('等待回复以检查队列'); await send.click()
    await expect.poll(() => Boolean(pendingResponse.current)).toBe(true)
    await expect(page.locator('.agent-status')).toHaveText('正在生成')
    await input.fill('排队的中文问题'); await send.click()
    await page.getByRole('button', { name: '请求队列', exact: true }).click()
    const queue = page.getByRole('region', { name: '请求队列', exact: true })
    const queued = queue.locator('article').filter({ hasText: '排队的中文问题' })
    await expect(queued).toContainText('等待材料／排队')
    await queued.getByRole('button', { name: '取消未启动请求' }).click()
    await expect(queued).toContainText('已取消')
    await page.getByRole('button', { name: '关闭弹窗' }).click()
    await page.getByRole('button', { name: '停止本次执行', exact: true }).click()
    await page.getByRole('button', { name: '继续执行', exact: true }).click()
    await expect(page.locator('.agent-status')).toHaveText('正在生成')
    await page.getByRole('button', { name: '停止本次执行', exact: true }).click()
    await page.getByRole('dialog', { name: '停止当前执行？' }).getByRole('button', { name: '停止本次执行', exact: true }).click()
    await expect(page.locator('.agent-status')).toHaveText('本次执行已停止')
    expect((await call({ type: 'request.list', task_id: task })).items).toHaveLength(5)
    expect(errors).toEqual([])
  } finally { pendingResponse.current?.destroy(); await app.close(); await server.close(); await rm(directory, { recursive: true, force: true }) }
})

test('Agent activity follows this request and actual tool outcomes instead of a fixed timeline', async () => {
  test.setTimeout(60000)
  let dataId = ''
  const server = await modelServer(({ body }, res) => {
    if (synthetic(body, res)) return
    if (body.messages.at(-1).role === 'tool') {
      const result = JSON.parse(body.messages.at(-1).content)
      if (result.data?.id) dataId = result.data.id
      textStream(res, '此处是正文回复，不应进入状态栏。'); return
    }
    const request = JSON.parse(body.messages.findLast((message: any) => message.role === 'user').content).request
    if (request === '创建学习进度') hostToolStream(res, 'write', { type: 'task_data.create', data: { schema: { type: 'string' }, value: '学习第一课', references: [] } })
    else if (request === '读取学习进度') hostToolStream(res, 'read', { target: { kind: 'task_data', id: dataId } })
    else if (request === '读取不存在的进度') hostToolStream(res, 'read', { target: { kind: 'task_data', id: 'missing-progress' } })
    else textStream(res, '这是一次纯问答回复。')
  })
  const directory = await mkdtemp(join(tmpdir(), 'pliuna-agent-activity-'))
  const app = await electron.launch({ executablePath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', PLIUNA_TEST_DATA: directory } })
  try {
    const page = await app.firstWindow(), errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await configureModel(page, { id: 'activity-main', url: server.url, key: 'isolated-activity-key', model: 'wire-model', context: 100000, output: 2048 })
    await page.evaluate(async () => { const result = await window.pliuna.request({ type: 'model.test', model_id: 'activity-main', role: 'main', confirm_cost: true }); if (!result.ok) throw Error(result.error.code) })
    await page.getByRole('button', { name: '创建第一个任务' }).click()
    await page.getByLabel('任务名称').fill('学习计划')
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    const input = page.getByLabel('想从哪里开始？'), send = page.getByRole('button', { name: '发送消息', exact: true })
    await page.locator('.agent-tabs').getByRole('button', { name: '执行记录', exact: true }).click()
    const dynamic = page.getByRole('region', { name: '本次执行动态' })
    for (const [request, operation, result] of [['创建学习进度', '创建任务数据', '已完成'], ['读取学习进度', '读取任务数据', '已完成'], ['读取不存在的进度', '读取任务数据', '未执行']]) {
      await input.fill(request!); await send.click()
      await expect(page.locator('.agent-status')).toHaveText('本次执行已完成')
      await expect(dynamic.locator('.agent-request')).toContainText(request!)
      const row = dynamic.locator('li').filter({ hasText: operation! })
      await expect(row).toContainText(result!)
      await expect(dynamic).toContainText('回复已保存')
      await expect(dynamic).not.toContainText('请求已启动')
      await expect(dynamic).not.toContainText('查看任务内容与记录')
      await expect(dynamic).not.toContainText('此处是正文回复')
      expect(await dynamic.locator('li').count()).toBeLessThanOrEqual(3)
    }
    await input.fill('解释学习间隔'); await send.click()
    await expect(dynamic.locator('.agent-request')).toContainText('解释学习间隔')
    await expect(dynamic.locator('li')).toHaveCount(1)
    await expect(dynamic).toContainText('回复已保存')
    await expect(dynamic).not.toContainText('读取任务数据')
    await expect(dynamic).not.toContainText('创建任务数据')
    for (const width of [1440, 720, 390]) {
      await page.setViewportSize({ width, height: 850 })
      if (await page.locator('#pane-right').isHidden()) await page.getByRole('navigation', { name: '工作区视图' }).getByRole('button', { name: 'Agent', exact: true }).click()
      expect(await page.locator('.agent').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    }
    await page.setViewportSize({ width: 1440, height: 960 })
    await page.screenshot({ path: test.info().outputPath('pliuna-agent-dynamic-activity.png') })
    await page.getByRole('button', { name: '＋ 新建任务', exact: true }).click()
    await page.getByLabel('任务名称').fill('另一个任务')
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    await expect(page.locator('.agent-ready')).toContainText('发送你的第一个请求')
    await expect(dynamic).toHaveCount(0)
    expect(errors).toEqual([])
  } finally { await app.close(); await server.close(); await rm(directory, { recursive: true, force: true }) }
})

test('approval stays on its originating message while another Run is stopped', async () => {
  test.setTimeout(90000)
  const alpha = 'ALPHA：生成交付内容，先移除临时的任务条目。', beta = 'BETA：等待独立回复。'
  let dataId = '', held: ServerResponse | undefined, removeCalls = 0
  const server = await modelServer(({ body }, response) => {
    if (synthetic(body, response)) return
    const system = body.messages[0].content ?? '', last = body.messages.at(-1)
    const current = JSON.parse(body.messages.findLast((message: { role: string }) => message.role === 'user').content).request
    if (!system.includes('Bound data: ')) {
      if (current === alpha) textStream(response, JSON.stringify({ kind: 'new' }))
      else if (current === beta) held = response
      else textStream(response, JSON.stringify({ kind: 'reply', text: '后续对话仍然可用。' }))
      return
    }
    const binding = JSON.parse(system.slice(system.indexOf('Bound data: ') + 'Bound data: '.length)) as { requirement_ids: string[] }
    if (last.role !== 'tool') {
      hostToolStream(response, 'write', { type: 'task_data.create', data: { schema: { type: 'string' }, value: 'PRIVATE_ALPHA_DATA', references: [] } }, '', 'alpha-create')
    } else if (last.tool_call_id === 'alpha-create') {
      dataId = JSON.parse(last.content).data.id
      removeCalls++
      hostToolStream(response, 'write', { type: 'task_data.remove', id: dataId, expected_revision: 1 }, '', 'alpha-remove')
    } else textStream(response, JSON.stringify({ version: 1, complete: false, answer: 'ALPHA 操作已结束。', artifacts: [], requirement_ids: [], unresolved: binding.requirement_ids }))
  })
  const directory = await mkdtemp(join(tmpdir(), 'pliuna-runner-messages-')), env = { ...process.env }
  delete env.PLIUNA_TEST_RUNNER; delete env.TRELLIS_TEST_RUNNER
  const app = await electron.launch({ executablePath, args: ['.'], env: { ...env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', PLIUNA_TEST_DATA: directory } })
  try {
    const page = await app.firstWindow()
    await page.setViewportSize({ width: 1440, height: 960 })
    const call = async <T,>(request: HostRequest): Promise<T> => page.evaluate(async request => {
      const response = await window.pliuna.request(request)
      if (!response.ok) throw Error(response.error.code)
      return response.data as T
    }, request)
    await configureModel(page, { id: 'runner-main', url: server.url, key: 'isolated-runner-key', model: 'runner-wire', context: 100000, output: 4096 })
    await chooseModel(page, 'runner-main')
    await page.getByRole('button', { name: '创建第一个任务' }).click()
    await page.getByLabel('任务名称').fill('消息审批和独立运行')
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    const task = (await call<{ id: string }[]>({ type: 'host.tasks' }))[0]!.id
    const snapshot = () => call<Snapshot>({ type: 'task.snapshot', task_id: task })
    const chat = page.getByRole('region', { name: '任务对话', exact: true })
    const row = (text: string) => chat.getByRole('article', { name: '你的消息' }).filter({ hasText: text })
    const send = async (text: string) => {
      await page.getByLabel('想从哪里开始？').fill(text)
      await page.getByRole('button', { name: '发送消息', exact: true }).click()
    }
    await send(alpha)
    const approval = row(alpha).locator('.approval-card')
    await expect(approval).toContainText('移除任务数据')
    await expect(approval).not.toContainText('PRIVATE_ALPHA_DATA')
    await expect(approval.getByRole('button')).toHaveCount(2)
    const pending = (await snapshot()).approvals.find(item => item.decision === 'pending')!
    await send(beta)
    await expect.poll(() => !!held).toBe(true)
    await expect(row(beta).locator('.approval-card')).toHaveCount(0)
    await row(alpha).getByRole('button', { name: '执行详情' }).click()
    await page.getByRole('dialog', { name: '本次请求详情' }).getByRole('button', { name: '查看此执行流程' }).click()
    const flow = page.getByRole('region', { name: '实时执行流程', exact: true })
    await expect(flow.locator('.flow-card[aria-pressed=true]')).toContainText('待审批')
    await page.getByRole('navigation', { name: 'Agent 视图' }).getByRole('button', { name: '执行记录', exact: true }).click()
    await page.getByRole('button', { name: '收起Agent 栏' }).click()
    await flow.getByRole('button', { name: '前往 Agent 审批' }).click()
    await expect(approval).toBeFocused()
    await row(beta).getByRole('button', { name: '停止本次执行' }).click()
    await page.getByRole('dialog', { name: '停止当前执行？' }).getByRole('button', { name: '停止本次执行' }).click()
    await expect(row(beta)).toContainText('本次执行已停止')
    await expect(approval).toBeVisible()
    await approval.getByRole('button', { name: '批准', exact: true }).click()
    await expect(approval).toHaveCount(0)
    await expect.poll(async () => (await snapshot()).approvals.find(item => item.id === pending.id)?.decision).toBe('approve')
    await expect(call({ type: 'approval.decide', task_id: task, approval_id: pending.id, decision: 'approve' })).rejects.toThrow('APPROVAL_INVALID')
    await expect.poll(async () => (await snapshot()).task_data.total).toBe(0)
    expect(removeCalls).toBe(1)
    await expect.poll(async () => (await snapshot()).records.filter(record => record.kind === 'approval.decided')).toHaveLength(1)
    await expect(page.getByRole('region', { name: '各目标状态' })).toHaveCount(0)
  } finally {
    held?.destroy(); await app.close(); await server.close(); await rm(directory, { recursive: true, force: true })
  }
})
