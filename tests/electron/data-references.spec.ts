import { closeSettings, configureModel, openSettings, testRole } from '../helpers/settings-ui'
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { modelServer, synthetic, textStream, hostToolStream } from '../helpers/model-server'
const electronPath: string = createRequire(import.meta.url)('electron')

test('versioned data references: stale navigation, blocked removal, unlink/deny/approve and restart', async () => {
  test.setTimeout(60000)
  let target = '', source = '', removalAction = '', blockedCode = ''
  const schema = { type: 'string' }
  const server = await modelServer(({ body, url }, res) => {
    if (url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"references-model"}]}'); return }
    if (synthetic(body, res)) return
    const request = JSON.parse(body.messages.findLast((m: any) => m.role === 'user').content).request
    const last = body.messages.at(-1), result = last.role === 'tool' ? JSON.parse(last.content) : null
    if (request === '创建版本引用') {
      if (!result) hostToolStream(res, 'write', { type: 'task_data.create', data: { schema, value: '目标初始值', references: [] } }, '', 'target')
      else if (last.tool_call_id === 'target') { target = result.data.id; hostToolStream(res, 'write', { type: 'task_data.create', data: { schema, value: '引用方', references: [{ name: '依据', target: { kind: 'task_data', id: target, expected_revision: 1 } }] } }, '', 'source') }
      else { source = result.data.id; textStream(res, '版本引用已保存') }
    } else if (result) {
      if (request === '尝试受保护移除') blockedCode = result.error?.code
      if (request === '批准移除' && result.execution === 'success') removalAction = result.operation_id
      textStream(res, request + '结果：' + (result.error?.code ?? result.execution))
    } else if (request === '更新目标') hostToolStream(res, 'write', { type: 'task_data.replace', id: target, expected_revision: 1, value: '目标新值', references: [] })
    else if (request === '解除引用') hostToolStream(res, 'write', { type: 'task_data.replace', id: source, expected_revision: 1, value: '已解除', references: [] })
    else hostToolStream(res, 'write', { type: 'task_data.remove', id: target, expected_revision: 2 })
  })
  const directory = await mkdtemp(join(tmpdir(), 'trellis-reference-desktop-'))
  const launch = () => electron.launch({ executablePath: electronPath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', TRELLIS_TEST_DATA: directory } })
  let app = await launch()
  try {
    let page = await app.firstWindow(); const errors: string[] = []; page.on('pageerror', e => errors.push(e.message))
    await configureModel(page, { id: 'references-main', url: server.url, key: 'isolated-reference-sentinel', model: 'references-model', context: 1000000, output: 1024 })
    await openSettings(page)
    await testRole(page, '主模型')
    await closeSettings(page)
    await page.getByRole('button', { name: '创建第一个任务' }).click()
    await page.getByLabel('任务名称').fill('版本引用与安全移除')
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    async function send(text: string, decision?: '批准' | '拒绝') {
      await page.getByLabel('想从哪里开始？').fill(text)
      await page.getByRole('button', { name: /发送 · 新 Run/ }).click()
      if (decision) {
        await expect(page.getByRole('button', { name: decision + '本次动作', exact: true })).toBeVisible()
        await expect(page.locator('.approval-card pre').first()).toContainText(text === '解除引用' ? source : target)
        if (text === '拒绝移除' || text === '批准移除') await expect(page.locator('.approval-card').first()).toContainText('不能撤销')
        await page.getByRole('button', { name: decision + '本次动作', exact: true }).click()
      }
      await expect(page.getByText(text === '创建版本引用' ? '版本引用已保存' : new RegExp('^' + text + '结果：'), { exact: true })).toBeVisible()
    }
    await send('创建版本引用')
    await page.getByRole('tab', { name: /任务数据/ }).click()
    const data = page.getByRole('region', { name: '全部任务数据分页浏览' })
    const openSource = async () => { await data.getByRole('button', { name: '刷新全部任务数据', exact: true }).click(); await data.getByRole('button', { name: new RegExp(source) }).click(); await data.getByRole('button', { name: '查看引用数据：依据 · 绑定 r1', exact: true }).click() }
    await openSource()
    let linked = data.getByRole('region', { name: '引用数据分页浏览' })
    await expect(linked.locator('pre')).toContainText('目标初始值')
    await expect(linked).toContainText('引用绑定版本 r1')
    await send('更新目标', '批准')
    await linked.getByRole('button', { name: '重新查询原记录', exact: true }).click()
    await expect(linked.getByRole('alert')).toContainText('READ_VERSION_CHANGED')
    await expect(linked.getByRole('alert')).toContainText('current revision 2')
    await expect(linked.locator('pre')).toHaveText('')
    await linked.getByRole('button', { name: '查看当前版本（不更新引用）', exact: true }).click()
    await expect(linked.locator('pre')).toContainText('目标新值')
    expect(JSON.parse((await data.locator(':scope > .record-rows > article > .record-raw > pre').textContent())!).references[0].target.expected_revision).toBe(1)
    await send('尝试受保护移除')
    expect(blockedCode).toBe('OBJECT_REFERENCED')
    await expect(page.getByRole('button', { name: '批准本次动作', exact: true })).toHaveCount(0)
    await send('解除引用', '批准')
    await send('拒绝移除', '拒绝')
    await data.getByRole('button', { name: '刷新全部任务数据', exact: true }).click()
    await data.getByRole('button', { name: new RegExp(target) }).click()
    await expect(data.locator('pre')).toContainText('目标新值')
    await send('批准移除', '批准')
    await data.getByRole('button', { name: '刷新全部任务数据', exact: true }).click()
    await expect(data.getByRole('button', { name: new RegExp(target) })).toHaveCount(0)
    await expect(data.getByRole('status')).toContainText('已加载到底 · 已遍历 1 条，当前显示 1 条')
    const requests = server.exchanges.length
    await app.close(); app = await launch(); page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message))
    await page.getByRole('button', { name: /版本引用与安全移除/ }).click()
    await page.getByRole('tab', { name: /执行记录/ }).click()
    await page.locator('.execution-category > summary').filter({ hasText: /^原动作$/ }).click()
    const actions = page.getByRole('region', { name: '原动作分页浏览' })
    await actions.getByRole('button', { name: '刷新原动作', exact: true }).click()
    await actions.getByRole('button', { name: new RegExp(removalAction) }).click()
    await expect(actions.locator('pre')).toContainText('"removed": true')
    await actions.getByRole('button', { name: '重新查询原记录', exact: true }).click()
    await expect(actions.locator('pre')).toContainText('"removed_revision": 2')
    await page.getByRole('tab', { name: /任务数据/ }).click()
    const restored = page.getByRole('region', { name: '全部任务数据分页浏览' })
    await restored.getByRole('button', { name: '刷新全部任务数据', exact: true }).click()
    await expect(restored.getByRole('button', { name: new RegExp(target) })).toHaveCount(0)
    expect(server.exchanges.length).toBe(requests); expect(errors).toEqual([])
  } finally { await app.close(); await server.close(); await rm(directory, { recursive: true, force: true }) }
})
