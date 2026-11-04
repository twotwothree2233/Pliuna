import { expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeStore } from '../../src/runtime/store'
import { ModelService } from '../../src/runtime/model/service'
import { modelServer, synthetic, textStream, hostToolStream } from '../helpers/model-server'
import { rejectedContext } from '../../src/runtime/model/capacity'
import { modelTools } from '../../src/runtime/model/tools'
import { assertContract } from '../../src/shared/validation'

async function until(check: () => boolean) {
  const end = Date.now() + 8000
  while (!check()) { if (Date.now() > end) throw Error('TEST_TIMEOUT'); await new Promise(resolve => setTimeout(resolve, 10)) }
}

it.each([false, true, 'diagnostic-disk'] as const)('commits once and retains results across restart; injected post-commit capacity failure: %s', async failAfterCommit => {
  const root = mkdtempSync(join(tmpdir(), 'trellis-receipt-runtime-')), bodyText = 'SAVED_BODY_'.repeat(6000), inputs: any[] = []
  const server = await modelServer(({ body }, response) => {
    if (synthetic(body, response)) return
    inputs.push(body)
    expect(body.max_tokens).toBe(128000)
    if (inputs.length === 1) return hostToolStream(response, 'write', { type: 'resource.create', display_name: 'receipt.txt', content: { type: 'text', text: bodyText } }, '', 'create')
    const previous = body.messages.find((message: any) => message.tool_calls?.[0]?.id === 'create')
    expect(JSON.parse(JSON.parse(previous.tool_calls[0].function.arguments).input_json).content.text).toBe(bodyText)
    expect(JSON.stringify(body.messages)).toContain(bodyText)
    if (inputs.length === 2) return hostToolStream(response, 'list', { kind: 'resource' }, '', 'after-commit-readonly')
    expect(inputs.length).toBe(3); textStream(response, 'Committed once; final response completed.')
  })
  const models = new ModelService()
  let store: RuntimeStore | undefined, db: Database.Database | undefined
  try {
    models.configure({ type: 'model.configure', configuration: { id: 'receipt', base_url: server.url, wire_model_id: 'synthetic', context_tokens: 240000, max_output_tokens: 128000, compatibility_profile: 'chat-max-tokens' }, api_key: 'synthetic-only', confirm_memory_only: true })
    await models.test('receipt', 'main'); store = new RuntimeStore(root, models)
    if (failAfterCommit) {
      const lease = models.acquire('receipt', 'main'), configuration = structuredClone(lease.config); lease.release()
      const original = (store as any).prepareContext.bind(store)
      ;(store as any).prepareContext = async (...args: any[]) => {
        const messages = await original(...args)
        if (messages.some((message: any) => message.role === 'tool')) throw rejectedContext(configuration, [...messages, { role: 'assistant', content: 'PRIVATE_CAPACITY_BODY'.repeat(15000) }], modelTools, 'protected-input', 'CONTEXT_MINIMUM_TOO_LARGE')
        return messages
      }
      if (failAfterCommit === 'diagnostic-disk') {
        const record = (store as any).record.bind(store)
        ;(store as any).record = (task: string, kind: string, payload: unknown) => { if (kind === 'model.context.rejected') throw Error('injected diagnostic disk failure'); return record(task, kind, payload) }
      }
    }
    const task = store.create('Receipt isolated test').task.id
    store.start(task, 'Create the resource, inspect its directory, then report.', 'receipt', [])
    await until(() => { const run = store!.snapshot(task).runs[0]; if (!failAfterCommit && run?.state === 'failed') throw Error(run.primary_reason ?? 'failed'); return run?.state === (failAfterCommit ? 'failed' : 'completed') })
    db = new Database(join(root, 'trellis.sqlite'))
    const run = store.snapshot(task).runs[0]!, actions = db.prepare('SELECT * FROM actions WHERE task_id=?').all(task)
    expect(actions).toHaveLength(1); expect(actions[0]).toMatchObject({ state: 'ended', result: 'success' })
    const records = db.prepare('SELECT * FROM records WHERE task_id=? ORDER BY sequence').all(task)
    const original = records.find((record: any) => record.kind === 'model.response') as any
    expect(JSON.parse(JSON.parse(JSON.parse(original.payload_json).message.tool_calls[0].function.arguments).input_json).content.text).toBe(bodyText)
    expect(records.filter((record: any) => record.kind === 'model.tool_result')).toHaveLength(failAfterCommit ? 1 : 2)
    const receipts = records.filter((record: any) => record.kind === 'model.request.evidence').map((record: any) => JSON.parse(record.payload_json))
    if (!failAfterCommit) expect(receipts.slice(1).every((manifest: any) => manifest.entries.some((entry: any) => entry.representation === 'recorded-message'))).toBe(true)
    else {
      expect(inputs).toHaveLength(1); expect(run.primary_reason).toBe(failAfterCommit === 'diagnostic-disk' ? 'CONTEXT_DIAGNOSTIC_UNAVAILABLE' : 'CONTEXT_MINIMUM_TOO_LARGE')
      expect(store.handle({ type: 'host.run.results', task_id: task, run_id: run.id, offset: 0 })).toMatchObject({ total: 1, items: [{ kind: 'action', result: 'success', state: 'ended' }] })
    }
    const diagnostics = records.filter((record: any) => record.kind === 'model.context.rejected') as any[]
    expect(diagnostics).toHaveLength(failAfterCommit === true ? 1 : 0)
    if (failAfterCommit === true) {
      const diagnostic = JSON.parse(diagnostics[0].payload_json)
      assertContract<{ estimated_input: number; available_input: number }>('context_rejected', diagnostic)
      expect(diagnostic).toMatchObject({ version: 1, run_id: run.id, model_id: 'receipt', model_revision: 1, stage: 'protected-input', output_reserve: 128000, available_input: 240000 })
      expect(JSON.stringify(diagnostic)).not.toMatch(/PRIVATE_CAPACITY_BODY|SAVED_BODY_|synthetic-only/)
      expect(diagnostic.estimated_input).toBeGreaterThan(diagnostic.available_input)
      expect(store.handle({ type: 'task.query', task_id: task, query: { type: 'read', input: { target: { kind: 'event', id: diagnostics[0].id } } } })).toMatchObject({ data: { payload: diagnostic } })
      const foreign = store.create('Unrelated isolated task').task.id
      expect(() => store!.handle({ type: 'task.query', task_id: foreign, query: { type: 'read', input: { target: { kind: 'event', id: diagnostics[0].id } } } })).toThrow()
    }
    const resources = db.prepare('SELECT * FROM resources').all(), requests = server.exchanges.length
    db.close(); db = undefined; store.close(); store = new RuntimeStore(root)
    const reopened = new Database(join(root, 'trellis.sqlite'))
    try {
      expect(reopened.prepare('SELECT * FROM records WHERE task_id=? ORDER BY sequence').all(task)).toEqual(records)
      expect(reopened.prepare('SELECT * FROM actions WHERE task_id=?').all(task)).toEqual(actions)
      expect(reopened.prepare('SELECT * FROM resources').all()).toEqual(resources)
      expect(store.snapshot(task).runs[0]).toMatchObject({ id: run.id, state: failAfterCommit ? 'failed' : 'completed' })
      expect(server.exchanges).toHaveLength(requests)
    } finally { reopened.close() }
  } finally { db?.close(); store?.close(); models.close(); await server.close() }
})
