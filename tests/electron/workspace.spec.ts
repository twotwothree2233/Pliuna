import { chooseModel, chooseTheme, openSettings } from '../helpers/settings-ui'
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const electronPath: string = createRequire(import.meta.url)('electron')

test('shared UI keeps task creation errors inside the dialog and preserves the name', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pliuna-create-error-'))
  const app = await electron.launch({ executablePath: electronPath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', PLIUNA_TEST_DATA: directory } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: '尚无任务', exact: true })).toBeVisible()
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('pliuna:request')
      ipcMain.handle('pliuna:request', () => ({ ok: false, error: { code: 'OFFLINE', message: 'Test runtime unavailable' } }))
    })
    await page.getByRole('button', { name: '创建第一个任务' }).click()
    await page.getByLabel('任务名称').fill('保留未提交任务名')
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '新建任务' })
    await expect(dialog.getByRole('alert')).toContainText('OFFLINE')
    await expect(page.getByLabel('任务名称')).toHaveValue('保留未提交任务名')
    await expect(dialog.getByRole('button', { name: '创建任务', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await page.getByRole('button', { name: '创建第一个任务' }).click()
    await expect(dialog.getByRole('alert')).toHaveCount(0)
    await expect(page.getByLabel('任务名称')).toHaveValue('保留未提交任务名')
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('desktop workspace: exact theme geometry, real navigation, per-task composer and keyboard', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pliuna-workspace-'))
  const app = await electron.launch({ executablePath: electronPath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', PLIUNA_TEST_DATA: directory } })
  try {
    const page = await app.firstWindow(), errors: string[] = []
    page.on('pageerror', e => errors.push(e.message))
    await page.setViewportSize({ width: 1440, height: 900 })
    await expect(page.getByRole('heading', { name: '尚无任务', exact: true })).toBeVisible()
    await expect(page.getByText('让学习，')).toHaveCount(0)
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dusk')
    await page.emulateMedia({ colorScheme: 'light' })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'graphite')
    await page.getByRole('button', { name: '创建第一个任务' }).click()
    await expect(page.getByLabel('任务名称')).toBeFocused()
    await page.getByLabel('任务名称').fill('事务与持久化')
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    await expect(page.getByRole('heading', { name: '事务与持久化', exact: true })).toBeVisible()
    const themes = [
      ['graphite', 220, 300, 48, 42, 27, 640, 'light'], ['paper', 220, 300, 48, 42, 31, 618, 'light'],
      ['midnight', 220, 300, 48, 42, 26, 640, 'dark'], ['dusk', 220, 300, 48, 42, 26, 640, 'dark'],
      ['moss', 220, 300, 48, 42, 28, 660, 'light'], ['blueprint', 220, 300, 46, 40, 31, 672, 'light']
    ] as const
    for (const [theme, left, right, title, toolbar, heading, reading, scheme] of themes) {
      await chooseTheme(page, theme)
      const actual = await page.evaluate(() => {
        const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect()
        return { left: box('.sidebar').width, right: box('.agent').width, title: box('.titlebar').height, toolbar: box('.toolbar').height, row: box('.task-row').height, heading: getComputedStyle(document.querySelector('.document h1')!).fontSize, reading: getComputedStyle(document.documentElement).getPropertyValue('--reading').trim(), scheme: getComputedStyle(document.documentElement).colorScheme }
      })
      expect(actual).toEqual({ left, right, title, toolbar, row: 31, heading: heading + 'px', reading: reading + 'px', scheme })
      if (theme === 'paper') expect(await page.locator('.document h1').evaluate(el => getComputedStyle(el).fontFamily)).toContain('Songti')
      if (theme === 'blueprint') {
        const rule = await page.locator('.pane-separator[data-side=left]').evaluate(el => ({ token: getComputedStyle(el).getPropertyValue('--rule').trim(), color: getComputedStyle(el, '::before').backgroundColor }))
        expect(rule.token).toBe('1.5px')
        expect(rule.color).toBe('rgb(16, 18, 20)')
        await expect(page.locator('.task-number').first()).toBeVisible()
        expect(await page.locator('.primary').first().evaluate(el => getComputedStyle(el).borderRadius)).toBe('0px')
      }
      if (theme === 'moss') expect(await page.locator('.primary').first().evaluate(el => getComputedStyle(el).borderRadius)).toBe('999px')
    }
    await chooseTheme(page, 'graphite')
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'graphite')
    await chooseTheme(page, 'system')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dusk')
    await chooseTheme(page, 'graphite')
    await expect(page.locator('.task-number').first()).not.toBeVisible()
    await page.getByLabel('想从哪里开始？').fill('第一任务尚未发送的目标')
    await page.keyboard.press('ControlOrMeta+n')
    await expect(page.getByRole('dialog', { name: '新建任务' })).toBeVisible()
    await page.getByLabel('任务名称').fill('版本与权限')
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    await expect(page.getByRole('heading', { name: '版本与权限', exact: true })).toBeVisible()
    await expect(page.getByLabel('想从哪里开始？')).toHaveValue('')
    await page.getByRole('button', { name: /事务与持久化/ }).click()
    await expect(page.getByLabel('想从哪里开始？')).toHaveValue('第一任务尚未发送的目标')
    await page.getByLabel('筛选任务').fill('权限')
    await expect(page.locator('.task-row')).toHaveCount(1)
    await page.getByLabel('筛选任务').fill('')
    await openSettings(page, '权限与审批')
    await page.getByRole('button', { name: '外观', exact: true }).focus()
    await page.keyboard.press('Shift+Tab')
    await expect(page.getByRole('button', { name: '启用独立辅助审批', exact: true })).not.toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await openSettings(page, '模型服务')
    await page.getByRole('button', { name: /^返回工作区/ }).click()
    await chooseModel(page, 'fixture')
    await page.getByLabel('想从哪里开始？').fill('请解释事务中的持久性')
    await page.getByRole('button', { name: /发送 · 新 Run/ }).click()
    await expect(page.getByRole('heading', { name: '思考与记录' })).toBeVisible()
    await page.screenshot({ path: join(tmpdir(), 'pliuna-workspace-graphite.png') })
    await chooseTheme(page, 'paper')
    await page.screenshot({ path: join(tmpdir(), 'pliuna-workspace-paper.png') })
    await chooseTheme(page, 'dusk')
    await page.screenshot({ path: join(tmpdir(), 'pliuna-workspace-dusk.png') })
    await page.setViewportSize({ width: 720, height: 900 })
    await expect(page.getByLabel('筛选任务')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.setViewportSize({ width: 390, height: 900 })
    await page.locator('#toggle-left').click()
    await expect(page.getByLabel('筛选任务')).toBeVisible()
    await page.getByRole('button', { name: /版本与权限/ }).click()
    await expect(page.getByRole('heading', { name: '版本与权限' })).toBeVisible()
    await page.locator('#toggle-right').click()
    await expect(page.getByLabel('想从哪里开始？')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByLabel('想从哪里开始？')).not.toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(errors).toEqual([])
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})
