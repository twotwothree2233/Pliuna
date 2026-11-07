import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
// @ts-expect-error Standalone package structure verifier.
import { verifyDesktop } from '../../scripts/verify-desktop.mjs'

const packaged = process.env.TRELLIS_PACKAGED_OUTPUT ? verifyDesktop(process.env.TRELLIS_PACKAGED_OUTPUT) : undefined
const executablePath: string = packaged?.executable ?? createRequire(import.meta.url)('electron')
test('starts without calculation, creates a task and restores it on the native desktop', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trellis-platform-smoke-'))
  const launch = () => electron.launch({ executablePath, args: packaged ? [] : ['.'], ...(packaged ? { cwd: root } : {}), env: {
    ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: packaged ? 'http://127.0.0.1:1/must-not-load' : '',
    TRELLIS_TEST_DATA: join(root, 'user data'), TRELLIS_ENABLE_MONTY: '0'
  } })
  let app = await launch()
  try {
    let page = await app.firstWindow()
    expect(page.url()).toMatch(/^file:/)
    expect(await page.evaluate(() => window.trellis.platform)).toBe(process.platform)
    expect(await page.locator('.app').evaluate(element => element.classList.contains('native-mac'))).toBe(process.platform === 'darwin')
    await page.getByRole('button', { name: '创建第一个任务', exact: true }).click()
    await page.getByLabel('任务名称').fill('跨平台启动测试')
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    await expect(page.getByRole('button', { name: /跨平台启动测试/ })).toBeVisible()
    await page.keyboard.press('ControlOrMeta+n')
    await expect(page.getByLabel('任务名称')).toBeVisible()
    await page.keyboard.press('Escape')
    await page.keyboard.press('ControlOrMeta+,')
    await expect(page.getByRole('dialog', { name: '应用设置', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '外观', exact: true }).click()
    await page.getByRole('radio', { name: '110%', exact: true }).check()
    await page.keyboard.press('Escape')
    await app.close()
    app = await launch(); page = await app.firstWindow()
    await expect(page.getByRole('button', { name: /跨平台启动测试/ })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--text-scale'))).toBe('1.1')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(390, 650))
    await expect(page.getByRole('button', { name: '设置', exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.keyboard.press('ControlOrMeta+,')
    await expect(page.getByRole('dialog', { name: '应用设置', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.screenshot({ path: test.info().outputPath('platform-smoke.png') })
    // Last-window close follows the application's shutdown path as well as Quit.
    const appProcess = app.process()
    const utilityPids = await app.evaluate(({ app }) => app.getAppMetrics().filter(metric => metric.type === 'Utility').map(metric => metric.pid))
    expect(utilityPids.length).toBeGreaterThan(0)
    await page.close()
    await expect.poll(() => appProcess.exitCode).toBe(0)
    await expect.poll(() => utilityPids.filter(pid => { try { process.kill(pid, 0); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error } })).toEqual([])
  } finally { await app.close(); await rm(root, { recursive: true, force: true }) }
})
