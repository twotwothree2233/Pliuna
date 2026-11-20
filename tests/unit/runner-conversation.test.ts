import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { afterEach, expect, it } from 'vitest'
import type { ExecutionScope } from '../../src/shared/contracts.generated'
import { captureConversation, fitConversation, loadConversation, type ConversationHistory } from '../../src/runtime/runner/conversation'

const coreSql = readFileSync(new URL('../../src/shared/contracts/001-core.sql', import.meta.url), 'utf8')
const runnerSql = readFileSync(new URL('../../src/shared/contracts/002-runner.sql', import.meta.url), 'utf8')
const databases: Database.Database[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
const owner: ExecutionScope = { task_id: 'task', run_id: 'run', work_id: 'work', attempt_id: 'attempt', role: 'producer', purpose: 'production', request_id: 'first', intent_revision: 1 }

function setup() {
  const db = new Database(':memory:'); databases.push(db); db.exec(coreSql); db.exec(runnerSql)
  db.prepare("INSERT INTO tasks(id,title,state,revision) VALUES ('task','Task','active',1),('other','Other','active',1)").run()
  let ordinal = 0
  const record = (kind: string, payload: unknown, task = 'task') => {
    const sequence = (db.prepare('SELECT next_sequence FROM tasks WHERE id=?').get(task) as { next_sequence: number }).next_sequence, id = `event-${++ordinal}`
    db.prepare('INSERT INTO records VALUES (?,?,?,?,?,?)').run(id, task, sequence, kind, JSON.stringify(payload), 'time')
    db.prepare('UPDATE tasks SET next_sequence=next_sequence+1 WHERE id=?').run(task)
    return { id, sequence }
  }
  const request = (id = 'first', input: unknown = { text: 'First question' }, task = 'task') => {
    db.prepare("INSERT INTO requests VALUES (?,?,'started','{}',?,'time')").run(id, task, JSON.stringify(input))
  }
  const answer = (text: string, extra: Record<string, unknown> = {}) => record('runner.answer', { purpose: 'final_answer', text, request_id: 'first', run_id: 'run', owner, ...extra })
  const material = (id: string, task = 'task') => {
    db.prepare("INSERT INTO resources VALUES (?,?,'fixture-digest',1,'text/plain',?,'time')").run(id, id, id)
    db.prepare('INSERT INTO task_resources VALUES (?,?)').run(task, id)
  }
  const correction = (text: string, installed: boolean) => {
    const inputId = `input-${ordinal + 1}`, received = record('runner.input.received', { text, runner_input: { input_event_id: inputId, kind: 'correction', request_id: 'first' } })
    db.prepare("INSERT INTO runner_inputs VALUES (?,'task',?,'correction','{}','time')").run(inputId, received.id)
    const install = () => {
      db.prepare("INSERT INTO runner_consumptions VALUES (?,'task','installed','{}','time')").run(inputId)
      record('runner.input.installed', { input_event_id: inputId, route: { route: 'direct', kind: 'correction', request_id: 'first' } })
    }
    if (installed) install()
    return { ...received, install }
  }
  return { db, record, request, answer, material, correction }
}

it.each([
  '已生成讲义。\n```json\n{"version":1,"complete":true,"answer":"讲义说明","artifacts":[],"requirement_ids":["answer"],"unresolved":[]}\n```',
  '已生成讲义。\n```json\n{version:1,complete:true,answer:"讲义说明",artifacts:[],requirement_ids:["answer"],unresolved:[]}\n```'
])('keeps a polluted historical answer as an exact reference instead of conversation text: %s', text => {
  const fixture = setup(); fixture.request()
  const user = fixture.record('message.user', { text: '制作讲义', request_id: 'first' })
  const polluted = fixture.answer(text), normal = fixture.answer('已收到下一条问题。')
  const teaching = fixture.answer('JSON 示例：\n```json\n{"answer":"解释","artifacts":[]}\n```')
  const binding = captureConversation(fixture.db, 'task'), history = loadConversation(fixture.db, 'task', binding)
  expect(history.messages.map(item => item.source.id)).toEqual([user.id, normal.id, teaching.id])
  expect(history.messages.map(item => item.message.role)).toEqual(['user', 'assistant', 'assistant'])
  expect(history.messages[2]!.message.content).toContain('JSON 示例')
  expect(history.refs).toEqual([{ kind: 'event', id: polluted.id }])
  expect(history.truncated).toBe(true)
  const original = fixture.db.prepare('SELECT payload_json FROM records WHERE id=?').get(polluted.id) as { payload_json: string }
  expect(JSON.parse(original.payload_json).text).toBe(text)
})

it('freezes original user and accepted answer records before the next turn', () => {
  const fixture = setup(); fixture.request()
  const user = fixture.record('message.user', { text: 'Remember the name Lyra', request_id: 'first' }), answer = fixture.answer('I will use Lyra.')
  const binding = captureConversation(fixture.db, 'task')
  fixture.record('message.user', { text: 'What was the name?', request_id: 'second' })
  fixture.answer('FUTURE ANSWER')
  const history = loadConversation(fixture.db, 'task', binding)
  expect(binding).toMatchObject({ version: 1, through_sequence: answer.sequence, reply_to_request_id: 'first' })
  expect(history.messages.map(item => item.source.id)).toEqual([user.id, answer.id])
  expect(history.messages.map(item => item.message.role)).toEqual(['user', 'assistant'])
  expect(history.messages[1]?.message.content).toBe('I will use Lyra.')
  expect(JSON.stringify(history)).not.toContain('FUTURE')
  expect(history.refs).toEqual([]); expect(history.truncated).toBe(false)
})

it('excludes worker internals, role projections, other tasks and unaccepted answers', () => {
  const fixture = setup(); fixture.request()
  fixture.record('message.user', { text: 'Visible input', request_id: 'first' })
  fixture.answer('Visible answer')
  for (const kind of ['worker.input', 'worker.conversation', 'model.response', 'model.tool_result', 'message.assistant', 'message.assistant.partial']) {
    fixture.record(kind, { text: 'PRIVATE TRACE', message: { role: 'assistant', content: 'PRIVATE TRACE' }, owner, finish: 'stop' })
  }
  fixture.answer('PRIVATE DIAGNOSIS', { owner: { ...owner, role: 'diagnostic' } })
  fixture.answer('PRIVATE COLLATION', { owner: { ...owner, role: 'collator' } })
  fixture.answer('PRIVATE PROCESS', { purpose: 'process' })
  fixture.answer('PRIVATE OTHER OWNER', { owner: { ...owner, task_id: 'other' } })
  fixture.record('message.user', { text: 'PRIVATE OTHER TASK' }, 'other')
  const history = loadConversation(fixture.db, 'task', captureConversation(fixture.db, 'task'))
  expect(history.messages).toHaveLength(2)
  expect(JSON.stringify(history)).not.toContain('PRIVATE')
})

it('includes only corrections whose installation existed at the snapshot cutoff', () => {
  const fixture = setup(); fixture.request()
  fixture.record('message.user', { text: 'Original input', request_id: 'first' })
  const installed = fixture.correction('Installed correction', true), pending = fixture.correction('Later correction', false)
  const binding = captureConversation(fixture.db, 'task')
  pending.install()
  expect(loadConversation(fixture.db, 'task', binding).messages.map(item => item.source.id)).toContain(installed.id)
  expect(JSON.stringify(loadConversation(fixture.db, 'task', binding))).not.toContain('Later correction')
  expect(JSON.stringify(loadConversation(fixture.db, 'task', captureConversation(fixture.db, 'task')))).toContain('Later correction')
})

it('freezes only same-task, explicitly bound user materials and accepts old bindings', () => {
  const fixture = setup()
  for (const id of ['direct', 'imported', 'future']) fixture.material(id)
  fixture.material('foreign', 'other')
  fixture.request('first', { text: 'Read these', resource_ids: ['direct', 'foreign'], bound_materials: [{ id: 'imported' }] })
  fixture.record('message.user', { text: 'Read these', request_id: 'first' })
  const binding = captureConversation(fixture.db, 'task')
  fixture.db.prepare('UPDATE requests SET input_json=? WHERE id=?').run(JSON.stringify({ text: 'Read these', resource_ids: ['direct', 'foreign'], bound_materials: [{ id: 'imported' }, { id: 'future' }] }), 'first')
  expect(new Set(binding.resource_ids)).toEqual(new Set(['direct', 'imported']))
  expect(new Set(loadConversation(fixture.db, 'task', binding).resource_ids)).toEqual(new Set(['direct', 'imported']))
  const { resource_ids: _resources, ...legacy } = binding
  expect(loadConversation(fixture.db, 'task', legacy).resource_ids).toEqual([])
})

it('keeps the recent 64 messages intact and separate event navigation for older history', () => {
  const fixture = setup(); fixture.request()
  const ids: string[] = []
  for (let index = 0; index < 70; index++) ids.push(fixture.record('message.user', { text: `Original ${index}`, request_id: 'first' }).id)
  const history = loadConversation(fixture.db, 'task', captureConversation(fixture.db, 'task'))
  expect(history.messages).toHaveLength(64)
  expect(history.messages[0]?.source.id).toBe(ids[6])
  expect(history.messages.at(-1)?.source.id).toBe(ids[69])
  expect(history.refs).toEqual(ids.slice(0, 6).map(id => ({ kind: 'event', id })))
  expect(history.truncated).toBe(true)
})

it('retains an exact event reference instead of fabricating a shortened long answer', () => {
  const fixture = setup(); fixture.request()
  fixture.record('message.user', { text: 'Original question', request_id: 'first' })
  const text = '中😀'.repeat(50000), answer = fixture.answer(text)
  const history = loadConversation(fixture.db, 'task', captureConversation(fixture.db, 'task'))
  expect(history.messages).toHaveLength(1)
  expect(history.refs).toContainEqual({ kind: 'event', id: answer.id })
  expect(history.truncated).toBe(true)
  expect((fixture.db.prepare('SELECT payload_json FROM records WHERE id=?').get(answer.id) as { payload_json: string }).payload_json).toContain(text)
})

it('supports fixture output and final legacy replies without importing legacy tool batches', () => {
  const fixture = setup(); fixture.request()
  fixture.db.prepare("INSERT INTO runs(id,task_id,request_id,state,runtime_epoch,limits_json,budget_json,created_at) VALUES ('legacy','task','first','completed','epoch','{}','{}','time')").run()
  fixture.record('message.assistant', { text: 'Fixture answer', run_id: 'legacy', model_config_id: 'fixture' })
  fixture.record('model.response', { run_id: 'legacy', finish: 'tool_calls', message: { role: 'assistant', content: 'PRIVATE TOOL PLAN', tool_calls: [{ id: 'call' }] } })
  fixture.record('model.response', { run_id: 'legacy', finish: 'stop', message: { role: 'assistant', content: 'Legacy final answer' } })
  const binding = captureConversation(fixture.db, 'task'), history = loadConversation(fixture.db, 'task', binding)
  expect(binding.reply_to_request_id).toBe('first')
  expect(history.messages.map(item => item.message.content)).toEqual(['Fixture answer', 'Legacy final answer'])
})

it('rejects malformed snapshot bindings before reading conversation bodies', () => {
  const fixture = setup()
  expect(() => loadConversation(fixture.db, 'task', { version: 1, through_sequence: -1, reply_to_request_id: null })).toThrow(expect.objectContaining({ code: 'CONVERSATION_INVALID' }))
  expect(() => loadConversation(fixture.db, 'task', { version: 1, through_sequence: 0, reply_to_request_id: null, resource_ids: ['same', 'same'] })).toThrow(expect.objectContaining({ code: 'CONVERSATION_INVALID' }))
})

function capacityHistory(): ConversationHistory {
  return {
    messages: [1, 2, 3].map(sequence => ({
      source: { task_id: 'task', id: `message-${sequence}`, sequence, kind: 'message.user' },
      message: { role: 'user', content: `Original ${sequence}` }
    })),
    refs: [{ kind: 'event', id: 'older' }],
    truncated: false,
    resource_ids: ['material']
  }
}

it('tries the complete conversation first without changing a fitting input', () => {
  const history = capacityHistory(), original = structuredClone(history), attempts: ConversationHistory[] = []
  const fitted = fitConversation(history, candidate => { attempts.push(candidate); return true })
  expect(attempts).toEqual([original])
  expect(fitted).toEqual(original)
  expect(history).toEqual(original)
  expect(fitted.messages).not.toBe(history.messages)
  expect(fitted.refs).not.toBe(history.refs)
  expect(fitted.resource_ids).not.toBe(history.resource_ids)
})

it('moves the oldest messages to stable exact refs until the context fits', () => {
  const history = capacityHistory(), attempts: ConversationHistory[] = []
  history.refs.push({ kind: 'event', id: 'message-1' }, { kind: 'event', id: 'older' })
  const original = structuredClone(history)
  const fitted = fitConversation(history, candidate => { attempts.push(candidate); return candidate.messages.length <= 1 })
  expect(attempts[0]).toEqual(original)
  expect(fitted.messages).toEqual(original.messages.slice(2))
  expect(fitted.refs).toEqual(['older', 'message-1', 'message-2'].map(id => ({ kind: 'event', id })))
  expect(fitted.truncated).toBe(true)
  expect(fitted.resource_ids).toEqual(['material'])
  expect(history).toEqual(original)
})

it('keeps the newest exact ref when navigation also exceeds capacity', () => {
  const history = capacityHistory(), original = structuredClone(history)
  const fitted = fitConversation(history, candidate => !candidate.messages.length && candidate.refs.length <= 1)
  expect(fitted.messages).toEqual([])
  expect(fitted.refs).toEqual([{ kind: 'event', id: 'message-3' }])
  expect(fitted.truncated).toBe(true)
  expect(history).toEqual(original)
})

it('returns an empty candidate when the current request leaves no room for history', () => {
  const history = capacityHistory(), original = structuredClone(history), attempts: ConversationHistory[] = []
  const fitted = fitConversation(history, candidate => { attempts.push(candidate); return false })
  expect(attempts[0]).toEqual(original)
  expect(attempts.at(-1)).toEqual(fitted)
  expect(fitted).toEqual({ messages: [], refs: [], truncated: true, resource_ids: ['material'] })
  expect(history).toEqual(original)
  expect(fitConversation({ ...fitted, truncated: false }, () => false)).toEqual({ ...fitted, truncated: false })
})

it('keeps recent messages when older navigation would exhaust a 32k context', () => {
  const history = capacityHistory()
  history.messages = Array.from({ length: 64 }, (_, index) => ({
    source: { task_id: 'task', id: `message-${index}`, sequence: index + 1, kind: 'runner.answer' },
    message: { role: 'assistant', content: `Recent answer ${index}: ${'x'.repeat(100)}` }
  }))
  history.refs = Array.from({ length: 680 }, (_, index) => ({ kind: 'event', id: `older-${String(index).padStart(4, '0')}-${'x'.repeat(60)}` }))
  const original = structuredClone(history)
  const fits = (candidate: ConversationHistory) => Buffer.byteLength(JSON.stringify({ messages: candidate.messages.map(item => item.message), refs: candidate.refs })) <= 32000
  expect(fits(history)).toBe(false)
  const fitted = fitConversation(history, fits)
  expect(fits(fitted)).toBe(true)
  expect(fitted.messages).toEqual(original.messages)
  expect(fitted.refs.length).toBeGreaterThan(0)
  expect(fitted.refs.length).toBeLessThan(original.refs.length)
  expect(fitted.refs).toEqual(original.refs.slice(-fitted.refs.length))
  expect(fitted.truncated).toBe(true)
  expect(history).toEqual(original)
})
