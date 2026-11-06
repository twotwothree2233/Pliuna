import { closeSettings, configureModel, openSettings, testRole } from '../helpers/settings-ui'
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
    await configureModel(page, { id: 'surface-main', url: server.url, key: 'local-surface-sentinel', model: 'wire-model', context: 1000000, output: 4096 })
    await openSettings(page)
    await testRole(page, '主模型')
    await closeSettings(page)
    await page.getByRole('button', { name: '创建第一个任务' }).click()
    await page.getByLabel('任务名称').fill('HTTP 表单闭环')
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    await expect(page.locator('.agent-note')).toHaveCount(0)
    await expect(page.locator('.agent-note')).toHaveCount(0)
    await page.getByLabel('想从哪里开始？').fill('创建一道事务练习')
    await page.getByRole('button', { name: /发送 · 新 Run/ }).click()
    await expect(page.getByRole('heading', { name: '事务练习', exact: true })).toBeVisible()
    await expect(page.getByText('本机合成服务已发布练习表单。', { exact: true })).toBeVisible()
    await page.getByLabel('什么是原子性？', { exact: true }).fill('事务全部成功或全部回滚。')
    await expect(page.getByRole('status').filter({ hasText: /^已保存$/ })).toBeVisible()
    await page.getByRole('button', { name: '提交练习', exact: true }).click()
    await page.getByRole('tab', { name: /作答记录/ }).click()
    await page.getByText('第 1 次提交').click()
    await expect(page.locator('.history .record-values')).toContainText('事务全部成功或全部回滚。')
    await page.getByLabel('想从哪里开始？').fill('读取正式答案')
    await page.getByRole('button', { name: /发送 · 新 Run/ }).click()
    await page.getByRole('tab', { name: /^内容/ }).click()
    await expect(page.getByText('本机合成服务读取正式答案：事务全部成功或全部回滚。', { exact: true })).toBeVisible()
    await expect(page.locator('.agent-status')).toContainText('已完成')
    await page.getByRole('tab', { name: /执行记录/ }).click()
    await page.locator('.execution-category > summary').filter({ hasText: /^原动作$/ }).click()
    await expect(page.getByRole('region', { name: '原动作分页浏览', exact: true })).toContainText('success')
    await page.screenshot({ path: join(tmpdir(), 'trellis-http-execution.png') })
    expect(errors).toEqual([])
    expect(server.exchanges.filter(e => !e.body?.messages?.[0]?.content.startsWith('Synthetic') && e.body)).toHaveLength(6)
  } finally { await app.close(); await server.close(); await rm(directory, { recursive: true, force: true }) }
})
