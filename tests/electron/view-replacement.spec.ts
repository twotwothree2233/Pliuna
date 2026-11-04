import { _electron as electron, expect, test, type Dialog } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { modelServer, synthetic, textStream, hostToolStream } from '../helpers/model-server'
import type { Snapshot } from '../../src/shared/types'
const electronPath: string = createRequire(import.meta.url)('electron')

for (const scenario of ['preserve', 'reset-cancel', 'reset-confirm', 'pending-input'] as const) test('isolated View replacement: ' + scenario, async () => {
  let source: Snapshot
  const server = await modelServer(({ body, url }, res) => {
    if (url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"wire-model"}]}'); return }
    if (synthetic(body, res)) return
    if (body.messages.at(-1).role === 'tool') { textStream(res, 'REPLACEMENT_RUN_ENDED'); return }
    const view = source.views[0]!, bundle = structuredClone(view.bundle), reset = scenario.startsWith('reset')
    bundle.html = bundle.html.replace('思考与记录', '新版练习')
    bundle.state.initial = { response: '新初值', prompt: '新版说明' }
    if (reset) bundle.state.compatibility_version = 'new-question-v2'
    hostToolStream(res, 'write', { type: 'surface.update', surface_id: source.surface.id, expected_revision: source.surface.revision, operations: [{ type: 'view.replace', view_id: view.id, expected_view_revision: view.revision, bundle: { type: 'inline', bundle }, state_transition: reset ? { type: 'reset', expected_state_revision: view.state_revision, initial: bundle.state.initial } : { type: 'preserve', expected_state_revision: view.state_revision, compatibility_version: view.bundle.state.compatibility_version } }] })
  })
  const directory = await mkdtemp(join(tmpdir(), 'trellis-view-desktop-'))
  const launch = () => electron.launch({ executablePath: electronPath, args: ['.'], env: { ...Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !['TRELLIS_ENABLE_MONTY', 'TRELLIS_ENABLE_VIEW_REPLACEMENT'].includes(key))) as Record<string, string>, ELECTRON_RUN_AS_NODE: '', TRELLIS_TEST_DATA: directory, TRELLIS_TEST_VIEW_REPLACEMENT: '' } })
  let app = await launch()
  try {
    let page = await app.firstWindow()
    await expect(page.getByText('首版基础候选 · 本地运行', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '模型与审批', exact: true }).click()
    await page.getByLabel('配置标识', { exact: true }).fill('replace-main')
    await page.getByLabel('服务 Base URL').fill(server.url)
    await page.getByLabel('API Key', { exact: true }).fill('local-replacement-sentinel')
    await page.getByLabel('精确模型标识').fill('wire-model')
    await page.getByLabel('已知上下文容量').fill('1000000')
    await page.getByLabel('输出上限', { exact: true }).fill('4096')
    await page.getByRole('checkbox', { name: /^我确认连接凭据/ }).check()
    await page.getByRole('checkbox', { name: /^记住连接/ }).uncheck()
    await page.getByRole('button', { name: '保存内存配置并查询', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('查询到 1 个服务候选')
    await page.getByRole('button', { name: '测试并启用主模型', exact: true }).click(); await page.getByRole('dialog', { name: '确认模型角色测试' }).getByRole('button', { name: '确认费用并开始测试', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('main 合成验证通过')
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByRole('button', { name: '创建第一个任务', exact: true }).click()
    await page.getByLabel('任务名称').fill('替换草稿验收')
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    for (let n = 0; n < 2; n++) {
      await page.getByLabel('本次模型', { exact: true }).selectOption('fixture')
      await page.getByLabel('想从哪里开始？').fill('fixture form ' + n)
      await page.getByRole('button', { name: /发送 · 新 Run/ }).click()
      await expect(page.locator('.managed')).toHaveCount(n + 1)
      await expect(page.getByLabel('最近 Run 结果')).toContainText('completed')
    }
    const first = page.locator('.managed').nth(0), other = page.locator('.managed').nth(1)
    await first.getByLabel('你的想法').fill('保留的旧答案')
    await other.getByLabel('你的想法').fill('其他 View 不变')
    await expect(first.getByRole('status')).toHaveText('已保存')
    await expect(other.getByRole('status')).toHaveText('已保存')
    await first.getByRole('button', { name: '提交答案', exact: true }).click()
    await expect(first.getByRole('status')).toContainText('提交成功')
    const otherNode = await other.getByLabel('你的想法').elementHandle()
    source = await page.evaluate(async () => {
      const tasks = await window.trellis.request({ type: 'host.tasks' })
      if (!tasks.ok) throw new Error('tasks unavailable')
      const task = (tasks.data as { id: string }[])[0]!
      const result = await window.trellis.request({ type: 'task.snapshot', task_id: task.id })
      if (!result.ok) throw new Error('snapshot unavailable')
      return result.data as Snapshot
    })
    await page.getByLabel('本次模型', { exact: true }).selectOption('replace-main')
    await page.getByLabel('想从哪里开始？').fill('replace the first View only')
    await page.getByRole('button', { name: /发送 · 新 Run/ }).click()
    await page.getByRole('button', { name: '批准本次动作', exact: true }).click()
    await expect(page.getByRole('button', { name: '保存输入并检查替换', exact: true })).toBeVisible()
    if (scenario === 'pending-input') {
      // Same turn as the input event: do not let the debounce save hide this race.
      await page.evaluate(() => {
        const input = document.querySelector('.managed .view-boundary > div')!.shadowRoot!.querySelector<HTMLTextAreaElement>('textarea')!
        input.value = '尚未防抖保存的输入'; input.dispatchEvent(new Event('input', { bubbles: true }))
        Array.from(document.querySelectorAll('button')).find(button => button.textContent === '保存输入并检查替换')!.click()
      })
    } else {
      if (scenario.startsWith('reset')) page.once('dialog', dialog => scenario === 'reset-cancel' ? dialog.dismiss() : dialog.accept())
      await page.getByRole('button', { name: '保存输入并检查替换', exact: true }).click()
    }
    await expect(page.getByText('REPLACEMENT_RUN_ENDED', { exact: true })).toBeVisible()
    if (scenario === 'pending-input') {
      await expect(page.getByRole('button', { name: '查询原替换结果并同步', exact: true })).toBeVisible()
      expect(await first.locator('[data-view]').evaluate(node => (node as HTMLElement).inert)).toBe(true)
      expect(await page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true })))).toBe(true)
      // Electron vetoes unload without a native dialog; clear Playwright's dialog bookkeeping.
      let unloadHandling: Promise<void> | undefined
      const observeUnload = (dialog: Dialog) => {
        unloadHandling = dialog.dismiss().catch(error => {
          if (!String(error).includes('Protocol error (Page.handleJavaScriptDialog): No dialog is showing')) throw error
        })
      }
      page.on('dialog', observeUnload)
      try {
        await app.evaluate(({ app, BrowserWindow }) => new Promise<void>((resolve, reject) => {
          const contents = BrowserWindow.getAllWindows()[0]!.webContents
          const blocked = () => { clearTimeout(timer); resolve() }
          const timer = setTimeout(() => { contents.removeListener('will-prevent-unload', blocked); reject(new Error('Quit was not blocked')) }, 3000)
          contents.once('will-prevent-unload', blocked)
          app.quit()
        }))
        await expect.poll(() => !!unloadHandling).toBe(true)
        await unloadHandling
      } finally { page.removeListener('dialog', observeUnload) }
      expect(page.isClosed()).toBe(false)
      expect(await page.evaluate(async () => (await window.trellis.request({ type: 'host.tasks' })).ok)).toBe(true)
      const requests = server.exchanges.length
      await page.getByRole('button', { name: '查询原替换结果并同步', exact: true }).click()
      await expect(page.getByRole('button', { name: '查询原替换结果并同步', exact: true })).toHaveCount(0)
      expect(await first.locator('[data-view]').evaluate(node => (node as HTMLElement).inert)).toBe(false)
      expect(server.exchanges).toHaveLength(requests)
    }
    await expect(first.getByLabel('你的想法')).toHaveValue(scenario === 'reset-confirm' ? '新初值' : scenario === 'pending-input' ? '尚未防抖保存的输入' : '保留的旧答案')
    await expect(first.getByRole('heading', { name: scenario === 'reset-cancel' || scenario === 'pending-input' ? '思考与记录' : '新版练习' })).toBeVisible()
    expect(await otherNode!.evaluate(node => node.isConnected)).toBe(true)
    await expect(other.getByLabel('你的想法')).toHaveValue('其他 View 不变')
    if (scenario === 'preserve' || scenario === 'reset-confirm') {
      const stale = await page.evaluate(async old => window.trellis.request({ type: 'draft.save', task_id: old.task.id, view_id: old.views[0]!.id, view_revision: old.views[0]!.revision, expected_state_revision: old.views[0]!.state_revision, fields: [{ path: '/response', value: 'stale write' }] }), source)
      expect(stale).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } })
    }
    await page.getByRole('tab', { name: /作答记录/ }).click()
    await page.getByText('第 1 次提交').click()
    await expect(page.locator('.history pre')).toContainText('保留的旧答案')
    const requests = server.exchanges.length
    await app.close(); app = await launch(); page = await app.firstWindow()
    await page.getByRole('button', { name: /替换草稿验收/ }).click()
    await expect(page.locator('.managed').first().getByLabel('你的想法')).toHaveValue(scenario === 'reset-confirm' ? '新初值' : scenario === 'pending-input' ? '尚未防抖保存的输入' : '保留的旧答案')
    expect(server.exchanges).toHaveLength(requests)
  } finally { await app.close(); await server.close(); await rm(directory, { recursive: true, force: true }) }
})
