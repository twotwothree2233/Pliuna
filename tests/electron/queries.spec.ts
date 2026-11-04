import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const electronPath: string = createRequire(import.meta.url)('electron')

test('bounded desktop queries: pagination, Unicode continuation, original results and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'trellis-query-desktop-'))
  const launch = () => electron.launch({ executablePath: electronPath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', TRELLIS_TEST_DATA: directory } })
  let app = await launch()
  try {
    let page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: '尚无任务', exact: true })).toBeVisible()
    const taskId = await page.evaluate(async () => {
      const result = await window.trellis.request({ type: 'task.create', title: '分页续读验收' })
      if (!result.ok) throw Error(result.error.code)
      return (result.data as { task: { id: string } }).task.id
    })
    await app.evaluate(async (_electron, { directory, taskId }) => {
      const Database = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('better-sqlite3')
      const db = new Database(directory + '/trellis.sqlite')
      try { db.transaction(() => {
        const data = db.prepare('INSERT INTO task_data (id,task_id,revision,schema_json,value_json,references_json) VALUES (?,?,1,?,?,?)')
        const event = db.prepare('INSERT INTO records VALUES (?,?,?,?,?,?)')
        for (let i = 0; i < 201; i++) {
          data.run('data-' + String(i).padStart(3, '0'), taskId, '{"type":"string"}', JSON.stringify(i === 0 ? '中文😀'.repeat(16000) + '全文末尾标记' : '第' + i + '条数据'), '[]')
          event.run('message-' + String(i).padStart(3, '0'), taskId, i + 1, 'message.user', JSON.stringify({ text: '历史消息 ' + i }), '2026-01-01T00:00:00.000Z')
        }
        db.prepare('UPDATE tasks SET next_sequence=202,revision=revision+1 WHERE id=?').run(taskId)
        for (let i = 0; i < 51; i++) db.prepare("INSERT INTO tasks VALUES (?,?,'active',1,1)").run('other-task-' + i, '其他分页任务 ' + i)
        const action = db.prepare("INSERT INTO actions (id,task_id,kind,state,source_json,request_json,result,commit_valid,result_json,created_at) VALUES (?,?,'mutation','ended','{}','{}',?,0,?,?)")
        action.run('original-success', taskId, 'success', '{"message":"原操作成功标记"}', '2026-01-01T00:00:00Z')
        action.run('original-denied', taskId, 'not_executed', '{"code":"APPROVAL_DENIED"}', '2026-01-02T00:00:00Z')
        db.prepare("INSERT INTO approvals VALUES ('original-approval','original-denied','deny','revoked','manual','resolved','2026-01-03','{}','{}')").run()
      })() } finally { db.close() }
    }, { directory, taskId })
    await page.reload()
    await page.getByRole('button', { name: /分页续读验收/ }).click()
    await expect(page.getByRole('button', { name: '加载更多任务', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '加载更多任务', exact: true }).click()
    await expect(page.getByRole('button', { name: /其他分页任务 50/ })).toBeVisible()
    await page.getByLabel('筛选任务').fill('其他分页任务 50')
    await expect(page.locator('.task-row')).toHaveCount(1)
    await page.getByLabel('筛选任务').fill('')
    await expect(page.locator('.task-row')).toHaveCount(50)
    await page.getByRole('tab', { name: /任务数据/ }).click()
    const data = page.getByRole('region', { name: '全部任务数据分页浏览' })
    await data.getByRole('button', { name: '刷新全部任务数据', exact: true }).click()
    for (let i = 0; i < 4; i++) await data.getByRole('button', { name: '加载更多全部任务数据', exact: true }).click()
    await expect(data.getByRole('status')).toContainText('已加载到底 · 已遍历 201 条，当前显示 200 条')
    await data.getByRole('button', { name: /data-200/ }).click()
    await expect(data.getByRole('article')).toContainText('第200条数据')
    await data.getByRole('button', { name: '刷新全部任务数据', exact: true }).click()
    await data.getByRole('button', { name: /data-000/ }).click()
    const next = data.getByRole('button', { name: '继续读取全文', exact: true })
    await expect(next).toBeVisible()
    for (let i = 0; i < 20 && await next.count(); i++) {
      const length = (await data.locator('pre').textContent())!.length
      await next.click()
      await expect.poll(async () => (await data.locator('pre').textContent())!.length).toBeGreaterThan(length)
    }
    await expect(data.getByRole('article')).toContainText('全文读取完成')
    const text = await data.locator('pre').textContent()
    expect(JSON.parse(text!).value).toBe('中文😀'.repeat(16000) + '全文末尾标记')
    await page.getByRole('tab', { name: /执行记录/ }).click()
    const actions = page.getByRole('region', { name: '原动作分页浏览' })
    await actions.getByRole('button', { name: '刷新原动作', exact: true }).click()
    await actions.getByRole('button', { name: /original-success/ }).click()
    await expect(actions.locator('pre')).toContainText('原操作成功标记')
    await actions.getByRole('button', { name: /original-denied/ }).click()
    await expect(actions.locator('pre')).toContainText('APPROVAL_DENIED')
    await actions.getByRole('button', { name: '重新查询原记录', exact: true }).click()
    const approvals = page.getByRole('region', { name: '原审批分页浏览' })
    await approvals.getByRole('button', { name: '刷新原审批', exact: true }).click()
    await approvals.getByRole('button', { name: /original-approval/ }).click()
    await expect(approvals.locator('pre')).toContainText('"decision": "deny"')
    const messages = page.getByRole('region', { name: '全部消息分页浏览' })
    await messages.getByRole('button', { name: '刷新全部消息', exact: true }).click()
    for (let i = 0; i < 4; i++) await messages.getByRole('button', { name: '加载更多全部消息', exact: true }).click()
    await messages.getByRole('button', { name: '刷新全部消息', exact: true }).click()
    await messages.getByRole('button', { name: /message-000/ }).click()
    await expect(messages.locator('pre')).toContainText('历史消息 0')
    const counts = await page.evaluate(async taskId => {
      const result = await window.trellis.request({ type: 'task.query', task_id: taskId, query: { type: 'list', input: { kind: 'action' } } })
      if (!result.ok) throw Error(result.error.code)
      return (result.data as { items: unknown[] }).items.length
    }, taskId)
    expect(counts).toBe(2)
    await app.close(); app = await launch(); page = await app.firstWindow()
    await page.getByRole('button', { name: /分页续读验收/ }).click()
    await page.getByRole('tab', { name: /执行记录/ }).click()
    const restored = page.getByRole('region', { name: '原动作分页浏览' })
    await restored.getByRole('button', { name: '刷新原动作', exact: true }).click()
    await restored.getByRole('button', { name: /original-success/ }).click()
    await expect(restored.locator('pre')).toContainText('原操作成功标记')
    await expect(page.getByLabel('本次模型', { exact: true })).toHaveValue('')
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})
