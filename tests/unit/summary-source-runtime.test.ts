import { expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { RuntimeStore } from '../../src/runtime/store'
import { ModelService } from '../../src/runtime/model/service'
import instruction from '../../src/runtime/model/prompts/summary-v0.1.txt?raw'
import { modelServer, synthetic, textStream } from '../helpers/model-server'

it('counts exact organizing input and rejects foreign retained references without source expansion', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pliuna-summary-source-runtime-'))
  let original: any, rounds = 0
  const server = await modelServer(({ body }, response) => {
    if (synthetic(body, response)) return
    if (body.messages.at(-1).content !== instruction) { textStream(response, 'Confirmed without tools'); return }
    rounds++
    if (rounds === 1) original = body.messages.find((message: any) => message.role === 'user')
    else {
      expect(body.messages.some((message: any) => message.content === '工作摘要：\nGoal Cedar remains pending')).toBe(true)
      if (rounds > 2) expect(body.messages).not.toContainEqual(original)
    }
    textStream(response, 'Goal Cedar remains pending')
  })
  const models = new ModelService()
  models.configure({ type: 'model.configure', configuration: { id: 'main', base_url: server.url, wire_model_id: 'synthetic', context_tokens: 240000, compatibility_profile: 'chat-max-tokens' }, api_key: 'synthetic', confirm_memory_only: true })
  let store: RuntimeStore | undefined, db: Database.Database | undefined
  try {
    await models.test('main', 'main'); store = new RuntimeStore(root, models); db = new Database(join(root, 'pliuna.sqlite'))
    const task = store.create('Original source continuity').task.id, other = store.create('Other task').task.id
    const until = async (run: string) => { const end = Date.now() + 8000; while (true) { const r = store!.snapshot(task).runs.find(r => r.id === run)!; if (r.state === 'completed') return; if (r.state === 'failed') throw Error(r.primary_reason!); if (Date.now() > end) throw Error('TEST_TIMEOUT'); await new Promise(r => setTimeout(r, 10)) } }
    for (let n = 0; n < 3; n++) {
      await until(store.start(task, n ? 'Goal unchanged; answer only' : 'Goal Cedar; verification pending', 'main', []))
      const r = store.handle({ type: 'context.compact', task_id: task, model_config_id: 'main', confirm_cost: true }) as any
      await until(r.run_id)
    }
    expect(rounds).toBe(3)
    const sent = server.exchanges.filter(e => e.body?.messages.at(-1)?.content === instruction)
    const completed = db.prepare("SELECT payload_json FROM records WHERE task_id=? AND kind='model.request.accounting' AND json_extract(payload_json,'$.purpose')='summary' AND json_extract(payload_json,'$.phase')='completed' ORDER BY sequence").all(task) as any[]
    expect(completed).toHaveLength(3)
    for (let n = 0; n < 3; n++) expect(JSON.parse(completed[n]!.payload_json).input_bytes).toBe(Buffer.byteLength(JSON.stringify({ messages: sent[n]!.body.messages })))
    const old = (store.handle({ type: 'context.status', task_id: task }) as any).current
    const network = server.exchanges.length
    ;(store as any).record(other, 'message.user', { text: 'Other task source' })
    const foreign = db.prepare('SELECT id FROM records WHERE task_id=?').get(other) as { id: string }
    expect(db.prepare('SELECT id FROM records WHERE task_id=? AND id=?').get(task, foreign.id)).toBeUndefined()
    ;(store as any).record(task, 'context.summary.installed', { ...old, latest_user_id: foreign.id })
    expect(() => store!.handle({ type: 'context.status', task_id: task })).toThrow('Retained original is unavailable')
    expect(server.exchanges.length).toBe(network)
  } finally { store?.close(); db?.close(); models.close(); await server.close() }
})
