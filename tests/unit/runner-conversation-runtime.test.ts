import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, expect, it, vi } from 'vitest'
import { ChatAdapter, type ChatMessage, type Completion } from '../../src/runtime/model/adapter'
import { ModelService, type ModelLease } from '../../src/runtime/model/service'
import { modelToolRequest } from '../../src/runtime/model/tool-input'
import { RuntimeStore } from '../../src/runtime/store'
import type { ModelConfiguration } from '../../src/shared/contracts.generated'

type Row = Record<string, any>
const stores: RuntimeStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close(); vi.restoreAllMocks() })

const answer = (text: string): Completion => ({ text, calls: [], finish: 'stop', usage: { prompt_tokens: 30, completion_tokens: 8 } })
function deferred<T>() {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>(done => { resolve = done }), resolve: (value: T) => resolve(value) }
}
function setup(options: { directory?: string; task?: string; productionRuns?: 1 | 2; contextTokens?: number } = {}) {
  const adapter = new ChatAdapter(), models = new ModelService(adapter)
  const config: ModelConfiguration = { id: 'conversation', base_url: 'https://example.invalid/v1', wire_model_id: 'synthetic', context_tokens: options.contextTokens ?? 100000, max_output_tokens: 4096, compatibility_profile: 'chat-max-tokens' }
  models.configure({ type: 'model.configure', configuration: config, api_key: 'synthetic', confirm_memory_only: true })
  vi.spyOn(models, 'list').mockReturnValue([{ ...config, revision: 1, roles: ['main'], credential_missing: false }])
  vi.spyOn(models, 'acquire').mockImplementation((): ModelLease => ({ id: config.id, revision: 1, config, release() {} }))
  vi.spyOn(models, 'acquireCompaction').mockReturnValue(undefined)
  const complete = vi.spyOn(adapter, 'complete').mockResolvedValue(answer('Synthetic final answer'))
  const sent: ChatMessage[][] = [], request = models.request.bind(models)
  vi.spyOn(models, 'request').mockImplementation((...args) => { sent.push(structuredClone(args[2])); return request(...args) })
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), 'pliuna-conversation-runtime-'))
  const store = new RuntimeStore(directory, models, { viewReplacement: true, runner: { productionRuns: options.productionRuns ?? 2, collator: 'rule', diagnostics: false } })
  stores.push(store)
  const internal = store as unknown as {
    db: Database.Database
    record(task: string, kind: string, payload: Row): string
    requests: { invalidateConfiguration(): void }
  }
  const db = internal.db, task = options.task ?? store.create('Continuous conversation').task.id
  const submit = (text: string) => store.handle({ type: 'request.submit', task_id: task, text, model_config_id: config.id, resource_ids: [], import_ids: [] }) as Row
  const requestInput = (request: string) => JSON.parse((db.prepare('SELECT input_json FROM requests WHERE task_id=? AND id=?').get(task, request) as Row).input_json) as Row
  const record = (kind: string, payload: Row) => internal.record(task, kind, payload)
  const records = (kind: string) => (db.prepare('SELECT id,sequence,payload_json FROM records WHERE task_id=? AND kind=? ORDER BY sequence').all(task, kind) as { id: string; sequence: number; payload_json: string }[]).map(row => ({ ...row, payload: JSON.parse(row.payload_json) }))
  const waitRun = async (run: string) => vi.waitFor(() => expect((db.prepare('SELECT state FROM runs WHERE task_id=? AND id=?').get(task, run) as Row).state).toBe('completed'))
  const close = () => { stores.splice(stores.indexOf(store), 1); store.close() }
  return { store, internal, db, task, config, directory, complete, sent, submit, requestInput, record, records, waitRun, close }
}
const body = (messages: readonly ChatMessage[]) => messages.map(message => message.content ?? '').join('\n')

it('continues ordinary sends with the real preceding user and accepted assistant messages', async () => {
  const s = setup()
  s.complete.mockResolvedValueOnce(answer('The agreed codename is Cedar.')).mockResolvedValueOnce(answer('Cedar is the codename we agreed on.'))
  const first = s.submit('Choose a codename and remember our decision.')
  await s.waitRun(first.run_id)
  const second = s.submit('What was the codename we just agreed on?')
  await s.waitRun(second.run_id)

  expect(s.complete).toHaveBeenCalledTimes(2)
  const messages = s.sent[1]!
  expect(messages.some(message => message.role === 'user' && message.content?.includes('Choose a codename and remember our decision.'))).toBe(true)
  expect(messages.some(message => message.role === 'assistant' && message.content === 'The agreed codename is Cedar.')).toBe(true)
  expect(messages.at(-1)?.role).toBe('user')
  expect(messages.at(-1)?.content).toContain('What was the codename we just agreed on?')
  expect(s.requestInput(second.request_id).conversation).toMatchObject({ version: 1, reply_to_request_id: first.request_id })
  const copies = s.records('worker.conversation').filter(record => record.payload.owner.run_id === second.run_id)
  expect(copies).toHaveLength(2)
  expect(copies.map(record => record.payload.conversation_source.id)).toEqual([
    s.records('message.user').find(record => record.payload.request_id === first.request_id)!.id,
    s.records('runner.answer')[0]!.id
  ])
  expect(s.store.runnerGoals({ task_id: s.task }).goals.every(goal => goal.intent_revision === 1)).toBe(true)
})

