import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { configureModel, chooseTheme } from '../helpers/settings-ui'
import { hostToolStream, modelServer, synthetic, textStream } from '../helpers/model-server'

const executablePath: string = createRequire(import.meta.url)('electron')
test('Agent status sidebar keeps output central and input fixed at the bottom', async () => {
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
    const call = async (request: any): Promise<any> => page.evaluate(async request => { const response = await window.pliuna.request(request); if (!response.ok) throw Error(response.error.code); return response.data }, request)
    await configureModel(page, { id: 'conversation-main', url: server.url, key: 'isolated-agent-key', model: 'wire-model', context: 100000, output: 2048 })
    await call({ type: 'model.test', model_id: 'conversation-main', role: 'main', confirm_cost: true })
    await page.getByRole('button', { name: '创建第一个任务' }).click()
    await page.getByLabel('任务名称').fill('Agent 状态栏验收')
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    const task = (await call({ type: 'host.tasks' }))[0].id
    const input = page.getByLabel('想从哪里开始？'), send = page.getByRole('button', { name: '发送 · 新 Run', exact: true })
    await expect(page.locator('.agent-ready')).toContainText('准备就绪')
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
    await expect(page.locator('.task-reply')).toContainText('中文回复：原子性');expect(await page.locator('.agent-state-scroll').innerText()).not.toContain('中文回复：原子性');expect(await page.locator('.agent .message,.agent pre,.agent code').count()).toBe(0)
    const geometry = await page.evaluate(() => {
      const status = document.querySelector('.agent-status')!, heading = document.querySelector('.agent-heading')!, composer = document.querySelector('.agent-composer')!, agent = document.querySelector('.agent')!
      return { sameRow: status.parentElement === heading, headingHeight: heading.getBoundingClientRect().height, composerBottom: composer.getBoundingClientRect().bottom, agentBottom: agent.getBoundingClientRect().bottom }
    })
    expect(geometry.sameRow).toBe(true)
    expect(geometry.composerBottom).toBeCloseTo(geometry.agentBottom, 0)
    expect(await page.locator('.agent-state-scroll').innerText()).not.toContain('本次执行已完成')
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
    await page.getByRole('button', { name: '关闭Agent 栏', exact: true }).click()
    await page.locator('#toggle-right').click()
    await expect(input).toHaveAttribute('data-agent-editor', 'retained')
    await expect(input).toHaveValue('打开工具后保留的中文草稿')
    await expect(page.locator('.composer-materials')).toContainText('中文材料.txt')
    await send.click()
    await expect(page.locator('.composer-materials')).toHaveCount(0)
    await expect(page.locator('.agent-status')).toHaveText('本次执行已完成')
    await input.fill('读取长回复');await send.click()
    await expect(page.locator('.task-reply-text').last()).toContainText('长回复末尾')
    expect((await call({ type: 'task.snapshot', task_id: task })).records.findLast((record: any) => record.kind === 'message.assistant').payload.truncated).toBe(true)
    expect(await page.evaluate(() => (window as any).AGENT_EXECUTED)).toBeUndefined()
    expect(await page.locator('.agent-state-scroll').innerText()).not.toContain('中文解释')
    await page.screenshot({ path: test.info().outputPath('pliuna-agent-status-implemented.png') })
    for (const theme of ['graphite', 'paper', 'midnight', 'dusk', 'moss', 'blueprint']) {
      await chooseTheme(page, theme)
      for (const width of [1440, 720, 390]) {
        await page.setViewportSize({ width, height: 850 })
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
        if (await page.locator('#pane-right').isHidden()) await page.locator('#toggle-right').click()
        await expect(page.locator('#pane-right')).toBeVisible()
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
    const input = page.getByLabel('想从哪里开始？'), send = page.getByRole('button', { name: '发送 · 新 Run', exact: true })
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
      if (await page.locator('#pane-right').isHidden()) await page.locator('#toggle-right').click()
      expect(await page.locator('.agent').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    }
    await page.setViewportSize({ width: 1440, height: 960 })
    await page.screenshot({ path: test.info().outputPath('pliuna-agent-dynamic-activity.png') })
    await page.getByRole('button', { name: '＋ 新建', exact: true }).click()
    await page.getByLabel('任务名称').fill('另一个任务')
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    await expect(page.locator('.agent-ready')).toContainText('准备就绪')
    await expect(dynamic).toHaveCount(0)
    expect(errors).toEqual([])
  } finally { await app.close(); await server.close(); await rm(directory, { recursive: true, force: true }) }
})
