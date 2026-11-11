import { chooseModel, openSettings } from '../helpers/settings-ui'
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
const electronPath: string = createRequire(import.meta.url)('electron')
for (const scenario of ['confirm', 'cancel', 'input-conflict', 'response-lost', 'startup-blocked'] as const) test('isolated restore desktop: ' + scenario, async () => {
  test.setTimeout(60000)
  const directory = await mkdtemp(join(tmpdir(), 'pliuna-restore-desktop-'))
  const launch = () => electron.launch({ executablePath: electronPath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', PLIUNA_TEST_DATA: directory, PLIUNA_ENABLE_VIEW_REPLACEMENT: '1' } })
  let app = await launch(), page = await app.firstWindow()
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  async function inspect(): Promise<any> {
    return app.evaluate((_electron, directory) => {
      const Database = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('better-sqlite3')
      const control = new Database(directory + '/restore-control.sqlite'), journal = JSON.parse(control.prepare('SELECT manifest FROM restore_control').get().manifest); control.close()
      const db = new Database(directory + '/' + journal.selected)
      try { return { journal, drafts: db.prepare('SELECT draft_json FROM views').all(), answers: db.prepare('SELECT count(*) n FROM answers').get().n, runs: db.prepare('SELECT id,state,commit_valid FROM runs').all() } } finally { db.close() }
    }, directory)
  }
  try {
    await page.getByRole('button', { name: '创建第一个任务' }).click(); await page.getByLabel('任务名称').fill('恢复验收任务'); await page.getByRole('button', { name: '创建任务', exact: true }).click()
    await chooseModel(page, 'fixture'); await page.getByLabel('想从哪里开始？').fill('fixture'); await page.getByRole('button', { name: /发送 · 新 Run/ }).click()
    await expect(page.locator('.managed')).toHaveCount(1); await expect(page.locator('.agent-status')).toContainText('已完成')
    await page.getByLabel('你的想法').fill('恢复点中的草稿'); await expect(page.locator('.managed').getByRole('status')).toHaveText('已保存')
    await openSettings(page, '存储与恢复')
    let panel = page.getByRole('dialog', { name: '应用设置', exact: true })
    page.once('dialog', dialog => dialog.accept()); await panel.getByRole('button', { name: '创建一致性恢复点', exact: true }).click()
    await expect(panel.getByRole('button', { name: '恢复此点的旧数据', exact: true })).toBeEnabled()
    await panel.getByRole('button', { name: /^返回工作区/ }).click()
    await page.getByLabel('你的想法').fill('恢复点之后的草稿'); await expect(page.locator('.managed').getByRole('status')).toHaveText('已保存')
    await page.getByRole('button', { name: '提交答案', exact: true }).click(); await expect(page.locator('.managed').getByRole('status')).toContainText('提交成功')
    await page.getByLabel('想从哪里开始？').fill('绝不自动发送的恢复前消息')
    const before = await inspect()
    if (scenario === 'startup-blocked') {
      await app.close(); await writeFile(join(directory, 'restore-control.sqlite'), 'damaged control'); app = await launch(); page = await app.firstWindow()
      await openSettings(page, '存储与恢复'); panel = page.getByRole('dialog', { name: '应用设置', exact: true })
      await expect(panel).toContainText('RESTORE_JOURNAL_INVALID'); await expect(panel.getByRole('button', { name: '恢复此点的旧数据', exact: true })).toBeDisabled()
      return
    }
    if (scenario === 'response-lost') await app.evaluate(({ ipcMain }) => {
      const original = (ipcMain as any)._invokeHandlers.get('pliuna:request'); let lost = false
      ipcMain.removeHandler('pliuna:request'); ipcMain.handle('pliuna:request', async (event, request) => { const result = await original(event, request); if (!lost && request?.type === 'maintenance.restore' && result.ok) { lost = true; return { ok: false, error: { code: 'UNKNOWN_RESULT', message: 'Injected restore response loss' } } }; return result })
    })
    await openSettings(page, '存储与恢复'); panel = page.getByRole('dialog', { name: '应用设置', exact: true })
    const restore = panel.getByRole('button', { name: '恢复此点的旧数据', exact: true }); await expect(restore).toBeEnabled()
    if (scenario === 'input-conflict') {
      await app.evaluate((_electron, directory) => {
        const Database = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('better-sqlite3'), db = new Database(directory + '/pliuna.sqlite'); db.prepare('UPDATE views SET state_revision=state_revision+1').run(); db.close()
      }, directory)
      await page.getByLabel('你的想法').evaluate(element => { const input = element as HTMLTextAreaElement; input.value = '保留冲突输入'; input.dispatchEvent(new Event('input', { bubbles: true })); Array.from(document.querySelectorAll('button')).find(b => b.textContent === '恢复此点的旧数据')!.click() })
      await expect(panel.getByRole('alert')).toContainText('VERSION_CONFLICT'); expect((await inspect()).journal.operations).toHaveLength(0)
      await expect(page.getByLabel('你的想法')).toHaveValue('保留冲突输入')
      await panel.getByRole('button', { name: /^返回工作区/ }).click(); page.once('dialog', d => d.accept()); await page.getByRole('button', { name: '放弃本地输入并重新加载', exact: true }).click()
    } else {
      let confirmation = ''
      page.once('dialog', async dialog => { confirmation = dialog.message(); if (scenario === 'cancel') await dialog.dismiss(); else await dialog.accept() })
      await restore.click(); await expect(restore).toBeEnabled()
      expect(confirmation).toContain('刚保存的输入也可能被旧草稿替换'); expect(confirmation).toContain('旧 Run、工具和审批不会续跑')
      if (scenario === 'cancel') {
        expect((await inspect()).journal.operations).toHaveLength(0); expect((await inspect()).answers).toBe(1)
        await panel.getByRole('button', { name: /^返回工作区/ }).click(); await expect(page.getByLabel('你的想法')).toHaveValue('恢复点之后的草稿')
        await expect(page.getByLabel('想从哪里开始？')).toHaveValue('绝不自动发送的恢复前消息')
      } else {
        await expect(panel).toContainText('completed'); const after = await inspect()
        expect(after.answers).toBe(0); expect(JSON.parse(after.drafts[0].draft_json).response).toBe('恢复点中的草稿')
        expect(after.journal.operations).toHaveLength(1); expect(after.runs.map((r: any) => r.id)).toEqual(before.runs.map((r: any) => r.id)); expect(after.runs.every((r: any) => r.commit_valid === 0)).toBe(true)
        const selectedFile = after.journal.selected
        await panel.getByRole('button', { name: /^返回工作区/ }).click()
        await expect(page.getByLabel('恢复前未发送文本')).toContainText('绝不自动发送的恢复前消息')
        await page.getByRole('button', { name: /恢复验收任务/ }).click(); await expect(page.getByLabel('你的想法')).toHaveValue('恢复点中的草稿'); await expect(page.getByLabel('想从哪里开始？')).toHaveValue('')
        await app.close(); app = await launch(); page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message))
        await page.getByRole('button', { name: /恢复验收任务/ }).click(); await expect(page.getByLabel('你的想法')).toHaveValue('恢复点中的草稿')
        expect((await inspect()).journal.selected).toBe(selectedFile); expect((await inspect()).answers).toBe(0)
      }
    }
    expect(errors).toEqual([])
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})