it('continues within a small context and authorizes paged reads of a large original answer', async () => {
  const s = setup({ contextTokens: 32000 })
  const start = 'OLD-ANSWER-BEGIN', end = 'OLD-ANSWER-END'
  const original = start + 'x'.repeat(40 * 1024 - start.length - end.length) + end
  s.complete.mockResolvedValueOnce(answer(original))
  const first = s.submit('Produce the original detailed answer.')
  await s.waitRun(first.run_id)
  const originalId = s.records('runner.answer')[0]!.id
  let pagesRead = 0, recovered = ''
  s.complete.mockResolvedValueOnce({
    text: '',
    calls: [{ id: 'read-original', type: 'function', function: { name: 'read', arguments: JSON.stringify({ kind: 'event', id: originalId, max_chars: 4096 }) } }],
    finish: 'tool_calls', usage: { prompt_tokens: 30, completion_tokens: 8 }
  }).mockImplementationOnce(async () => {
    const tool = s.sent.at(-1)!.filter(message => message.role === 'tool').at(-1)!
    const result = JSON.parse(tool.content!) as Row
    expect(result).toMatchObject({ execution: 'success', delivery: 'delivered' })
    let page = result.data as Row
    expect(page.metadata.id).toBe(originalId)
    expect(page.data.text).toContain(start)
    expect(page.next_cursor).toEqual(expect.any(String))
    recovered = page.data.text
    pagesRead++
    const owner = s.records('worker.input').at(-1)!.payload.owner
    const signal = new AbortController().signal
    // Host acceptance reads the remaining pages through the live Worker authority.
    // These extra pages are not inserted into the provider's context.
    while (page.next_cursor && pagesRead < 32) {
      const next = await s.store.workerTool(owner.attempt_id, modelToolRequest('read', { kind: 'event', id: originalId, cursor: page.next_cursor }), signal) as Row
      expect(next).toMatchObject({ execution: 'success', delivery: 'delivered' })
      page = next.data
      expect(page.metadata.id).toBe(originalId)
      recovered += page.data.text
      pagesRead++
    }
    expect(page.next_cursor).toBeNull()
    expect(JSON.parse(recovered).payload.text).toBe(original)
    return answer('Continued after reading the original answer.')
  })
  const second = s.submit('Continue from that answer.')
  await s.waitRun(second.run_id)

  expect(s.complete).toHaveBeenCalledTimes(3)
  expect(body(s.sent[1]!)).toContain('Continue from that answer.')
  expect(body(s.sent[1]!)).not.toContain(original)
  const input = s.records('worker.input').find(record => record.payload.owner.run_id === second.run_id)!.payload
  expect(input.conversation_history).toMatchObject({ truncated: true, refs: expect.arrayContaining([{ kind: 'event', id: originalId }]) })
  expect(pagesRead).toBeGreaterThan(1)
  expect(JSON.parse(recovered).payload.text).toBe(original)
  expect(s.records('model.context.rejected').filter(record => record.payload.run_id === second.run_id)).toEqual([])
})

it('freezes queued conversation at acceptance and retains that binding through explicit confirmation', async () => {
  const s = setup({ productionRuns: 1 }), pending = deferred<Completion>()
  s.complete.mockImplementationOnce(() => pending.promise).mockResolvedValueOnce(answer('The queued follow-up completed.'))
  const first = s.submit('Prior request visible before the follow-up.')
  await vi.waitFor(() => expect(s.complete).toHaveBeenCalledTimes(1))
  const second = s.submit('Queued follow-up, preserve its original context.')
  expect(second.state).toBe('queued')
  const binding = structuredClone(s.requestInput(second.request_id).conversation)
  expect(binding).toMatchObject({ version: 1, reply_to_request_id: first.request_id })

  s.internal.requests.invalidateConfiguration()
  expect((s.store.handle({ type: 'request.status', task_id: s.task, request_id: second.request_id }) as Row).state).toBe('confirmation_required')
  s.record('message.user', { text: 'FUTURE USER INPUT MUST STAY OUT', request_id: 'later-request' })
  s.store.handle({ type: 'request.resolve', task_id: s.task, request_id: second.request_id, model_config_id: s.config.id, use_successful: false, replacements: [], confirm: true })
  expect(s.requestInput(second.request_id).conversation).toEqual(binding)

  pending.resolve(answer('LATE ANSWER MUST STAY OUT'))
  await s.waitRun(first.run_id)
  await vi.waitFor(() => expect(s.complete).toHaveBeenCalledTimes(2))
  const status = s.store.handle({ type: 'request.status', task_id: s.task, request_id: second.request_id }) as Row
  await s.waitRun(status.run_id)
  const messages = s.sent[1]!
  expect(body(messages)).toContain('Prior request visible before the follow-up.')
  expect(body(messages)).toContain('Queued follow-up, preserve its original context.')
  expect(body(messages)).not.toContain('FUTURE USER INPUT MUST STAY OUT')
  expect(body(messages)).not.toContain('LATE ANSWER MUST STAY OUT')
  expect(s.requestInput(second.request_id).conversation).toEqual(binding)
})

