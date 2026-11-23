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
import type { TaskMessagePage } from '../../src/shared/types'

type Row = Record<string, any>
const stores: RuntimeStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close(); vi.restoreAllMocks() })

const answer = (text: string): Completion => ({ text, calls: [], finish: 'stop', usage: { prompt_tokens: 30, completion_tokens: 8 } })
function deferred<T>() {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>(done => { resolve = done }), resolve: (value: T) => resolve(value) }
}
function setup(options: { directory?: string; task?: string; productionRuns?: 1 | 2; contextTokens?: number; conversationRouting?: boolean } = {}) {
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
  const store = new RuntimeStore(directory, models, { viewReplacement: true, runner: { productionRuns: options.productionRuns ?? 2, collator: 'rule', diagnostics: false, conversationRouting: options.conversationRouting } })
  stores.push(store)
  const internal = store as unknown as {
    db: Database.Database
    record(task: string, kind: string, payload: Row): string
    recordRunnerAnswer(task: string, payload: Row): string
    requests: { invalidateConfiguration(): void }
  }
  const db = internal.db, task = options.task ?? store.create('Continuous conversation').task.id
  const submit = (text: string) => store.handle({ type: 'request.submit', task_id: task, text, model_config_id: config.id, resource_ids: [], import_ids: [] }) as Row
  const requestInput = (request: string) => JSON.parse((db.prepare('SELECT input_json FROM requests WHERE task_id=? AND id=?').get(task, request) as Row).input_json) as Row
  const record = (kind: string, payload: Row) => internal.record(task, kind, payload)
  const messages = () => (store.handle({ type: 'host.messages.page', task_id: task }) as TaskMessagePage).items
  const records = (kind: string) => (db.prepare('SELECT id,sequence,payload_json FROM records WHERE task_id=? AND kind=? ORDER BY sequence').all(task, kind) as { id: string; sequence: number; payload_json: string }[]).map(row => ({ ...row, payload: JSON.parse(row.payload_json) }))
  const waitRun = async (run: string) => vi.waitFor(() => expect((db.prepare('SELECT state FROM runs WHERE task_id=? AND id=?').get(task, run) as Row).state).toBe('completed'))
  const close = () => { stores.splice(stores.indexOf(store), 1); store.close() }
  return { store, internal, db, task, config, directory, complete, sent, submit, requestInput, record, records, messages, waitRun, close }
}
const body = (messages: readonly ChatMessage[]) => messages.map(message => message.content ?? '').join('\n')
function importText(store: RuntimeStore, task: string, name: string, text: string): Row {
  const call = (type: string, extra: Row = {}) => store.handle({ type, task_id: task, ...extra }) as Row
  const operation = call('material.internal.register', { items: [{ display_name: name, source: 'text' }] }).items[0].operation_id
  const bytes = Buffer.from(text)
  call('material.internal.begin', { operation_id: operation, byte_length: bytes.length, media_type: 'text/plain; charset=utf-8' })
  call('material.internal.chunk', { operation_id: operation, offset: 0, data: bytes.toString('base64') })
  return call('material.internal.finish', { operation_id: operation }).resource
}

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

it('answers ordinary questions in one model call and reports actual progress without creating content requirements', async () => {
  const s = setup({ conversationRouting: true })
  const route = (value: Row) => answer(JSON.stringify(value))
  s.complete.mockResolvedValueOnce(route({ kind: 'reply', text: 'Use Cedar as the codename.' }))
    .mockResolvedValueOnce(route({ kind: 'reply', text: 'The codename was Cedar.' }))
    .mockResolvedValueOnce(route({ kind: 'progress' }))
  async function send(text: string) {
    const request = s.submit(text)
    const status = () => s.store.handle({ type: 'request.status', task_id: s.task, request_id: request.request_id }) as Row
    await vi.waitFor(() => expect(status()).toMatchObject({ state: 'started', run_state: 'completed' }))
    return request.request_id
  }
  await send('Pick a codename for this conversation.')
  await send('What was the codename?')
  await send('How much is complete?')
  expect(s.sent).toHaveLength(3)
  expect(s.sent[1]).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'assistant', content: 'Use Cedar as the codename.' })]))
  expect(s.messages().filter(message => message.role === 'assistant').map(message => message.text)).toEqual(['Use Cedar as the codename.', 'The codename was Cedar.', '已完成：2 次'])
  expect(s.store.runnerGoals({ task_id: s.task }).goals).toEqual([])
  expect(s.store.snapshot(s.task).views).toEqual([])
})

