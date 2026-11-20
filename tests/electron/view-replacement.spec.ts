import { openPending } from '../helpers/agent-ui'
import { chooseModel, closeSettings, configureModel, openSettings, testRole } from '../helpers/settings-ui'
import { _electron as electron, expect, test, type Dialog } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { modelServer, synthetic, textStream, hostToolStream } from '../helpers/model-server'
import type { HostRequest, HostResponse, Snapshot } from '../../src/shared/types'
const electronPath: string = createRequire(import.meta.url)('electron')
interface ReplacementEvidence { actionId: string | null; confirmations: number; queries: string[]; queryAllowed: boolean }
declare global {
  var replacementEvidence: ReplacementEvidence
}

for (const scenario of ['preserve', 'reset-cancel', 'reset-confirm', 'pending-input', 'lost-response', 'query-unavailable', 'unknown-result', 'unknown-focus-moved'] as const) test('isolated View replacement: ' + scenario, async () => {
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
  const directory = await mkdtemp(join(tmpdir(), 'pliuna-view-desktop-'))
  const launch = () => electron.launch({ executablePath: electronPath, args: ['.'], env: { ...Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !['PLIUNA_ENABLE_MONTY', 'PLIUNA_ENABLE_VIEW_REPLACEMENT'].includes(key))) as Record<string, string>, ELECTRON_RUN_AS_NODE: '', PLIUNA_TEST_DATA: directory, PLIUNA_TEST_VIEW_REPLACEMENT: '' } })
  let app = await launch()
  try {
    let page = await app.firstWindow()
    await expect(page.getByText('本地运行', { exact: true })).toBeVisible()
    await configureModel(page, { id: 'replace-main', url: server.url, key: 'local-replacement-sentinel', model: 'wire-model', context: 1000000, output: 4096 })
    await openSettings(page)
    await testRole(page, '主模型')
    await closeSettings(page)
    await page.getByRole('button', { name: '创建第一个任务', exact: true }).click()
    await page.getByLabel('任务名称').fill('替换草稿验收')
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    for (let n = 0; n < 2; n++) {
      await chooseModel(page, 'fixture')
      await page.getByLabel('想从哪里开始？').fill('fixture form ' + n)
      await page.getByRole('button', { name: /发送消息/ }).click()
      await expect(page.locator('.managed')).toHaveCount(n + 1)
      await expect(page.locator('.agent-status')).toContainText('已完成')
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
      const tasks = await window.pliuna.request({ type: 'host.tasks' })
      if (!tasks.ok) throw new Error('tasks unavailable')
      const task = (tasks.data as { id: string }[])[0]!
      const result = await window.pliuna.request({ type: 'task.snapshot', task_id: task.id })
      if (!result.ok) throw new Error('snapshot unavailable')
      return result.data as Snapshot
    })
    await chooseModel(page, 'replace-main')
    await page.getByLabel('想从哪里开始？').fill('replace the first View only')
    await page.getByRole('button', { name: /发送消息/ }).click()
    await openPending(page)
    await page.getByRole('button', { name: '批准本次动作', exact: true }).click()
    await openPending(page)
    await expect(page.getByRole('button', { name: '保存输入并检查替换', exact: true })).toBeVisible()
    await app.evaluate(({ ipcMain }, scenario) => {
      const handlers = (ipcMain as typeof ipcMain & { _invokeHandlers: Map<string, (event: unknown, input: HostRequest) => Promise<HostResponse>> })._invokeHandlers
      const original = handlers.get('pliuna:request')
      if (!original) throw Error('The real IPC request handler is unavailable')
      const evidence: ReplacementEvidence = { actionId: null, confirmations: 0, queries: [], queryAllowed: false }
      globalThis.replacementEvidence = evidence
      handlers.set('pliuna:request', async (event, input) => {
        if (input.type === 'surface.respond') {
          evidence.confirmations++; evidence.actionId = input.action_id
          const response = await original(event, input)
          if (scenario === 'lost-response' || scenario === 'unknown-result' || scenario === 'unknown-focus-moved') return { ok: false, error: { code: 'UNKNOWN_RESULT', message: 'Synthetic lost response' } }
          return response
        }
        if (input.type === 'task.query' && input.query.type === 'read' && input.query.input.target.kind === 'action' && input.query.input.target.id === evidence.actionId) {
          evidence.queries.push(input.query.input.target.id)
          if (!evidence.queryAllowed && scenario === 'query-unavailable') return { ok: false, error: { code: 'CONNECTION_LOST', message: 'Synthetic unavailable query' } }
          if (!evidence.queryAllowed && (scenario === 'unknown-result' || scenario === 'unknown-focus-moved')) return { ok: true, data: { metadata: { state: 'ended', result: 'unknown' }, data: {} } }
        }
        return original(event, input)
      })
    }, scenario)
    const pendingInput = scenario === 'pending-input' || scenario === 'query-unavailable'
    const checksFocus = scenario === 'preserve' || scenario === 'lost-response' || scenario === 'unknown-result' || scenario === 'unknown-focus-moved'
    const waitsForQuery = scenario === 'query-unavailable' || scenario === 'unknown-result' || scenario === 'unknown-focus-moved'
    if (pendingInput) {
      // Same turn as the input event: do not let the debounce save hide this race.
      await page.evaluate(() => {
        const input = document.querySelector('.managed .view-boundary > div')!.shadowRoot!.querySelector<HTMLTextAreaElement>('textarea')!
        input.value = '尚未防抖保存的输入'; input.dispatchEvent(new Event('input', { bubbles: true }))
        Array.from(document.querySelectorAll('button')).find(button => button.textContent === '保存输入并检查替换')!.click()
      })
    } else if (checksFocus) {
      await page.evaluate(() => {
        const input = document.querySelector('.managed .view-boundary > div')!.shadowRoot!.querySelector<HTMLTextAreaElement>('textarea')!
        input.focus(); input.setSelectionRange(2, 5, 'forward')
        Array.from(document.querySelectorAll('button')).find(button => button.textContent === '保存输入并检查替换')!.click()
      })
    } else {
      if (scenario.startsWith('reset')) page.once('dialog', dialog => scenario === 'reset-cancel' ? dialog.dismiss() : dialog.accept())
      await page.getByRole('button', { name: '保存输入并检查替换', exact: true }).click()
    }
    await expect(page.getByText('REPLACEMENT_RUN_ENDED', { exact: true })).toBeVisible()
    if (waitsForQuery) {
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
      expect(await page.evaluate(async () => (await window.pliuna.request({ type: 'host.tasks' })).ok)).toBe(true)
      const requests = server.exchanges.length
      await app.evaluate(() => { globalThis.replacementEvidence.queryAllowed = true })
      if (scenario === 'unknown-focus-moved') {
        await page.getByRole('searchbox', { name: '筛选任务' }).focus()
        await expect(page.getByRole('searchbox', { name: '筛选任务' })).toBeFocused()
      }
      await page.evaluate(() => { Array.from(document.querySelectorAll('button')).find(button => button.textContent === '查询原替换结果并同步')!.click() })
      await expect(page.getByRole('button', { name: '查询原替换结果并同步', exact: true })).toHaveCount(0)
      expect(await first.locator('[data-view]').evaluate(node => (node as HTMLElement).inert)).toBe(false)
      expect(server.exchanges).toHaveLength(requests)
    }
    await expect(page.getByRole('button', { name: '查询原替换结果并同步', exact: true })).toHaveCount(0)
    if (pendingInput) {
      await expect(page.getByRole('alert').filter({ hasText: '替换未完成：正文或输入版本已变化（VERSION_CONFLICT）' })).toBeVisible()
      expect(await first.locator('[data-view]').evaluate(node => (node as HTMLElement).inert)).toBe(false)
    } else if (scenario === 'lost-response' || scenario === 'unknown-result' || scenario === 'unknown-focus-moved') {
      await expect(page.getByRole('alert').filter({ hasText: /替换未完成|原替换结果|替换结果尚未确认/ })).toHaveCount(0)
    }
    const evidence = await app.evaluate(() => globalThis.replacementEvidence)
    expect(evidence.confirmations).toBe(1)
    expect(evidence.queries).toEqual(Array.from({ length: waitsForQuery ? 2 : pendingInput || scenario === 'lost-response' ? 1 : 0 }, () => evidence.actionId))
    if (checksFocus) {
      if (scenario === 'unknown-focus-moved') await expect(page.getByRole('searchbox', { name: '筛选任务' })).toBeFocused()
      else {
        await expect(first.getByLabel('你的想法')).toBeFocused()
        expect(await first.getByLabel('你的想法').evaluate(node => { const input = node as HTMLTextAreaElement; return [input.selectionStart, input.selectionEnd, input.selectionDirection] })).toEqual([2, 5, 'forward'])
      }
    }
    await expect(first.getByLabel('你的想法')).toHaveValue(scenario === 'reset-confirm' ? '新初值' : pendingInput ? '尚未防抖保存的输入' : '保留的旧答案')
    await expect(first.getByRole('heading', { name: scenario === 'reset-cancel' || pendingInput ? '思考与记录' : '新版练习' })).toBeVisible()
    expect(await otherNode!.evaluate(node => node.isConnected)).toBe(true)
    await expect(other.getByLabel('你的想法')).toHaveValue('其他 View 不变')
    if (scenario === 'preserve' || scenario === 'reset-confirm' || scenario === 'lost-response' || scenario === 'unknown-result' || scenario === 'unknown-focus-moved') {
      const stale = await page.evaluate(async old => window.pliuna.request({ type: 'draft.save', task_id: old.task.id, view_id: old.views[0]!.id, view_revision: old.views[0]!.revision, expected_state_revision: old.views[0]!.state_revision, fields: [{ path: '/response', value: 'stale write' }] }), source)
      expect(stale).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } })
    }
    await page.getByRole('tab', { name: /作答记录/ }).click()
    await page.getByText('第 1 次提交').click()
    await expect(page.locator('.history pre')).toContainText('保留的旧答案')
    const requests = server.exchanges.length
    await app.close(); app = await launch(); page = await app.firstWindow()
    await page.getByRole('button', { name: /替换草稿验收/ }).click()
    await expect(page.locator('.managed').first().getByLabel('你的想法')).toHaveValue(scenario === 'reset-confirm' ? '新初值' : pendingInput ? '尚未防抖保存的输入' : '保留的旧答案')
    expect(server.exchanges).toHaveLength(requests)
  } finally { await app.close(); await server.close(); await rm(directory, { recursive: true, force: true }) }
})
