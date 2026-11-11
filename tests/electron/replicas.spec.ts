import { chooseModel, openSettings } from '../helpers/settings-ui'
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
const electronPath: string = createRequire(import.meta.url)('electron')
for (const scenario of ['confirm', 'cancel', 'input-conflict', 'response-lost', 'current-fallback', 'partial-retry'] as const) test('isolated replica retirement desktop: ' + scenario, async () => {
  test.setTimeout(60000)
  const directory = await mkdtemp(join(tmpdir(), 'pliuna-replicas-desktop-'))
  const launch = () => electron.launch({ executablePath: electronPath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', PLIUNA_TEST_DATA: directory, PLIUNA_ENABLE_VIEW_REPLACEMENT: '1' } })
  let app = await launch(), page = await app.firstWindow()
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message))
  const call = async (request: any): Promise<any> => { const response = await page.evaluate(request => window.pliuna.request(request), request); if (!response.ok) throw new Error(response.error.code); return response.data }
  const begin = async (): Promise<string> => (await call({ type: 'maintenance.begin' })).reservation.token
  async function inspect(): Promise<any> {
    return app.evaluate((_electron, root) => {
      const Database = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('better-sqlite3'), control = new Database(root + '/restore-control.sqlite')
      const journal = JSON.parse(control.prepare('SELECT manifest FROM restore_control').get().manifest); control.close()
      const db = new Database(root + '/' + journal.selected)
      try { return { journal, drafts: db.prepare('SELECT draft_json FROM views').all(), runs: db.prepare('SELECT id,state FROM runs').all(), answers: db.prepare('SELECT count(*) n FROM answers').get().n } } finally { db.close() }
    }, directory)
  }
  try {
    await page.getByRole('button', { name: '创建第一个任务' }).click(); await page.getByLabel('任务名称').fill('副本隔离验收'); await page.getByRole('button', { name: '创建任务', exact: true }).click()
    await chooseModel(page, 'fixture'); await page.getByLabel('想从哪里开始？').fill('正常发布'); await page.getByRole('button', { name: /发送 · 新 Run/ }).click()
    await expect(page.locator('.managed')).toHaveCount(1); await expect(page.locator('.agent-status')).toContainText('已完成')
    await page.getByLabel('你的想法').fill('不会丢失的草稿'); await expect(page.locator('.managed').getByRole('status')).toHaveText('已保存')
    await page.getByRole('button', { name: '提交答案', exact: true }).click(); await expect(page.locator('.managed').getByRole('status')).toContainText('提交成功')
    const before = await inspect(), resources = await readdir(join(directory, 'resources')), resourceBytes = await Promise.all(resources.map(f => readFile(join(directory, 'resources', f))))
    const old = (await call({ type: 'maintenance.create', token: await begin(), inputs_saved: true, replace_id: null })).active
    const active = (await call({ type: 'maintenance.create', token: await begin(), inputs_saved: true, replace_id: old.id })).active
    if (scenario === 'current-fallback') {
      await call({ type: 'maintenance.restore', token: await begin(), point_id: active.id, database_sha256: active.database_sha256, inputs_saved: true, confirm_replace_newer_data: true })
      const pre = await call({ type: 'maintenance.replica.list' }); expect(pre.items.filter((i: any) => i.eligible)).toHaveLength(1)
      const current = pre.items.find((i: any) => i.label.includes('当前代际')), rejected = await page.evaluate(async ({ token, replica_id }) => window.pliuna.request({ type: 'maintenance.replica.preview', token, replica_id, inputs_saved: true }), { token: await begin(), replica_id: current.replica_id }); expect(rejected.ok).toBe(false)
      await call({ type: 'maintenance.cancel', token: (await call({ type: 'maintenance.status' })).reservation.token })
      await app.close(); app = await launch(); page = await app.firstWindow()
      const items = (await call({ type: 'maintenance.replica.list' })).items; expect(items.filter((i: any) => i.eligible)).toHaveLength(3)
      await page.getByRole('button', { name: /副本隔离验收/ }).click()
    }
    if (scenario === 'partial-retry') {
      // Isolated persisted partial failure: real filesystem failure/backoff is tested separately in unit/SIGKILL suites.
      const items = (await call({ type: 'maintenance.replica.list' })).items, target = items.find((i: any) => i.eligible), token = await begin(), p = await call({ type: 'maintenance.replica.preview', token, replica_id: target.replica_id, inputs_saved: true })
      await call({ type: 'maintenance.cancel', token }); await app.close()
      // Relaunch only the isolated application, mutate its isolated control via Electron ABI.
      app = await launch(); page = await app.firstWindow()
      await app.evaluate((_electron, { root, id }) => {
        const req = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json'), Database = req('better-sqlite3'), fs = req('node:fs'), db = new Database(root + '/restore-control.sqlite')
        const value = JSON.parse(db.prepare('SELECT manifest FROM restore_control').get().manifest), r = value.retirements.find((r: any) => r.id === id)
        r.phase = 'retired'; r.attempt = 1; r.reason = 'EBUSY'; r.next_retry_at = new Date(Date.now() - 1000).toISOString(); fs.unlinkSync(root + '/' + r.file); r.members[0].state = 'deleted'; db.prepare('UPDATE restore_control SET manifest=?').run(JSON.stringify(value)); db.close()
      }, { root: directory, id: p.id })
      await app.close(); app = await launch(); page = await app.firstWindow(); await page.getByRole('button', { name: /副本隔离验收/ }).click()
    }
    if (scenario === 'response-lost') await app.evaluate(({ ipcMain }) => {
      const original = (ipcMain as any)._invokeHandlers.get('pliuna:request'); let lost = false
      ipcMain.removeHandler('pliuna:request'); ipcMain.handle('pliuna:request', async (event, request) => { const result = await original(event, request); if (!lost && request?.type === 'maintenance.replica.execute' && result.ok) { lost = true; return { ok: false, error: { code: 'UNKNOWN_RESULT', message: 'Isolated response loss' } } }; return result })
    })
    await page.getByLabel('想从哪里开始？').fill('保持未发送的消息')
    await openSettings(page, '存储与恢复'); const panel = page.getByRole('dialog', { name: '应用设置', exact: true }), section = panel.getByRole('region', { name: '副本退役与回收' })
    // Choose an enabled candidate; protected current/fallback entries remain visibly disabled.
    const enabled = scenario === 'partial-retry' ? section.getByRole('button', { name: '重试原副本未完成项', exact: true }).first() : section.locator('button:not([disabled])').filter({ hasText: /^核验并退役此副本$/ }).first()
    await expect(enabled).toBeEnabled()
    if (scenario === 'input-conflict') {
      await app.evaluate((_electron, root) => { const Database = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('better-sqlite3'), db = new Database(root + '/pliuna.sqlite'); db.exec('UPDATE views SET state_revision=state_revision+1'); db.close() }, directory)
      await page.getByLabel('你的想法').evaluate(inputElement => { const input = inputElement as HTMLTextAreaElement; input.value = '冲突输入不能丢'; input.dispatchEvent(new Event('input', { bubbles: true })); Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent === '核验并退役此副本' && !b.disabled)!.click() })
      await expect(panel.getByRole('alert').last()).toContainText('VERSION_CONFLICT'); expect((await inspect()).journal.retirements).toHaveLength(0); await expect(page.getByLabel('你的想法')).toHaveValue('冲突输入不能丢')
      await panel.getByRole('button', { name: /^返回工作区/ }).click(); page.once('dialog', d => d.accept()); await page.getByRole('button', { name: '放弃本地输入并重新加载', exact: true }).click()
    } else {
      let message = ''; page.once('dialog', async d => { message = d.message(); if (scenario === 'cancel') await d.dismiss(); else await d.accept() }); await enabled.click()
      await expect(panel.getByRole('button', { name: /^返回工作区/ })).toBeEnabled(); expect(message).toContain('永远不可再选择或恢复'); expect(message).toContain('不删除正式资源')
      if (scenario === 'cancel') { expect((await inspect()).journal.retirements.every((r: any) => r.phase === 'preview')).toBe(true); expect((await readdir(join(directory, 'recovery'))).some(f => f === old.id + '.sqlite')).toBe(true) }
      else { await expect(section).toContainText('PROTECTION_RELEASED'); const r = (await inspect()).journal.retirements.find((r: any) => r.phase === 'released'); expect(r).toBeTruthy(); expect((await call({ type: 'maintenance.status' })).active.id).toBe(active.id); await app.close(); app = await launch(); page = await app.firstWindow(); expect((await call({ type: 'maintenance.replica.status', operation_id: r.id })).phase).toBe('released') }
    }
    const after = await inspect(); expect(after.runs).toEqual(before.runs); expect(after.answers).toBe(before.answers)
    expect(await readdir(join(directory, 'resources'))).toEqual(resources); for (let i = 0; i < resources.length; i++) expect(await readFile(join(directory, 'resources', resources[i]!))).toEqual(resourceBytes[i])
    expect(errors).toEqual([])
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})
