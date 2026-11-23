import type { Page } from '@playwright/test'

export async function openTaskRecords(page: Page, category: '任务数据' | '作答记录' | '执行记录') {
  const main = page.getByRole('main')
  await main.getByRole('tab', { name: '记录', exact: true }).click()
  await main.getByRole('navigation', { name: '记录分类' }).getByRole('button', { name: category, exact: true }).click()
}
