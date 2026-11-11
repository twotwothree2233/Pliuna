import { chooseModel, openSettings } from '../helpers/settings-ui'
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const electronPath: string = createRequire(import.meta.url)('electron')

test('storage inspection: failed publication, retained files, recheck, damaged formal resource and restart', async () => {
  test.setTimeout(60000)
  const directory = await mkdtemp(join(tmpdir(), 'pliuna-storage-desktop-'))
  const launch = () => electron.launch({ executablePath: electronPath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', PLIUNA_TEST_DATA: directory } })
  let app = await launch()
  const errors: string[] = []
  async function database(mode: 'fail' | 'drop' | 'query'): Promise<any> {
    return app.evaluate((_electron, { directory, mode }) => {
      const Database = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('better-sqlite3')
      const db = new Database(directory + '/pliuna.sqlite')
      try {
        if (mode === 'fail') db.exec("CREATE TRIGGER fail_view BEFORE INSERT ON views BEGIN SELECT RAISE(ABORT,'injected storage failure'); END")
        if (mode === 'drop') db.exec('DROP TRIGGER fail_view')
        return { stages: db.prepare('SELECT id,state,storage_key FROM staging ORDER BY rowid').all(), actions: db.prepare('SELECT id,result FROM actions ORDER BY rowid').all(), schema: db.prepare('SELECT version FROM schema_version').all() }
      } finally { db.close() }
    }, { directory, mode })
  }
  try {
    let page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await page.getByRole('button', { name: '创建第一个任务' }).click(); await page.getByLabel('任务名称').fill('存储登记验收')
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    await chooseModel(page, 'fixture')
    await database('fail')
    await page.getByLabel('想从哪里开始？').fill('失败发布'); await page.getByRole('button', { name: /发送 · 新 Run/ }).click()
    await expect(page.locator('.agent-status')).toContainText('失败')
    const failed = await database('drop'), originalFiles = await readdir(join(directory, 'resources'))
    expect(failed.actions).toHaveLength(1); expect(failed.actions[0].result).toBe('not_executed')
    await openSettings(page, '存储与恢复')
    let panel = page.getByRole('dialog', { name: '应用设置', exact: true })
    await expect(panel.getByRole('heading', { name: '孤立候选（保留）', exact: true })).toBeVisible()
    await expect(panel).toContainText('仅开放已登记 staging、已核验副本及已删除任务的正式资源受限回收')
    await panel.getByRole('button', { name: '重新核对此项', exact: true }).click()
    await expect(panel.getByRole('button', { name: '刷新存储登记', exact: true })).toBeEnabled()
    expect((await database('query')).actions).toEqual(failed.actions)
    expect(await readdir(join(directory, 'resources'))).toEqual(originalFiles)
    await panel.getByRole('button', { name: /^返回工作区/ }).click()
    await page.getByLabel('想从哪里开始？').fill('正常发布'); await page.getByRole('button', { name: /发送 · 新 Run/ }).click()
    await expect(page.locator('.managed')).toHaveCount(1); await expect(page.locator('.agent-status')).toContainText('已完成')
    await page.getByLabel('你的想法').fill('保持保存草稿'); await expect(page.locator('.managed').getByRole('status')).toHaveText('已保存')
    await page.getByRole('button', { name: '提交答案', exact: true }).click(); await expect(page.locator('.managed').getByRole('status')).toContainText('提交成功')
    const before = await database('query'), key = before.stages.find((s: any) => s.state === 'committed').storage_key
    const original = await readFile(join(directory, 'resources', key))
    await app.close(); await writeFile(join(directory, 'resources', key), 'broken'); app = await launch()
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await openSettings(page, '存储与恢复'); panel = page.getByRole('dialog', { name: '应用设置', exact: true })
    await expect(panel).toContainText('RESOURCE_CORRUPT')
    await expect(panel.getByRole('heading', { name: '孤立候选（保留）', exact: true })).toBeVisible()
    await expect(panel.getByRole('heading', { name: '需要核对（保留）', exact: true })).toBeVisible()
    const review = panel.locator('article').filter({ hasText: 'RESOURCE_CORRUPT' })
    await writeFile(join(directory, 'resources', key), original)
    await review.getByRole('button', { name: '重新核对此项', exact: true }).click()
    await expect(panel.getByRole('heading', { name: '正式提交已核对', exact: true })).toBeVisible()
    await panel.getByRole('button', { name: /^返回工作区/ }).click()
    await page.getByRole('button', { name: /存储登记验收/ }).click()
    await expect(page.getByLabel('你的想法')).toHaveValue('保持保存草稿')
    await page.getByRole('tab', { name: /作答记录/ }).click(); await expect(page.getByText('第 1 次提交')).toBeVisible()
    expect((await database('query')).actions).toEqual(before.actions)
    expect((await database('query')).schema).toEqual([{ version: 1 }])
    expect((await readdir(join(directory, 'resources'))).length).toBe(2)
    expect(errors).toEqual([])
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})