it('restores continuous dialogue from persistent accepted records after reopening the runtime', async () => {
  const first = setup()
  first.complete.mockResolvedValueOnce(answer('We selected the northern route.'))
  const original = first.submit('Choose the route for this trip.')
  await first.waitRun(original.run_id)
  const { directory, task } = first
  first.close()

  const reopened = setup({ directory, task })
  reopened.complete.mockResolvedValueOnce(answer('The northern route was selected earlier.'))
  const continuation = reopened.submit('Which route did we choose before restarting?')
  await reopened.waitRun(continuation.run_id)
  const messages = reopened.sent[0]!
  expect(messages.some(message => message.role === 'user' && message.content?.includes('Choose the route for this trip.'))).toBe(true)
  expect(messages.some(message => message.role === 'assistant' && message.content === 'We selected the northern route.')).toBe(true)
  expect(body(messages)).toContain('Which route did we choose before restarting?')
  expect(reopened.requestInput(continuation.request_id).conversation.reply_to_request_id).toBe(original.request_id)
})

it('excludes private worker, tool, diagnostic and other-Task history from the next dialogue turn', async () => {
  const s = setup()
  s.complete.mockResolvedValueOnce(answer('PUBLIC ACCEPTED REPLY')).mockResolvedValueOnce(answer('Public follow-up reply'))
  const first = s.submit('PUBLIC USER QUESTION')
  await s.waitRun(first.run_id)
  const accepted = s.records('runner.answer')[0]!.payload
  s.record('worker.input', { text: 'PRIVATE WORKER INPUT', owner: accepted.owner, run_id: first.run_id })
  s.record('model.response', { message: { role: 'assistant', content: 'PRIVATE MODEL TRACE' }, owner: accepted.owner, run_id: first.run_id })
  s.record('model.tool_result', { message: { role: 'tool', tool_call_id: 'private-call', content: 'PRIVATE TOOL RESULT' }, owner: accepted.owner, run_id: first.run_id })
  s.record('message.assistant.partial', { text: 'PRIVATE PARTIAL RESPONSE', run_id: first.run_id })
  s.record('message.assistant', { text: 'PRIVATE BACKGROUND ASSISTANT', run_id: first.run_id })
  s.record('runner.answer', { ...accepted, text: 'PRIVATE DIAGNOSTIC ANSWER', owner: { ...accepted.owner, role: 'diagnostic' } })
  s.record('runner.answer', { ...accepted, text: 'PRIVATE COLLATOR ANSWER', owner: { ...accepted.owner, role: 'collator' } })
  const other = s.store.create('Other task').task.id
  s.internal.record(other, 'message.user', { text: 'PRIVATE OTHER TASK INPUT' })

  const next = s.submit('Continue our public conversation.')
  await s.waitRun(next.run_id)
  const messages = s.sent[1]!, input = body(messages)
  expect(messages.some(message => message.role === 'assistant' && message.content === 'PUBLIC ACCEPTED REPLY')).toBe(true)
  expect(input).toContain('PUBLIC USER QUESTION')
  expect(input).not.toContain('PRIVATE')
  expect(messages.every(message => message.role !== 'tool')).toBe(true)
})

it('carries the prior accepted answer into a corrected goal without changing an unrelated goal', async () => {
  const s = setup()
  s.complete.mockResolvedValueOnce(answer('The first draft uses a blue cover.')).mockResolvedValueOnce(answer('Unrelated result.')).mockResolvedValueOnce(answer('The corrected draft uses a green cover.'))
  const first = s.submit('Create the first draft with a blue cover.')
  await s.waitRun(first.run_id)
  const unrelated = s.submit('Answer an unrelated question.')
  await s.waitRun(unrelated.run_id)
  const receipt = s.store.handle({ type: 'host.runner.input', task_id: s.task, input_event_id: 'make-cover-green', kind: 'correction', request_id: first.request_id, text: 'Change the cover you just proposed to green.' }) as Row
  expect(receipt.state).toBe('installed')
  await vi.waitFor(() => expect(s.complete).toHaveBeenCalledTimes(3))
  const corrected = s.db.prepare("SELECT run_id FROM runner_runs WHERE task_id=? AND request_id=? AND intent_revision=2 AND purpose='production'").get(s.task, first.request_id) as Row
  await s.waitRun(corrected.run_id)
  const messages = s.sent[2]!
  expect(messages.some(message => message.role === 'assistant' && message.content === 'The first draft uses a blue cover.')).toBe(true)
  expect(body(messages)).toContain('Change the cover you just proposed to green.')
  const goals = s.store.runnerGoals({ task_id: s.task }).goals
  expect(goals.find(goal => goal.request_id === first.request_id)?.intent_revision).toBe(2)
  expect(goals.find(goal => goal.request_id === unrelated.request_id)?.intent_revision).toBe(1)
})
