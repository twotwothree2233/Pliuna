import { modelInputFromHost } from '../helpers/model-server'
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { modelServer, synthetic, textStream, frame } from '../helpers/model-server'
import type { ServerResponse } from 'node:http'
const electronPath: string = createRequire(import.meta.url)('electron')
const schema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }
const bundle = { profile: 'managed-v1', html: '<label for="a">证据作答</label><textarea id="a"></textarea><button id="s">提交依据答案</button>', css: '', state: { schema, initial: { text: '' }, compatibility_version: 'e1' }, forms: [{ id: 'f', fields: ['/text'] }], behaviors: [{ type: 'input', element_id: 'a', field: '/text', control: 'textarea' }, { type: 'submit', element_id: 's', form_id: 'f' }], references: [], export: [] }
function tool(res: ServerResponse, args: unknown, id: string) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end(frame({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name: 'write', arguments: JSON.stringify(modelInputFromHost('write', args)) } }] }) + frame({}, 'tool_calls') + 'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 1000 } }) + '\n\ndata: [DONE]\n\n')
}

test('immutable evidence: real desktop publication, answer, source removal, continuation and restart', async () => {
  test.setTimeout(90000)
  const original = '<script>globalThis.EVIDENCE_EXECUTED=true</script>' + '原始中文😀\\\"\n'.repeat(2000) + '冻结全文末尾'
  let dataId = '', resourceId = '', taskId = '', surfaceId = ''
  const failures: string[] = []
  const server = await modelServer(({ body, url }, res) => {
    if (url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"evidence-model"}]}'); return }
    if (synthetic(body, res)) return
    const request = JSON.parse(body.messages.findLast((m: any) => m.role === 'user').content).request
    const last = body.messages.at(-1), result = last.role === 'tool' ? JSON.parse(last.content) : null
    if (result && result.execution !== 'success') failures.push(last.tool_call_id + ':' + JSON.stringify(result.error))
    if (request === '发布冻结依据') {
      if (!result) tool(res, { type: 'resource.create', display_name: '原始参考材料', content: { type: 'text', text: '原材料正文' } }, 'resource')
      else if (last.tool_call_id === 'resource') { resourceId = result.data.id; tool(res, { type: 'task_data.create', data: { schema, value: { text: original }, references: [{ name: '资料', target: { kind: 'resource', id: resourceId } }] } }, 'data') }
      else if (last.tool_call_id === 'data') { dataId = result.data.id; tool(res, { type: 'surface.update', surface_id: surfaceId, expected_revision: 1, snapshot_sources: [{ kind: 'task_data', id: dataId, expected_revision: 1 }], operations: [{ type: 'view.create', client_ref: 'evidence', slot_id: 'main', bundle: { type: 'inline', bundle } }] }, 'publish') }
      else textStream(res, '冻结发布完成')
    } else if (request === '更新源') {
      if (!result) tool(res, { type: 'task_data.replace', id: dataId, expected_revision: 1, value: { text: '当前新版，不得替代旧依据' }, references: [] }, 'update')
      else textStream(res, '源更新完成')
    } else {
      if (!result) tool(res, { type: 'task_data.remove', id: dataId, expected_revision: 2 }, 'remove')
      else textStream(res, '源移除完成')
    }
  })
  const directory = await mkdtemp(join(tmpdir(), 'trellis-evidence-desktop-'))
  const launch = () => electron.launch({ executablePath: electronPath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', TRELLIS_TEST_DATA: directory } })
  let app = await launch()
  const errors: string[] = []
  async function send(page: Page, text: string) {
    await page.getByLabel('想从哪里开始？').fill(text); await page.getByRole('button', { name: /发送 · 新 Run/ }).click()
  }
  async function full(region: ReturnType<Page['getByRole']>) {
    await expect(region.locator('pre').first()).not.toHaveText('')
    const next = region.getByRole('button', { name: '继续读取全文', exact: true })
    for (let n = 0; n < 40 && await next.count(); n++) {
      const length = (await region.locator('pre').first().textContent())!.length
      await next.click(); await expect.poll(async () => (await region.locator('pre').first().textContent())!.length).toBeGreaterThan(length)
    }
    await expect(region.getByText('全文读取完成', { exact: true }).first()).toBeVisible()
    return JSON.parse((await region.locator('pre').first().textContent())!)
  }
  try {
    let page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await page.getByRole('button', { name: '模型与审批', exact: true }).click()
    await page.getByLabel('配置标识').fill('evidence-main'); await page.getByLabel('服务 Base URL').fill(server.url)
    await page.getByLabel('API Key', { exact: true }).fill('isolated-key'); await page.getByLabel('精确模型标识').fill('evidence-model')
    await page.getByLabel('已知上下文容量').fill('1000000'); await page.getByLabel('输出上限', { exact: true }).fill('4096')
    await page.getByRole('checkbox', { name: /^记住连接/ }).uncheck()
    await page.getByRole('checkbox', { name: /我确认连接凭据/ }).check(); await page.getByRole('button', { name: '保存内存配置并查询' }).click()
    await expect(page.getByText(/查询到 1 个服务候选/)).toBeVisible(); await page.getByRole('button', { name: '测试并启用主模型', exact: true }).click(); await page.getByRole('dialog', { name: '确认模型角色测试' }).getByRole('button', { name: '确认费用并开始测试', exact: true }).click(); await expect(page.getByText(/main 合成验证通过/)).toBeVisible()
    await page.getByRole('button', { name: '关闭', exact: true }).click(); await page.getByRole('button', { name: '创建第一个任务' }).click()
    await page.getByLabel('任务名称').fill('不可变证据验收'); await page.getByRole('button', { name: '创建任务', exact: true }).click()
    const snapshot: any = await page.evaluate(async () => {
      const tasks: any = await window.trellis.request({ type: 'host.tasks' })
      const snapshot: any = await window.trellis.request({ type: 'task.snapshot', task_id: tasks.data[0].id }); return snapshot.data
    })
    taskId = snapshot.task.id; surfaceId = snapshot.surface.id
    await send(page, '发布冻结依据'); await expect(page.getByText('冻结发布完成', { exact: true })).toBeVisible()
    await page.getByLabel('证据作答').fill('原版作答'); await expect(page.locator('.managed').getByRole('status')).toHaveText('已保存')
    await page.getByRole('button', { name: '提交依据答案', exact: true }).click(); await expect(page.locator('.managed').getByRole('status')).toContainText('提交成功')
    for (const request of ['更新源', '移除源']) {
      await send(page, request); await page.getByRole('button', { name: '批准本次动作', exact: true }).click()
      await expect(page.getByText(request === '更新源' ? '源更新完成' : '源移除完成', { exact: true })).toBeVisible()
    }
    await page.getByRole('tab', { name: /执行记录/ }).click()
    const history = page.getByRole('region', { name: '界面历史依据分页浏览' })
    await history.getByRole('button', { name: '刷新界面历史依据', exact: true }).click(); await history.locator('.object-list button').first().click()
    const saved = await full(history); expect(saved.evidence.sources[0].value.text).toBe(original)
    await history.getByRole('button', { name: /查看引用资源/ }).click()
    await expect(history.getByRole('region', { name: '引用资源分页浏览' }).locator('pre')).toContainText('原材料正文')
    expect(await page.evaluate(() => (globalThis as any).EVIDENCE_EXECUTED)).toBeUndefined()
    const requests = server.exchanges.length
    await app.close(); app = await launch(); page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await page.getByRole('button', { name: /不可变证据验收/ }).click(); await page.getByRole('tab', { name: /作答/ }).click()
    const answers = page.getByRole('region', { name: '全部作答分页浏览' })
    await answers.getByRole('button', { name: '刷新全部作答', exact: true }).click(); await answers.locator('.object-list button').first().click()
    const answer = await full(answers); expect(answer.value).toEqual({ text: '原版作答' }); expect(answer.view_history.id).toBe(saved.id)
    expect(answer.view_history.evidence.sources[0].value.text).toBe(original)
    const data: any = await page.evaluate(async task_id => window.trellis.request({ type: 'task.query', task_id, query: { type: 'list', input: { kind: 'task_data' } } }), taskId)
    expect(data.data.items).toEqual([])
    await writeFile(join(directory, 'resources', resourceId), 'damaged')
    await answers.getByRole('button', { name: '重新查询原记录', exact: true }).click(); await expect(answers.locator('pre').first()).not.toHaveText('')
    const damaged = await full(answers)
    expect(damaged.view_history.evidence.sources[0].value.text).toBe(original)
    expect(damaged.view_history.resource_status).toContainEqual({ id: resourceId, integrity: 'unavailable', reason: 'RESOURCE_CORRUPT' })
    expect(server.exchanges.length).toBe(requests); expect(failures).toEqual([]); expect(errors).toEqual([])
  } finally { await app.close(); await server.close(); await rm(directory, { recursive: true, force: true }) }
})
