import { chooseTheme } from '../helpers/settings-ui'
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const executablePath: string = createRequire(import.meta.url)('electron')
async function widths(page: Page) {
  return page.evaluate(() => {
    const width = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().width
    return { left: width('#pane-left'), center: width('.content'), right: width('#pane-right'), total: width('.workspace-body') }
  })
}
async function dragSeparator(page: Page, side: 'left' | 'right', offset: number) {
  const box = (await page.locator(`.pane-separator[data-side=${side}]`).boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + offset, box.y + box.height / 2, { steps: 8 })
  await page.mouse.up()
}

test('resizes real workspace, closes panes completely and retains task input across drawers', async () => {
  test.setTimeout(60000)
  const root = await mkdtemp(join(tmpdir(), 'trellis-layout-'))
  const app = await electron.launch({ executablePath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', TRELLIS_TEST_DATA: root } })
  const page = await app.firstWindow(), errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await expect(page.locator('.workspace-body')).toBeVisible()
    await expect.poll(async () => (await widths(page)).left).toBe(220)
    await page.getByRole('button', { name: '＋ 新建' }).click()
    await page.getByLabel('任务名称').fill('布局交互验证')
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    const input = page.getByRole('textbox', { name: '想从哪里开始？' })
    await input.fill('关闭面板后保留的草稿')
    const material = join(root, 'layout-material.txt')
    await writeFile(material, '仅用于验证关闭侧栏后保留材料绑定')
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, material)
    await page.getByRole('button', { name: /^本次请求材料/ }).click()
    await page.getByRole('button', { name: '选择新文件并绑定请求' }).click()
    const selected = page.getByRole('dialog', { name: '本次请求材料', exact: true }).locator('li').filter({ hasText: 'layout-material.txt' })
    await expect(selected).toBeVisible()
    await page.getByRole('button', { name: '完成选择', exact: true }).click()
    // Identity detects accidental unmount/recreation even when React restores text.
    await input.evaluate(element => element.setAttribute('data-retained-editor', 'yes'))
    await dragSeparator(page, 'left', 70)
    await expect.poll(async () => (await widths(page)).left).toBeCloseTo(290, 0)
    await dragSeparator(page, 'right', -80)
    await expect.poll(async () => (await widths(page)).right).toBeCloseTo(380, 0)
    await page.locator('#toggle-left').click(); await page.getByRole('button', { name: '关闭Agent 栏', exact: true }).click()
    await expect(page.locator('#pane-left')).toBeHidden(); await expect(page.locator('#pane-right')).toBeHidden()
    await expect(page.getByRole('separator')).toHaveCount(0)
    const closed = await widths(page); expect(closed.center).toBe(closed.total)
    await page.locator('#toggle-right').click(); await page.locator('#toggle-left').click()
    await expect(input).toHaveValue('关闭面板后保留的草稿')
    await expect(input).toHaveAttribute('data-retained-editor', 'yes')
    await page.getByRole('button', { name: /^本次请求材料/ }).click()
    await expect(selected).toBeVisible()
    await page.getByRole('button', { name: '完成选择', exact: true }).click()
    expect((await widths(page)).left).toBeCloseTo(290, 0); expect((await widths(page)).right).toBeCloseTo(380, 0)
    const leftSeparator = page.locator('.pane-separator[data-side=left]')
    await leftSeparator.focus(); await page.keyboard.press('Home')
    expect((await widths(page)).left).toBe(180)
    await page.keyboard.press('Shift+ArrowRight'); expect((await widths(page)).left).toBe(230)
    await page.keyboard.press('End'); expect((await widths(page)).center).toBeCloseTo(360, 0)
    await leftSeparator.dblclick(); expect((await widths(page)).left).toBe(220)
    const start = (await leftSeparator.boundingBox())!
    await page.mouse.move(start.x + 3, start.y + 100); await page.mouse.down()
    await page.mouse.move(start.x + 83, start.y + 100)
    await expect.poll(async () => (await widths(page)).left).toBeCloseTo(300, 0)
    await page.keyboard.press('Escape'); await page.mouse.up()
    await expect.poll(async () => (await widths(page)).left).toBe(220)
    await expect(page.locator('.app')).not.toHaveClass(/resizing/)
    await page.locator('.pane-separator[data-side=right]').dblclick()
    expect((await widths(page)).left).toBe(220); expect((await widths(page)).right).toBe(300)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(700, 800))
    await expect(page.locator('#pane-right')).toBeHidden()
    await page.locator('#toggle-right').click()
    await expect(page.locator('#pane-right.drawer')).toBeVisible()
    await expect(input).toHaveValue('关闭面板后保留的草稿')
    await page.keyboard.press('Escape'); await expect(page.locator('#pane-right')).toBeHidden()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(390, 700))
    await expect(page.locator('#pane-left')).toBeHidden()
    await page.locator('#toggle-left').click(); await expect(page.locator('#pane-left.drawer')).toBeVisible()
    await page.locator('#toggle-right').click(); await expect(page.locator('#pane-right.drawer')).toBeVisible()
    await expect(page.locator('#pane-left')).toBeHidden()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: test.info().outputPath('trellis-workspace-narrow.png') })
    await page.getByRole('button', { name: '关闭Agent 栏', exact: true }).click()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1320, 860))
    await expect(page.locator('#pane-left')).toBeVisible()
    await expect(page.locator('#pane-right')).toBeHidden() // Explicit closure survives resize.
    await page.locator('#toggle-right').click()
    await expect(input).toHaveValue('关闭面板后保留的草稿')
    await expect(input).toHaveAttribute('data-retained-editor', 'yes')
    await page.screenshot({ path: test.info().outputPath('trellis-workspace-desktop.png') })
    for (const theme of ['graphite', 'paper', 'midnight', 'dusk', 'moss', 'blueprint']) {
      await chooseTheme(page, theme)
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      expect((await widths(page)).left).toBe(220); expect((await widths(page)).right).toBe(300)
    }
    expect(errors).toEqual([])
  } finally {
    // The selected request material deliberately leaves beforeunload protection active.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy())).catch(() => {})
    await app.close()
  }
})
