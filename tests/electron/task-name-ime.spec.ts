import { _electron as electron, expect, test } from '@playwright/test'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const executablePath: string = createRequire(import.meta.url)('electron')

for (const key of ['Enter', 'Escape'] as const) test(`task name keeps Chinese composition active when pressing ${key}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pliuna-task-ime-'))
  const app = await electron.launch({ executablePath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', PLIUNA_TEST_DATA: directory } })
  try {
    const page = await app.firstWindow()
    await page.getByRole('button', { name: '创建第一个任务' }).click()
    const dialog = page.getByRole('dialog', { name: '新建任务', exact: true })
    const input = dialog.getByLabel('任务名称')
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 })
    await expect(input).toHaveValue('中文')
    await page.keyboard.press(key)
    // The query is ordered after the key-triggered IPC, detecting accidental creation.
    const tasks = await page.evaluate(async () => {
      const reply = await window.pliuna.request({ type: 'host.tasks' })
      if (!reply.ok) throw new Error(reply.error.code)
      return reply.data as { title: string }[]
    })
    expect(tasks).toEqual([])
    await expect(dialog).toBeVisible()
    await expect(input).toBeFocused()
    await expect(input).toHaveValue('中文')
    // Commit a candidate through Chromium's IME input path, then explicitly create.
    await cdp.send('Input.insertText', { text: '中文任务' })
    await expect(input).toHaveValue('中文任务')
    // Some IMEs end composition before their confirming Enter, reporting only 229.
    expect(await input.evaluate(element => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true })
      element.dispatchEvent(event)
      return event.defaultPrevented
    })).toBe(true)
    await expect(dialog).toBeVisible()
    await input.press('Enter')
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('heading', { name: '中文任务', exact: true })).toBeVisible()
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})
