import { chooseModel, openSettings } from '../helpers/settings-ui'
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const electronPath: string = createRequire(import.meta.url)('electron')
for (const scenario of ['confirm', 'cancel', 'response-lost', 'input-conflict', 'backoff', 'exhausted'] as const) test('replica cleanup reauthorization desktop: ' + scenario, async () => {
  test.setTimeout(90000)
  const directory = await mkdtemp(join(tmpdir(), 'pliuna-reauthorization-desktop-'))
  const launch = () => electron.launch({ executablePath: electronPath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', PLIUNA_TEST_DATA: directory, PLIUNA_ENABLE_VIEW_REPLACEMENT: '1' } })
  let app = await launch(), page = await app.firstWindow()
  const errors: string[] = []
  const watch = () => page.on('pageerror', error => errors.push(error.message))
  watch()
  const call = async (request: any): Promise<any> => {
    const response = await page.evaluate(request => window.pliuna.request(request), request)
    if (!response.ok) throw new Error(response.error.code)
    return response.data
  }
  const begin = async (): Promise<string> => (await call({ type: 'maintenance.begin' })).reservation.token
  const inspect = async (): Promise<any> => app.evaluate((_electron, root) => {
    const Database = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('better-sqlite3')
    const control = new Database(root + '/restore-control.sqlite'), journal = JSON.parse(control.prepare('SELECT manifest FROM restore_control').get().manifest)
    control.close()
    const database = new Database(root + '/' + journal.selected)
    try { return { journal, runs: database.prepare('SELECT id,state FROM runs').all(), answers: database.prepare('SELECT count(*) n FROM answers').get().n } } finally { database.close() }
  }, directory)
  const restart = async () => { await app.close(); app = await launch(); page = await app.firstWindow(); watch() }
  try {
    await page.getByRole('button', { name: '创建第一个任务' }).click()
    await page.getByLabel('任务名称').fill('原清理重新授权')
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    await chooseModel(page, 'fixture')
    await page.getByLabel('想从哪里开始？').fill('正常发布')
    await page.getByRole('button', { name: /发送消息/ }).click()
    await expect(page.locator('.managed')).toHaveCount(1)
    await expect(page.locator('.agent-status')).toContainText('已完成')
    await page.getByLabel('你的想法').fill('原副本草稿')
    await expect(page.locator('.managed').getByRole('status')).toHaveText('已保存')
    await page.getByRole('button', { name: '提交答案', exact: true }).click()
    await expect(page.locator('.managed').getByRole('status')).toContainText('提交成功')
    const baseline = await inspect(), resources = await readdir(join(directory, 'resources'))
    const resourceBytes = await Promise.all(resources.map(file => readFile(join(directory, 'resources', file))))
    const old = (await call({ type: 'maintenance.create', token: await begin(), inputs_saved: true, replace_id: null })).active
    const active = (await call({ type: 'maintenance.create', token: await begin(), inputs_saved: true, replace_id: old.id })).active
    // Keep a real remaining member after the original attempt deletes the main database.
    await app.evaluate((_electron, { root, id }) => {
      const fs = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('node:fs')
      fs.writeFileSync(root + '/recovery/' + id + '.sqlite-journal', Buffer.alloc(512), { mode: 0o600 })
    }, { root: directory, id: old.id })
    const target = (await call({ type: 'maintenance.replica.list' })).items.find((item: any) => item.eligible)
    expect(target).toBeTruthy()
    const token = await begin(), preview = await call({ type: 'maintenance.replica.preview', token, replica_id: target.replica_id, inputs_saved: true })
    expect(preview.files.some((file: any) => file.kind === '-journal')).toBe(true)
    await call({ type: 'maintenance.cancel', token }); await app.close()
    // Persist an isolated partial-failure fixture while its runtime is closed.
    // Real EBUSY progress and control-write failure are covered by the Node storage suite.
    execFileSync(electronPath, ['-e', `
      const req = require('node:module').createRequire(process.cwd() + '/package.json');
      const Database = req('better-sqlite3'), fs = req('node:fs');
      const [root, id, scenario] = process.argv.slice(1), database = new Database(root + '/restore-control.sqlite');
      const manifest = JSON.parse(database.prepare('SELECT manifest FROM restore_control').get().manifest);
      const record = manifest.retirements.find(entry => entry.id === id);
      fs.unlinkSync(root + '/' + record.file);
      record.members.find(member => member.suffix === '').state = 'deleted';
      record.phase = 'retired'; record.reason = 'EBUSY';
      record.attempt = scenario === 'exhausted' ? 4 : 1;
      record.next_retry_at = new Date(Date.now() + (scenario === 'backoff' ? 3600000 : -1000)).toISOString();
      database.prepare('UPDATE restore_control SET manifest=?').run(JSON.stringify(manifest)); database.close();
    `, directory, preview.id, scenario], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    app = await launch(); page = await app.firstWindow(); watch()
    const partial = await call({ type: 'maintenance.replica.status', operation_id: preview.id })
    expect(partial.attempt).toBe(scenario === 'exhausted' ? 4 : 1)
    expect(partial.files.find((file: any) => file.kind === 'database').state).toBe('deleted')
    expect(partial.protection_released).toBe(false)
    await call({ type: 'maintenance.restore', token: await begin(), point_id: active.id, database_sha256: active.database_sha256, inputs_saved: true, confirm_replace_newer_data: true })
    await restart()
    await page.getByRole('button', { name: /原清理重新授权/ }).click()
    const before = await inspect(), original = before.journal.retirements.find((entry: any) => entry.id === preview.id)
    expect(before.journal.selected).not.toBe(original.selected)
    const status = await call({ type: 'maintenance.replica.status', operation_id: preview.id })
    expect(status.reauthorization_required).toBe(true)
    expect(status.authorization_count).toBe(0)
    const remainingPaths = original.members.filter((member: any) => !['deleted', 'absent'].includes(member.state)).map((member: any) => join(directory, original.file + member.suffix)) as string[]
    const remainingBytes = await Promise.all(remainingPaths.map(file => readFile(file)))
    await app.evaluate(({ ipcMain }, loseResponse) => {
      const handler = (ipcMain as any)._invokeHandlers.get('pliuna:request')
      ;(globalThis as any).__reauthorizationRequests = []
      ipcMain.removeHandler('pliuna:request')
      ipcMain.handle('pliuna:request', async (event, request) => {
        ;(globalThis as any).__reauthorizationRequests.push(request)
        const response = await handler(event, request)
        if (loseResponse && request?.type === 'maintenance.replica.reauthorize.confirm' && response.ok) return { ok: false, error: { code: 'UNKNOWN_RESULT', message: 'Isolated confirmation response loss' } }
        return response
      })
    }, scenario === 'response-lost')
    await openSettings(page, '存储与恢复')
    const panel = page.getByRole('dialog', { name: '应用设置', exact: true }), section = panel.getByRole('region', { name: '副本退役与回收' })
    const article = section.getByRole('article').filter({ hasText: preview.id })
    const renew = article.getByRole('button', { name: '重新授权并续办原清理', exact: true })
    await expect(article.getByRole('button', { name: '重试原副本未完成项', exact: true })).toBeDisabled()
    if (scenario === 'backoff' || scenario === 'exhausted') {
      await expect(renew).toBeDisabled()
      await expect(article).toContainText(scenario === 'exhausted' ? '累计尝试 4 次' : '可重试时间')
    } else if (scenario === 'input-conflict') {
      await expect(renew).toBeEnabled()
      await app.evaluate((_electron, root) => {
        const Database = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('better-sqlite3'), control = new Database(root + '/restore-control.sqlite')
        const manifest = JSON.parse(control.prepare('SELECT manifest FROM restore_control').get().manifest); control.close()
        const database = new Database(root + '/' + manifest.selected); database.exec('UPDATE views SET state_revision=state_revision+1'); database.close()
      }, directory)
      await page.getByLabel('你的想法').evaluate(element => {
        const input = element as HTMLTextAreaElement; input.value = '冲突输入保留'; input.dispatchEvent(new Event('input', { bubbles: true }))
        Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === '重新授权并续办原清理' && !button.disabled)!.click()
      })
      await expect(panel.getByRole('alert').last()).toContainText('VERSION_CONFLICT')
      await expect(page.getByLabel('你的想法')).toHaveValue('冲突输入保留')
      await panel.getByRole('button', { name: /^返回工作区/ }).click()
      page.once('dialog', dialog => dialog.accept())
      await page.getByRole('button', { name: '放弃本地输入并重新加载', exact: true }).click()
    } else {
      await expect(renew).toBeEnabled()
      let message = ''
      page.once('dialog', async dialog => { message = dialog.message(); if (scenario === 'cancel') await dialog.dismiss(); else await dialog.accept() })
      await renew.click()
      await expect(panel.getByRole('button', { name: /^返回工作区/ })).toBeEnabled()
      expect(message).toContain('副本清理重新授权')
      expect(message).toContain(`本次剩余 ${remainingPaths.length} 个数据库文件`)
      expect(message).toContain('累计 1 次尝试')
      expect(message).toContain('不删除正式资源')
      if (scenario !== 'cancel') await expect(article).toContainText('PROTECTION_RELEASED')
      await expect(article).toContainText(scenario === 'cancel' ? '仅预览，尚未确认' : '已明确确认')
    }
    const requests = await app.evaluate(() => (globalThis as any).__reauthorizationRequests) as any[]
    const previews = requests.filter(request => request.type === 'maintenance.replica.reauthorize.preview')
    const confirmations = requests.filter(request => request.type === 'maintenance.replica.reauthorize.confirm')
    const confirms = scenario === 'confirm' || scenario === 'response-lost'
    expect(previews).toHaveLength(['backoff', 'exhausted', 'input-conflict'].includes(scenario) ? 0 : 1)
    expect(confirmations).toHaveLength(confirms ? 1 : 0)
    expect(requests.filter(request => request.type === 'maintenance.replica.retry')).toHaveLength(0)
    if (scenario === 'response-lost') {
      expect(requests.some(request => request.type === 'maintenance.replica.status' && request.operation_id === preview.id && request.authorization_id === confirmations[0].authorization_id)).toBe(true)
      await expect(panel.getByRole('alert').last()).toContainText('仅查询，不重发')
    }
    const result = await call({ type: 'maintenance.replica.status', operation_id: preview.id })
    expect(result.authorization_count).toBe(previews.length)
    expect(result.attempt).toBe(scenario === 'exhausted' ? 4 : confirms ? 2 : 1)
    if (confirms) {
      expect(result.protection_released).toBe(true)
      expect(result.reauthorization.state).toBe('confirmed')
      for (const file of remainingPaths) await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
    } else {
      expect(result.protection_released).toBe(false)
      for (let index = 0; index < remainingPaths.length; index++) expect(await readFile(remainingPaths[index]!)).toEqual(remainingBytes[index])
      if (scenario === 'cancel') expect(result.reauthorization.state).toBe('preview')
    }
    const after = await inspect(), retained = after.journal.retirements.find((entry: any) => entry.id === preview.id)
    for (const key of ['id', 'token', 'selected', 'graph', 'file', 'created_at', 'protection']) expect(retained[key]).toEqual(original[key])
    expect(retained.members.map((member: any) => member.identity)).toEqual(original.members.map((member: any) => member.identity))
    expect(after.runs).toEqual(baseline.runs); expect(after.answers).toBe(baseline.answers)
    expect(await readdir(join(directory, 'resources'))).toEqual(resources)
    for (let index = 0; index < resources.length; index++) expect(await readFile(join(directory, 'resources', resources[index]!))).toEqual(resourceBytes[index])
    if (confirms) {
      await restart()
      const persisted = await call({ type: 'maintenance.replica.status', operation_id: preview.id, authorization_id: confirmations[0].authorization_id })
      expect(persisted.attempt).toBe(2); expect(persisted.reauthorization.state).toBe('confirmed'); expect(persisted.protection_released).toBe(true)
    }
    expect(errors).toEqual([])
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})
