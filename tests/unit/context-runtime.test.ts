import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeStore } from '../../src/runtime/store'
import { ModelService } from '../../src/runtime/model/service'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { modelServer, synthetic, textStream, toolStream } from '../helpers/model-server'
import Database from 'better-sqlite3'
import instruction from '../../src/runtime/model/prompts/summary-v0.1.txt?raw'
const closes: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })
async function until(check: () => boolean) { const end = Date.now() + 8000; while (!check()) { if (Date.now() > end) throw Error('TEST_TIMEOUT'); await new Promise(r => setTimeout(r, 10)) } }
async function setup() {
  let summaries = 0
  const server = await modelServer(({ body }, res) => {
    if (synthetic(body, res)) return
    if (body.messages.at(-1).content === instruction) { textStream(res, 'SUMMARY_' + ++summaries); return }
    textStream(res, 'Business response')
  }); closes.push(server.close)
  const root = mkdtempSync(join(tmpdir(), 'trellis-context-runtime-v2-')), models = new ModelService(); closes.push(() => models.close())
  models.configure({ type: 'model.configure', configuration: { id: 'main', base_url: server.url, wire_model_id: 'synthetic', context_tokens: 100000, max_output_tokens: 128000, compatibility_profile: 'chat-max-tokens' }, api_key: 'synthetic-only', confirm_memory_only: true })
  await models.test('main', 'main')
  let store = new RuntimeStore(root, models); closes.push(() => store.close())
  const task = store.create('Context task').task.id
  const call = (type: string, extra: any = {}) => store.handle({ type, task_id: task, ...extra }) as any
  const wait = async () => until(() => { const run = store.snapshot(task).runs[0]; if (run?.state === 'failed') throw Error(run.primary_reason ?? 'failed'); return run?.state === 'completed' })
  const submit = async (text = 'Current goal') => { call('task.submit', { text, model_config_id: 'main', attachments: [] }); await wait() }
  const compact = async () => { const result = call('context.compact', { model_config_id: 'main', confirm_cost: true }); await wait(); return result }
  return { server, models, root, task, call, wait, submit, compact, get store() { return store }, reopen() { store.close(); store = new RuntimeStore(root); closes.push(() => store.close()) } }
}
it('persists text and exact retention references and restores without replay', async () => {
  const s = await setup(); await s.submit('Initial'); await s.submit('最新目标😀'); await s.compact()
  const status = s.call('context.status'), before = s.server.exchanges.length
  expect(status.current).toMatchObject({ version: 2, text: 'SUMMARY_1', retained_interactions: [expect.any(Array), expect.any(Array)] })
  const db = new Database(join(s.root, 'trellis.sqlite')), original = db.prepare('SELECT * FROM records ORDER BY sequence').all()
  s.reopen(); expect(s.call('context.status')).toEqual(status); expect(s.server.exchanges).toHaveLength(before)
  expect(db.prepare('SELECT * FROM records ORDER BY sequence').all()).toEqual(original); db.close()
  s.store.models.configure({ type: 'model.configure', configuration: { id: 'main', base_url: s.server.url, wire_model_id: 'synthetic', context_tokens: 100000, max_output_tokens: 128000, compatibility_profile: 'chat-max-tokens' }, api_key: 'synthetic-only', confirm_memory_only: true })
  await s.store.models.test('main', 'main')
  await s.submit('Continue')
  const messages = s.server.exchanges.at(-1)!.body.messages
  expect(messages.filter((message: any) => message.role === 'assistant')).toHaveLength(2)
  expect(messages.filter((message: any) => message.content?.includes('最新目标😀'))).toHaveLength(1)
  expect(messages[1].content).toBe('工作摘要：\nSUMMARY_1')
})
it('empty and already compacted history is a zero-request no-op, including after restart', async () => {
  const s = await setup(), start = s.server.exchanges.length
  expect(s.call('context.compact', { model_config_id: 'main', confirm_cost: true })).toMatchObject({ status: 'unchanged', reason: 'no_new_history', model_requests: 0 })
  expect(s.server.exchanges).toHaveLength(start); expect(s.store.snapshot(s.task).runs).toHaveLength(0)
  await s.submit(); await s.compact(); s.reopen()
  const count = s.server.exchanges.length, runs = s.store.snapshot(s.task).runs
  for (let i = 0; i < 2; i++) expect(s.call('context.compact', { model_config_id: 'main', confirm_cost: true })).toMatchObject({ status: 'unchanged', model_requests: 0 })
  expect(s.server.exchanges).toHaveLength(count); expect(s.store.snapshot(s.task).runs).toEqual(runs)
})
it('keeps one summary generation across five consecutive compactions', async () => {
  const s = await setup()
  for (let n = 1; n <= 5; n++) {
    await s.submit('Goal ' + n); await s.compact()
    const request = s.server.exchanges.at(-1)!.body
    expect(request.messages.at(-1).content).toBe(instruction)
    expect(request.messages.filter((message: any) => message.content?.startsWith('工作摘要：'))).toHaveLength(n === 1 ? 0 : 1)
    expect(s.call('context.status').current).toMatchObject({ text: 'SUMMARY_' + n, retained_interactions: expect.any(Array) })
  }
  expect(s.call('context.status').current.retained_interactions).toHaveLength(2)
})
it.each(['cancel', 'new-input', 'disk', 'empty', 'network'] as const)('keeps old checkpoint and original records after %s fault', async failure => {
  const s = await setup(); await s.submit('Old'); await s.compact(); await s.submit('New')
  const old = s.call('context.status'), original = s.models.request.bind(s.models)
  let started = false, release: () => void = () => {}
  const promise = new Promise<void>(resolve => { release = resolve })
  s.models.request = async (...args) => {
    const response = await original(...args)
    if (args[2].at(-1)?.content === instruction) {
      if (failure === 'cancel') { started = true; await promise }
      if (failure === 'new-input') (s.store as any).record(s.task, 'message.user', { text: 'During compaction', run_id: 'external' })
      if (failure === 'empty') return { ...response, text: ' ' }
      if (failure === 'network') throw Error('INJECTED_NETWORK')
    }
    return response
  }
  if (failure === 'disk') {
    const record = (s.store as any).record.bind(s.store)
    ;(s.store as any).record = (task: string, kind: string, payload: unknown) => { if (kind === 'context.summary.installed') throw Error('INJECTED_DISK'); return record(task, kind, payload) }
  }
  const result = s.call('context.compact', { model_config_id: 'main', confirm_cost: true })
  if (failure === 'cancel') { await until(() => started); s.call('run.cancel', { run_id: result.run_id }); release() }
  await until(() => !['running','waiting'].includes(s.store.snapshot(s.task).runs[0]!.state))
  expect(s.call('context.status')).toEqual(old)
  expect(s.store.snapshot(s.task).records.filter(record => record.kind === 'message.user').map(record => record.payload.text)).toEqual(expect.arrayContaining(['Old', 'New']))
  s.reopen(); expect(s.call('context.status')).toEqual(old)
})
it('rejects a damaged retained reference without rewriting raw records', async () => {
  const s = await setup(); await s.submit(); await s.compact()
  const valid = s.call('context.status').current
  ;(s.store as any).record(s.task, 'context.summary.installed', { ...valid, retained_interactions: [['absent']] })
  expect(() => s.call('context.status')).toThrow('Retained original is unavailable')
  expect(s.store.snapshot(s.task).records.some(record => record.kind === 'model.response')).toBe(true)
})
it('preserves oversized retained originals after recovery cannot reduce the context', async () => {
  const s = await setup(); (s.store as any).record(s.task, 'message.assistant', { run_id: 'fixture', model_config_id: 'fixture', text: 'PRIVATE_BODY_'.repeat(10000) })
  const before = s.server.exchanges.length
  s.call('context.compact', { model_config_id: 'main', confirm_cost: true })
  await until(() => s.store.snapshot(s.task).runs[0]?.state === 'failed')
  const snapshot = s.store.snapshot(s.task)
  expect(snapshot.runs[0]?.primary_reason).toBe('CONTEXT_RECOVERY_NO_PROGRESS')
  expect(snapshot.records.some(record => record.kind === 'context.summary.installed')).toBe(false)
  expect(s.server.exchanges).toHaveLength(before + 1)
  s.reopen(); expect(s.store.snapshot(s.task).records).toEqual(snapshot.records)
  const db = new Database(join(s.root, 'trellis.sqlite'), { readonly: true })
  try {
    const row = db.prepare("SELECT payload_json FROM records WHERE task_id=? AND kind='message.assistant' LIMIT 1").get(s.task) as { payload_json: string }
    expect(JSON.parse(row.payload_json).text).toBe('PRIVATE_BODY_'.repeat(10000))
  } finally { db.close() }
})
it('manual organization waits for a completed active response', async () => {
  const s = await setup(), original = s.models.request.bind(s.models)
  let started = false, release: () => void = () => {}
  s.models.request = async (...args) => { const response = await original(...args); if (args[3]) { started = true; await new Promise<void>(resolve => { release = resolve }) }; return response }
  const run = s.call('task.submit', { text: 'Current', model_config_id: 'main', attachments: [] })
  await until(() => started)
  expect(s.call('context.compact', { model_config_id: 'main', confirm_cost: true })).toMatchObject({ run_id: run.run_id, scheduled: true })
  release(); await s.wait()
  expect(s.call('context.status').current.retained_interactions).toHaveLength(1)
})
it('does not preload host state or capability catalogs during ordinary inference', async () => {
  const s = await setup(); await s.submit()
  const request = s.server.exchanges.at(-1)!.body
  expect(request.messages).toHaveLength(2)
  expect(JSON.parse(request.messages[1].content)).toEqual({ request: 'Current goal' })
})
