import { expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeStore } from '../../src/runtime/store'
import { ModelService } from '../../src/runtime/model/service'
import { modelServer, synthetic, textStream, toolStream } from '../helpers/model-server'

it('discovers task, surface, answers and actions through tools; keeps Runs continuous and tasks isolated', async () => {
  const root = mkdtempSync(join(tmpdir(), 'trellis-tool-led-')), requests: any[] = []
  const kinds = ['task', 'surface', 'answer', 'action', 'capability', 'plugin']
  const server = await modelServer(({ body }, res) => {
    if (synthetic(body, res)) return
    requests.push(body)
    const current = JSON.parse(body.messages.findLast((message: any) => message.role === 'user').content)
    expect(Object.keys(current)).toEqual(['request'])
    expect(JSON.stringify(body.messages)).not.toMatch(/host_context|execution_identity|submitted_answers|action_facts|computation|request_relations|request_evidence|historical_action_facts|recorded_read_observations/)
    const last = body.messages.at(-1)
    if (current.request === 'FIRST_TASK_MARKER') {
      const count = body.messages.filter((message: any) => message.role === 'tool').length
      if (count < kinds.length) return toolStream(res, 'list', { kind: kinds[count] }, '', 'directory-' + count)
      const task = JSON.parse(body.messages.find((message: any) => message.tool_call_id === 'directory-0').content).data.items[0]
      if (count === kinds.length) return toolStream(res, 'read', { kind: 'task', id: task.id }, '', 'read-task')
      expect(JSON.parse(last.content)).toMatchObject({ execution: 'success', data: { data: { title: 'First task' } } })
      return textStream(res, 'FIRST_TASK_RESPONSE')
    }
    if (current.request === 'CONTINUE_TASK') {
      expect(body.messages.some((message: any) => message.content === JSON.stringify({request:'FIRST_TASK_MARKER'}))).toBe(true)
      expect(body.messages.some((message: any) => message.content === 'FIRST_TASK_RESPONSE')).toBe(true)
      return textStream(res, 'CONTINUED')
    }
    expect(JSON.stringify(body.messages)).not.toContain('FIRST_TASK_')
    textStream(res, 'ISOLATED')
  })
  const models = new ModelService()
  let store: RuntimeStore | undefined
  try {
    models.configure({ type: 'model.configure', configuration: { id: 'main', base_url: server.url, wire_model_id: 'synthetic', context_tokens: 240000, compatibility_profile: 'chat-max-tokens' }, api_key: 'synthetic-only', confirm_memory_only: true })
    await models.test('main', 'main')
    store = new RuntimeStore(root, models)
    const first = store.create('First task').task.id, other = store.create('Other task').task.id
    const run = async (task: string, text: string) => {
      const id = store!.start(task, text, 'main', []), end = Date.now() + 10000
      while (true) {
        const value = store!.snapshot(task).runs.find(run => run.id === id)!
        if (!['running', 'waiting'].includes(value.state)) { expect(value.state, value.primary_reason ?? '').toBe('completed'); return id }
        if (Date.now() > end) throw Error('Run timeout')
        await new Promise(resolve => setTimeout(resolve, 5))
      }
    }
    const one = await run(first, 'FIRST_TASK_MARKER'), two = await run(first, 'CONTINUE_TASK')
    expect(two).not.toBe(one)
    await run(other, 'OTHER_TASK')
    expect(requests).toHaveLength(10)
    const records = (store as any).db.prepare("SELECT payload_json FROM records WHERE task_id=? AND kind='model.request.evidence'").all(first)
    expect(records).toHaveLength(9)
    expect(records.some((row: any) => JSON.parse(row.payload_json).entries.some((entry: any) => entry.read_target?.kind === 'task'))).toBe(true)
    expect(requests.every(body => body.max_tokens === undefined && body.max_completion_tokens === undefined)).toBe(true)
    console.log(JSON.stringify({ benchmark: 'tool-led-initial-input', messages_bytes: Buffer.byteLength(JSON.stringify(requests[0].messages)), tools_bytes: Buffer.byteLength(JSON.stringify(requests[0].tools)), automatic_host_context_bytes: 0, real_api_requests: 0 }))
  } finally { store?.close(); models.close(); await server.close() }
})
