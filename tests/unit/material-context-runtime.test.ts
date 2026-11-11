import Database from 'better-sqlite3'
import { expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { RuntimeStore } from '../../src/runtime/store'
import { ModelService } from '../../src/runtime/model/service'
import instruction from '../../src/runtime/model/prompts/summary-v0.1.txt?raw'
import { modelServer, synthetic, textStream, hostToolStream } from '../helpers/model-server'

async function until(check: () => boolean) { const end = Date.now() + 8000; while (!check()) { if (Date.now() > end) throw Error('TEST_TIMEOUT'); await new Promise(r => setTimeout(r, 10)) } }
it.each(['exact-repeat', 'request-compaction'] as const)('real runtime read projection and restart: %s', async scenario => {
  const root = mkdtempSync(join(tmpdir(), 'pliuna-material-context-')), text = '中😀'.repeat(16000), resource = randomUUID()
  let business = 0, summaries = 0
  const server = await modelServer(({ body }, res) => {
    if (synthetic(body, res)) return
    if (body.messages.at(-1).content === instruction) {
      summaries++
      expect(body.messages.some((message: any) => message.role === 'tool' && message.content.includes('中😀'))).toBe(true)
      textStream(res, 'Selected resource was read; continue.'); return
    }
    business++
    const input = JSON.parse(body.messages.findLast((m: any) => m.role === 'user').content)
    const tools = body.messages.filter((m: any) => m.role === 'tool')
    if (business === 1) { hostToolStream(res, 'read', { target: { kind: 'resource', id: resource }, content: { max_chars: 32000 } }, '', 'first'); return }
    const last = tools.length ? JSON.parse(tools.at(-1).content) : null
    if (business === 2) {
      if (scenario === 'exact-repeat') expect(last.data.data.text).toBe(text)
      else { expect(last.data.data.text).toBe(text); expect(summaries).toBe(1); expect(JSON.stringify(body.messages)).toContain('工作摘要：'); expect(input.request).toContain('Read the selected resource') }
      hostToolStream(res, 'read', { target: { kind: 'resource', id: resource }, content: { max_chars: scenario === 'exact-repeat' ? 32000 : 1000 } }, '', 'second'); return
    }
    expect(business).toBe(3)
    if (scenario === 'exact-repeat') { expect(last.data.data.text).toBe(text); expect(tools).toHaveLength(2); expect(last.data.data).not.toHaveProperty('context_reuse') }
    else expect(last.data.actual_range.chars).toBe(1000)
    textStream(res, 'Application stores accepted records locally, not all stored text is in every model input; restart does not resume execution.')
  })
  const models = new ModelService()
  models.configure({ type: 'model.configure', configuration: { id: 'main', base_url: server.url, wire_model_id: 'synthetic', context_tokens: scenario === 'exact-repeat' ? 300000 : 125000, max_output_tokens: 8192, compatibility_profile: 'chat-max-tokens' }, api_key: 'synthetic-only', confirm_memory_only: true })
  let store: RuntimeStore | undefined, db: Database.Database | undefined
  try {
    await models.test('main', 'main'); store = new RuntimeStore(root, models); db = new Database(join(root, 'pliuna.sqlite'))
    const task = store.create('Synthetic material context').task.id, bytes = Buffer.from(text), sha = createHash('sha256').update(bytes).digest('hex')
    writeFileSync(join(root, 'resources', resource), bytes)
    db.prepare('INSERT INTO resources VALUES (?,?,?,?,?,?,?)').run(resource, resource, sha, bytes.length, 'text/plain; charset=utf-8', 'synthetic', 'now'); db.prepare('INSERT INTO task_resources VALUES (?,?)').run(task, resource)
    store.start(task, 'Read the selected resource; use exact input evidence.', 'main', [])
    await until(() => { const run = store!.snapshot(task).runs[0]; if (run?.state === 'failed') throw Error(run.primary_reason ?? 'failed'); return run?.state === 'completed' })
    expect(business).toBe(3)
    const rows = db.prepare("SELECT id,payload_json FROM records WHERE task_id=? AND kind='model.tool_result' ORDER BY sequence").all(task) as any[]
    expect(rows).toHaveLength(2)
    const results = rows.map(r => JSON.parse(JSON.parse(r.payload_json).message.content))
    if (scenario === 'exact-repeat') { expect(results.map(r => r.data.data.text)).toEqual([text, text]); expect(results[1].data.data).not.toHaveProperty('context_reuse') }
    else { expect(results[0].data.data.text).toBe(text); expect(results[1].data.actual_range.chars).toBe(1000); expect(summaries).toBeGreaterThanOrEqual(1) }
    const completed = db.prepare("SELECT payload_json FROM records WHERE kind='model.request.accounting' AND json_extract(payload_json,'$.phase')='completed' AND json_extract(payload_json,'$.purpose')='main' ORDER BY sequence").all() as any[]
    const requests = server.exchanges.filter(e => e.body?.messages[0]?.content.includes('你是 Pliuna 的通用学习与任务助手。') && e.body.messages.at(-1)?.content !== instruction)
    expect(completed).toHaveLength(3)
    for (let n = 0; n < 3; n++) expect(JSON.parse(completed[n]!.payload_json).input_bytes).toBe(Buffer.byteLength(JSON.stringify({ messages: requests[n]!.body.messages, tools: requests[n]!.body.tools })))
    if (scenario === 'exact-repeat') expect(JSON.parse(completed[2].payload_json).input_bytes - JSON.parse(completed[1].payload_json).input_bytes).toBeGreaterThan(100000)
    expect(db.prepare('SELECT count(*) n FROM actions').get()).toEqual({ n: 0 }); expect(db.prepare('SELECT count(*) n FROM calls').get()).toEqual({ n: 0 })
    const before = server.exchanges.length, records = db.prepare('SELECT payload_json FROM records ORDER BY sequence').all()
    store.close(); store = new RuntimeStore(root)
    expect(store.snapshot(task).runs[0]!.state).toBe('completed'); expect(server.exchanges).toHaveLength(before)
    expect(db.prepare('SELECT payload_json FROM records ORDER BY sequence').all()).toEqual(records); expect(readFileSync(join(root, 'resources', resource))).toEqual(bytes)
  } finally { store?.close(); db?.close(); models.close(); await server.close() }
})
