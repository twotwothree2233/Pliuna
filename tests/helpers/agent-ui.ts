import { expect, type Page } from '@playwright/test'

export async function openPending(page: Page) {
  const dialog = page.getByRole('dialog', { name: '待处理事项', exact: true })
  if (!await dialog.isVisible()) await page.getByRole('button', { name: '查看并处理 →', exact: true }).click()
  await expect(dialog).toBeVisible()
  return dialog
}

export async function openRequestQueue(page: Page) {
  const button = page.getByRole('button', { name: '请求队列', exact: true })
  if (await button.isVisible()) await button.click()
  else { await page.getByRole('button', { name: '更多 Agent 操作', exact: true }).click(); await page.getByRole('menuitem', { name: '请求队列', exact: true }).click() }
}
