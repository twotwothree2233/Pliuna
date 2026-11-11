import { chooseModel, chooseTheme } from '../helpers/settings-ui'
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const electronPath: string = createRequire(import.meta.url)('electron')

test('core slice: task, fixture write, saved submission, data-only restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pliuna-electron-'))
  const launch = () => electron.launch({ executablePath: electronPath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', PLIUNA_TEST_DATA: directory } })
  let app = await launch()
  try {
    let page = await app.firstWindow()
    const pageErrors: string[] = []
    page.on('pageerror', error => pageErrors.push(error.message))
    await expect(page.getByRole('heading', { name: '尚无任务', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '创建第一个任务' }).click()
    await page.getByLabel('任务名称').fill('可追溯学习')
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    await expect(page.getByRole('button', { name: /发送 · 新 Run/ })).toBeDisabled()
    await chooseModel(page, 'fixture')
    await page.getByLabel('想从哪里开始？').fill('请帮助理解原子事务')
    await page.getByRole('button', { name: /发送 · 新 Run/ }).click()
    await expect(page.getByRole('heading', { name: '思考与记录' })).toBeVisible()
    const hostStyle = await page.getByRole('button', { name: '停止任务' }).evaluate(el => getComputedStyle(el).fontSize)
    expect(await page.getByRole('heading', { name: '思考与记录' }).evaluate(el => getComputedStyle(el).fontSize)).toBe('22px')
    expect(await page.getByRole('button', { name: '停止任务' }).evaluate(el => getComputedStyle(el).fontSize)).toBe(hostStyle)
    expect(await page.locator('[data-view] textarea').evaluate(el => ({ labels: (el as HTMLTextAreaElement).labels?.length, outside: el.closest('[data-view]') === null }))).toEqual({ labels: 1, outside: false })
    const answer = page.getByLabel('你的想法')
    await answer.fill('答案与事件必须一起提交。')
    await expect(page.getByRole('status').filter({ hasText: /^已保存$/ })).toBeVisible()
    await page.getByRole('button', { name: '提交答案', exact: true }).click()
    await page.getByRole('tab', { name: /作答记录/ }).click()
    await expect(page.getByText('第 1 次提交')).toBeVisible()
    await page.getByRole('tab', { name: /^内容/ }).click()
    await page.getByRole('button', { name: '提交答案', exact: true }).click()
    await page.getByRole('tab', { name: /作答记录/ }).click()
    await expect(page.getByText('第 2 次提交')).toBeVisible()
    await chooseTheme(page, 'paper')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'paper')
    await app.close()
    app = await launch(); page = await app.firstWindow()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'paper')
    await page.getByRole('button', { name: /可追溯学习/ }).click()
    await page.getByRole('tab', { name: /作答记录/ }).click()
    await expect(page.getByText('第 2 次提交')).toBeVisible()
    await page.getByRole('tab', { name: /^内容/ }).click()
    await expect(page.getByLabel('你的想法')).toHaveValue('答案与事件必须一起提交。')
    await expect(page.locator('[data-view]')).toHaveCount(1)
    expect(pageErrors).toEqual([])
    expect(await page.evaluate(() => ({ node: typeof (window as unknown as { require?: unknown }).require, keys: Object.keys(window.pliuna) }))).toEqual({ node: 'undefined', keys: ['request'] })
    for (const width of [390, 720, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})
