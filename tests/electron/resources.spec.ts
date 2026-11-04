import { modelInputFromHost } from '../helpers/model-server'
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { modelServer, synthetic, textStream, frame } from '../helpers/model-server'
import type { ServerResponse } from 'node:http'
const electronPath: string = createRequire(import.meta.url)('electron')
function toolStream(res: ServerResponse, name: string, args: unknown, text = '', id = 'call') {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end(frame({ role: 'assistant', content: text, tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(modelInputFromHost(name, args)) } }] }) + frame({}, 'tool_calls') + 'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 2000, completion_tokens: 2000 } }) + '\n\ndata: [DONE]\n\n')
}

test('immutable resources: HTTP Agent, desktop continuation/reference/approval, restart and corruption', async () => {
  test.setTimeout(60000)
  const text = '<script>globalThis.RESOURCE_EXECUTED=true</script>\n' + '资料中文😀\\"\n'.repeat(1000) + '资源全文末尾'
  let textId = '', jsonId = '', dataId = ''
  const schema = { type: 'object', properties: { stage: { type: 'string' } }, required: ['stage'], additionalProperties: false }
  const reference = (id: string) => [{ name: '材料', target: { kind: 'resource', id } }]
  const server = await modelServer(({ body, url }, res) => {
    if (url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"resource-model"}]}'); return }
    if (synthetic(body, res)) return
    const request = JSON.parse(body.messages.findLast((m: any) => m.role === 'user').content).request
    const last = body.messages.at(-1), result = last.role === 'tool' ? JSON.parse(last.content) : null
    if (request === '创建资源与引用') {
      if (!result) toolStream(res, 'write', { type: 'resource.create', display_name: '长文本材料', content: { type: 'text', text } }, '', 'create-text')
      else if (last.tool_call_id === 'create-text') { textId = result.data.id; toolStream(res, 'write', { type: 'resource.create', display_name: 'JSON材料', content: { type: 'json', value: { title: '来源JSON', values: [1, true, null] } } }, '', 'create-json') }
      else if (last.tool_call_id === 'create-json') { jsonId = result.data.id; toolStream(res, 'write', { type: 'task_data.create', data: { schema, value: { stage: 'initial' }, references: reference(textId) } }, '', 'create-data') }
      else if (last.tool_call_id === 'create-data') { dataId = result.data.id; toolStream(res, 'list', { kind: 'resource' }, '', 'list-resources') }
      else if (last.tool_call_id === 'list-resources') { expect(result.data.items).toHaveLength(2); toolStream(res, 'read', { target: { kind: 'resource', id: jsonId } }, '', 'read-json') }
      else { expect(result.data.data.content.value).toEqual({ title: '来源JSON', values: [1, true, null] }); textStream(res, '资源与引用已保存并读回。') }
    } else if (!result) toolStream(res, 'write', { type: 'task_data.replace', id: dataId, expected_revision: 1, value: { stage: 'updated' }, references: reference(jsonId) }, '', 'replace-reference')
    else textStream(res, result.execution === 'success' ? '引用替换已提交。' : '引用替换未执行。')
  })
  const directory = await mkdtemp(join(tmpdir(), 'trellis-resource-desktop-'))
  const launch = () => electron.launch({ executablePath: electronPath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', TRELLIS_TEST_DATA: directory } })
  let app = await launch()
  const errors: string[] = []
  async function send(page: Page, request: string) {
    await page.getByLabel('想从哪里开始？').fill(request)
    await page.getByRole('button', { name: /发送 · 新 Run/ }).click()
  }
  async function fullText(page: Page) {
    const region = page.getByRole('region', { name: '全部资源分页浏览' })
    await region.getByRole('button', { name: '刷新全部资源', exact: true }).click()
    await region.getByRole('button', { name: /长文本材料/ }).click()
    const next = region.getByRole('button', { name: '继续读取全文', exact: true })
    await expect(next).toBeVisible()
    for (let i = 0; i < 30 && await next.count(); i++) {
      const length = (await region.locator('pre').textContent())!.length
      await next.click()
      await expect.poll(async () => (await region.locator('pre').textContent())!.length).toBeGreaterThan(length)
    }
    await expect(region.getByRole('article')).toContainText('全文读取完成')
    expect(JSON.parse((await region.locator('pre').textContent())!).content.text).toBe(text)
    expect(await page.evaluate(() => (globalThis as any).RESOURCE_EXECUTED)).toBeUndefined()
  }
  try {
    let page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message))
    await page.getByRole('button', { name: '模型与审批', exact: true }).click()
    await page.getByLabel('配置标识').fill('resource-main')
    await page.getByLabel('服务 Base URL').fill(server.url)
    await page.getByLabel('API Key', { exact: true }).fill('isolated-resource-key')
    await page.getByLabel('精确模型标识').fill('resource-model')
    await page.getByLabel('已知上下文容量').fill('1000000')
    await page.getByLabel('输出上限', { exact: true }).fill('4096')
    await page.getByRole('checkbox', { name: /我确认连接凭据/ }).check()
    await page.getByRole('checkbox', { name: /^记住连接/ }).uncheck()
    await page.getByRole('button', { name: '保存内存配置并查询' }).click()
    await expect(page.getByText(/查询到 1 个服务候选/)).toBeVisible()
    await page.getByRole('button', { name: '测试并启用主模型', exact: true }).click(); await page.getByRole('dialog', { name: '确认模型角色测试' }).getByRole('button', { name: '确认费用并开始测试', exact: true }).click()
    await expect(page.getByText(/main 合成验证通过/)).toBeVisible()
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByRole('button', { name: '创建第一个任务' }).click()
    await page.getByLabel('任务名称').fill('资源闭环验收')
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    await send(page, '创建资源与引用')
    await expect(page.getByText('资源与引用已保存并读回。', { exact: true })).toBeVisible()
    await page.getByRole('tab', { name: /资源/ }).click()
    await fullText(page)
    const resources = page.getByRole('region', { name: '全部资源分页浏览' })
    await resources.getByRole('button', { name: /JSON材料/ }).click()
    await expect(resources.locator('pre')).toContainText('来源JSON')
    expect(JSON.parse((await resources.locator('pre').textContent())!).content.value).toEqual({ title: '来源JSON', values: [1, true, null] })
    await page.getByRole('tab', { name: /任务数据/ }).click()
    const data = page.getByRole('region', { name: '全部任务数据分页浏览' })
    await data.getByRole('button', { name: '刷新全部任务数据', exact: true }).click()
    await data.getByRole('button', { name: new RegExp(dataId) }).click()
    await data.getByRole('button', { name: '查看引用资源：材料', exact: true }).click()
    await expect(data.getByRole('region', { name: '引用资源分页浏览' }).locator('pre')).toContainText('RESOURCE_EXECUTED')
    await data.getByRole('button', { name: '刷新全部任务数据', exact: true }).click()
    await expect(data.getByRole('region', { name: '引用资源分页浏览' })).toHaveCount(0)
    for (const decision of ['拒绝', '批准']) {
      await send(page, '替换引用' + decision)
      await expect(page.getByRole('button', { name: decision + '本次动作', exact: true })).toBeVisible()
      await expect(page.locator('.approval-card pre').first()).toContainText(jsonId)
      await page.getByRole('button', { name: decision + '本次动作', exact: true }).click()
      await expect(page.getByText(decision === '批准' ? '引用替换已提交。' : '引用替换未执行。', { exact: true })).toBeVisible()
      await data.getByRole('button', { name: '刷新全部任务数据', exact: true }).click()
      await data.getByRole('button', { name: new RegExp(dataId) }).click()
      await expect(data.locator('pre')).toContainText('"references"')
      expect(JSON.parse((await data.locator('pre').textContent())!).references[0].target.id).toBe(decision === '批准' ? jsonId : textId)
    }
    const requests = server.exchanges.length
    await app.close(); app = await launch(); page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message))
    await page.getByRole('button', { name: /资源闭环验收/ }).click()
    await page.getByRole('tab', { name: /资源/ }).click(); await fullText(page)
    await page.getByRole('tab', { name: /任务数据/ }).click()
    const restored = page.getByRole('region', { name: '全部任务数据分页浏览' })
    await restored.getByRole('button', { name: '刷新全部任务数据', exact: true }).click()
    await restored.getByRole('button', { name: new RegExp(dataId) }).click()
    await restored.getByRole('button', { name: '查看引用资源：材料', exact: true }).click()
    await expect(restored.getByRole('region', { name: '引用资源分页浏览' }).locator('pre')).toContainText('来源JSON')
    await writeFile(join(directory, 'resources', jsonId), 'corrupt')
    await restored.getByRole('region', { name: '引用资源分页浏览' }).getByRole('button', { name: '重新查询原记录', exact: true }).click()
    await expect(restored.getByRole('alert')).toContainText('RESOURCE_CORRUPT')
    await expect(restored.getByRole('region', { name: '引用资源分页浏览' }).locator('pre')).toHaveText('')
    expect(server.exchanges.length).toBe(requests)
    expect(errors).toEqual([])
  } finally { await app.close(); await server.close(); await rm(directory, { recursive: true, force: true }) }
})
