import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import type { HostRequest } from '../../src/shared/types'

const executablePath: string = createRequire(import.meta.url)('electron')

test('archiving the open task closes its workspace and preserves its draft and pin order', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pliuna-task-organization-'))
  const launch = () => electron.launch({ executablePath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', PLIUNA_TEST_DATA: directory } })
  let app = await launch()
  try {
    let page = await app.firstWindow()
    const call = (request: HostRequest) => page.evaluate(async request => {
      const answer = await window.pliuna.request(request)
      if (!answer.ok) throw Error(answer.error.code)
      return answer.data
    }, request)
    await call({ type: 'task.create', title: '原始任务' })
    await call({ type: 'task.create', title: '随后任务' })
    await page.reload()
    const group = () => page.getByRole('button', { name: '已归档', exact: true })
    const titles = () => page.locator('.task-list .task-name')
    const actions = (name: string) => page.getByRole('group', { name: `任务操作：${name}`, exact: true })
    const original = () => page.locator('.task-row').filter({ hasText: '原始任务' })
    await original().click()
    await actions('原始任务').getByRole('button', { name: '置顶', exact: true }).press('Enter')
    await expect(actions('原始任务').getByRole('button', { name: '取消置顶', exact: true })).toBeFocused()
    await actions('随后任务').getByRole('button', { name: '置顶', exact: true }).press('Enter')
    await expect(titles()).toHaveText(['随后任务', '原始任务'])

    const draft = page.getByLabel('想从哪里开始？')
    await draft.fill('未发送的草稿')
    const token = (await call({ type: 'maintenance.begin' }) as { reservation: { token: string } }).reservation.token
    const archive = actions('原始任务').getByRole('button', { name: '归档', exact: true })
    await archive.press('Enter')
    await expect(page.getByRole('alert')).toContainText('任务整理状态未能更新')
    await expect(original()).toBeVisible()
    await expect(draft).toHaveValue('未发送的草稿')
    await call({ type: 'maintenance.cancel', token })
    await page.getByRole('button', { name: '重新查询任务' }).click()
    await archive.press('Enter')
    await expect(original()).toHaveCount(0)
    await expect(page.getByRole('button', { name: '全部', exact: true })).toBeFocused()
    await expect(page.getByRole('heading', { name: '选择任务', exact: true })).toBeVisible()
    await expect(draft).toHaveCount(0)

    await group().press('Enter')
    await original().click()
    await expect(draft).toHaveValue('未发送的草稿')

    await app.close(); app = await launch(); page = await app.firstWindow()
    await expect(titles()).toHaveText(['随后任务'])
    await group().press('Enter')
    await expect(titles()).toHaveText(['原始任务'])
    await actions('原始任务').getByRole('button', { name: '从归档恢复', exact: true }).press('Enter')
    await expect(titles()).toHaveCount(0)
    await expect(group()).toBeFocused()
    await page.getByRole('button', { name: '全部', exact: true }).press('Enter')
    await expect(titles()).toHaveText(['随后任务', '原始任务'])
    await expect(actions('原始任务').getByRole('button', { name: '取消置顶', exact: true })).toHaveAttribute('aria-pressed', 'true')
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('archive settings searches and restores saved tasks without changing the workspace filter or draft', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pliuna-archive-settings-'))
  const launch = () => electron.launch({ executablePath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', PLIUNA_TEST_DATA: directory } })
  let app = await launch()
  try {
    let page = await app.firstWindow()
    const call = (request: HostRequest) => page.evaluate(async request => {
      const answer = await window.pliuna.request(request)
      if (!answer.ok) throw Error(answer.error.code)
      return answer.data
    }, request)
    await call({ type: 'task.create', title: '要归档的任务' })
    await call({ type: 'task.create', title: '当前任务' })
    await call({ type: 'task.create', title: '另一项归档任务' })
    await page.reload()
    const actions = (title: string) => page.getByRole('group', { name: `任务操作：${title}`, exact: true })
    const titles = () => page.locator('.task-list .task-name')
    await actions('当前任务').getByRole('button', { name: '置顶', exact: true }).click()
    await actions('要归档的任务').getByRole('button', { name: '置顶', exact: true }).click()
    await actions('另一项归档任务').getByRole('button', { name: '归档', exact: true }).click()
    await actions('要归档的任务').getByRole('button', { name: '归档', exact: true }).click()
    await expect(titles()).toHaveText(['当前任务'])

    await app.close(); app = await launch(); page = await app.firstWindow()
    await page.locator('.task-row').filter({ hasText: '当前任务' }).click()
    const draft = page.getByLabel('想从哪里开始？')
    await draft.fill('未发送的草稿')
    const taskSearch = page.getByRole('searchbox', { name: '筛选任务' })
    await taskSearch.fill('当前')
    await page.keyboard.press('ControlOrMeta+,')
    const settings = page.getByRole('dialog', { name: '应用设置' })
    await settings.getByRole('button', { name: '归档', exact: true }).click()
    const rows = settings.getByRole('list', { name: '归档任务' }).getByRole('listitem')
    await expect(rows.locator('strong')).toHaveText(['要归档的任务', '另一项归档任务'])
    await expect(rows.locator('time')).toHaveCount(2)
    await page.screenshot({ path: test.info().outputPath('settings-archive.png') })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(390, 800))
    expect(await settings.locator('.settings-content').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1200, 800))

    const search = settings.getByRole('searchbox', { name: '搜索归档任务' })
    await search.fill('找不到'); await expect(settings.getByText('未找到匹配的任务')).toBeVisible()
    await settings.getByRole('button', { name: '清除搜索' }).click()
    await expect(rows).toHaveCount(2)
    await search.fill('要归档'); await expect(rows).toHaveCount(1)
    const restore = settings.getByRole('button', { name: '恢复任务：要归档的任务' })
    const token = (await call({ type: 'maintenance.begin' }) as { reservation: { token: string } }).reservation.token
    await restore.press('Enter')
    await expect(settings.getByRole('alert')).toContainText('未能恢复「要归档的任务」')
    await expect(restore).toBeFocused()
    await call({ type: 'maintenance.cancel', token })
    await restore.press('Enter')
    await expect(settings.getByRole('status')).toHaveText('已恢复「要归档的任务」。')
    await expect(search).toBeFocused()
    await settings.getByRole('button', { name: '清除搜索' }).click()
    await settings.getByRole('button', { name: '恢复任务：另一项归档任务' }).press('Enter')
    await expect(settings.getByText('暂无已归档任务')).toBeVisible()
    await expect(settings.getByRole('heading', { name: '已归档任务' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(settings).toHaveCount(0)
    await expect(draft).toHaveValue('未发送的草稿')
    await expect(taskSearch).toHaveValue('当前')
    await taskSearch.fill('')
    await expect(titles()).toHaveText(['要归档的任务', '当前任务', '另一项归档任务'])
    await expect(actions('要归档的任务').getByRole('button', { name: '取消置顶', exact: true })).toBeVisible()
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})
