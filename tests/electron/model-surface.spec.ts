import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { modelServer, synthetic, textStream, hostToolStream } from '../helpers/model-server'
const electronPath: string = createRequire(import.meta.url)('electron')

test('HTTP model publishes an interactive View, user submits, next Run reads immutable answer', async () => {
  const server = await modelServer(({ body, url }, res) => {
    if (url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"wire-model"}]}'); return }
    if (synthetic(body, res)) return
    const current = JSON.parse(body.messages.findLast((m: any) => m.role === 'user').content)
    const last = body.messages.at(-1)
    if (current.request === '创建一道事务练习') {
      if (last.role !== 'tool') { hostToolStream(res, 'list', { kind: 'surface' }, '', 'discover-surface'); return }
      if (last.tool_call_id !== 'discover-surface') { textStream(res, '本机合成服务已发布练习表单。'); return }
      const surface = JSON.parse(last.content).data.items[0]
      hostToolStream(res, 'write', { type: 'surface.update', surface_id: surface.id, expected_revision: surface.revision, operations: [{ type: 'view.create', client_ref: 'exercise', slot_id: 'main', bundle: { type: 'inline', bundle: {
        profile: 'managed-v1', html: '<section><h2>事务练习</h2><p>提交答案前可以修改草稿。</p><label for="response">什么是原子性？</label><textarea id="response" rows="4"></textarea><button id="submit" type="button">提交练习</button></section>',
        css: 'section { display: grid; gap: 12px; } textarea { width: 100%; }',
        state: { schema: { type: 'object', properties: { response: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['response'], additionalProperties: false }, initial: { response: '' }, compatibility_version: 'http-exercise-v1' },
        forms: [{ id: 'exercise', fields: ['/response'] }], behaviors: [{ type: 'input', element_id: 'response', field: '/response', control: 'textarea' }, { type: 'submit', element_id: 'submit', form_id: 'exercise' }], references: [], export: []
      } } }] })
      return
    }
    if (last.role !== 'tool') { hostToolStream(res, 'list', { kind: 'answer' }, '', 'list-answers'); return }
    const result = JSON.parse(last.content)
    if (last.tool_call_id === 'list-answers') { hostToolStream(res, 'read', { target: { kind: 'answer', id: result.data.items[0].id } }, '', 'read-answer'); return }
    textStream(res, `本机合成服务读取正式答案：${result.data.data.value.response}`)
  })
  const directory = await mkdtemp(join(tmpdir(), 'trellis-model-surface-'))
  const app = await electron.launch({ executablePath: electronPath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', TRELLIS_TEST_DATA: directory } })
  try {
    const page = await app.firstWindow(), errors: string[] = []
    page.on('pageerror', e => errors.push(e.message))
    await page.getByRole('button', { name: '模型与审批', exact: true }).click()
    await page.getByLabel('配置标识').fill('surface-main')
    await page.getByLabel('服务 Base URL').fill(server.url)
    await page.getByLabel('API Key', { exact: true }).fill('local-surface-sentinel')
    await page.getByLabel('精确模型标识').fill('wire-model')
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
    await page.getByLabel('任务名称').fill('HTTP 表单闭环')
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    await expect(page.getByLabel('本次模型', { exact: true })).toHaveValue('surface-main')
    await expect(page.locator('.agent-note')).toContainText(server.url)
    await expect(page.locator('.agent-note')).toContainText('必要历史和按需读取的内容')
    await page.getByLabel('想从哪里开始？').fill('创建一道事务练习')
    await page.getByRole('button', { name: /发送 · 新 Run/ }).click()
    await expect(page.getByRole('heading', { name: '事务练习', exact: true })).toBeVisible()
    await expect(page.getByText('本机合成服务已发布练习表单。', { exact: true })).toBeVisible()
    await page.getByLabel('什么是原子性？', { exact: true }).fill('事务全部成功或全部回滚。')
    await expect(page.getByRole('status').filter({ hasText: /^已保存$/ })).toBeVisible()
    await page.getByRole('button', { name: '提交练习', exact: true }).click()
    await page.getByRole('tab', { name: /作答记录/ }).click()
    await page.getByText('第 1 次提交').click()
    await expect(page.locator('.history pre')).toContainText('事务全部成功或全部回滚。')
    await page.getByLabel('想从哪里开始？').fill('读取正式答案')
    await page.getByRole('button', { name: /发送 · 新 Run/ }).click()
    await expect(page.getByText('本机合成服务读取正式答案：事务全部成功或全部回滚。', { exact: true })).toBeVisible()
    await expect(page.getByLabel('最近 Run 结果')).toContainText('completed')
    await page.getByRole('tab', { name: /执行记录/ }).click()
    await expect(page.getByLabel('执行记录查看器')).toContainText('success')
    await page.screenshot({ path: join(tmpdir(), 'trellis-http-execution.png') })
    expect(errors).toEqual([])
    expect(server.exchanges.filter(e => !e.body?.messages?.[0]?.content.startsWith('Synthetic') && e.body)).toHaveLength(6)
  } finally { await app.close(); await server.close(); await rm(directory, { recursive: true, force: true }) }
})
