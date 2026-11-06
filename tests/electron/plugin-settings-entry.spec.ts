import { _electron as electron, expect, test } from '@playwright/test'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openSettings } from '../helpers/settings-ui'

const executablePath: string = createRequire(import.meta.url)('electron')

test('plugin settings exposes controls without a task and provides task creation and selection', async () => {
  test.setTimeout(45000)
  const root = await mkdtemp(join(tmpdir(), 'trellis-plugin-entry-'))
  const launch = () => electron.launch({ executablePath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', TRELLIS_TEST_DATA: root } })
  let app = await launch()
  try {
    let page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await openSettings(page, '插件与主流程')
    let settings = page.getByRole('dialog', { name: '应用设置', exact: true })
    await expect(settings.getByRole('button', { name: '从文件夹导入固定包', exact: true })).toBeVisible()
    await expect(settings.getByRole('button', { name: '重新查询状态', exact: true })).toBeVisible()
    await expect(settings.getByLabel('插件管理任务')).toBeDisabled()
    await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }) })
    await settings.getByRole('button', { name: '从文件夹导入固定包', exact: true }).click()
    await expect(settings.getByRole('status')).toContainText('已取消导入')
    await settings.getByRole('button', { name: '重新查询状态', exact: true }).click()
    await expect(settings.getByRole('status')).toContainText('已更新任务列表')
    await page.screenshot({ path: '/tmp/trellis-plugin-entry-desktop.png' })
    await app.evaluate(({ dialog }, fixture) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture] }) }, resolve('tests/fixtures/plugin-demo'))
    await settings.getByRole('button', { name: '从文件夹导入固定包', exact: true }).click()
    await expect(settings.getByRole('status')).toContainText('固定副本已导入，未启用、未执行。选择任务后可查看和启用。')
    await settings.getByRole('button', { name: '新建任务', exact: true }).click()
    await page.getByLabel('任务名称').fill('插件入口回归任务')
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    await openSettings(page, '插件与主流程')
    await expect(settings.locator('.plugin-card')).toContainText('trellis.acceptance')
    await expect(settings.getByRole('button', { name: '核对启用依赖', exact: true })).toBeVisible()
    await expect(settings.getByRole('button', { name: '从文件夹导入固定包', exact: true })).toBeEnabled()
    await app.close(); app = await launch(); page = await app.firstWindow()
    page.on('pageerror', error => errors.push(error.message))
    await openSettings(page, '插件与主流程')
    settings = page.getByRole('dialog', { name: '应用设置', exact: true })
    const taskSelect = settings.getByLabel('插件管理任务')
    await expect(taskSelect).toBeEnabled()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(390, 800))
    expect(await settings.locator('.settings-content').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    await page.screenshot({ path: '/tmp/trellis-plugin-entry-mobile.png' })
    await taskSelect.selectOption({ label: '插件入口回归任务' })
    await expect(settings.locator('.plugin-card')).toContainText('trellis.acceptance')
    await expect(settings.getByRole('button', { name: '从文件夹导入固定包', exact: true })).toBeEnabled()
    await expect(settings.getByLabel('插件管理任务')).toHaveCount(0)
    expect(errors).toEqual([])
  } finally { await app.close(); await rm(root, { recursive: true, force: true }) }
})
