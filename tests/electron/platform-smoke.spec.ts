import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
// @ts-expect-error Standalone package structure verifier.
import { verifyDesktop } from '../../scripts/verify-desktop.mjs'

const packaged = process.env.PLIUNA_PACKAGED_OUTPUT ? verifyDesktop(process.env.PLIUNA_PACKAGED_OUTPUT) : undefined
const executablePath: string = packaged?.executable ?? createRequire(import.meta.url)('electron')
const healthyMaintenance = { ok: true, data: { phase: 'idle', error: null, restore: { error: null }, gc: { enabled: true, error: null } } }
async function runtimeReady(page: Page): Promise<void> {
  // A visible renderer can precede native permission checks and runtime IPC.
  // Wait for a read-only acknowledgement before dispatching a business action.
  await expect.poll(() => page.evaluate(() => window.pliuna.request({ type: 'maintenance.status' })), {
    timeout: 15000, intervals: [100, 250, 500]
  }).toMatchObject(healthyMaintenance)
}
test('starts without calculation, creates a task and restores it on the native desktop', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pliuna-platform-smoke-'))
  // Windows treats an empty value as present, so omit the flag entirely for GUI
  // startup. App-node backends set it explicitly through their own launcher.
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'ELECTRON_RUN_AS_NODE'))
  const launch = () => electron.launch({ executablePath, args: packaged ? [] : ['.'], ...(packaged ? { cwd: root } : {}), env: {
    ...environment, ELECTRON_RENDERER_URL: packaged ? 'http://127.0.0.1:1/must-not-load' : '',
    PLIUNA_TEST_DATA: join(root, 'user data'), PLIUNA_ENABLE_MONTY: '0',
    ...(process.platform === 'win32' ? { PLIUNA_TEST_FILE_IDENTITIES: 'decimal-v2' } : {})
  } })
  let app = await launch()
  let page: Page | undefined
  try {
    page = await app.firstWindow()
    expect(page.url()).toMatch(/^file:/)
    await expect(page).toHaveTitle('Pliuna')
    expect(await app.evaluate(({ app }) => app.getName())).toBe('Pliuna')
    expect(await page.evaluate(() => window.pliuna.platform)).toBe(process.platform)
    expect(await page.locator('.app').evaluate(element => element.classList.contains('native-mac'))).toBe(process.platform === 'darwin')
    await runtimeReady(page)
    await page.getByRole('button', { name: '创建第一个任务', exact: true }).click()
    await page.getByLabel('任务名称').fill('跨平台启动测试')
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    await expect(page.getByRole('button', { name: /跨平台启动测试/ })).toBeVisible()
    await expect(page.getByRole('dialog', { name: '新建任务', exact: true })).toBeHidden()
    expect(await readFile(join(root, 'user data', 'restore-established'), 'utf8')).toBe(process.platform === 'win32' ? 'restore-v6\n' : 'restore-v5\n')
    expect(await readFile(join(root, 'user data', 'gc-established'), 'utf8')).toBe(process.platform === 'win32' ? 'gc-v2\n' : 'gc-v1\n')
    const maintenance = await page.evaluate(() => window.pliuna.request({ type: 'maintenance.status' }))
    await writeFile(test.info().outputPath('desktop-status.json'), JSON.stringify(maintenance, null, 2) + '\n')
    expect(maintenance).toMatchObject(healthyMaintenance)
    await expect(page.getByTitle(/^新建任务（/)).toBeEnabled()
    await page.keyboard.press('ControlOrMeta+n')
    await expect(page.getByLabel('任务名称')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: '新建任务', exact: true })).toBeHidden()
    await page.keyboard.press('ControlOrMeta+,')
    await expect(page.getByRole('dialog', { name: '应用设置', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '关于 Pliuna', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Pliuna', exact: true })).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('pliuna-about.png') })
    await page.getByRole('button', { name: '外观', exact: true }).click()
    await page.getByRole('radio', { name: '110%', exact: true }).check()
    await page.keyboard.press('Escape')
    await app.close()
    app = await launch(); page = await app.firstWindow()
    await runtimeReady(page)
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
  } catch (error) {
    if (page && !page.isClosed()) {
      await page.screenshot({ path: test.info().outputPath('platform-failure.png') }).catch(() => {})
      const diagnostics = await page.evaluate(async () => ({
        text: document.body.innerText.slice(0, 8000),
        maintenance: await Promise.race([window.pliuna.request({ type: 'maintenance.status' }), new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 1500))])
      })).catch(diagnosticError => ({ diagnostic_error: String(diagnosticError) }))
      const diagnosticPath = test.info().outputPath('desktop-failure.json')
      await writeFile(diagnosticPath, JSON.stringify(diagnostics, null, 2) + '\n')
        .then(() => test.info().attach('desktop-failure', { path: diagnosticPath, contentType: 'application/json' })).catch(() => {})
    }
    throw error
  } finally { await app.close(); await rm(root, { recursive: true, force: true }) }
})
