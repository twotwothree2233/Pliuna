import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { chooseModel, chooseTheme, configureModel } from '../helpers/settings-ui'
import { hostToolStream, modelServer, synthetic, textStream } from '../helpers/model-server'
const electronPath: string = createRequire(import.meta.url)('electron')

test('continuous task reading: inline records, saved drafts, history and safe resources', async () => {
  test.setTimeout(90000)
  const directory = await mkdtemp(join(tmpdir(), 'trellis-task-reading-'))
  const app = await electron.launch({ executablePath: electronPath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', TRELLIS_TEST_DATA: directory } })
  try {
    const page = await app.firstWindow(), errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewportSize({ width: 1440, height: 960 })
    await page.getByRole('button', { name: '创建第一个任务' }).click()
    await page.getByLabel('任务名称').fill('连续阅读验收')
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    await chooseModel(page, 'fixture')
    const send = async (text: string) => { await page.getByLabel('想从哪里开始？').fill(text); await page.getByRole('button', { name: /发送 · 新 Run/ }).click() }
    await send('理解原子性')
    await expect(page.getByRole('heading', { name: '思考与记录' })).toBeVisible()
    await page.getByLabel('你的想法').fill('第一份中文作答')
    await expect(page.locator('.managed').getByRole('status')).toHaveText('已保存')
    await page.getByRole('button', { name: '提交答案', exact: true }).click()
    await expect(page.locator('.managed').getByRole('status')).toContainText('提交成功')
    await page.getByLabel('你的想法').fill('第二份中文作答')
    await expect(page.locator('.managed').getByRole('status')).toHaveText('已保存')
    await page.getByRole('button', { name: '提交答案', exact: true }).click()
    await expect(page.locator('.managed').getByRole('status')).toContainText('提交成功')
    await page.getByRole('tab', { name: /作答记录/ }).click()
    const answers = page.getByRole('region', { name: '全部作答分页浏览', exact: true })
    await expect(answers.locator('.record-row')).toHaveCount(2)
    await answers.locator('.record-row').last().click()
    await expect(answers.locator('.record-detail > .record-values').first()).toContainText('第二份中文作答')
    expect(await answers.locator('.record-rows > .record-detail').evaluate(el => el.previousElementSibling?.getAttribute('aria-expanded'))).toBe('true')
    await answers.getByText('与上一次作答对照', { exact: true }).click()
    await expect(answers.locator('details[open] .record-values')).toContainText('第一份中文作答')
    let continuation = ''
    page.once('dialog', async dialog => { continuation = dialog.message(); await dialog.dismiss() })
    await answers.getByRole('button', { name: '基于已保存作答继续', exact: true }).click()
    const selectedAnswer = await answers.locator('.record-rows > .record-detail > header > .mono').textContent()
    expect(continuation).toContain(selectedAnswer!)
    expect(await page.evaluate(async () => { const tasks = await window.trellis.request({ type: 'host.tasks' }); if (!tasks.ok) throw Error(tasks.error.code); const taskId = (tasks.data as { id: string }[])[0]!.id; const result = await window.trellis.request({ type: 'task.snapshot', task_id: taskId }); if (!result.ok) throw Error(result.error.code); return (result.data as { runs: unknown[] }).runs.length })).toBe(1)
    await answers.getByRole('button', { name: '回到当前内容', exact: true }).click()
    await expect(page.getByLabel('你的想法')).toHaveValue('第二份中文作答')
    await send('继续理解一致性')
    await expect(page.locator('.managed')).toHaveCount(2)
    const ids = await page.locator('.managed').evaluateAll(nodes => nodes.map(node => node.id.replace('content-', '')))
    await page.getByLabel('本页内容').selectOption(ids[1]!)
    await expect(page.locator('.managed').last()).toBeInViewport()
    await page.getByRole('tab', { name: /任务数据/ }).click()
    await expect(page.getByText('存在未保存或冲突输入，请等待保存完成或明确处理冲突后再切换任务。', { exact: true })).toHaveCount(0)
    const data = page.getByRole('region', { name: '全部任务数据分页浏览', exact: true })
    await expect(data.locator('.record-row')).toHaveCount(0)
    const taskId = await page.evaluate(async () => { const response = await window.trellis.request({ type: 'host.tasks' }); if (!response.ok) throw Error(response.error.code); return (response.data as { id: string }[])[0]!.id })
    await app.evaluate((_electron, { directory, taskId }) => {
      const Database = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('better-sqlite3')
      const db = new Database(directory + '/trellis.sqlite')
      try { db.prepare('INSERT INTO task_data (id,task_id,revision,schema_json,value_json,references_json) VALUES (?,?,1,?,?,?)').run('reading-data', taskId, JSON.stringify({ type: 'object', properties: { topic: { type: 'string' } } }), JSON.stringify({ topic: '事务与一致性' }), '[]') } finally { db.close() }
    }, { directory, taskId })
    await data.getByRole('button', { name: '刷新全部任务数据', exact: true }).click()
    await data.locator('.record-row').click()
    await expect(data.locator('.record-values')).toContainText('事务与一致性')
    await data.getByRole('button', { name: '原始 JSON', exact: true }).click()
    await expect(data.locator('pre')).toContainText('reading-data')
    await data.getByRole('button', { name: '结构', exact: true }).click()
    await expect(data.locator('pre')).toContainText('properties')
    await data.getByRole('button', { name: '收起详情', exact: true }).click()
    await expect(data.locator('.record-detail')).toHaveCount(0)
    await page.getByRole('tab', { name: '资源', exact: true }).click()
    await page.getByRole('button', { name: '粘贴文本', exact: true }).click()
    await page.getByLabel('材料名称').fill('中文材料')
    const activeText = '<script>window.RECORD_EXECUTED=true</script> 安全原文'
    await page.getByLabel('添加为材料的文本').fill(activeText)
    await page.getByRole('tab', { name: /内容/ }).click()
    await expect(page.getByLabel('添加为材料的文本')).toHaveValue(activeText)
    await page.getByRole('button', { name: '将文本保存为材料', exact: true }).click()
    await expect(page.getByLabel('添加为材料的文本')).toHaveValue('')
    const resources = page.getByRole('region', { name: '全部资源分页浏览', exact: true })
    await resources.getByRole('button', { name: /中文材料/ }).click()
    await expect(resources.locator('.record-value-text')).toContainText(activeText)
    expect(await page.evaluate(() => (window as any).RECORD_EXECUTED)).toBeUndefined()
    await resources.getByRole('button', { name: '来源与记录', exact: true }).click()
    await expect(resources.locator('.record-values')).toContainText('text/plain')
    await resources.getByLabel('搜索全部资源已加载记录').fill('没有的资源')
    await expect(resources.getByRole('status').filter({ hasText: '没有匹配项' })).toBeVisible()
    await resources.getByLabel('搜索全部资源已加载记录').fill('')
    await page.getByRole('tab', { name: /执行记录/ }).click()
    await expect(page.locator('.execution-category[open]')).toHaveCount(0)
    const runs = page.getByRole('region', { name: '全部运行分页浏览', exact: true })
    await runs.locator('.record-row').first().click()
    await expect(runs.locator('.run-reading-outcome')).toContainText('开发夹具')
    await page.locator('.execution-category > summary').filter({ hasText: /^全部消息$/ }).click()
    await expect(page.getByRole('region', { name: '全部消息分页浏览', exact: true }).locator('.record-row')).not.toHaveCount(0)
    for (const theme of ['graphite', 'paper', 'midnight', 'dusk', 'moss', 'blueprint']) {
      await chooseTheme(page, theme)
      for (const width of [390, 720, 1440]) {
        await page.setViewportSize({ width, height: 960 })
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      }
    }
    await page.setViewportSize({ width: 1440, height: 960 })
    await chooseTheme(page, 'graphite')
    for (const [id, name] of [['surface', '内容'], ['data', '任务数据'], ['resources', '资源'], ['answers', '作答记录'], ['execution', '执行记录']] as const) {
      await page.getByRole('tab', { name: new RegExp('^' + name) }).click()
      if (id === 'data') await page.getByRole('region', { name: '全部任务数据分页浏览', exact: true }).locator('.record-row').first().click()
      if (id === 'answers') await page.getByRole('region', { name: '全部作答分页浏览', exact: true }).locator('.record-row').last().click()
      if (id === 'resources') await page.getByRole('region', { name: '全部资源分页浏览', exact: true }).getByRole('button', { name: /中文材料/ }).click()
      if (id === 'execution') await page.getByRole('region', { name: '全部运行分页浏览', exact: true }).locator('.record-row').first().click()
      await page.screenshot({ path: join(tmpdir(), `trellis-task-A-${id}.png`) })
    }
    expect(errors).toEqual([])
  } finally { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy())).catch(() => {}); await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('windowed answer actions use the selected answer independently of segmented JSON', async () => {
  test.setTimeout(90000)
  const requests: string[] = [], pending: { response: Parameters<typeof textStream>[0] | null } = { response: null }
  const server = await modelServer(({ body }, response) => {
    if (synthetic(body, response)) return
    const request = JSON.parse(body.messages.findLast((message: any) => message.role === 'user').content).request
    requests.push(request)
    if (request === '等待作答操作测试') { pending.response = response; return }
    const last = body.messages.at(-1)
    if (request !== '创建长作答练习') { textStream(response, '已收到所选作答的继续请求。'); return }
    if (last.role !== 'tool') { hostToolStream(response, 'list', { kind: 'surface' }, '', 'find-surface'); return }
    if (last.tool_call_id !== 'find-surface') { textStream(response, '长作答练习已创建。'); return }
    const surface = JSON.parse(last.content).data.items[0]
    hostToolStream(response, 'write', { type: 'surface.update', surface_id: surface.id, expected_revision: surface.revision, operations: [{ type: 'view.create', client_ref: 'long-answer', slot_id: 'main', bundle: { type: 'inline', bundle: {
      profile: 'managed-v1', html: '<section><h2>长作答练习</h2><label for="response">长作答内容</label><textarea id="response"></textarea><button id="submit" type="button">保存正式作答</button></section>', css: '',
      state: { schema: { type: 'object', properties: { response: { type: 'string', minLength: 1, maxLength: 200000 } }, required: ['response'], additionalProperties: false }, initial: { response: '' }, compatibility_version: 'long-answer-v1' },
      forms: [{ id: 'exercise', fields: ['/response'] }], behaviors: [{ type: 'input', element_id: 'response', field: '/response', control: 'textarea' }, { type: 'submit', element_id: 'submit', form_id: 'exercise' }], references: [], export: []
    } } }] })
  })
  const directory = await mkdtemp(join(tmpdir(), 'trellis-windowed-answer-'))
  const app = await electron.launch({ executablePath: electronPath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', TRELLIS_TEST_DATA: directory } })
  try {
    const page = await app.firstWindow(), errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewportSize({ width: 1440, height: 960 })
    const call = async (request: any): Promise<any> => page.evaluate(async request => { const result = await window.trellis.request(request); if (!result.ok) throw Error(result.error.code); return result.data }, request)
    await configureModel(page, { id: 'answer-main', url: server.url, key: 'isolated-answer-test-key', model: 'wire-model', context: 1000000, output: 4096 })
    await call({ type: 'model.test', model_id: 'answer-main', role: 'main', confirm_cost: true })
    await page.getByRole('button', { name: '创建第一个任务' }).click()
    await page.getByLabel('任务名称').fill('分段作答操作')
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    const send = async (text: string) => { await page.getByLabel('想从哪里开始？').fill(text); await page.getByRole('button', { name: '发送 · 新 Run', exact: true }).click() }
    await send('创建长作答练习')
    await expect(page.getByRole('heading', { name: '长作答练习', exact: true })).toBeVisible()
    await expect(page.locator('.agent-status')).toHaveText('本次执行已完成')
    for (const value of ['x'.repeat(140000), '最新的短作答']) {
      await page.getByLabel('长作答内容', { exact: true }).fill(value)
      await expect(page.locator('.managed').getByRole('status')).toHaveText('已保存')
      await page.getByRole('button', { name: '保存正式作答', exact: true }).click()
      await expect(page.locator('.managed').getByRole('status')).toContainText('提交成功')
    }
    const taskId = (await call({ type: 'host.tasks' }))[0].id
    const snapshot = await call({ type: 'task.snapshot', task_id: taskId }), selectedId = snapshot.answers[0].id, latestId = snapshot.answers[1].id
    await page.getByRole('tab', { name: /作答记录/ }).click()
    const answers = page.getByRole('region', { name: '全部作答分页浏览', exact: true })
    await expect(answers.locator('.record-row')).toHaveCount(2)
    await answers.locator('.record-row').first().click()
    const detail = answers.getByRole('article', { name: '全部作答全文', exact: true })
    await expect(detail).toContainText('当前为 JSON 文本片段')
    let pages = 1
    const next = detail.getByRole('button', { name: '继续读取全文', exact: true })
    while (await next.count()) {
      const before = await detail.locator('pre').textContent()
      await next.click()
      await expect.poll(async () => (await detail.locator('pre').textContent()) !== before).toBe(true)
      if (++pages > 64) throw Error('Answer pagination did not finish within its fixture bound')
    }
    expect(pages).toBeGreaterThan(1)
    await expect(detail).toContainText('仅显示末尾 256K 字符')
    await expect(detail.getByRole('status')).toHaveText('全文读取完成')
    const continueAnswer = detail.getByRole('button', { name: '基于已保存作答继续', exact: true }), returnToContent = detail.getByRole('button', { name: '回到当前内容', exact: true })
    await expect(continueAnswer).toBeEnabled()
    await expect(returnToContent).toBeVisible()
    let confirmation = ''
    const beforeCancel = requests.length
    page.once('dialog', async dialog => { confirmation = dialog.message(); await dialog.dismiss() })
    await continueAnswer.click()
    expect(confirmation).toContain(selectedId)
    expect(confirmation).not.toContain(latestId)
    expect(requests).toHaveLength(beforeCancel)
    expect((await call({ type: 'task.snapshot', task_id: taskId })).runs).toHaveLength(1)
    await continueAnswer.scrollIntoViewIfNeeded()
    await page.screenshot({ path: test.info().outputPath('trellis-windowed-answer-actions.png') })
    await returnToContent.click()
    await expect(page.getByLabel('长作答内容', { exact: true })).toHaveValue('最新的短作答')
    await page.getByRole('tab', { name: /作答记录/ }).click()
    await answers.locator('.record-row').first().click()
    await expect(detail).toContainText('当前为 JSON 文本片段')
    await expect(continueAnswer).toBeEnabled()
    await expect(returnToContent).toBeVisible()
    await send('等待作答操作测试')
    await expect.poll(() => Boolean(pending.response)).toBe(true)
    await expect(continueAnswer).toBeDisabled()
    await expect(returnToContent).toBeEnabled()
    textStream(pending.response!, '等待已结束。'); pending.response = null
    await expect(page.locator('.agent-status')).toHaveText('本次执行已完成')
    await expect(continueAnswer).toBeEnabled()
    page.once('dialog', dialog => dialog.accept())
    await continueAnswer.click()
    await expect.poll(() => requests.at(-1)).toContain(selectedId)
    await expect(page.locator('.agent-status')).toHaveText('本次执行已完成')
    expect((await call({ type: 'task.snapshot', task_id: taskId })).runs).toHaveLength(3)
    expect(errors).toEqual([])
  } finally { pending.response?.destroy(); await app.close(); await server.close(); await rm(directory, { recursive: true, force: true }) }
})
