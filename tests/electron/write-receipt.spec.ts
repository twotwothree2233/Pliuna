import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { modelServer, synthetic, textStream, hostToolStream } from '../helpers/model-server'

const executablePath: string = createRequire(import.meta.url)('electron')
for (const failAfterCommit of [false, true]) test(`completed write receipt, original results and isolated restart: capacity failure ${failAfterCommit}`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'trellis-write-receipt-desktop-')), inputs: any[] = [], text = 'SYNTHETIC_SAVED_BODY_'.repeat(3000)
  const server = await modelServer(async ({ body }, response) => {
    if (synthetic(body, response)) return
    inputs.push(body); expect(body.max_tokens).toBe(128000)
    if (inputs.length === 1) return hostToolStream(response, 'write', { type: 'resource.create', display_name: 'receipt.txt', content: { type: 'text', text } }, '', 'create')
    expect(JSON.stringify(body.messages)).toContain(text)
    const previous = body.messages.find((message: any) => message.tool_calls?.[0]?.id === 'create')
    expect(JSON.parse(JSON.parse(previous.tool_calls[0].function.arguments).input_json).content.text).toBe(text)
    if (inputs.length === 2) return hostToolStream(response, 'list', { kind: 'resource' }, failAfterCommit ? 'CAPACITY_INJECTION_'.repeat(15000) : '', 'inspect-after-commit')
    textStream(response, 'RECEIPT_FINAL_COMPLETE')
  })
  const launch = () => electron.launch({ executablePath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', TRELLIS_TEST_DATA: root } })
  let app = await launch(), page = await app.firstWindow()
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  const call = async (request: any): Promise<any> => {
    const reply = await page.evaluate(input => window.trellis.request(input), request)
    if (!reply.ok) throw Error(reply.error.code)
    return reply.data
  }
  try {
    await call({ type: 'model.configure', configuration: { id: 'receipt', base_url: server.url, wire_model_id: 'synthetic', context_tokens: 240000, max_output_tokens: 128000, compatibility_profile: 'chat-max-tokens' }, api_key: 'synthetic-only', remember_connection: true, confirm_plaintext_storage: true, confirm_memory_only: true })
    await call({ type: 'model.test', model_id: 'receipt', role: 'main', confirm_cost: true })
    await page.getByRole('button', { name: '创建第一个任务', exact: true }).click()
    await page.getByLabel('任务名称').fill('Receipt desktop acceptance')
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    const task = (await call({ type: 'host.tasks' }))[0].id
    const submitted = await call({ type: 'task.submit', task_id: task, text: 'Create the synthetic resource, inspect its directory, then report.', model_config_id: 'receipt', attachments: [] })
    await expect.poll(async () => { return (await call({ type: 'task.snapshot', task_id: task })).runs.find((run: any) => run.id === submitted.run_id)?.state }).toBe(failAfterCommit ? 'failed' : 'completed')
    await expect(page.getByText('宿主原结果核对（不是模型答复）', { exact: false })).toBeVisible()
    await expect(page.getByText('本页已结束且 success 的动作 1 项', { exact: false })).toBeVisible()
    if (!failAfterCommit) { expect(inputs).toHaveLength(3); await expect(page.getByText('RECEIPT_FINAL_COMPLETE', { exact: true })).toBeVisible() }
    else { expect(inputs).toHaveLength(3); expect((await call({ type: 'task.snapshot', task_id: task })).runs[0].primary_reason).toBe('CONTEXT_RECOVERY_NO_PROGRESS') }
    const results = await call({ type: 'host.run.results', task_id: task, run_id: submitted.run_id, offset: 0 })
    expect(results).toMatchObject({ total: 1, items: [{ state: 'ended', result: 'success' }] })
    const before = await app.evaluate((_electron, { root }) => {
      const req = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json'), db = new (req('better-sqlite3'))(root + '/trellis.sqlite')
      try { return Object.fromEntries(['tasks', 'records', 'actions', 'resources'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])) } finally { db.close() }
    }, { root })
    const diagnostics = before.records.filter((record: any) => record.kind === 'model.context.rejected')
    expect(diagnostics).toHaveLength(0)
    const settings = await readFile(join(root, 'settings.json')), auth = await readFile(join(root, 'auth.json')), count = server.exchanges.length
    await app.close(); app = await launch(); page = await app.firstWindow()
    await page.getByRole('button', { name: /Receipt desktop acceptance/ }).click()
    expect(await call({ type: 'host.run.results', task_id: task, run_id: submitted.run_id, offset: 0 })).toEqual(results)
    const after = await app.evaluate((_electron, { root }) => {
      const req = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json'), db = new (req('better-sqlite3'))(root + '/trellis.sqlite')
      try { return Object.fromEntries(['tasks', 'records', 'actions', 'resources'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])) } finally { db.close() }
    }, { root })
    expect(after).toEqual(before); expect(await readFile(join(root, 'settings.json'))).toEqual(settings); expect(await readFile(join(root, 'auth.json'))).toEqual(auth)
    expect(server.exchanges).toHaveLength(count); expect(errors).toEqual([])
  } finally {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy())).catch(() => {})
    await app.close().catch(() => {}); await server.close()
  }
})
