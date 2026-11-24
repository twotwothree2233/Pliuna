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

test('resizes real workspace, closes panes completely and retains task input across full-width narrow views', async () => {
  test.setTimeout(60000)
  const root = await mkdtemp(join(tmpdir(), 'pliuna-layout-'))
  const app = await electron.launch({ executablePath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', PLIUNA_TEST_DATA: root } })
  const page = await app.firstWindow(), errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await expect(page.locator('.workspace-body')).toBeVisible()
    await expect.poll(async () => (await widths(page)).left).toBe(214)
    await page.getByRole('button', { name: '＋ 新建任务' }).click()
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
    await expect.poll(async () => (await widths(page)).left).toBeCloseTo(284, 0)
    await dragSeparator(page, 'right', -80)
    await expect.poll(async () => (await widths(page)).right).toBeCloseTo(358, 0)
    await page.locator('#toggle-left').click(); await page.locator('#toggle-right').click()
    await expect(page.locator('#pane-left')).toBeHidden(); await expect(page.locator('#pane-right')).toBeHidden()
    await expect(page.getByRole('separator')).toHaveCount(0)
    const closed = await widths(page); expect(closed.center).toBe(closed.total)
    await page.locator('#toggle-right').click(); await page.locator('#toggle-left').click()
    await expect(input).toHaveValue('关闭面板后保留的草稿')
    await expect(input).toHaveAttribute('data-retained-editor', 'yes')
    await page.getByRole('button', { name: /^本次请求材料/ }).click()
    await expect(selected).toBeVisible()
    await page.getByRole('button', { name: '完成选择', exact: true }).click()
    expect((await widths(page)).left).toBeCloseTo(284, 0); expect((await widths(page)).right).toBeCloseTo(358, 0)
    const leftSeparator = page.locator('.pane-separator[data-side=left]')
    await leftSeparator.focus(); await page.keyboard.press('Home')
    expect((await widths(page)).left).toBe(200)
    await page.keyboard.press('Shift+ArrowRight'); expect((await widths(page)).left).toBe(250)
    await page.keyboard.press('End'); expect((await widths(page)).center).toBeCloseTo(360, 0)
    await leftSeparator.dblclick(); expect((await widths(page)).left).toBe(214)
    const start = (await leftSeparator.boundingBox())!
    await page.mouse.move(start.x + 3, start.y + 100); await page.mouse.down()
    await page.mouse.move(start.x + 83, start.y + 100)
    await expect.poll(async () => (await widths(page)).left).toBeCloseTo(294, 0)
    await page.keyboard.press('Escape'); await page.mouse.up()
    await expect.poll(async () => (await widths(page)).left).toBe(214)
    await expect(page.locator('.app')).not.toHaveClass(/resizing/)
    await page.locator('.pane-separator[data-side=right]').dblclick()
    expect((await widths(page)).left).toBe(214); expect((await widths(page)).right).toBe(278)
    const rightSeparator = page.locator('.pane-separator[data-side=right]')
    await rightSeparator.press('Home')
    await expect.poll(async () => (await widths(page)).right).toBe(260)
    await page.evaluate(() => document.documentElement.style.setProperty('--text-scale', '1.4'))
    const send = page.getByRole('button', { name: '发送消息', exact: true })
    const actionRow = page.locator('.composer-input-actions')
    const metrics = () => input.evaluate((element: HTMLTextAreaElement) => {
      const { clientHeight, scrollHeight, clientWidth, scrollWidth, scrollTop } = element
      return { clientHeight, scrollHeight, clientWidth, scrollWidth, scrollTop, start: element.selectionStart, end: element.selectionEnd }
    })
    const compact = (await metrics()).clientHeight
    const longDraft = ['开头', ...Array.from({ length: 24 }, (_, i) => `段落 ${i + 1}`), 'W'.repeat(1500), '结尾'].join('\n')
    await input.fill('')
    await input.focus()
    await app.evaluate(({ BrowserWindow, clipboard }, value) => {
      clipboard.writeText(value); BrowserWindow.getAllWindows()[0]!.webContents.paste()
    }, longDraft)
    await expect(input).toHaveValue(longDraft)
    const checkLongDraft = async () => {
      const grown = await metrics()
      expect(grown.clientHeight).toBeGreaterThan(compact)
      expect(grown.clientHeight).toBeLessThanOrEqual(280)
      expect(grown.scrollHeight).toBeGreaterThan(grown.clientHeight)
      expect(grown.scrollWidth).toBeLessThanOrEqual(grown.clientWidth + 1)
      const [pane, actions, button] = await Promise.all([page.locator('#pane-right').boundingBox(), actionRow.boundingBox(), send.boundingBox()])
      expect(actions!.y + actions!.height).toBeLessThanOrEqual(pane!.y + pane!.height)
      expect(button!.x + button!.width).toBeLessThanOrEqual(actions!.x + actions!.width + 1)
      expect(await actionRow.locator('.composer-usage').isVisible()).toBe(true)
    }
    await checkLongDraft()
    const docStart = process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home'
    const docEnd = process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End'
    await input.press(docStart)
    expect(await metrics()).toMatchObject({ start: 0, scrollTop: 0 })
    await input.press(docEnd)
    const end = await metrics()
    expect(end.start).toBe(longDraft.length)
    expect(end.scrollHeight - end.clientHeight - end.scrollTop).toBeLessThanOrEqual(2)
    await input.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(3, 17))
    await dragSeparator(page, 'right', -35)
    await expect(input).toBeFocused()
    expect(await metrics()).toMatchObject({ start: 3, end: 17 })
    const mobile = page.getByRole('navigation', { name: '工作区视图' })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(700, 800))
    await expect(page.locator('#pane-right')).toBeHidden()
    await mobile.getByRole('button', { name: 'Agent', exact: true }).click()
    await expect(page.locator('#pane-right')).toBeVisible()
    await expect(page.getByRole('main')).toBeHidden()
    await expect(input).toHaveValue(longDraft)
    await expect(input).toHaveAttribute('data-retained-editor', 'yes')
    expect(await metrics()).toMatchObject({ start: 3, end: 17 })
    await checkLongDraft()
    await input.fill('关闭面板后保留的草稿')
    await expect(page.locator('.composer-materials')).toContainText('layout-material.txt')
    await page.evaluate(() => document.documentElement.style.setProperty('--text-scale', '1'))
    await mobile.getByRole('button', { name: '内容', exact: true }).click()
    await expect(page.locator('#pane-right')).toBeHidden()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(390, 700))
    await mobile.getByRole('button', { name: '任务', exact: true }).click()
    await expect(page.locator('#pane-left')).toBeVisible()
    await mobile.getByRole('button', { name: 'Agent', exact: true }).click()
    await expect(page.locator('#pane-right')).toBeVisible()
    await expect(page.locator('#pane-left')).toBeHidden()
    expect((await page.locator('#pane-right').boundingBox())!.width).toBe(390)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: test.info().outputPath('pliuna-workspace-narrow.png') })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1320, 860))
    await expect(page.locator('#pane-left')).toBeVisible()
    await expect(page.locator('#pane-right')).toBeVisible()
    await expect(input).toHaveValue('关闭面板后保留的草稿')
    await expect(input).toHaveAttribute('data-retained-editor', 'yes')
    await rightSeparator.dblclick()
    await page.screenshot({ path: test.info().outputPath('pliuna-workspace-desktop.png') })
    for (const theme of ['graphite', 'paper', 'midnight', 'dusk', 'moss', 'blueprint']) {
      await chooseTheme(page, theme)
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      expect((await widths(page)).left).toBe(214); expect((await widths(page)).right).toBe(278)
    }
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const track = (side: 'left' | 'right') => page.locator(`#pane-slot-${side}`)
    const trackWidth = async (side: 'left' | 'right') => (await track(side).boundingBox())!.width
    const waitForTrack = async (side: 'left' | 'right', width: number) => {
      await expect.poll(() => trackWidth(side)).toBe(width)
      await expect(page.locator('.workspace-body')).not.toHaveAttribute('data-pane-motion', '')
    }
    for (const [side, minimum, normal, direction] of [['left', 200, 214, -1], ['right', 260, 278, 1]] as const) {
      const divider = page.locator(`.pane-separator[data-side=${side}]`), hint = page.getByText('松手收起', { exact: true })
      const toggle = page.locator(`#toggle-${side}`)
      await dragSeparator(page, side, direction * (normal - minimum + 47))
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      await expect(hint).toHaveCount(0)
      await waitForTrack(side, minimum)
      const pressDivider = async () => {
        const { x, y, width } = (await divider.boundingBox())!
        const point = { x: x + width / 2, y: y + 100 }
        await page.mouse.move(point.x, point.y); await page.mouse.down()
        return point
      }
      let point = await pressDivider()
      await page.mouse.move(point.x + direction * 48, point.y)
      await expect(hint).toBeVisible()
      await page.mouse.move(point.x + direction * 47, point.y)
      await expect(hint).toHaveCount(0)
      await page.mouse.up(); await waitForTrack(side, minimum)
      await divider.dblclick(); await waitForTrack(side, normal)
      point = await pressDivider()
      await page.mouse.move(point.x + direction * (normal - minimum + 48), point.y)
      await expect(hint).toBeVisible(); await page.keyboard.press('Escape'); await page.mouse.up()
      await waitForTrack(side, normal)
      await dragSeparator(page, side, direction * (normal - minimum + 48))
      await expect(toggle).toBeFocused()
      await waitForTrack(side, 0)
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await toggle.press('Enter'); await waitForTrack(side, normal)
    }
    for (const side of ['left', 'right', 'left', 'right', 'right', 'left', 'right', 'left'] as const) {
      const frames = await page.locator(`#toggle-${side}`).evaluate((element: HTMLButtonElement, side) => {
        const slot = document.querySelector(`#pane-slot-${side}`)!, canvas = slot.querySelector('aside')!, center = document.querySelector('main')!
        const frame = () => ({ width: slot.getBoundingClientRect().width, inner: canvas.getBoundingClientRect().width, center: center.getBoundingClientRect().width })
        const frames = [frame()], started = performance.now()
        element.click()
        return new Promise<typeof frames>(resolve => {
          const read = () => {
            frames.push(frame())
            if (performance.now() - started > 600 || (!document.querySelector('[data-pane-motion]') && frames.length > 2)) resolve(frames)
            else requestAnimationFrame(read)
          }
          requestAnimationFrame(read)
        })
      }, side)
      const first = frames[0]!, last = frames.at(-1)!, full = Math.max(first.width, last.width)
      const intermediate = frames.find(frame => frame.width > 1 && frame.width < full - 1)
      expect(intermediate).toBeDefined()
      expect(intermediate!.inner).toBe(full)
      expect(intermediate!.center).toBeGreaterThan(Math.min(first.center, last.center))
      expect(intermediate!.center).toBeLessThan(Math.max(first.center, last.center))
    }
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.locator('#toggle-right').press('Enter')
    await expect(page.locator('.workspace-body')).not.toHaveAttribute('data-pane-motion', '')
    expect(await trackWidth('right')).toBe(0)
    await page.locator('#toggle-right').press('Enter')
    await expect(input).toHaveValue('关闭面板后保留的草稿')
    await expect(input).toHaveAttribute('data-retained-editor', 'yes')
    await expect(page.locator('.composer-materials')).toContainText('layout-material.txt')
    expect(errors).toEqual([])
  } finally {
    // The selected request material deliberately leaves beforeunload protection active.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy())).catch(() => {})
    await app.close()
  }
})
