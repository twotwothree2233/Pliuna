import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { chooseModel, chooseTheme, closeSettings, openSettings } from '../helpers/settings-ui'

const executablePath: string = createRequire(import.meta.url)('electron')
async function metrics(page: Page) {
  return page.evaluate(() => ({
    left: document.querySelector('#pane-left')!.getBoundingClientRect().width,
    right: document.querySelector('#pane-right')!.getBoundingClientRect().width,
    title: parseFloat(getComputedStyle(document.querySelector('.document-heading h1')!).fontSize),
    task: parseFloat(getComputedStyle(document.querySelector('.task-row')!).fontSize),
    heading: parseFloat(getComputedStyle(document.querySelector('.view-boundary>div')!.shadowRoot!.querySelector('h2')!).fontSize),
    input: parseFloat(getComputedStyle(document.querySelector('.view-boundary>div')!.shadowRoot!.querySelector('textarea')!).fontSize)
  }))
}

test('text size scales UI and managed text without remounting drafts, then persists across restart', async () => {
  test.setTimeout(60000)
  const root = await mkdtemp(join(tmpdir(), 'pliuna-text-size-'))
  const launch = () => electron.launch({ executablePath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', PLIUNA_TEST_DATA: root } })
  let app = await launch()
  try {
    let page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await expect(page.locator('.workspace-body')).toBeVisible()
    await page.getByRole('button', { name: '创建第一个任务' }).click()
    await page.getByLabel('任务名称').fill('文字大小验证')
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    await chooseTheme(page, 'graphite')
    await chooseModel(page, 'fixture')
    await page.getByLabel('想从哪里开始？').fill('生成可编辑内容')
    await page.getByRole('button', { name: /发送 · 新 Run/ }).click()
    await expect(page.getByRole('heading', { name: '思考与记录' })).toBeVisible()
    await page.getByLabel('你的想法').fill('调整字号后保留的正文草稿')
    await page.getByLabel('你的想法').evaluate(el => el.setAttribute('data-retained-editor', 'yes'))
    await page.getByLabel('想从哪里开始？').fill('调整字号后保留的请求草稿')
    await page.getByLabel('想从哪里开始？').evaluate(el => el.setAttribute('data-retained-editor', 'yes'))
    const initial = await metrics(page)
    expect(initial).toMatchObject({ left: 220, right: 300, title: 27, task: 11, heading: 22 })
    await openSettings(page, '外观')
    await expect(page.getByRole('radio', { name: '100%（默认）', exact: true })).toBeChecked()
    for (const size of [90, 100, 110, 125, 140]) {
      await page.getByRole('radio', { name: size === 100 ? '100%（默认）' : `${size}%`, exact: true }).check()
      await expect.poll(async () => (await metrics(page)).heading).toBeCloseTo(initial.heading * size / 100, 1)
      const scaled = await metrics(page)
      expect(scaled.left).toBe(initial.left); expect(scaled.right).toBe(initial.right)
      for (const field of ['title', 'task', 'input'] as const) expect(scaled[field]).toBeCloseTo(initial[field] * size / 100, 1)
    }
    // Native radio buttons keep arrow-key navigation and selection together.
    await page.getByRole('radio', { name: '140%', exact: true }).focus()
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByRole('radio', { name: '125%', exact: true })).toBeChecked()
    await page.getByRole('radio', { name: '140%', exact: true }).check()
    await page.screenshot({ path: test.info().outputPath('pliuna-text-size-desktop.png') })
    await closeSettings(page)
    for (const name of ['你的想法', '想从哪里开始？']) {
      await expect(page.getByLabel(name)).toHaveAttribute('data-retained-editor', 'yes')
      await expect(page.getByLabel(name)).toHaveValue(name === '你的想法' ? '调整字号后保留的正文草稿' : '调整字号后保留的请求草稿')
    }
    await chooseTheme(page, 'paper')
    expect((await metrics(page)).title).toBeCloseTo(31 * 1.4, 1)
    expect((await metrics(page)).heading).toBeCloseTo(22 * 1.4, 1)
    await openSettings(page, '外观')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(390, 850))
    await expect(page.getByRole('radio', { name: '140%', exact: true })).toBeChecked()
    expect(await page.locator('.settings-content').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.getByRole('radio', { name: '140%', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: test.info().outputPath('pliuna-text-size-mobile.png') })
    await closeSettings(page)
    await expect(page.getByRole('status').filter({ hasText: /^已保存$/ })).toBeVisible()
    expect(errors).toEqual([])
    await app.close(); app = await launch(); page = await app.firstWindow()
    await openSettings(page, '外观')
    await expect(page.getByRole('radio', { name: '140%', exact: true })).toBeChecked()
    expect(await page.locator('.settings-page h1').evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeCloseTo(24 * 1.4, 1)
    // Invalid persisted values must fall back to the original baseline.
    await page.evaluate(() => localStorage.setItem('pliuna-text-size', '999'))
    await page.reload()
    await openSettings(page, '外观')
    await expect(page.getByRole('radio', { name: '100%（默认）', exact: true })).toBeChecked()
  } finally {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy())).catch(() => {})
    await app.close(); await rm(root, { recursive: true, force: true })
  }
})
