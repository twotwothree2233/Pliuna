import { chooseModel, openSettings } from '../helpers/settings-ui'
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
const electronPath: string = createRequire(import.meta.url)('electron')
for (const scenario of ['confirm', 'cancel', 'input-conflict', 'response-lost', 'active-run', 'gc-control-blocked', 'persisted-retry'] as const) test('isolated restricted GC desktop: ' + scenario, async () => {
  test.setTimeout(60000)
  const directory = await mkdtemp(join(tmpdir(), 'trellis-gc-desktop-'))
  const launch = () => electron.launch({ executablePath: electronPath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', TRELLIS_TEST_DATA: directory, TRELLIS_ENABLE_VIEW_REPLACEMENT: '1' } })
  let app = await launch(), page = await app.firstWindow()
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  async function database(mode = 'query'): Promise<any> {
    return app.evaluate((_electron, { directory, mode }) => {
      const Database = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('better-sqlite3'), db = new Database(directory + '/trellis.sqlite')
      try {
        if (mode === 'fail') db.exec("CREATE TRIGGER reject_view BEFORE INSERT ON views BEGIN SELECT RAISE(ABORT,'isolated fault'); END")
        if (mode === 'drop') db.exec('DROP TRIGGER reject_view')
        if (mode === 'conflict') db.exec('UPDATE views SET state_revision=state_revision+1')
        const gc = new Database(directory + '/gc-control.sqlite'); let ops
        try { ops = gc.prepare('SELECT manifest FROM gc_operations ORDER BY rowid').all().map((r: any) => JSON.parse(r.manifest)) } finally { gc.close() }
        return { actions: db.prepare('SELECT id,result FROM actions ORDER BY rowid').all(), drafts: db.prepare('SELECT draft_json FROM views').all(), stages: db.prepare('SELECT * FROM staging ORDER BY rowid').all(), ops }
      } finally { db.close() }
    }, { directory, mode })
  }
  try {
    await page.getByRole('button', { name: '创建第一个任务' }).click(); await page.getByLabel('任务名称').fill('GC隔离验收'); await page.getByRole('button', { name: '创建任务', exact: true }).click()
    await chooseModel(page, 'fixture')
    await database('fail'); await page.getByLabel('想从哪里开始？').fill('失败发布'); await page.getByRole('button', { name: /发送 · 新 Run/ }).click(); await expect(page.locator('.agent-status')).toContainText('失败'); await database('drop')
    await page.getByLabel('想从哪里开始？').fill('正常发布'); await page.getByRole('button', { name: /发送 · 新 Run/ }).click(); await expect(page.locator('.managed')).toHaveCount(1); await expect(page.locator('.agent-status')).toContainText('已完成')
    await page.getByLabel('你的想法').fill('保留的已保存草稿'); await expect(page.locator('.managed').getByRole('status')).toHaveText('已保存')
    await page.getByRole('button', { name: '提交答案', exact: true }).click(); await expect(page.locator('.managed').getByRole('status')).toContainText('提交成功')
    await page.getByLabel('想从哪里开始？').fill('不能自动发送的消息'); const before = await database(), files = await readdir(join(directory, 'resources'))
    expect(files).toHaveLength(2)
    if (scenario === 'gc-control-blocked') { await app.close(); await writeFile(join(directory, 'gc-control.sqlite'), 'corrupt'); app = await launch(); page = await app.firstWindow() }
    if (scenario === 'response-lost') await app.evaluate(({ ipcMain }) => {
      const original = (ipcMain as any)._invokeHandlers.get('trellis:request'); let lost = false
      ipcMain.removeHandler('trellis:request'); ipcMain.handle('trellis:request', async (event, request) => { const result = await original(event, request); if (!lost && request?.type === 'maintenance.gc.execute' && result.ok) { lost = true; return { ok: false, error: { code: 'UNKNOWN_RESULT', message: 'Injected GC response loss' } } }; return result })
    })
    if (scenario === 'active-run') {
      const result = await page.evaluate(async () => { const tasks = await window.trellis.request({ type: 'host.tasks' }); if (!tasks.ok) throw new Error('tasks'); const task = (tasks.data as any[])[0]; const started = await window.trellis.request({ type: 'task.submit', task_id: task.id, text: 'held fixture', model_config_id: 'fixture', attachments: [] }); const blocked = await window.trellis.request({ type: 'maintenance.begin' }); if (started.ok) await window.trellis.request({ type: 'run.cancel', task_id: task.id, run_id: (started.data as any).run_id }); return blocked })
      expect(result.ok).toBe(false); if (!result.ok) expect(result.error.code).toBe('MAINTENANCE_EXECUTION_ACTIVE'); expect(await readdir(join(directory, 'resources'))).toEqual(files)
    }
    await openSettings(page, '存储与恢复'); const panel = page.getByRole('dialog', { name: '应用设置', exact: true }), collect = panel.getByRole('button', { name: '检查并回收暂存首批', exact: true })
    if (scenario === 'gc-control-blocked') { await expect(panel).toContainText('GC_CONTROL_INVALID'); await expect(collect).toBeDisabled(); expect(await readdir(join(directory, 'resources'))).toEqual(files); return }
    await expect(collect).toBeEnabled()
    if (scenario === 'persisted-retry') {
      page.once('dialog', d => d.dismiss()); await collect.click(); await expect(collect).toBeEnabled()
      const seeded = await database(); expect(seeded.ops).toHaveLength(1)
      await panel.getByRole('button', { name: /^返回工作区/ }).click(); await app.close()
      // Persisted retry UI fixture; actual unlink failures and durable backoff are tested in unit/fault tests.
      const op = seeded.ops[0]; op.authorized = true; op.phase = 'settled'; op.items[0].state = 'failed'; op.items[0].attempt = 1; op.items[0].reason = 'EIO'; op.items[0].next_retry_at = '2000-01-01T00:00:00.000Z'
      const bootstrap = await launch(); app = bootstrap
      await app.evaluate((_electron, { directory, op }) => {
        const Database = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('better-sqlite3'), control = new Database(directory + '/gc-control.sqlite'); control.prepare('UPDATE gc_operations SET manifest=? WHERE id=?').run(JSON.stringify(op), op.id); control.close()
      }, { directory, op }); await app.close(); app = await launch(); page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message))
      await openSettings(page, '存储与恢复'); const retryPanel = page.getByRole('dialog', { name: '应用设置', exact: true })
      await expect(retryPanel).toContainText('EIO'); page.once('dialog', d => d.accept()); await retryPanel.getByRole('button', { name: '重试原 GC 未完成项', exact: true }).click()
      await expect(retryPanel).toContainText('已确认删除 1 个'); const after = await database(); expect(after.ops).toHaveLength(1); expect(after.ops[0].id).toBe(op.id); expect(after.ops[0].items[0].attempt).toBe(2); expect(after.actions).toEqual(before.actions)
      await retryPanel.getByText('查询原 GC 作业记录', { exact: true }).click(); await retryPanel.getByRole('button', { name: '查询此 GC 原结果', exact: true }).click(); await expect(retryPanel).toContainText('已确认删除 1 个'); expect(await readdir(join(directory, 'resources'))).toHaveLength(1)
    } else if (scenario === 'input-conflict') {
      await database('conflict')
      await page.getByLabel('你的想法').evaluate(inputElement => { const input = inputElement as HTMLTextAreaElement; input.value = '必须保留的冲突输入'; input.dispatchEvent(new Event('input', { bubbles: true })); Array.from(document.querySelectorAll('button')).find(b => b.textContent === '检查并回收暂存首批')!.click() })
      await expect(panel.getByRole('alert')).toContainText('VERSION_CONFLICT'); expect((await database()).ops).toHaveLength(0); expect(await readdir(join(directory, 'resources'))).toEqual(files)
      await expect(page.getByLabel('你的想法')).toHaveValue('必须保留的冲突输入'); await panel.getByRole('button', { name: /^返回工作区/ }).click(); page.once('dialog', d => d.accept()); await page.getByRole('button', { name: '放弃本地输入并重新加载', exact: true }).click()
    } else if (scenario !== 'active-run') {
      let confirmation = ''
      page.once('dialog', async dialog => { confirmation = dialog.message(); if (scenario === 'cancel') await dialog.dismiss(); else await dialog.accept() })
      await collect.click(); await expect(collect).toBeEnabled(); expect(confirmation).toContain('正式材料、历史、数据库、回退副本和恢复点及其资源均保留')
      const after = await database(); expect(after.actions).toEqual(before.actions); expect(after.drafts).toEqual(before.drafts); expect(after.ops).toHaveLength(1)
      expect((await readdir(join(directory, 'resources'))).length).toBe(scenario === 'cancel' ? 2 : 1)
      if (scenario === 'cancel') expect(after.ops[0].authorized).toBe(false)
      else { await expect(panel).toContainText('已确认删除 1 个'); expect(after.ops[0].phase).toBe('settled') }
      await panel.getByRole('button', { name: /^返回工作区/ }).click(); await expect(page.getByLabel('想从哪里开始？')).toHaveValue('不能自动发送的消息')
      await app.close(); app = await launch(); page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message))
      await page.getByRole('button', { name: /GC隔离验收/ }).click(); await expect(page.getByLabel('你的想法')).toHaveValue('保留的已保存草稿'); await page.getByRole('tab', { name: /作答记录/ }).click(); await expect(page.getByText('第 1 次提交')).toBeVisible()
      expect((await database()).actions).toEqual(before.actions); expect((await database()).ops).toHaveLength(1)
    }
    expect(errors).toEqual([])
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})
