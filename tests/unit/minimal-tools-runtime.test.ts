import { expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { RuntimeStore } from '../../src/runtime/store'
import { ModelService } from '../../src/runtime/model/service'
import { modelServer, synthetic, textStream, toolStream } from '../helpers/model-server'
import { modelTools } from '../../src/runtime/model/tools'

it('uses new wire directly for on-demand contracts, writes and Unicode continuation; rejects routing before side effects and retains raw records on restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'trellis-minimal-tools-')), captured: any[] = [], text = '材料😀'.repeat(3000)
  let resource = '', data = '', cursor = '', recovered = '', index = 0, contractBytes = 0
  const server = await modelServer(({ body }, res) => {
    if (synthetic(body, res)) return
    captured.push(body)
    const last = body.messages.at(-1), result = last.role === 'tool' ? JSON.parse(last.content) : null
    switch (index++) {
      case 0: return toolStream(res, 'list', { kind: 'object_type' })
      case 1: {
        const entry = result.data.items.find((item: any) => item.id === 'task_data.create')
        expect(entry.contract_target).toEqual({ kind: 'object_type', id: 'task_data.create' })
        return toolStream(res, 'read', entry.contract_target)
      }
      case 2: {
        const contract = result.data.data
        contractBytes = Buffer.byteLength(JSON.stringify(result))
        expect(JSON.stringify(contract)).not.toMatch(/surface.update|view_op|forms/)
        return toolStream(res, 'write', contract.example)
      }
      case 3:
        data = result.data.id
        expect(result.execution).toBe('success')
        return toolStream(res, 'write', { operation: 'resource.create', input_json: JSON.stringify({ display_name: 'material.txt', content: { type: 'text', text } }) })
      case 4:
        resource = result.data.id
        return toolStream(res, 'read', { kind: 'resource', id: resource, max_chars: 4000, selection: { view: 'text' } })
      case 5:
        recovered = result.data.data.text; cursor = result.data.next_cursor
        expect([...recovered]).toHaveLength(4000)
        return toolStream(res, 'read', { kind: 'resource', id: resource, cursor, selection: { view: 'text' }, max_chars: 4000 })
      case 6:
        recovered += result.data.data.text
        expect([...recovered]).toHaveLength(8000)
        expect(text.startsWith(recovered)).toBe(true)
        return toolStream(res, 'write', { operation: 'task_data.remove', input_json: JSON.stringify({ type: 'task_data.remove', id: data, expected_revision: 1 }) })
      case 7:
        expect(result.error.code).toBe('INVALID_REQUEST')
        return textStream(res, 'No invalid write executed.')
      default: throw Error('Unexpected replay')
    }
  })
  const models = new ModelService(); let store: RuntimeStore | undefined
  try {
    models.configure({ type: 'model.configure', configuration: { id: 'minimal', base_url: server.url, wire_model_id: 'synthetic', context_tokens: 240000, compatibility_profile: 'chat-max-tokens' }, api_key: 'synthetic-only', confirm_memory_only: true })
    await models.test('minimal', 'main'); store = new RuntimeStore(root, models)
    const task = store.create('Minimal model wire').task.id, run = store.start(task, 'Inspect a contract and use the tools.', 'minimal', [])
    const end = Date.now() + 10000
    while (['running', 'waiting'].includes(store.snapshot(task).runs[0]!.state)) { if (Date.now() > end) throw Error('Run timeout'); await new Promise(resolve => setTimeout(resolve, 5)) }
    expect(store.snapshot(task).runs[0]).toMatchObject({ id: run, state: 'completed' })
    expect(store.snapshot(task).approvals).toHaveLength(0)
    const db = new Database(join(root, 'trellis.sqlite'))
    const records = db.prepare('SELECT * FROM records ORDER BY sequence').all()
    expect(db.prepare('SELECT count(*) n FROM actions').get()).toEqual({ n: 2 })
    expect(db.prepare('SELECT revision FROM task_data WHERE id=?').get(data)).toEqual({ revision: 1 })
    const wire = JSON.parse(JSON.parse((records.find((row: any) => row.kind === 'model.response') as any).payload_json).message.tool_calls[0].function.arguments)
    expect(wire).toEqual({ kind: 'object_type' }); db.close()
    for (const body of captured) { expect(body).not.toHaveProperty('max_tokens'); expect(body.tools).toEqual(modelTools) }
    const network = server.exchanges.length
    store.close(); store = new RuntimeStore(root)
    const reopened = new Database(join(root, 'trellis.sqlite'))
    expect(reopened.prepare('SELECT * FROM records ORDER BY sequence').all()).toEqual(records); reopened.close()
    expect(server.exchanges).toHaveLength(network)
    console.log(JSON.stringify({ benchmark: 'minimal-tools-on-demand', tools_bytes: Buffer.byteLength(JSON.stringify(modelTools)), contract_response_bytes: contractBytes, request_input_bytes: captured.map(body => Buffer.byteLength(JSON.stringify({ messages: body.messages, tools: body.tools }))), real_api_requests: 0 }))
  } finally { store?.close(); models.close(); await server.close() }
})
