import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { modelServer, synthetic, textStream, hostToolStream } from '../helpers/model-server'
const executablePath: string = process.env.TRELLIS_CANDIDATE_EXECUTABLE || createRequire(import.meta.url)('electron')
const capability = 'builtin:monty:v1'

test('native calculation discovers its contract, saves faithful values, cancels and restores without replay', async () => {
  test.setTimeout(90000)
  const root = await mkdtemp(join(tmpdir(), 'trellis-monty-desktop-'))
  let mode = 'normal', turn = 0, saved: any, source: any, failure: string | undefined
  const server = await modelServer(({ body }, response) => {
    try {
      if (synthetic(body, response)) return
      expect(body).not.toHaveProperty('max_tokens'); expect(body).not.toHaveProperty('max_completion_tokens')
      turn++
      if (mode === 'cancel') { hostToolStream(response, 'call', { capability, arguments: { code: 'while True:\n    pass', inputs: {} }, references: [] }); return }
      if (turn === 1) { hostToolStream(response, 'list', { kind: 'capability' }); return }
      const result = JSON.parse(body.messages.at(-1).content)
      if (turn === 2) { expect(result.data.items.some((item: any) => item.id === capability)).toBe(true); hostToolStream(response, 'read', { target: { kind: 'capability', id: capability } }); return }
      if (turn === 3) { expect(result.data.data.runtime).toBe('@pydantic/monty@1.3.0'); hostToolStream(response, 'call', { capability, arguments: { code: 'print("native output")\nresult = (sum(values), 2**100, frozenset([3]), b"abc")', inputs: { values: [2,3,5] } }, references: [] }); return }
      if (turn === 4) {
        expect(result).toMatchObject({ execution: 'success', delivery: 'delivered' }); saved = result
        hostToolStream(response, 'read', { target: { kind: 'resource', id: saved.data.result_resource.id } }); return
      }
      if (turn === 5) {
        expect(JSON.stringify(result)).toContain('frozenset')
        hostToolStream(response, 'write', { type: 'surface.update', surface_id: source.surface.id, expected_revision: source.surface.revision, operations: [{ type: 'view.create', client_ref: 'computed', slot_id: 'main', bundle: { type: 'inline', bundle: { profile: 'managed-v1', html: '<section id="calculation"><h2>Verified calculation sample</h2><p>2 + 3 + 5 = 10</p><p>Saved tool output is evidence of execution, not a general correctness proof.</p></section>', css: '', state: { schema: { type: 'object', properties: {}, additionalProperties: false }, initial: {}, compatibility_version: 'v1' }, forms: [], behaviors: [], references: [], export: [{ id: 'computed', category: 'learning', source: { type: 'element', element_id: 'calculation' } }] } } }] }); return
      }
      expect(result.execution).toBe('success')
      textStream(response, 'MONTY_DESKTOP_DONE: original calculation is saved, not proof of mathematical correctness.')
    } catch (error) { failure = String(error); response.writeHead(500); response.end() }
  })
  const launch = () => electron.launch({ executablePath, args: process.env.TRELLIS_CANDIDATE_EXECUTABLE ? [] : ['.'], env: { ...Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !['TRELLIS_ENABLE_MONTY', 'TRELLIS_ENABLE_VIEW_REPLACEMENT'].includes(key))) as Record<string, string>, PATH: '', MONTY_BIN: '/untrusted-must-not-run', NAPI_RS_NATIVE_LIBRARY_PATH: '/untrusted-must-not-load', ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', TRELLIS_TEST_DATA: root } })
  let app = await launch(), page = await app.firstWindow()
  const request = async (input: any): Promise<any> => { const response = await page.evaluate(r => window.trellis.request(r), input); if (!response.ok) throw Error(response.error.code); return response.data }
  const query = (task: string, kind: string, id?: string) => request({ type: 'task.query', task_id: task, query: id ? { type: 'read', input: { target: { kind, id } } } : { type: 'list', input: { kind } } })
  try {
    await expect(page.getByText('首版基础候选 · 本地运行', { exact: true })).toBeVisible()
    expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(root)
    if (process.env.TRELLIS_CANDIDATE_EXECUTABLE) expect(await app.evaluate(({ app }) => app.getAppPath())).toContain('Trellis.app/Contents/Resources/app')
    expect(await request({ type: 'host.tasks' })).toEqual([])
    await request({ type: 'model.configure', configuration: { id: 'monty-synthetic', base_url: server.url, wire_model_id: 'synthetic', context_tokens: 1000000, compatibility_profile: 'chat-max-tokens' }, api_key: 'synthetic-only', confirm_memory_only: true, remember_connection: true, confirm_plaintext_storage: true })
    await request({ type: 'model.test', model_id: 'monty-synthetic', role: 'main', confirm_cost: true })
    const task = (await request({ type: 'task.create', title: 'Native calculation synthetic' })).task.id
    source = await request({ type: 'task.snapshot', task_id: task })
    const submitted = await request({ type: 'task.submit', task_id: task, text: 'Calculate explicit synthetic values.', model_config_id: 'monty-synthetic', attachments: [] })
    await expect.poll(async () => (await request({ type: 'task.snapshot', task_id: task })).runs.find((run: any) => run.id === submitted.run_id)?.state).toBe('completed')
    expect(failure).toBeUndefined(); expect(turn).toBe(6)
    const original = (await query(task, 'call')).items[0].id, rootResource = saved.data.result_resource.id
    const result = JSON.parse(await readFile(join(root, 'resources', rootResource), 'utf8'))
    expect(result).toMatchObject({ version: 1, stdout: 'native output\n', value: { type: 'tuple' } })
    expect(result.value.items.map((item: any) => item.type)).toEqual(['json', 'bigint', 'frozenset', 'bytes'])
    expect(result.value.items[0].value).toBe(10); expect(await readFile(join(root, 'resources', result.value.items[3].resource.id), 'utf8')).toBe('abc')
    const exportJob = await request({ type: 'export.prepare', task_id: task, answer_ids: [] })
    await expect.poll(async () => (await request({ type: 'export.status', task_id: task, operation_id: exportJob.id })).phase).toBe('preview')
    const exported = join(root, 'synthetic-computed.html')
    await app.evaluate(({ dialog }, path) => { (dialog as any).showSaveDialog = async () => ({ canceled: false, filePath: path }) }, exported)
    await request({ type: 'export.save', task_id: task, operation_id: exportJob.id, partial: false })
    expect(await readFile(exported, 'utf8')).toContain('2 + 3 + 5 = 10')
    const settings = await readFile(join(root, 'settings.json'), 'utf8'), auth = await readFile(join(root, 'auth.json'), 'utf8')
    const count = server.exchanges.length
    await app.close(); app = await launch(); page = await app.firstWindow(); await page.waitForFunction(() => !!window.trellis)
    expect((await query(task, 'call', original)).data.result_data).toEqual(saved)
    expect(server.exchanges).toHaveLength(count); expect(await readFile(join(root, 'settings.json'), 'utf8')).toBe(settings); expect(await readFile(join(root, 'auth.json'), 'utf8')).toBe(auth)
    mode = 'cancel'; turn = 0
    const pending = await request({ type: 'task.submit', task_id: task, text: 'Synthetic cancellation fixture.', model_config_id: 'monty-synthetic', attachments: [] })
    await expect.poll(async () => (await query(task, 'call')).items.length).toBe(2)
    await request({ type: 'task.stop', task_id: task })
    await expect.poll(async () => (await query(task, 'call')).items.every((item: any) => item.state === 'ended')).toBe(true)
    const stopped = await request({ type: 'task.snapshot', task_id: task }); expect(stopped.runs.find((run: any) => run.id === pending.run_id).state).not.toBe('running')
    expect((await query(task, 'resource')).items).toHaveLength(3)
    const finalCount = server.exchanges.length
    await app.close(); app = await launch(); page = await app.firstWindow(); await page.waitForFunction(() => !!window.trellis)
    expect(server.exchanges).toHaveLength(finalCount); expect((await query(task, 'call')).items).toHaveLength(2); expect((await query(task, 'call', original)).data.result_data).toEqual(saved)
    console.log(JSON.stringify({ isolated_profile: root, packaged: Boolean(process.env.TRELLIS_CANDIDATE_EXECUTABLE), requests: server.exchanges.length, native_result_restored: true, real_api_requests: 0 }))
  } finally { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy())).catch(() => {}); await app.close().catch(() => {}); await server.close() }
})
