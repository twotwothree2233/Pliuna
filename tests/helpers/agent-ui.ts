import { expect, type Page } from '@playwright/test'

export async function pendingApprovals(page: Page) {
  const region = page.getByRole('region', { name: '待审批操作', exact: true })
  await expect(region).toBeVisible()
  return region
}

export async function openRequestQueue(page: Page) {
  const button = page.getByRole('button', { name: '请求队列', exact: true })
  if (await button.isVisible()) await button.click()
  else { await page.getByRole('button', { name: '更多 Agent 操作', exact: true }).click(); await page.getByRole('menuitem', { name: '请求队列', exact: true }).click() }
}
