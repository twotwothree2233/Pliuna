import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const executablePath: string = createRequire(import.meta.url)('electron')
test('starts without calculation, creates a task and restores it on the native desktop', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trellis-platform-smoke-'))
  const launch = () => electron.launch({ executablePath, args: ['.'], env: {
    ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '',
    TRELLIS_TEST_DATA: root, TRELLIS_ENABLE_MONTY: '0'
  } })
  let app = await launch()
  try {
    let page = await app.firstWindow()
    await page.getByRole('button', { name: '创建第一个任务', exact: true }).click()
    await page.getByLabel('任务名称').fill('跨平台启动测试')
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    await expect(page.getByRole('button', { name: /跨平台启动测试/ })).toBeVisible()
    await page.keyboard.press('ControlOrMeta+,')
    await expect(page.getByRole('dialog', { name: '应用设置', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await app.close()
    app = await launch(); page = await app.firstWindow()
    await expect(page.getByRole('button', { name: /跨平台启动测试/ })).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('platform-smoke.png') })
  } finally { await app.close(); await rm(root, { recursive: true, force: true }) }
})