it('stops all open dialogue Runs and keeps earlier replies visible', async () => {
  const s = setup({ conversationRouting: true })
  const earlier = 'Earlier completed reply'
  s.complete.mockResolvedValueOnce(answer(JSON.stringify({ kind: 'reply', text: earlier })))
  const first = s.submit('Complete this round')
  const status = (request: Row) => s.store.handle({ type: 'request.status', task_id: s.task, request_id: request.request_id }) as Row
  await vi.waitFor(() => expect(status(first).run_state).toBe('completed'))
  const a = deferred<Completion>(), b = deferred<Completion>()
  s.complete.mockImplementationOnce(() => a.promise).mockImplementationOnce(() => b.promise)
  const left = s.submit('Open A'), right = s.submit('Open B')
  await vi.waitFor(() => expect(s.complete).toHaveBeenCalledTimes(3))
  s.store.handle({ type: 'task.stop', task_id: s.task })
  const late = answer(JSON.stringify({ kind: 'reply', text: 'A delayed result' }))
  a.resolve(late); b.resolve(late)
  await vi.waitFor(() => {
    expect(status(left).run_state).toBe('cancelled')
    expect(status(right).run_state).toBe('cancelled')
  })
  expect(s.messages().filter(message => message.role === 'assistant').map(message => message.text)).toEqual([earlier])
})

it.each([false, true])('only admits the bound preceding result while independent work proceeds (cancelled=%s)', async cancelled => {
  const s = setup({ conversationRouting: true }), source = deferred<Completion>()
  const routed = (value: Row) => answer(JSON.stringify(value))
  const status = (request: Row) => s.store.handle({ type: 'request.status', task_id: s.task, request_id: request.request_id }) as Row
  s.complete.mockImplementationOnce(() => source.promise)
  const parent = s.submit('Source question, keep running.')
  await vi.waitFor(() => expect(s.complete).toHaveBeenCalledTimes(1))
  const sourceMessage = s.messages().at(-1)!.id
  s.complete.mockResolvedValueOnce(routed({ kind: 'depends', message_id: sourceMessage }))
  const follow = s.submit('Expand the result once it arrives.')
  await vi.waitFor(() => expect(status(follow)).toMatchObject({ state: 'queued', code: 'CONVERSATION_WAITING_FOR_RESULT' }))
  s.complete.mockResolvedValueOnce(routed({ kind: 'reply', text: 'INDEPENDENT LATE REPLY' }))
  const independent = s.submit('Independent question.')
  await vi.waitFor(() => expect(status(independent)).toMatchObject({ state: 'started', run_state: 'completed' }))
  expect(status(follow).state).toBe('queued')
  if (cancelled) {
    s.store.handle({ type: 'request.cancel', task_id: s.task, request_id: parent.request_id })
    source.resolve(routed({ kind: 'reply', text: 'REVOKED' }))
    await vi.waitFor(() => expect(status(follow)).toMatchObject({ state: 'rejected', code: 'CONVERSATION_DEPENDENCY_UNAVAILABLE' }))
    expect(s.complete).toHaveBeenCalledTimes(3)
  } else {
    s.complete.mockResolvedValueOnce(routed({ kind: 'reply', text: 'The expanded result.' }))
    source.resolve(routed({ kind: 'reply', text: 'BOUND PARENT REPLY' }))
    await vi.waitFor(() => expect(status(follow)).toMatchObject({ state: 'started', run_state: 'completed' }))
    expect(s.sent).toHaveLength(4)
    expect(body(s.sent[3]!)).toContain('BOUND PARENT REPLY')
    expect(body(s.sent[3]!)).not.toContain('INDEPENDENT LATE REPLY')
    expect(s.requestInput(follow.request_id).conversation_dependency).toMatchObject({ message_id: sourceMessage, result_id: expect.any(String) })
  }
})

