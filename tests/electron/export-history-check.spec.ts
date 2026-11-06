import { openPending } from '../helpers/agent-ui'
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { modelServer, synthetic, hostToolStream, textStream } from '../helpers/model-server'
import type { Bundle } from '../../src/shared/contracts.generated'
const executablePath: string = createRequire(import.meta.url)('electron')
const question = (complete: boolean): Bundle => ({ profile: 'managed-v1', html: '<section id="question"><p>Frozen question</p>' + (complete ? '' : '</section>') + '<label for="response">Answer quantity</label><input id="response" type="text"><button id="send">Submit quantity</button>' + (complete ? '</section>' : ''), css: '', state: { schema: { type: 'object', properties: { response: { type: 'number' } }, required: ['response'], additionalProperties: false }, initial: { response: '12.5' }, compatibility_version: 'numeric-v1' }, forms: [{ id: 'form', fields: ['/response'] }], behaviors: [{ type: 'input', element_id: 'response', field: '/response', control: 'number' }, { type: 'submit', element_id: 'send', form_id: 'form' }], references: [], export: [{ id: 'question', category: 'learning', source: { type: 'element', element_id: 'question' } }] })

test('keeps frozen original blockers after current correction and restores checks without replay', async () => {
  test.setTimeout(60000)
  const root = await mkdtemp(join(tmpdir(), 'trellis-history-check-desktop-'))
  let source: any, phase = 0, replace = false
  const server = await modelServer(({ body }, response) => {
    if (synthetic(body, response)) return
    expect(body.max_tokens).toBeUndefined(); expect(body.max_completion_tokens).toBeUndefined()
    if (phase++ === 0) return hostToolStream(response, 'write', { type: 'surface.update', surface_id: source.surface.id, expected_revision: source.surface.revision, operations: [replace ? { type: 'view.replace', view_id: source.views[0].id, expected_view_revision: source.views[0].revision, state_transition: { type: 'preserve', expected_state_revision: source.views[0].state_revision, compatibility_version: 'numeric-v1' }, bundle: { type: 'inline', bundle: question(true) } } : { type: 'view.create', client_ref: 'question', slot_id: 'main', bundle: { type: 'inline', bundle: question(false) } }] })
    textStream(response, replace ? 'CURRENT_CORRECTED' : 'ORIGINAL_CREATED')
  })
  const launch = () => electron.launch({ executablePath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', TRELLIS_TEST_DATA: root, TRELLIS_ENABLE_VIEW_REPLACEMENT: '1' } })
  let app = await launch(), page = await app.firstWindow()
  const call = async (request: any): Promise<any> => { const result = await page.evaluate(request => window.trellis.request(request), request); if (!result.ok) throw Error(result.error.code); return result.data }
  try {
    await call({ type: 'model.configure', configuration: { id: 'history-check', base_url: server.url, wire_model_id: 'synthetic', context_tokens: 240000, compatibility_profile: 'chat-max-tokens' }, api_key: 'synthetic', confirm_memory_only: true, remember_connection: true, confirm_plaintext_storage: true })
    await call({ type: 'model.test', model_id: 'history-check', role: 'main', confirm_cost: true })
    const task = (await call({ type: 'task.create', title: 'Frozen original diagnosis' })).task.id
    await page.reload(); await page.getByRole('button', { name: /Frozen original diagnosis/ }).click()
    const snapshot = () => call({ type: 'task.snapshot', task_id: task })
    source = await snapshot(); await call({ type: 'task.submit', task_id: task, text: 'Create synthetic question', model_config_id: 'history-check', attachments: [] })
    await expect(page.getByText('ORIGINAL_CREATED', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Submit quantity', exact: true }).click()
    await expect.poll(async () => (await snapshot()).answer_total).toBe(1)
    const answer = (await snapshot()).answers[0]; expect(answer.raw).toEqual({ response: '12.5' }); expect(answer.value).toEqual({ response: 12.5 })
    source = await snapshot(); phase = 0; replace = true
    await call({ type: 'task.submit', task_id: task, text: 'Correct current synthetic question', model_config_id: 'history-check', attachments: [] })
    await openPending(page)
    await page.getByRole('button', { name: '批准本次动作', exact: true }).click()
    await openPending(page);await page.getByRole('button', { name: '保存输入并检查替换', exact: true }).click()
    await expect(page.getByText('CURRENT_CORRECTED', { exact: true })).toBeVisible()
    const before = await snapshot(), settings = await readFile(join(root, 'settings.json')), auth = await readFile(join(root, 'auth.json'))
    const inspect = async () => {
      await page.getByRole('button', { name: '导出', exact: true }).click()
      await page.getByRole('button', { name: '检查当前导出选择', exact: true }).click()
      await expect(page.getByRole('status').filter({ hasText: '完整性检查通过' })).toBeVisible()
      await page.getByText(/可选：附带已提交作答/).click(); await page.getByLabel(/原题版本绑定/).check()
      await expect(page.getByText('完整性检查通过', { exact: false })).toHaveCount(0)
      await page.getByRole('button', { name: '检查当前导出选择', exact: true }).click()
      await expect(page.getByRole('status').filter({ hasText: '存在遗漏，完整导出受阻' })).toBeVisible()
      await expect(page.getByRole('listitem').filter({ hasText: /冻结原题.*版本 1.*元素 send/ })).toBeVisible()
      expect(await call({ type: 'export.list', task_id: task })).toEqual([])
      await page.getByRole('button', { name: '关闭导出', exact: true }).click()
    }
    await inspect()
    expect((await snapshot()).records).toEqual(before.records)
    const count = server.exchanges.length
    await app.close(); app = await launch(); page = await app.firstWindow()
    await page.getByRole('button', { name: /Frozen original diagnosis/ }).click(); await inspect()
    const after = await snapshot(); expect(after.views).toEqual(before.views); expect(after.answers).toEqual(before.answers); expect(after.records).toEqual(before.records)
    expect(await readFile(join(root, 'settings.json'))).toEqual(settings); expect(await readFile(join(root, 'auth.json'))).toEqual(auth); expect(server.exchanges).toHaveLength(count)
    console.log('Preserved fresh synthetic frozen-original directory:', root)
  } finally { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy())).catch(() => {}); await app.close().catch(() => {}); await server.close() }
})
