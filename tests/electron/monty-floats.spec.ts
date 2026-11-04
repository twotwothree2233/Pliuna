import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { modelServer, synthetic, textStream, toolStream } from '../helpers/model-server'

const executablePath: string = createRequire(import.meta.url)('electron')
const capability = 'builtin:monty:v1'

test('delivers native decimals, preserves rejection reasons and restores saved facts without replay', async () => {
  test.setTimeout(90000)
  const root = await mkdtemp(join(tmpdir(), 'trellis-monty-floats-desktop-'))
  const cases = [
    { name: 'plain', code: 'result = price', inputs: { price: 14.5 }, value: 14.5 },
    { name: 'nested', code: 'result = {"total": qty * price + freight, "nested": [price, {"freight": freight}]}', inputs: { qty: 17, price: 14.5, freight: 0.3 }, value: { total: 246.8, nested: [14.5, { freight: 0.3 }] } },
    { name: 'negative-zero', code: 'result = {"nested": [-0.0]}', error: 'MONTY_NONFAITHFUL_FLOAT' },
    { name: 'unsafe-float', code: 'result = [9007199254740992.0]', error: 'MONTY_NONFAITHFUL_FLOAT' },
    { name: 'cycle', code: 'value = []\nvalue.append(value)\nresult = value', error: 'MONTY_CYCLIC_VALUE' },
    { name: 'unsupported', code: 'import datetime\nresult = datetime.datetime.now()', error: 'MONTY_VALUE_UNSUPPORTED' },
    { name: 'execution-failed', code: 'result = 1 / 0', error: 'MONTY_EXECUTION_FAILED' }
  ]
  let current = cases[0]!, turn = 0, failure: string | undefined, dataId = ''
  const saved: any[] = []
  const server = await modelServer(({ body }, response) => {
    try {
      if (synthetic(body, response)) return
      expect(body).not.toHaveProperty('max_tokens'); expect(body).not.toHaveProperty('max_completion_tokens')
      turn++
      if (turn === 1) return toolStream(response, 'call', { capability, input_json: JSON.stringify({ code: current.code, inputs: current.inputs ?? {} }) })
      const result = JSON.parse(body.messages.at(-1).content)
      if (turn === 2) {
        saved.push(result)
        if (current.error) {
          expect(result).toMatchObject({ execution: current.error === 'MONTY_EXECUTION_FAILED' ? 'failure' : 'success', delivery: current.error === 'MONTY_EXECUTION_FAILED' ? 'delivered' : 'failed', error: { code: current.error } })
          expect(result).not.toHaveProperty('data')
          return textStream(response, 'REJECTED_' + current.name)
        }
        expect(result).toMatchObject({ execution: 'success', delivery: 'delivered', data: { version: 1, value: { type: 'json', value: current.value } } })
        if (current.name === 'nested') return toolStream(response, 'write', { operation: 'task_data.create', input_json: JSON.stringify({ data: { schema: { type: 'object', properties: { total: { type: 'number' } }, required: ['total'], additionalProperties: false }, value: { total: 246.8 }, references: [] } }) })
        return textStream(response, 'SAVED_' + current.name)
      }
      if (turn === 3 && current.name === 'nested') {
        expect(result.execution).toBe('success'); dataId = result.data.id
        return toolStream(response, 'read', { kind: 'task_data', id: dataId })
      }
      expect(result.data.data.value).toEqual({ total: 246.8 })
      textStream(response, 'SAVED_AND_READ_nested')
    } catch (error) { failure = String(error); response.writeHead(500); response.end() }
  })
  const launch = () => electron.launch({ executablePath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', TRELLIS_TEST_DATA: root, TRELLIS_ENABLE_MONTY: '1' } })
  let app = await launch(), page = await app.firstWindow()
  const call = async (request: any): Promise<any> => {
    const result = await page.evaluate(request => window.trellis.request(request), request)
    if (!result.ok) throw Error(result.error.code)
    return result.data
  }
  try {
    await call({ type: 'model.configure', configuration: { id: 'floats', base_url: server.url, wire_model_id: 'synthetic', context_tokens: 1000000, compatibility_profile: 'chat-max-tokens' }, api_key: 'synthetic-only', confirm_memory_only: true, remember_connection: true, confirm_plaintext_storage: true })
    await call({ type: 'model.test', model_id: 'floats', role: 'main', confirm_cost: true })
    const task = (await call({ type: 'task.create', title: 'Native decimal regression' })).task.id
    for (const entry of cases) {
      current = entry; turn = 0
      const run = await call({ type: 'task.submit', task_id: task, text: 'Synthetic native case: ' + entry.name, model_config_id: 'floats', attachments: [] })
      await expect.poll(async () => (await call({ type: 'task.snapshot', task_id: task })).runs.find((item: any) => item.id === run.run_id)?.state).toBe('completed')
      expect(failure).toBeUndefined(); expect(turn).toBe(entry.name === 'nested' ? 4 : 2)
    }
    expect(saved).toHaveLength(cases.length)
    const before = await call({ type: 'task.snapshot', task_id: task })
    const query = (kind: string, id?: string) => call({ type: 'task.query', task_id: task, query: id ? { type: 'read', input: { target: { kind, id } } } : { type: 'list', input: { kind } } })
    expect((await query('task_data', dataId)).data.value).toEqual({ total: 246.8 })
    expect((await query('resource')).items).toHaveLength(0)
    expect((await query('call')).items).toHaveLength(cases.length)
    const settings = await readFile(join(root, 'settings.json')), auth = await readFile(join(root, 'auth.json')), requests = server.exchanges.length
    await app.close(); app = await launch(); page = await app.firstWindow(); await page.waitForFunction(() => !!window.trellis)
    const after = await call({ type: 'task.snapshot', task_id: task })
    expect(after.runtime_epoch).not.toBe(before.runtime_epoch)
    expect({ ...after, runtime_epoch: null }).toEqual({ ...before, runtime_epoch: null })
    for (const result of saved) expect((await query('call', result.operation_id)).data.result_data).toEqual(result)
    expect((await query('task_data', dataId)).data.value).toEqual({ total: 246.8 })
    expect(await readFile(join(root, 'settings.json'))).toEqual(settings)
    expect(await readFile(join(root, 'auth.json'))).toEqual(auth)
    expect(server.exchanges).toHaveLength(requests)
    console.log(JSON.stringify({ benchmark: 'monty-floats', native_cases: cases.length, requests, restart_requests: server.exchanges.length - requests, real_api_requests: 0 }))
  } finally {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy())).catch(() => {})
    await app.close().catch(() => {}); await server.close()
  }
})