it('keeps reverse completions linked to the original inputs and confirms each result only once', async () => {
  const s = setup(), late = deferred<Completion>()
  s.complete.mockImplementationOnce(() => late.promise).mockResolvedValueOnce(answer('Answer B'))
  const first = s.submit('Question A')
  await vi.waitFor(() => expect(s.complete).toHaveBeenCalledTimes(1))
  const second = s.submit('Question B')
  await s.waitRun(second.run_id)
  late.resolve(answer('Answer A'))
  await s.waitRun(first.run_id)
  const [a, b, replyB, replyA] = s.messages()
  expect(s.messages().map(message => message.text)).toEqual(['Question A', 'Question B', 'Answer B', 'Answer A'])
  expect(replyA).toMatchObject({ reply_to: a!.id, run_id: first.run_id })
  expect(replyB).toMatchObject({ reply_to: b!.id, run_id: second.run_id })
  const accepted = s.records('runner.answer').at(-1)!
  expect(s.internal.recordRunnerAnswer(s.task, accepted.payload)).toBe(accepted.id)
  expect(s.records('runner.answer')).toHaveLength(2)
})

it('never projects a late result from a revoked Run as a conversation reply', async () => {
  const s = setup(), late = deferred<Completion>()
  s.complete.mockImplementationOnce(() => late.promise).mockResolvedValueOnce(answer('Independent answer'))
  const cancelled = s.submit('Cancel this run')
  await vi.waitFor(() => expect(s.complete).toHaveBeenCalledTimes(1))
  const retained = s.submit('Keep this run')
  s.store.handle({ type: 'host.runner.input', task_id: s.task, input_event_id: 'stop-only-first', kind: 'cancel_run', run_id: cancelled.run_id })
  late.resolve(answer('Revoked reply'))
  await s.waitRun(retained.run_id)
  await vi.waitFor(() => expect((s.db.prepare('SELECT state FROM runs WHERE id=?').get(cancelled.run_id) as Row).state).toBe('cancelled'))
  expect(s.messages().map(message => message.text)).toEqual(['Cancel this run', 'Keep this run', 'Independent answer'])
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

it('continues from a current recovery point without replaying prior requests', async () => {
  const s = setup({ conversationRouting: true })
  const reply = (text: string) => answer(JSON.stringify({ kind: 'reply', text }))
  const runState = (request: Row) => (s.store.handle({ type: 'request.status', task_id: s.task, request_id: request.request_id }) as Row).run_state
  const completed = (request: Row) => vi.waitFor(() => expect(runState(request)).toBe('completed'))
  const begin = () => (s.store.handle({ type: 'maintenance.begin' }) as Row).reservation.token
  s.complete.mockResolvedValueOnce(reply('Saved answer: northern route.'))
  await completed(s.submit('Choose a route.'))
  const saved = (await s.store.handle({ type: 'maintenance.create', token: begin(), inputs_saved: true, replace_id: null }) as Row).active
  s.complete.mockResolvedValueOnce(reply('Newer answer that will be rolled back.'))
  await completed(s.submit('Choose a route again.'))

  await s.store.handle({ type: 'maintenance.restore', token: begin(), point_id: saved.id, database_sha256: saved.database_sha256, inputs_saved: true, confirm_replace_newer_data: true })
  expect(s.messages().map(message => message.text)).toEqual(['Choose a route.', 'Saved answer: northern route.'])
  expect(s.complete).toHaveBeenCalledTimes(2)
  s.complete.mockResolvedValueOnce(reply('The northern route.'))
  await completed(s.submit('Which route did we choose?'))
  expect(s.complete).toHaveBeenCalledTimes(3)
  expect(body(s.sent[2]!)).toContain('Saved answer: northern route.')
  expect(body(s.sent[2]!)).not.toContain('Newer answer that will be rolled back.')
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

it('keeps accepted replies and the original correction readable after withdrawal', async () => {
  const s = setup()
  s.complete.mockResolvedValueOnce(answer('The first draft uses a blue cover.')).mockResolvedValueOnce(answer('Unrelated result.')).mockResolvedValueOnce(answer('The corrected draft uses a green cover.'))
  const first = s.submit('Create the first draft with a blue cover.')
  await s.waitRun(first.run_id)
  const unrelated = s.submit('Answer an unrelated question.')
  await s.waitRun(unrelated.run_id)
  const orphan = s.record('message.assistant', { text: 'Imported historical reply without a recorded parent.' })
  s.record('model.tool_result', { text: 'PRIVATE TOOL EVENT', run_id: unrelated.run_id })
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
  s.store.handle({ type: 'host.runner.input', task_id: s.task, input_event_id: 'withdraw-first', kind: 'withdraw_goal', request_id: first.request_id })
  const history = s.messages()
  expect(history.map(message => message.text)).toEqual([
    'Create the first draft with a blue cover.', 'The first draft uses a blue cover.',
    'Answer an unrelated question.', 'Unrelated result.', 'Imported historical reply without a recorded parent.',
    'Change the cover you just proposed to green.', 'The corrected draft uses a green cover.'
  ])
  expect(history[1]).toMatchObject({ reply_to: history[0]!.id })
  expect(history.find(message => message.id === orphan)?.reply_to).toBeNull()
  expect(history.at(-1)?.reply_to).toBe(history.at(-2)?.id)
})

it('discovers imported material by name and reads its original through an ordinary send', async () => {
  const s = setup(), name = 'schedule-notes.txt', original = 'SYNTHETIC MATERIAL: Δ token 73.'
  const imported = importText(s.store, s.task, name, original)
  let discovered = ''
  s.complete.mockImplementationOnce(async () => {
    const messages = s.sent.at(-1)!, input = JSON.parse(messages.filter(message => message.role === 'user').at(-1)!.content!) as Row
    expect(input.bound.materials).toEqual([{ id: imported.id, display_name: name, byte_length: Buffer.byteLength(original), media_type: 'text/plain; charset=utf-8', provenance_ref: { task_id: s.task, kind: 'resource', id: imported.id } }])
    expect(body(messages)).not.toContain(original)
    discovered = input.bound.materials.find((material: Row) => material.display_name === name).id
    return {
      text: '', finish: 'tool_calls', usage: { prompt_tokens: 30, completion_tokens: 8 },
      calls: [{ id: 'read-imported', type: 'function', function: { name: 'read', arguments: JSON.stringify({ kind: 'resource', id: discovered, selection: { view: 'text' } }) } }]
    }
  }).mockImplementationOnce(async () => {
    const tool = s.sent.at(-1)!.find(message => message.role === 'tool' && message.tool_call_id === 'read-imported')!
    const result = JSON.parse(tool.content!) as Row
    expect(result).toMatchObject({ execution: 'success', delivery: 'delivered', provenance_ref: { task_id: s.task, kind: 'resource', id: imported.id }, data: { metadata: { id: discovered }, data: { text: original } } })
    return answer('The imported source was read.')
  })

  const request = s.submit('Read the imported material.')
  await s.waitRun(request.run_id)
  expect(discovered).toBe(imported.id)
  expect(s.complete).toHaveBeenCalledTimes(2)
})

it('keeps prior material discoverable and readable when the next send explicitly selects only a new resource', async () => {
  const s = setup(), priorText = 'Prior source: Cedar.', nextText = 'Current source: Birch.'
  const prior = importText(s.store, s.task, 'prior.txt', priorText)
  const first = s.submit('Remember this source for our conversation.')
  await s.waitRun(first.run_id)
  const current = importText(s.store, s.task, 'current.txt', nextText)
  s.complete.mockImplementationOnce(async () => {
    const input = JSON.parse(s.sent.at(-1)!.filter(message => message.role === 'user').at(-1)!.content!) as Row
    const materials = input.bound.materials as Row[]
    expect(new Set(materials.map(material => material.id))).toEqual(new Set([prior.id, current.id]))
    const sources = ['prior.txt', 'current.txt'].map(name => materials.find(material => material.display_name === name)!)
    expect(sources.every(Boolean)).toBe(true)
    return {
      text: '', finish: 'tool_calls', usage: { prompt_tokens: 30, completion_tokens: 8 },
      calls: sources.map((source, index) => ({ id: `read-source-${index}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ kind: 'resource', id: source.id, selection: { view: 'text' } }) } }))
    }
  }).mockImplementationOnce(async () => {
    for (const [index, source] of [prior, current].entries()) {
      const tool = s.sent.at(-1)!.find(message => message.role === 'tool' && message.tool_call_id === `read-source-${index}`)!
      expect(JSON.parse(tool.content!)).toMatchObject({ execution: 'success', delivery: 'delivered', data: { metadata: { id: source.id }, data: { text: [priorText, nextText][index] } } })
    }
    return answer('Both the prior and current sources were read.')
  })

  const next = s.store.handle({ type: 'request.submit', task_id: s.task, text: 'Compare the previous source with this one.', model_config_id: s.config.id, resource_ids: [current.id], import_ids: [] }) as Row
  await s.waitRun(next.run_id)
  expect(s.requestInput(next.request_id).resource_ids).toEqual([current.id])
  expect(s.requestInput(next.request_id).bound_materials.map((material: Row) => material.id)).toEqual([current.id])
  expect(s.complete).toHaveBeenCalledTimes(3)
})

it('discovers and reads all current-Task resources through paged model tools while isolating other Tasks', async () => {
  const s = setup(), imported = importText(s.store, s.task, 'available-source.txt', 'Visible imported source.')
  const other = s.store.create('Other material task').task.id
  const foreign = importText(s.store, other, 'available-foreign.txt', 'PRIVATE FOREIGN SOURCE')
  let generated = ''
  s.complete.mockResolvedValueOnce({
    text: '', finish: 'tool_calls', usage: { prompt_tokens: 30, completion_tokens: 8 },
    calls: [{ id: 'create-working-source', type: 'function', function: { name: 'write', arguments: JSON.stringify({ operation: 'resource.create', input: { display_name: 'available-generated.txt', content: { type: 'text', text: 'Visible generated source.' } } }) } }]
  }).mockImplementationOnce(async () => {
    const tool = s.sent.at(-1)!.find(message => message.role === 'tool' && message.tool_call_id === 'create-working-source')!
    const result = JSON.parse(tool.content!) as Row
    expect(result).toMatchObject({ execution: 'success', delivery: 'delivered' })
    generated = result.data.id
    return answer('The initial request completed.')
  })
  const first = s.submit('Prepare a separate working result.')
  await s.waitRun(first.run_id)
  expect(s.db.prepare('SELECT 1 FROM task_resources WHERE task_id=? AND resource_id=?').get(s.task, generated)).toBeTruthy()
  const listed: Row[] = []
  s.complete.mockImplementationOnce(async () => {
    const messages = s.sent.at(-1)!, input = JSON.parse(messages.filter(message => message.role === 'user').at(-1)!.content!) as Row
    expect(input.bound.materials.map((material: Row) => material.id)).toEqual([imported.id])
    for (const hidden of [generated, foreign.id, 'available-generated.txt', 'available-foreign.txt', 'PRIVATE FOREIGN SOURCE']) expect(body(messages)).not.toContain(hidden)
    return {
      text: '', finish: 'tool_calls', usage: { prompt_tokens: 30, completion_tokens: 8 },
      calls: [{ id: 'list-first-page', type: 'function', function: { name: 'list', arguments: JSON.stringify({ kind: 'resource', filters: { name_query: 'AVAILABLE-' }, limit: 1 }) } }]
    }
  }).mockImplementationOnce(async () => {
    const tool = s.sent.at(-1)!.find(message => message.role === 'tool' && message.tool_call_id === 'list-first-page')!
    const result = JSON.parse(tool.content!) as Row
    expect(result).toMatchObject({ execution: 'success', delivery: 'delivered', data: { items: [expect.objectContaining({ id: expect.any(String), media_type: 'text/plain; charset=utf-8' })], next_cursor: expect.any(String) } })
    listed.push(...result.data.items)
    expect(result.data.next_call).toMatchObject({ name: 'list', arguments: { kind: 'resource', filters: { name_query: 'AVAILABLE-' }, limit: 1, cursor: result.data.next_cursor } })
    return {
      text: '', finish: 'tool_calls', usage: { prompt_tokens: 30, completion_tokens: 8 },
      calls: [{ id: 'list-next-page', type: 'function', function: { name: result.data.next_call.name, arguments: JSON.stringify(result.data.next_call.arguments) } }]
    }
  }).mockImplementationOnce(async () => {
    const tool = s.sent.at(-1)!.find(message => message.role === 'tool' && message.tool_call_id === 'list-next-page')!
    const result = JSON.parse(tool.content!) as Row
    expect(result).toMatchObject({ execution: 'success', delivery: 'delivered', data: { items: [expect.objectContaining({ id: expect.any(String), media_type: 'text/plain; charset=utf-8' })], next_cursor: null } })
    listed.push(...result.data.items)
    expect(new Set(listed.map(resource => resource.id))).toEqual(new Set([imported.id, generated]))
    expect(listed.map(resource => resource.display_name).sort()).toEqual(['available-generated.txt', 'available-source.txt'])
    expect(body(s.sent.at(-1)!)).not.toContain('PRIVATE FOREIGN SOURCE')
    expect(body(s.sent.at(-1)!)).not.toContain(foreign.id)
    return {
      text: '', finish: 'tool_calls', usage: { prompt_tokens: 30, completion_tokens: 8 },
      calls: [
        { id: 'list-generated-name', type: 'function', function: { name: 'list', arguments: JSON.stringify({ kind: 'resource', filters: { name_query: 'GENERATED' } }) } },
        ...[...listed.map(resource => resource.id), foreign.id].map((id, index) => ({ id: `read-resource-${index}`, type: 'function' as const, function: { name: 'read', arguments: JSON.stringify({ kind: 'resource', id, selection: { view: 'text' } }) } }))
      ]
    }
  }).mockImplementationOnce(async () => {
    const messages = s.sent.at(-1)!, result = (id: string) => JSON.parse(messages.find(message => message.role === 'tool' && message.tool_call_id === id)!.content!) as Row
    expect(result('list-generated-name')).toMatchObject({ execution: 'success', data: { items: [{ id: generated }], next_cursor: null } })
    for (const [index, resource] of listed.entries()) {
      expect(result(`read-resource-${index}`)).toMatchObject({ execution: 'success', delivery: 'delivered', data: { metadata: { id: resource.id }, data: { text: resource.id === imported.id ? 'Visible imported source.' : 'Visible generated source.' } } })
    }
    expect(result(`read-resource-${listed.length}`)).toMatchObject({ execution: 'not_executed', delivery: 'delivered', error: { code: 'NOT_FOUND' } })
    expect(body(messages)).not.toContain('PRIVATE FOREIGN SOURCE')
    return {
      text: '', finish: 'tool_calls', usage: { prompt_tokens: 30, completion_tokens: 8 },
      calls: [{ id: 'read-missing-resource', type: 'function', function: { name: 'read', arguments: JSON.stringify({ kind: 'resource', id: 'absent-resource', selection: { view: 'text' } }) } }]
    }
  }).mockImplementationOnce(async () => {
    const tool = s.sent.at(-1)!.find(message => message.role === 'tool' && message.tool_call_id === 'read-missing-resource')!
    expect(JSON.parse(tool.content!)).toMatchObject({ execution: 'not_executed', delivery: 'delivered', error: { code: 'NOT_FOUND' } })
    return answer('The available Task resources were read.')
  })

  const next = s.submit('Continue using the available material.')
  await s.waitRun(next.run_id)
  expect(s.requestInput(next.request_id).bound_materials.map((material: Row) => material.id)).toEqual([imported.id])
  expect(s.complete).toHaveBeenCalledTimes(7)
})

it('discovers and reads a resource created during the current model execution', async () => {
  const s = setup(), text = 'A source created after the Worker input snapshot.'
  let created = ''
  s.complete.mockResolvedValueOnce({
    text: '', finish: 'tool_calls', usage: { prompt_tokens: 30, completion_tokens: 8 },
    calls: [{ id: 'create-live-source', type: 'function', function: { name: 'write', arguments: JSON.stringify({ operation: 'resource.create', input: { display_name: 'live-source.txt', content: { type: 'text', text } } }) } }]
  }).mockImplementationOnce(async () => {
    const tool = s.sent.at(-1)!.find(message => message.role === 'tool' && message.tool_call_id === 'create-live-source')!
    const result = JSON.parse(tool.content!) as Row
    expect(result).toMatchObject({ execution: 'success', delivery: 'delivered' })
    created = result.data.id
    return {
      text: '', finish: 'tool_calls', usage: { prompt_tokens: 30, completion_tokens: 8 },
      calls: [
        { id: 'list-live-source', type: 'function', function: { name: 'list', arguments: JSON.stringify({ kind: 'resource' }) } },
        { id: 'read-live-source', type: 'function', function: { name: 'read', arguments: JSON.stringify({ kind: 'resource', id: created, selection: { view: 'text' } }) } }
      ]
    }
  }).mockImplementationOnce(async () => {
    const messages = s.sent.at(-1)!, result = (id: string) => JSON.parse(messages.find(message => message.role === 'tool' && message.tool_call_id === id)!.content!) as Row
    expect(result('list-live-source')).toMatchObject({ execution: 'success', delivery: 'delivered', data: { items: [{ id: created, display_name: 'live-source.txt' }], next_cursor: null } })
    expect(result('read-live-source')).toMatchObject({ execution: 'success', delivery: 'delivered', data: { metadata: { id: created }, data: { text } } })
    return answer('The newly created Task source was read.')
  })

  const request = s.submit('Create and inspect a working source.')
  await s.waitRun(request.run_id)
  expect(s.requestInput(request.request_id).bound_materials).toEqual([])
  expect(s.complete).toHaveBeenCalledTimes(3)
})
