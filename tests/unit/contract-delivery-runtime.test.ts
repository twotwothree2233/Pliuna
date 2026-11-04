import { expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { RuntimeStore } from '../../src/runtime/store'
import { ModelService } from '../../src/runtime/model/service'
import { operationContract } from '../../src/runtime/model/operation-contracts'
import { modelServer } from '../helpers/model-server'
import { contractScenario } from '../helpers/contract-scenario'

it('actually delivers every large contract page through HTTP, uses its example and exports the persisted View', async () => {
  const root = mkdtempSync(join(tmpdir(), 'trellis-contract-delivery-')), scene = contractScenario()
  const server = await modelServer(scene.handle), models = new ModelService()
  let store: RuntimeStore | undefined
  try {
    models.configure({ type: 'model.configure', configuration: { id: 'contract', base_url: server.url, wire_model_id: 'synthetic', context_tokens: 240000, compatibility_profile: 'chat-max-tokens' }, api_key: 'synthetic-only', confirm_memory_only: true })
    await models.test('contract', 'main'); store = new RuntimeStore(root, models)
    const task = store.create('Contract page delivery').task.id
    store.start(task, 'Create the example learning content.', 'contract', [])
    const end = Date.now() + 10000
    while (['running', 'waiting'].includes(store.snapshot(task).runs[0]!.state)) { if (Date.now() > end) throw Error('Run timeout'); await new Promise(resolve => setTimeout(resolve, 5)) }
    expect(scene.failure).toBeUndefined()
    expect(store.snapshot(task).runs[0]!.state).toBe('completed')
    expect(scene.pages.length).toBeGreaterThan(1)
    expect(Buffer.byteLength(scene.pages[0]!.content)).toBeGreaterThan(4000)
    expect(scene.contract).toEqual(operationContract('surface.update'))
    const db = new Database(join(root, 'trellis.sqlite'))
    try {
      for (const page of scene.pages) {
        const row = db.prepare("SELECT payload_json FROM records WHERE kind='model.tool_result' AND json_extract(payload_json,'$.message.tool_call_id')=?").get(page.id) as any
        expect(JSON.parse(row.payload_json).message.content).toBe(page.content)
      }
      expect(db.prepare('SELECT count(*) n FROM actions').get()).toEqual({ n: 1 })
    } finally { db.close() }
    const view = store.snapshot(task).views[0]!
    const exported = await store.handle({ type: 'export.prepare', task_id: task, answer_ids: [], view_ids: [view.id] }) as any
    expect(exported.issues).toEqual([]); expect(exported.html).toContain('内容')
    await store.handle({ type: 'export.cancel', task_id: task, operation_id: exported.id })
    for (const body of scene.requests) { expect(body).not.toHaveProperty('max_tokens'); expect(body).not.toHaveProperty('max_completion_tokens') }
    console.log(JSON.stringify({ benchmark: 'actual-contract-page-delivery', page_bytes: scene.pages.map(page => Buffer.byteLength(page.content)), requests: scene.requests.length, real_api_requests: 0 }))
  } finally { store?.close(); models.close(); await server.close() }
})
