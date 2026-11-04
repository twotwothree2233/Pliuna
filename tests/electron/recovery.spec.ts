import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
const electronPath: string = createRequire(import.meta.url)('electron')
for (const scenario of ['save-cancel-replace-delete', 'input-conflict', 'save-failure', 'unknown-result', 'answer-unknown', 'active-run'] as const) test('isolated recovery desktop: ' + scenario, async () => {
  test.setTimeout(60000)
  const directory = await mkdtemp(join(tmpdir(), 'trellis-recovery-desktop-'))
  const launch = () => electron.launch({ executablePath: electronPath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', TRELLIS_TEST_DATA: directory, TRELLIS_ENABLE_VIEW_REPLACEMENT: '1' } })
  let app = await launch(), page = await app.firstWindow()
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message))
  async function inspect(backup = false): Promise<any> {
    return app.evaluate((_electron, { directory, backup }) => {
      const Database = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('better-sqlite3')
      const control = new Database(directory + '/recovery-control.sqlite'), state = JSON.parse(control.prepare('SELECT manifest FROM control').get().manifest); control.close()
      const db = new Database(backup && state.active ? directory + '/recovery/' + state.active.id + '.sqlite' : directory + '/trellis.sqlite')
      try { return { control: state, drafts: db.prepare('SELECT draft_json FROM views ORDER BY rowid').all(), answers: db.prepare('SELECT count(*) n FROM answers').get().n, actions: db.prepare('SELECT id,result FROM actions ORDER BY rowid').all() } } finally { db.close() }
    }, { directory, backup })
  }
  try {
    await page.getByRole('button', { name: '创建第一个任务' }).click(); await page.getByLabel('任务名称').fill('维护输入验收'); await page.getByRole('button', { name: '创建任务', exact: true }).click()
    await page.getByLabel('本次模型', { exact: true }).selectOption('fixture'); await page.getByLabel('想从哪里开始？').fill('fixture')
    if (scenario === 'active-run') {
      await page.getByRole('button', { name: /发送 · 新 Run/ }).click()
      const result = await page.evaluate(() => window.trellis.request({ type: 'maintenance.begin' }))
      expect(result.ok).toBe(false); if (!result.ok) expect(result.error.code).toBe('MAINTENANCE_EXECUTION_ACTIVE')
      await expect(page.getByLabel('最近 Run 结果')).toContainText('completed')
    } else {
      await page.getByRole('button', { name: /发送 · 新 Run/ }).click(); await expect(page.locator('.managed')).toHaveCount(1); await expect(page.getByLabel('最近 Run 结果')).toContainText('completed')
    }
    await page.getByLabel('你的想法').fill('已保存答案'); await expect(page.locator('.managed').getByRole('status')).toHaveText('已保存')
    if (scenario === 'answer-unknown') await app.evaluate(({ ipcMain }) => {
      const original = (ipcMain as any)._invokeHandlers.get('trellis:request'); let lost = false
      ipcMain.removeHandler('trellis:request'); ipcMain.handle('trellis:request', async (event, request) => { const result = await original(event, request); if (!lost && request?.type === 'answer.submit' && result.ok) { lost = true; return { ok: false, error: { code: 'UNKNOWN_RESULT', message: 'Injected answer response loss' } } }; return result })
    })
    await page.getByRole('button', { name: '提交答案', exact: true }).click()
    if (scenario === 'answer-unknown') {
      await expect(page.locator('.managed').getByRole('alert')).toContainText('答案提交结果未知')
      await page.getByRole('tab', { name: /作答记录/ }).click(); await expect(page.locator('.managed')).toHaveCount(1)
      await page.getByRole('button', { name: '存储检查', exact: true }).click()
      const modal = page.getByRole('dialog', { name: '存储检查', exact: true }); await modal.getByRole('button', { name: '创建一致性恢复点', exact: true }).click()
      await expect(modal.getByRole('alert')).toContainText('正在提交'); expect((await inspect()).control.active).toBeNull()
      await modal.getByRole('button', { name: '关闭', exact: true }).click(); await page.getByRole('button', { name: '查询已保存作答状态', exact: true }).click()
      await expect(page.locator('.managed').getByRole('status')).toContainText('已同步保存状态'); expect((await inspect()).answers).toBe(1)
    } else await expect(page.locator('.managed').getByRole('status')).toContainText('提交成功')
    await page.getByLabel('想从哪里开始？').fill('不应自动发送的草稿')
    const before = await inspect()
    await page.getByRole('button', { name: '存储检查', exact: true }).click()
    const panel = page.getByRole('dialog', { name: '存储检查', exact: true }), button = panel.getByRole('button', { name: '创建一致性恢复点', exact: true })
    await expect(button).toBeEnabled()
    if (scenario === 'input-conflict' || scenario === 'save-failure') {
      await app.evaluate((_electron, { directory, scenario }) => {
        const Database = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('better-sqlite3'), db = new Database(directory + '/trellis.sqlite')
        if (scenario === 'input-conflict') db.prepare('UPDATE views SET state_revision=state_revision+1').run()
        else db.exec("CREATE TRIGGER reject_draft BEFORE UPDATE OF draft_json ON views BEGIN SELECT RAISE(ABORT,'injected save failure'); END")
        db.close()
      }, { directory, scenario })
      await page.getByLabel('你的想法').evaluate(element => { const input = element as HTMLTextAreaElement; input.value = '必须保留的冲突输入'; input.dispatchEvent(new Event('input', { bubbles: true })); Array.from(document.querySelectorAll('button')).find(b => b.textContent === '创建一致性恢复点')!.click() })
      await expect(panel.getByRole('alert')).toContainText(scenario === 'input-conflict' ? 'VERSION_CONFLICT' : 'RUNTIME_ERROR')
      await expect(page.getByLabel('你的想法')).toHaveValue('必须保留的冲突输入')
      expect((await inspect()).control.active).toBeNull()
      const status = await page.evaluate(() => window.trellis.request({ type: 'maintenance.status' })); expect(status.ok && (status.data as any).phase).toBe('idle')
      // Avoid the intentional unsaved-input close veto in this isolated negative test only.
      await panel.getByRole('button', { name: '关闭', exact: true }).click()
      const confirmed = new Promise<void>((resolve, reject) => page.once('dialog', d => { d.accept().then(resolve, reject) }))
      await page.getByRole('button', { name: '放弃本地输入并重新加载', exact: true }).click(); await confirmed
      await expect(page.getByLabel('你的想法')).toHaveValue('已保存答案')
    } else {
      page.once('dialog', d => d.dismiss())
      // Same event turn beats draft debounce and tests maintenance's explicit save barrier.
      await page.getByLabel('你的想法').evaluate(element => { const input = element as HTMLTextAreaElement; input.value = '屏障保存的输入'; input.dispatchEvent(new Event('input', { bubbles: true })); Array.from(document.querySelectorAll('button')).find(b => b.textContent === '创建一致性恢复点')!.click() })
      await expect(button).toBeEnabled(); expect((await inspect()).control.active).toBeNull(); expect(JSON.parse((await inspect()).drafts[0].draft_json).response).toBe('屏障保存的输入')
      await expect(page.getByLabel('你的想法')).toHaveValue('屏障保存的输入'); await expect(page.getByLabel('想从哪里开始？')).toHaveValue('不应自动发送的草稿')
      if (scenario === 'unknown-result') await app.evaluate(({ ipcMain }) => {
        const handlers = (ipcMain as any)._invokeHandlers, original = handlers.get('trellis:request')
        let lost = false
        ipcMain.removeHandler('trellis:request')
        ipcMain.handle('trellis:request', async (event, request) => {
          const result = await original(event, request)
          if (!lost && request?.type === 'maintenance.create' && result.ok) { lost = true; return { ok: false, error: { code: 'UNKNOWN_RESULT', message: 'Injected response loss after commit' } } }
          return result
        })
      })
      page.once('dialog', d => d.accept()); await button.click(); await expect(panel.getByRole('button', { name: '创建新点并替换旧点', exact: true })).toBeEnabled()
      if (scenario === 'unknown-result') { await expect(panel.getByRole('alert')).toContainText('UNKNOWN_RESULT'); expect((await inspect()).control.retired).toHaveLength(0) }
      const first = await inspect(true); expect(first.answers).toBe(1); expect(first.actions).toEqual(before.actions); expect(JSON.parse(first.drafts[0].draft_json).response).toBe('屏障保存的输入')
      page.once('dialog', d => d.dismiss()); await panel.getByRole('button', { name: '创建新点并替换旧点' }).click(); expect((await inspect()).control.active.id).toBe(first.control.active.id)
      page.once('dialog', d => d.accept()); await panel.getByRole('button', { name: '创建新点并替换旧点' }).click(); await expect(panel.getByRole('button', { name: '创建新点并替换旧点' })).toBeEnabled()
      const next = await inspect(); expect(next.control.active.id).not.toBe(first.control.active.id); expect(next.control.retired).toContain(first.control.active.id)
      await panel.getByRole('button', { name: '关闭', exact: true }).click()
      await app.close(); app = await launch(); page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message))
      await page.getByRole('button', { name: /维护输入验收/ }).click(); await expect(page.getByLabel('你的想法')).toHaveValue('屏障保存的输入')
      expect((await inspect()).control.active.id).toBe(next.control.active.id)
      let confirmations = 0; page.on('dialog', async d => { confirmations++; if (confirmations === 2) await d.dismiss(); else await d.accept() })
      await page.getByRole('button', { name: '删除', exact: true }).click(); await expect(page.getByRole('button', { name: '删除', exact: true })).toBeEnabled(); expect((await inspect()).control.active.id).toBe(next.control.active.id)
      page.removeAllListeners('dialog'); page.on('dialog', d => d.accept())
      await page.getByRole('button', { name: '删除', exact: true }).click(); await expect(page.getByRole('button', { name: '创建第一个任务' })).toBeVisible()
      expect((await inspect()).control).toMatchObject({ active: null, invalidated: [next.control.active.id] })
    }
    expect(errors).toEqual([])
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})
