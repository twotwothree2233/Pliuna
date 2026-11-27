import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, expect, it, vi } from 'vitest'
import { runtimeFeatures } from '../../src/runtime/features'
import { ChatAdapter, ModelError, type ChatMessage, type Completion } from '../../src/runtime/model/adapter'
import { ModelService, type ModelLease } from '../../src/runtime/model/service'
import { modelToolRequest } from '../../src/runtime/model/tool-input'
import type { RunnerAdmission } from '../../src/runtime/runner/admission'
import { RUNNER_LIMITS } from '../../src/runtime/runner/limits'
import { DISCOVER_INPUTS, READ_BOUND_INPUT, READ_WORK_OUTPUT, REPORT_MISSING_INPUT, ROUTE_WORK } from '../../src/runtime/runner/orchestration-tool'
import { RunnerWorkState } from '../../src/runtime/runner/work-state'
import { RuntimeStore } from '../../src/runtime/store'
import type { ModelConfiguration } from '../../src/shared/contracts.generated'
import defaults from '../../src/shared/contracts/development-defaults.json'
import type { LiveFlowSnapshot, TaskMessagePage } from '../../src/shared/types'

type Row = Record<string, any>
const stores: RuntimeStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close(); vi.restoreAllMocks() })

const answer = (text: string): Completion => ({ text, calls: [], finish: 'stop', usage: { prompt_tokens: 30, completion_tokens: 8 } })
const invoke = (capability: string, input: unknown): Completion => ({ ...answer(''), finish: 'tool_calls', calls: [
  { id: `call-${capability}`, type: 'function', function: { name: 'call', arguments: JSON.stringify({ capability, input_json: JSON.stringify(input) }) } }
] })
function deferred<T>() {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>(done => { resolve = done }), resolve: (value: T) => resolve(value) }
}
function setup(options: { directory?: string; task?: string; productionRuns?: 1 | 2; contextTokens?: number; conversationRouting?: boolean; releaseProfile?: boolean } = {}) {
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
  const store = new RuntimeStore(directory, models, options.releaseProfile ? runtimeFeatures({}) : { viewReplacement: true, runner: { productionRuns: options.productionRuns ?? 2, collator: 'rule', diagnostics: false, conversationRouting: options.conversationRouting } })
  stores.push(store)
  const internal = store as unknown as {
    db: Database.Database
    record(task: string, kind: string, payload: Row): string
    recordRunnerAnswer(task: string, payload: Row): string
    requests: { invalidateConfiguration(): void }
  }
  const db = internal.db, task = options.task ?? store.create('Continuous conversation').task.id
  const submit = (text: string, resource_ids: string[] = [], model_config_id = config.id) => store.handle({ type: 'request.submit', task_id: task, text, model_config_id, resource_ids, import_ids: [] }) as Row
  const requestInput = (request: string) => JSON.parse((db.prepare('SELECT input_json FROM requests WHERE task_id=? AND id=?').get(task, request) as Row).input_json) as Row
  const record = (kind: string, payload: Row) => internal.record(task, kind, payload)
  const messages = () => (store.handle({ type: 'host.messages.page', task_id: task }) as TaskMessagePage).items
  const records = (kind: string) => (db.prepare('SELECT id,sequence,payload_json FROM records WHERE task_id=? AND kind=? ORDER BY sequence').all(task, kind) as { id: string; sequence: number; payload_json: string }[]).map(row => ({ ...row, payload: JSON.parse(row.payload_json) }))
  const waitRun = async (run: string) => vi.waitFor(() => expect((db.prepare('SELECT state FROM runs WHERE task_id=? AND id=?').get(task, run) as Row).state).toBe('completed'))
  const close = () => { stores.splice(stores.indexOf(store), 1); store.close() }
  return { store, internal, db, task, config, models, directory, complete, sent, submit, requestInput, record, records, messages, waitRun, close }
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

it('saves a direct assignment while production is occupied and starts it without asking the Router again', async () => {
  const s = setup({ conversationRouting: true, productionRuns: 1 }), first = deferred<Completion>()
  const status = (request: Row) => s.store.handle({ type: 'request.status', task_id: s.task, request_id: request.request_id }) as Row
  s.complete.mockResolvedValueOnce(answer('{"kind":"new"}')).mockImplementationOnce(() => first.promise)
  const blocker = s.submit('Keep the production slot occupied.')
  await vi.waitFor(() => expect(status(blocker).state).toBe('started'))
  s.complete.mockResolvedValueOnce(invoke(ROUTE_WORK, { action: 'dispatch', base_revision: 0, final_answer: 'answerer', assignments: [
    { assignment_key: 'answerer', instructions: 'Answer in one sentence', required: true, requirement_ids: ['answer'], outputs: [{ kind: 'answer', output_key: 'response' }] }
  ] })).mockResolvedValueOnce(answer('{"kind":"delegate"}')).mockImplementationOnce(async (_config, _key, messages) => {
    expect(messages[0]?.content).toContain('Answer in one sentence')
    return answer('The direct result.')
  })
  const queued = s.submit('Delegate this answer.')
  await vi.waitFor(() => expect(s.requestInput(queued.request_id)).toMatchObject({ code: 'PRODUCTION_ADMISSION_PENDING', admission_dispatch: { plan: { final_answer: 'answerer' } } }))
  expect(s.records('runner.plan.installed').filter(({ payload }) => payload.request_id === queued.request_id)).toHaveLength(0)
  expect(s.complete).toHaveBeenCalledTimes(4)
  first.resolve(answer('The slot can be released.'))
  await vi.waitFor(() => expect(status(queued)).toMatchObject({ state: 'started', run_state: 'completed' }))
  expect(s.complete).toHaveBeenCalledTimes(5)
  expect(s.records('runner.plan.installed').filter(({ payload }) => payload.request_id === queued.request_id)).toHaveLength(1)
  expect(s.records('runner.answer').map(({ payload }) => payload.text)).toContain('The direct result.')
})

it('asks the Router to correct a trailing status report without repeating a saved dispatch', async () => {
  const s = setup({ conversationRouting: true })
  s.complete.mockResolvedValueOnce(invoke(ROUTE_WORK, { action: 'dispatch', base_revision: 0, final_answer: 'writer', assignments: [
    { assignment_key: 'writer', instructions: 'Write the reply', required: true, requirement_ids: ['answer'], outputs: [{ kind: 'answer', output_key: 'reply' }] }
  ] })).mockImplementationOnce(async (_config, _key, messages) => {
    expect(messages[0]?.content).toContain('no prose, Markdown or status report')
    return answer('{"kind":"delegate"}\n\nThe assignment has started.')
  }).mockImplementationOnce(async (_config, _key, messages) => {
    expect(messages[0]?.content).toContain('keep that draft and return only its route')
    expect(JSON.parse(messages.find(message => message.role === 'tool')!.content!)).toMatchObject({ execution: 'success', data: { revision: 1 } })
    expect(s.records('runner.plan.installed')).toHaveLength(0)
    return answer('{"kind":"delegate"}')
  }).mockResolvedValueOnce(answer('The actual reply.'))
  const request = s.submit('Assign a Worker to reply.')
  await vi.waitFor(() => expect(s.store.handle({ type: 'request.status', task_id: s.task, request_id: request.request_id })).toMatchObject({ delivery_state: 'complete' }))
  expect(s.records('worker.result.rejected')).toHaveLength(1)
  expect(s.records('runner.plan.installed')).toHaveLength(1)
  expect(s.records('runner.answer').map(({ payload }) => payload.text)).toEqual(['The actual reply.'])
})

it('returns a stale content binding to the Router before installing a draft', async () => {
  const runtime = setup({ conversationRouting: true })
  const material = importText(runtime.store, runtime.task, 'Active notes', 'Original notes.')
  const dispatch = (revision: number, inputs: unknown[]) => invoke(ROUTE_WORK, { action: 'dispatch', base_revision: revision, final_answer: 'reply', assignments: [
    { assignment_key: 'reply', instructions: 'Write the reply', required: true, requirement_ids: ['answer'], outputs: [{ kind: 'answer', output_key: 'text' }], inputs }
  ] })
  runtime.complete.mockResolvedValueOnce(dispatch(0, [{ kind: 'material', resource_id: material.id }]))
    .mockImplementationOnce(async (_config, _key, messages) => {
      expect(JSON.parse(messages.at(-1)!.content!)).toMatchObject({ execution: 'success', data: { revision: 1 } })
      runtime.record('material.removed', { resource_id: material.id })
      return answer('{"kind":"delegate"}')
    }).mockImplementationOnce(async (_config, _key, messages) => {
      expect(messages[0]?.content).toContain('removed from active materials')
      expect(messages[0]?.content).toContain(material.id)
      expect(runtime.records('runner.plan.installed')).toHaveLength(0)
      return dispatch(2, [])
    }).mockResolvedValueOnce(answer('{"kind":"delegate"}')).mockResolvedValueOnce(answer('Reply without the removed material.'))
  const request = runtime.submit('Use the active notes if available.')
  await vi.waitFor(() => expect(runtime.store.handle({ type: 'request.status', task_id: runtime.task, request_id: request.request_id })).toMatchObject({ delivery_state: 'complete' }))
  expect(runtime.records('worker.result.rejected')).toHaveLength(1)
  expect(runtime.records('runner.plan.installed')).toHaveLength(1)
})

it('supplies the previous publication requirement on continuation and keeps the lecture body out of chat', async () => {
  const s = setup({ conversationRouting: true })
  const status = (request: Row) => s.store.handle({ type: 'request.status', task_id: s.task, request_id: request.request_id }) as Row
  const lecture = 'The Markov property conditions transitions on the current state.'
  s.complete.mockResolvedValueOnce(answer('{"kind":"new"}')).mockImplementationOnce(async (_config, _key, messages) => {
    const { owner } = JSON.parse(messages[0]!.content!.split('Bound data: ').at(-1)!) as Row
    const { task_id, request_id, intent_revision } = owner
    return answer(JSON.stringify({ version: 1, complete: true, answer: null, artifacts: [], requirement_ids: [], unresolved: [{ task_id, request_id, intent_revision, requirement_id: 'content' }] }))
  })
  const original = s.submit('生成强化学习讲义')
  await vi.waitFor(() => expect(status(original)).toMatchObject({ delivery_state: 'incomplete' }))
  expect(s.store.snapshot(s.task).views).toEqual([])

  s.complete.mockImplementationOnce(async (_config, _key, messages) => {
    expect(messages[0]?.content).toContain('Do not substitute a chat answer for an unfinished publication.')
    expect(JSON.parse(messages.at(-1)!.content!)).toMatchObject({ request: '继续', preceding_delivery: {
      request_id: original.request_id, intent_revision: 1, state: 'incomplete', required_outputs: ['artifact']
    } })
    return invoke(ROUTE_WORK, { action: 'dispatch', base_revision: 0, assignments: [
      { assignment_key: 'lecture', instructions: 'Publish the lecture in the View', required: true, requirement_ids: ['content'], outputs: [{ kind: 'artifact', output_key: 'lecture', exposure: 'publish' }] }
    ] })
  }).mockResolvedValueOnce(answer('{"kind":"new"}')).mockImplementationOnce(async (_config, _key, messages) => {
    expect(messages[0]?.content).toContain('Return answer:null')
    return { ...answer(''), finish: 'tool_calls', calls: [{ id: 'write-lecture', type: 'function', function: { name: 'write', arguments: JSON.stringify({ operation: 'resource.create', input: { display_name: '强化学习讲义', content: { type: 'json', value: {
      profile: 'managed-v1', html: `<article><h1>强化学习讲义</h1><p>${lecture}</p></article>`, css: '', state: { schema: { type: 'object', properties: {}, additionalProperties: false }, initial: {}, compatibility_version: 'static' }, forms: [], behaviors: [], references: [], export: []
    } } } }) } }] }
  }).mockImplementationOnce(async (_config, _key, messages) => {
    const { sections } = JSON.parse(messages[0]!.content!.split('Bound data: ').at(-1)!) as Row
    const result = JSON.parse(messages.find(message => message.tool_call_id === 'write-lecture')!.content!) as Row
    return answer(JSON.stringify({ version: 1, complete: true, answer: null, requirement_ids: ['content'], unresolved: [], artifacts: [{
      output_key: 'lecture', section_id: sections[0].section_id, bundle_resource_id: result.data.id, provenance_ref: result.provenance_ref, presentation_kind: 'managed-v1', width_constraint: 'full', interaction_kind: 'none', requirement_ids: ['content'], unresolved: []
    }] }))
  })
  const continued = s.submit('继续')
  const pending = () => s.store.snapshot(s.task).approvals.find(item => item.decision === 'pending' && item.validity === 'valid')
  await vi.waitFor(() => expect(pending()).toBeDefined())
  const approval = pending()!
  s.store.handle({ type: 'approval.decide', task_id: s.task, approval_id: approval.id, decision: 'approve' })
  await vi.waitFor(() => expect(s.store.snapshot(s.task).surface_updates).toEqual([expect.objectContaining({ action_id: approval.action_id })]))
  await s.store.handle({ type: 'surface.respond', task_id: s.task, action_id: approval.action_id, proceed: true, confirm_discard: false })
  await vi.waitFor(() => expect(status(continued)).toMatchObject({ delivery_state: 'complete' }))
  expect(s.store.snapshot(s.task).views[0]?.bundle.html).toContain(lecture)
  expect(s.records('runner.answer')).toEqual([])
  expect(s.messages().map(message => message.text).join('\n')).not.toContain(lecture)
})

it('lets the Router select the same complete checkpoint for two separate assignments', async () => {
  const s = setup({ conversationRouting: true })
  const assignment = (key: string, instructions: string, checkpoint_id?: string) => ({ assignment_key: key, instructions, checkpoint_id,
    required: true, requirement_ids: key === 'other' ? [] : ['answer'], outputs: [{ kind: 'answer', output_key: 'text' }] })
  const dispatch = (assignments: ReturnType<typeof assignment>[]) => invoke(ROUTE_WORK, { action: 'dispatch', base_revision: 0, final_answer: 'answerer', assignments })
  const status = (request: Row) => s.store.handle({ type: 'request.status', task_id: s.task, request_id: request.request_id }) as Row
  s.complete.mockResolvedValueOnce(dispatch([assignment('answerer', 'Prepare a reusable prefix')]))
    .mockResolvedValueOnce(answer('{"kind":"delegate"}'))
    .mockResolvedValueOnce({ ...answer(''), finish: 'tool_calls', calls: [{ id: 'checkpoint-contract', type: 'function', function: { name: 'list', arguments: '{"kind":"object_type","limit":1}' } }] })
    .mockResolvedValueOnce(answer('Original answer'))
  const original = s.submit('Gather a reusable prefix')
  await vi.waitFor(() => expect(status(original).run_state).toBe('completed'))
  let checkpoint: string | undefined
  s.complete.mockImplementationOnce(async (_config, _key, messages) => {
    const { work_table } = JSON.parse(messages.at(-1)!.content!) as Row
    checkpoint = work_table.find((entry: Row) => entry.request_id === original.request_id)?.checkpoints[1]?.checkpoint_id
    expect(checkpoint).toBeTruthy()
    return dispatch([assignment('answerer', 'Follow-up answer', checkpoint), assignment('other', 'Independent follow-up', checkpoint)])
  }).mockResolvedValueOnce(answer('{"kind":"delegate"}')).mockImplementation(async (_config, _key, messages) => {
    expect(messages.filter(message => message.role === 'tool').map(message => message.tool_call_id)).toEqual(['checkpoint-contract'])
    expect(messages[0]?.content).not.toContain('Prepare a reusable prefix')
    return answer(messages[0]?.content?.includes('Follow-up answer') ? 'Final follow-up answer' : 'Independent result')
  })
  const next = s.submit('Use the previous investigation for two independent follow-ups')
  await vi.waitFor(() => expect(status(next).run_state).toBe('completed'))
  const reused = s.records('runner.checkpoint.reused')
  expect(reused.map(entry => entry.payload.checkpoint_id)).toEqual([checkpoint, checkpoint])
  expect(new Set(reused.map(entry => entry.payload.owner.attempt_id)).size).toBe(2)
  expect(s.records('runner.answer').map(({ payload }) => payload.text)).toEqual(['Original answer', 'Final follow-up answer'])
})

it.each([
  { name: 'fits the byte budget', sourceText: 'source ' + '中文\\"\n'.repeat(2000) + ' end', pageCount: 1 },
  { name: 'needs a continuation', sourceText: 'source ' + '中😀\\"\n'.repeat(3800) + ' end', pageCount: 2 }
])('hands off exact output that $name and waits for required branches', async ({ sourceText, pageCount }) => {
  const s = setup({ releaseProfile: true }), source = deferred<Completion>(), independent = deferred<Completion>()
  const assignment = (key: string, instructions: string) => ({ assignment_key: key, instructions, required: true, requirement_ids: [], outputs: [{ kind: 'answer', output_key: 'text' }] })
  const output = (messages: ChatMessage[]) => JSON.parse(messages.find(message => message.role === 'tool')!.content!) as Row
  s.complete.mockResolvedValueOnce(invoke(ROUTE_WORK, { action: 'dispatch', base_revision: 0, assignments: [assignment('gather', 'Gather the exact source')] }))
    .mockImplementationOnce(async (_config, _key, messages) => {
      expect(output(messages)).toMatchObject({ execution: 'success', data: { revision: 1 } })
      return invoke(ROUTE_WORK, { action: 'dispatch', base_revision: 1, final_answer: 'write', assignments: [
        { ...assignment('write', 'Write the designated reply'), requirement_ids: ['answer'], inputs: [{ assignment_key: 'gather', output_key: 'text' }] },
        assignment('independent', 'Run the independent check')
      ] })
    })
    .mockResolvedValueOnce(answer('{"kind":"delegate"}'))
    .mockImplementation(async (_config, _key, messages) => {
      const system = messages[0]?.content ?? ''
      if (system.includes('Gather the exact source')) return system.includes('The host rejected the final result: INVALID_WORKER_RESULT') ? source.promise : answer('\n</｜DSML｜ calls>')
      if (system.includes('Run the independent check')) return independent.promise
      expect(system).toContain('Write the designated reply')
      expect(system).toContain('Use data.next_call if you need the next page')
      expect(body(messages)).not.toContain(sourceText)
      const input = JSON.parse(messages.find(message => message.role === 'user')!.content!) as Row
      const { kind: _kind, ...reference } = input.bound.work_outputs[0]
      expect(reference).toMatchObject({ plan_revision: 1, result_revision: 1, output_key: 'text' })
      const pages = messages.filter(message => message.role === 'tool').map(message => {
        expect(Buffer.byteLength(message.content!)).toBeLessThanOrEqual(defaults.read.text_bytes)
        return JSON.parse(message.content!) as Row
      })
      if (!pages.length) return invoke(READ_WORK_OUTPUT, reference)
      const page = pages.at(-1)!, received = pages.map(page => page.data.text).join('')
      expect(page.execution).toBe('success')
      if (pages.length < pageCount) {
        expect(page).toMatchObject({ truncated: true, data: { next_offset: received.length } })
        expect(received).toBe(sourceText.slice(0, received.length))
        expect(page.data.next_call).toEqual({ name: 'call', arguments: { capability: READ_WORK_OUTPUT, input_json: expect.any(String) } })
        const next = JSON.parse(page.data.next_call.arguments.input_json)
        expect(next).toEqual({ ...reference, offset: received.length })
        return invoke(READ_WORK_OUTPUT, next)
      }
      expect(page).toMatchObject({ truncated: false, data: { next_offset: null } })
      expect(page.data).not.toHaveProperty('next_call')
      expect(received).toBe(sourceText)
      return answer('The assembled answer.')
    })
  const request = s.submit('Use the source and perform an independent check.')
  await vi.waitFor(() => expect(s.complete).toHaveBeenCalledTimes(6))
  expect(s.records('worker.result.rejected')).toHaveLength(1)
  expect(s.records('runner.output.accepted')).toHaveLength(0)
  expect(s.records('runner.output.handoff')).toHaveLength(0)
  expect(s.records('runner.plan.installed')).toHaveLength(3)
  const readFlow = () => s.store.handle({ type: 'host.runner.flow', task_id: s.task }) as LiveFlowSnapshot
  expect(readFlow().lanes.Worker.items).toContainEqual(expect.objectContaining({ state: 'waiting', reason: 'dependency', handoff: { from: 'Router', kind: 'work', sequence: expect.any(Number) }, sources: [expect.objectContaining({ request_id: request.request_id, message_id: expect.any(String) })] }))
  source.resolve(answer(sourceText))
  await vi.waitFor(() => expect(s.records('runner.output.accepted')).toHaveLength(2))
  expect(s.records('runner.output.handoff')).toHaveLength(1)
  const handoff = s.records('runner.output.handoff')[0]!.payload
  expect(new RunnerWorkState(s.db, s.store.epoch).work(handoff.consumer_work_id)).toMatchObject({ assignment: { inputs: [{ work_id: handoff.work_id, plan_revision: 1, output_key: 'text', result_revision: 1 }] } })
  expect(s.records('runner.answer')).toHaveLength(0)
  expect(s.store.handle({ type: 'request.status', task_id: s.task, request_id: request.request_id })).toMatchObject({ delivery_state: 'open' })
  independent.resolve(answer('Internal check.'))
  await vi.waitFor(() => expect(s.store.handle({ type: 'request.status', task_id: s.task, request_id: request.request_id })).toMatchObject({ state: 'started', run_state: 'completed', delivery_state: 'complete' }))
  expect(s.records('runner.answer').map(({ payload }) => payload.text)).toEqual(['The assembled answer.'])
  expect(s.complete).toHaveBeenCalledTimes(7 + pageCount)
  expect(s.db.prepare("SELECT count(*) AS count FROM runner_runs WHERE purpose='composition'").get()).toEqual({ count: 0 })
})

it('reports repeated handoff pages and rejected reads but lets the assigned Worker finish', async () => {
  const s = setup({ conversationRouting: true }), sourceText = 'Bound source: ' + '中😀\\"\n'.repeat(3800) + ' end'
  const repeatCount = RUNNER_LIMITS.progress.stalled_repeat_threshold
  s.complete.mockResolvedValueOnce(invoke(ROUTE_WORK, { action: 'dispatch', base_revision: 0, final_answer: 'write', assignments: [
    { assignment_key: 'gather', instructions: 'Prepare the handoff', required: true, requirement_ids: [], outputs: [{ kind: 'answer', output_key: 'text' }] },
    { assignment_key: 'write', instructions: 'Use the handoff', required: true, requirement_ids: ['answer'], outputs: [{ kind: 'answer', output_key: 'text' }], inputs: [{ assignment_key: 'gather', output_key: 'text' }] }
  ] })).mockResolvedValueOnce(answer('{"kind":"delegate"}')).mockImplementation(async (_config, _key, messages) => {
    if (messages[0]?.content?.includes('Prepare the handoff')) return answer(sourceText)
    const input = JSON.parse(messages.find(message => message.role === 'user')!.content!) as Row
    const { kind: _kind, ...reference } = input.bound.work_outputs[0]
    const results = messages.filter(message => message.role === 'tool').map(message => {
      expect(Buffer.byteLength(message.content!)).toBeLessThanOrEqual(defaults.read.text_bytes)
      return JSON.parse(message.content!) as Row
    })
    if (!results.length) return invoke(READ_WORK_OUTPUT, reference)
    expect(results[0]).toMatchObject({ execution: 'success', truncated: true })
    expect(results[0]).not.toHaveProperty('notice')
    if (results.length <= repeatCount * 2) return invoke(READ_WORK_OUTPUT, results.length % 2
      ? { ...reference, work_id: 'unassigned-output' }
      : { result_revision: reference.result_revision, ...reference, offset: 0 })
    const duplicates = results.slice(1, repeatCount * 2 + 1).filter(result => result.execution === 'success')
    expect(duplicates).toHaveLength(repeatCount)
    for (const duplicate of duplicates) {
      expect(duplicate.notice).toContain('contains no new data')
      expect(duplicate.data).toEqual(results[0]!.data)
    }
    if (results.length === repeatCount * 2 + 1) return invoke(READ_WORK_OUTPUT, JSON.parse(results[0]!.data.next_call.arguments.input_json))
    const last = results.at(-1)!
    expect(last).toMatchObject({ execution: 'success', truncated: false })
    expect(last).not.toHaveProperty('notice')
    expect(results[0]!.data.text + last.data.text).toBe(sourceText)
    return answer('The completed answer.')
  })
  const request = s.submit('Read the source and deliver an answer.')
  await vi.waitFor(() => expect(s.store.handle({ type: 'request.status', task_id: s.task, request_id: request.request_id })).toMatchObject({ run_state: 'completed', delivery_state: 'complete' }), { timeout: 3000 })
  const reads = s.records('model.tool_result').filter(({ payload }) => payload.query_pattern === READ_WORK_OUTPUT)
  const readIds = reads.map(({ payload }) => payload.query_result_id)
  expect(readIds.filter(id => id !== undefined)).toEqual([...Array(repeatCount + 1).fill(readIds[0]), readIds.at(-1)])
  expect(readIds.at(-1)).not.toBe(readIds[0])
  const rejected = reads.filter(({ payload }) => payload.query_result_id === undefined)
  expect(rejected).toHaveLength(repeatCount)
  for (const { payload } of rejected) expect(JSON.parse(payload.message.content)).toMatchObject({ execution: 'not_executed', error: { code: 'WORKER_CAPABILITY_DENIED' } })
  const diagnoses = s.records('runner.progress.diagnosis').map(({ payload }) => payload)
  expect(diagnoses).toEqual(expect.arrayContaining([
    expect.objectContaining({ pattern: READ_WORK_OUTPUT, reason: 'repeated_failure', error_source: 'WORKER_CAPABILITY_DENIED', automatic_replay: false }),
    expect.objectContaining({ pattern: READ_WORK_OUTPUT, reason: 'suspected_stall', automatic_replay: false })
  ]))
  expect(JSON.stringify(diagnoses)).not.toContain('Bound source:')
  expect(s.records('runner.answer').map(({ payload }) => payload.text)).toEqual(['The completed answer.'])
  expect(s.records('runner.plan.installed')).toHaveLength(2)
})

it.each(['planned', 'bound'] as const)('recovers a %s handoff without duplicating the plan or its accepted source', async boundary => {
  const first = setup({ conversationRouting: true }), sourceText = 'The exact private handoff value'
  const state = new RunnerWorkState(first.db, first.store.epoch)
  const admission = (first.store as unknown as { runnerAdmission: RunnerAdmission }).runnerAdmission, select = admission.next.bind(admission)
  vi.spyOn(admission, 'next').mockImplementation((task, candidates, active, ready) => select(task, candidates.filter(candidate => {
    const work = state.work(candidate.work_id)
    return boundary === 'bound' && work.purpose === 'production' && work.assignment?.instructions === 'Produce source'
  }), active, ready))
  first.complete.mockResolvedValueOnce(invoke(ROUTE_WORK, { action: 'dispatch', base_revision: 0, final_answer: 'consumer', assignments: [
    { assignment_key: 'source', instructions: 'Produce source', required: true, requirement_ids: [], outputs: [{ kind: 'answer', output_key: 'value' }] },
    { assignment_key: 'consumer', instructions: 'Read exact source', required: true, requirement_ids: ['answer'], outputs: [{ kind: 'answer', output_key: 'reply' }], inputs: [{ assignment_key: 'source', output_key: 'value' }] }
  ] })).mockResolvedValueOnce(answer('{"kind":"delegate"}')).mockResolvedValue(answer(sourceText))
  const request = first.submit('Answer from one exact dependent source.')
  await vi.waitFor(() => expect(first.records('runner.plan.installed')).toHaveLength(2))
  if (boundary === 'bound') await vi.waitFor(() => expect(first.records('runner.output.handoff')).toHaveLength(1))
  const [source, consumer] = first.records('runner.plan.installed').map(item => state.work(item.payload.work_id))
  expect(consumer!.state).toBe(boundary === 'bound' ? 'queued' : 'planned')
  first.close()
  const next = setup({ directory: first.directory, task: first.task, conversationRouting: true })
  const recovered = new RunnerWorkState(next.db, next.store.epoch), allowConsumer = deferred<Completion>()
  next.complete.mockImplementation(async (_config, _key, messages) => {
    if (messages[0]?.content?.includes('Produce source')) return answer(sourceText)
    expect(messages[0]?.content).toContain('Read exact source')
    const { bound } = JSON.parse(messages.find(message => message.role === 'user')!.content!)
    expect(bound.work_outputs).toEqual([expect.objectContaining({ work_id: source!.work_id, plan_revision: boundary === 'bound' ? 1 : 2, result_revision: 1 })])
    return allowConsumer.promise
  })
  await next.store.recoverRunnerWork()
  await vi.waitFor(() => expect(next.records('runner.output.handoff')).toHaveLength(boundary === 'bound' ? 2 : 1))
  const read = () => next.store.handle({ type: 'host.runner.flow', task_id: next.task }) as LiveFlowSnapshot
  const flow = read()
  expect(flow.lanes.Worker.items).toContainEqual(expect.objectContaining({ id: `work:${consumer!.work_id}`, sources: [expect.objectContaining({ request_id: request.request_id, message_id: expect.any(String) })], handoff: { from: 'Worker', kind: 'output', sequence: next.records('runner.output.handoff').at(-1)!.sequence } }))
  expect(read()).toEqual(flow)
  expect(JSON.stringify(flow)).not.toContain(sourceText)
  allowConsumer.resolve(answer('One recovered reply'))
  await vi.waitFor(() => expect(next.records('runner.answer').map(row => row.payload.text)).toEqual(['One recovered reply']))
  await next.store.recoverRunnerWork()
  const output = next.records('runner.output.handoff').at(-1)!.payload
  expect(output).toMatchObject({ consumer_attempt_id: recovered.work(consumer!.work_id).current_attempt_id, result_revision: 1 })
  expect(next.records('runner.output.handoff')).toHaveLength(boundary === 'bound' ? 2 : 1)
  expect(next.records('runner.plan.installed')).toHaveLength(2)
  expect(next.complete).toHaveBeenCalledTimes(boundary === 'bound' ? 1 : 2)
})

it('lets the Router correct an invalid completed output reference before installing its draft', async () => {
  const s = setup({ conversationRouting: true })
  const assign = (instructions: string, inputs: unknown[] = []) => ({ action: 'dispatch', base_revision: 0, final_answer: 'answerer', assignments: [
    { assignment_key: 'answerer', instructions, required: true, requirement_ids: ['answer'], outputs: [{ kind: 'answer', output_key: 'text' }], inputs }
  ] })
  const status = (request: Row) => s.store.handle({ type: 'request.status', task_id: s.task, request_id: request.request_id })
  s.complete.mockResolvedValueOnce(invoke(ROUTE_WORK, assign('Produce the first result')))
    .mockResolvedValueOnce(answer('{"kind":"delegate"}')).mockResolvedValueOnce(answer('Exact reusable answer.'))
  const first = s.submit('Delegate the first answer.')
  await vi.waitFor(() => expect(status(first)).toMatchObject({ run_state: 'completed' }))
  const input = (messages: ChatMessage[]) => JSON.parse(messages.at(-1)!.content!) as Row
  s.complete.mockImplementationOnce(async (_config, _key, messages) => {
    const table = input(messages).work_table
    expect(table).toEqual([expect.objectContaining({ request_id: first.request_id, state: 'succeeded' })])
    const { kind: _kind, ...reference } = table[0].outputs[0]
    expect(reference.result_revision).toBe(1)
    return invoke(ROUTE_WORK, assign('Use the first result', [{ ...reference, output_key: 'wrong-key' }]))
  }).mockImplementationOnce(async (_config, _key, messages) => {
    const receipt = JSON.parse(messages.at(-1)!.content!) as Row
    expect(receipt).toMatchObject({ execution: 'not_executed', error: { code: 'RUNNER_DEPENDENCY_INVALID', message: expect.stringContaining('wrong-key') } })
    const routed = JSON.parse(messages.filter(message => message.role === 'user').at(-1)!.content!) as Row
    const { kind: _kind, ...reference } = routed.work_table[0].outputs[0]
    return invoke(ROUTE_WORK, assign('Use the exact first result', [reference]))
  }).mockResolvedValueOnce(answer('{"kind":"delegate"}')).mockImplementationOnce(async (_config, _key, messages) => {
    const { kind: _kind, ...reference } = input(messages).bound.work_outputs[0]
    return invoke(READ_WORK_OUTPUT, reference)
  }).mockImplementationOnce(async (_config, _key, messages) => {
    expect(JSON.parse(messages.at(-1)!.content!)).toMatchObject({ execution: 'success', data: { text: 'Exact reusable answer.' } })
    return answer('Second answer, using the first.')
  })
  const second = s.submit('Delegate a follow-up using the first result.')
  await vi.waitFor(() => expect(status(second)).toMatchObject({ run_state: 'completed' }))
  expect(s.records('runner.output.handoff').map(({ payload }) => payload)).toEqual([expect.objectContaining({ request_id: second.request_id, result_revision: 1 })])
  expect(s.complete).toHaveBeenCalledTimes(8)
})

it.each(['failed', 'cancelled'] as const)('settles a dependent Run with no attempt when its upstream is %s', async terminal => {
  const runtime = setup({ conversationRouting: true }), gate = deferred<void>()
  const state = new RunnerWorkState(runtime.db, runtime.store.epoch)
  const dispatch = (instructions: string, inputs: unknown[] = []) => invoke(ROUTE_WORK, { action: 'dispatch', base_revision: 0, final_answer: 'reply', assignments: [
    { assignment_key: 'reply', instructions, required: true, requirement_ids: ['answer'], outputs: [{ kind: 'answer', output_key: 'text' }], inputs }
  ] })
  runtime.complete.mockResolvedValueOnce(dispatch('Produce the upstream result')).mockResolvedValueOnce(answer('{"kind":"delegate"}')).mockImplementationOnce(async () => {
    await gate.promise
    throw new ModelError('MODEL_STREAM_INTERRUPTED')
  })
  const source = runtime.submit('Start the source request.')
  await vi.waitFor(() => expect(runtime.complete).toHaveBeenCalledTimes(3))
  const upstream = runtime.records('runner.plan.installed').find(({ payload }) => payload.request_id === source.request_id)!.payload
  runtime.complete.mockResolvedValueOnce(dispatch('Use the upstream result', [{ work_id: upstream.work_id, plan_revision: 1, output_key: 'text' }]))
    .mockResolvedValueOnce(answer('{"kind":"delegate"}'))
  const consumer = runtime.submit('Wait for the exact source result.')
  const status = () => runtime.store.handle({ type: 'request.status', task_id: runtime.task, request_id: consumer.request_id })
  await vi.waitFor(() => expect(runtime.records('runner.plan.installed').some(({ payload }) => payload.request_id === consumer.request_id)).toBe(true))
  const downstream = runtime.records('runner.plan.installed').find(({ payload }) => payload.request_id === consumer.request_id)!.payload
  expect(state.work(downstream.work_id)).toMatchObject({ state: 'planned' })
  if (terminal === 'cancelled') runtime.store.handle({ type: 'run.cancel', task_id: runtime.task, run_id: upstream.run_id })
  gate.resolve()
  await vi.waitFor(() => expect(status()).toMatchObject({ run_state: terminal }))
  await vi.waitFor(() => expect(runtime.records('runner.delivery.settled')).toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ request_id: consumer.request_id, state: 'incomplete' }) })))
  expect(state.work(downstream.work_id)).toMatchObject({ state: `dependency_${terminal}`, root_cause: { work_id: upstream.work_id } })
  expect(state.attempts(downstream.work_id)).toEqual([])
})

it('seals the recovered request with the accepted answer from the interrupted Run', async () => {
  const first = setup({ conversationRouting: true }), state = new RunnerWorkState(first.db, first.store.epoch)
  const admission = (first.store as unknown as { runnerAdmission: RunnerAdmission }).runnerAdmission, select = admission.next.bind(admission)
  vi.spyOn(admission, 'next').mockImplementation((task, candidates, active, ready) => select(task, candidates.filter(candidate => {
    const work = state.work(candidate.work_id)
    return work.purpose === 'production' && !!work.assignment?.final_answer
  }), active, ready))
  first.complete.mockResolvedValueOnce(invoke(ROUTE_WORK, { action: 'dispatch', base_revision: 0, final_answer: 'reply', assignments: [
    { assignment_key: 'reply', instructions: 'Write the final answer', required: true, requirement_ids: ['answer'], outputs: [{ kind: 'answer', output_key: 'reply' }] },
    { assignment_key: 'check', instructions: 'Complete the independent check', required: true, requirement_ids: [], outputs: [{ kind: 'answer', output_key: 'check' }] }
  ] })).mockResolvedValueOnce(answer('{"kind":"delegate"}')).mockResolvedValueOnce(answer('The original accepted answer.'))
  const request = first.submit('Answer and complete a separate check.')
  await vi.waitFor(() => expect(first.records('runner.output.accepted')).toHaveLength(1))
  const accepted = first.records('runner.output.accepted')[0]!.payload.owner
  expect(first.records('runner.answer')).toHaveLength(0)
  await first.store.shutdown()
  first.close()

  const next = setup({ directory: first.directory, task: first.task, conversationRouting: true })
  next.complete.mockImplementation(async (_config, _key, messages) => {
    expect(messages[0]?.content).toContain('Complete the independent check')
    return answer('Independent check done.')
  })
  await next.store.recoverRunnerWork()
  await vi.waitFor(() => expect(next.store.handle({ type: 'request.status', task_id: next.task, request_id: request.request_id })).toMatchObject({ run_state: 'completed', delivery_state: 'complete' }))
  expect(next.records('runner.answer').map(({ payload }) => payload)).toEqual([expect.objectContaining({ owner: accepted, text: 'The original accepted answer.' })])
  expect(next.messages().map(message => message.text)).toContain('The original accepted answer.')
  expect(next.complete).toHaveBeenCalledTimes(1)
})

it('discovers and delivers existing materials with a pinned chapter and an in-flight result', async () => {
  const s = setup({ releaseProfile: true }), statistics = deferred<Completion>()
  const oldText = 'OLDER_MINUTES: confirm the rehearsal owner.'
  const currentText = 'CURRENT_MINUTES: rehearsal is scheduled for Thursday.'
  const chapterText = 'PUBLISHED_POLICY: a backup is required before switching.'
  const otherText = 'UNRELATED_CHAPTER: internal room booking.'
  const statisticsText = 'ACCEPTED_COUNTS: 12 checked and 2 pending.'
  const old = importText(s.store, s.task, '纪要.md', oldText)
  const attachment = importText(s.store, s.task, '纪要.md', currentText)
  const bundle = (html: string) => ({ profile: 'managed-v1', html, css: '', state: { schema: { type: 'object', properties: {}, additionalProperties: false }, initial: {}, compatibility_version: 'v1' }, forms: [], behaviors: [], references: [], export: [] })
  const surface = s.store.snapshot(s.task).surface
  const seed = deferred<Completion>()
  s.complete.mockResolvedValueOnce(answer('{"kind":"new"}')).mockImplementationOnce(() => seed.promise)
  s.submit('Seed the published policy')
  await vi.waitFor(() => expect(s.complete).toHaveBeenCalledTimes(2))
  const fixture = s.records('runner.plan.installed')[0]!.payload.run_id
  const publication = s.store.modelTool(s.task, fixture, { type: 'write', input: { type: 'surface.update', surface_id: surface.id, expected_revision: surface.revision, operations: [{ type: 'view.create', client_ref: 'policy', slot_id: 'main', bundle: { type: 'inline', bundle: bundle(`<h1>交付规则</h1><p>${chapterText}</p><h1>其他事项</h1><p>${otherText}</p>`) } }] } }) as Row
  const viewId = publication.views[0].view_id
  s.store.handle({ type: 'run.cancel', task_id: s.task, run_id: fixture })
  seed.resolve(answer(''))
  s.complete.mockClear()
  const result = (messages: ChatMessage[]) => JSON.parse(messages.at(-1)!.content!) as Row
  const userInput = (messages: ChatMessage[]) => JSON.parse(messages.filter(message => message.role === 'user' && message.content?.startsWith('{')).at(-1)!.content!) as Row
  const status = (request: Row) => s.store.handle({ type: 'request.status', task_id: s.task, request_id: request.request_id }) as Row
  let routerCalls = 0
  let bindings: Row[] = []
  s.complete.mockResolvedValueOnce(invoke(ROUTE_WORK, { action: 'dispatch', base_revision: 0, final_answer: 'stats', assignments: [
    { assignment_key: 'stats', instructions: 'Count the release checks', required: true, requirement_ids: ['answer'], outputs: [{ kind: 'answer', output_key: 'statistics' }] }
  ] })).mockResolvedValueOnce(answer('{"kind":"delegate"}')).mockImplementationOnce(() => statistics.promise)
  const source = s.submit('统计已核验和待核验的数量。')
  await vi.waitFor(() => expect(s.complete).toHaveBeenCalledTimes(3))
  s.complete.mockImplementationOnce(async () => {
    routerCalls++
    return invoke(DISCOVER_INPUTS, {})
  }).mockImplementationOnce(async (_config, _key, messages) => {
    routerCalls++
    const catalog = result(messages)
    expect(catalog).toMatchObject({ execution: 'success' })
    expect(JSON.stringify(catalog)).not.toMatch(/OLDER_MINUTES|CURRENT_MINUTES|PUBLISHED_POLICY|UNRELATED_CHAPTER|ACCEPTED_COUNTS/)
    const entries = catalog.data.items as Row[]
    const minutes = entries.filter(entry => entry.name === '纪要.md')
    expect(minutes).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: expect.objectContaining({ kind: 'import' }), reference: { kind: 'material', resource_id: old.id } }),
      expect.objectContaining({ source: expect.objectContaining({ kind: 'attachment' }), reference: { kind: 'material', resource_id: attachment.id } })
    ]))
    expect(minutes).toHaveLength(2)
    const chapter = entries.find(entry => entry.kind === 'published' && entry.name === '交付规则')!
    expect(chapter.reference).toMatchObject({ view_id: viewId, view_revision: 1, revision: 1 })
    const counts = entries.find(entry => entry.kind === 'output' && entry.source.request_id === source.request_id)!
    expect(counts).toMatchObject({ status: 'expected', reference: { plan_revision: 1, output_key: 'statistics' } })
    expect(counts.reference).not.toHaveProperty('result_revision')
    bindings = [minutes.find(entry => entry.source.kind === 'import')!.reference, chapter.reference, counts.reference]
    return invoke(ROUTE_WORK, { action: 'dispatch', base_revision: 0, assignments: [
      { assignment_key: 'compose', instructions: 'Assemble the bound release brief', required: true, requirement_ids: ['content'], outputs: [{ kind: 'artifact', output_key: 'brief', exposure: 'publish' }], inputs: bindings }
    ] })
  }).mockImplementationOnce(async (_config, _key, messages) => {
    routerCalls++
    expect(result(messages)).toMatchObject({ execution: 'success' })
    return answer('{"kind":"new"}')
  }).mockImplementation(async (_config, _key, messages) => {
    const system = messages[0]!.content!
    if (system.includes('You are the Collator.')) {
      expect(body(messages)).not.toMatch(/OLDER_MINUTES|CURRENT_MINUTES|PUBLISHED_POLICY|UNRELATED_CHAPTER|ACCEPTED_COUNTS|builtin:discover-inputs|builtin:read-bound-input/)
      const { batch, indexes } = userInput(messages)
      const { task_id, run_id, batch_id, composition_version } = batch
      const [index] = indexes, [section] = batch.sections
      return answer(JSON.stringify({ task_id, run_id, batch_id, composition_version, intents: [{
        artifact: { task_id, artifact_id: index.artifact_id, artifact_revision: index.artifact_revision }, section_id: section.section_id,
        section_position_revision: section.position_revision, order_key: section.order_key, slot_id: 'main', layout_mode: 'column', width_constraint: index.width_constraint
      }] }))
    }
    expect(system).toContain('Assemble the bound release brief')
    const { bound_inputs, work_outputs } = userInput(messages).bound
    expect(bound_inputs.map((entry: Row) => entry.binding)).toEqual(bindings.slice(0, 2))
    const { kind, ...reference } = work_outputs[0]
    expect(kind).toBe('answer')
    expect(reference).toMatchObject({ ...bindings[2], result_revision: 1 })
    const tools = messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content!) as Row)
    if (!tools.length) return invoke(READ_BOUND_INPUT, { input_ref: bound_inputs[0].input_ref })
    expect(tools[0]).toMatchObject({ execution: 'success' })
    expect(JSON.stringify(tools[0]!.data)).toContain(oldText)
    expect(JSON.stringify(tools[0]!.data)).not.toContain(currentText)
    if (tools.length === 1) return invoke(READ_BOUND_INPUT, { input_ref: bound_inputs[1].input_ref })
    expect(tools[1]).toMatchObject({ execution: 'success' })
    expect(JSON.stringify(tools[1]!.data)).toContain(chapterText)
    expect(JSON.stringify(tools[1]!.data)).not.toContain(otherText)
    if (tools.length === 2) return invoke(READ_WORK_OUTPUT, reference)
    expect(tools[2]).toMatchObject({ execution: 'success', data: { text: statisticsText } })
    if (tools.length === 3) return { ...answer(''), finish: 'tool_calls', calls: [{ id: 'write-brief', type: 'function', function: { name: 'write', arguments: JSON.stringify({ operation: 'resource.create', input: {
      display_name: '交付稿', content: { type: 'json', value: bundle(`<h1>交付稿</h1><p>${oldText} ${chapterText} ${tools[2]!.data.text}</p>`) }
    } }) } }] }
    const binding = JSON.parse(system.split('Bound data: ').at(-1)!) as Row
    return answer(JSON.stringify({ version: 1, complete: true, answer: null, requirement_ids: ['content'], unresolved: [], artifacts: [{
      output_key: 'brief', section_id: binding.sections[0].section_id, bundle_resource_id: tools[3]!.data.id, provenance_ref: tools[3]!.provenance_ref,
      presentation_kind: 'managed-v1', width_constraint: 'full', interaction_kind: 'none', requirement_ids: ['content'], unresolved: []
    }] }))
  })
  const request = s.submit('把现有材料整理成交付稿。', [attachment.id])
  const state = new RunnerWorkState(s.db, s.store.epoch)
  const composer = () => state.taskWorks(s.task).find(work => work.purpose === 'production' && work.request_id === request.request_id)
  await vi.waitFor(() => expect(composer()).toMatchObject({ state: 'planned', assignment: { inputs: bindings } }))
  const flow = s.store.handle({ type: 'host.runner.flow', task_id: s.task }) as LiveFlowSnapshot
  expect(flow.lanes.Worker.items).toContainEqual(expect.objectContaining({ id: `work:${composer()!.work_id}`, state: 'waiting', reason: 'dependency' }))
  expect(s.records('runner.output.handoff')).toHaveLength(0)
  expect(s.complete).toHaveBeenCalledTimes(6)
  statistics.resolve(answer(statisticsText))
  const pending = () => s.store.snapshot(s.task).approvals.find(item => item.decision === 'pending' && item.validity === 'valid')
  await vi.waitFor(() => expect(pending()).toBeDefined(), { timeout: 3000 })
  expect(composer()).toMatchObject({ assignment: { inputs: [...bindings.slice(0, 2), { ...bindings[2], result_revision: 1 }] } })
  expect(s.records('runner.output.handoff').map(({ payload }) => payload)).toEqual([expect.objectContaining({ consumer_work_id: composer()!.work_id, ...bindings[2], result_revision: 1 })])
  expect(routerCalls).toBe(3)
  expect(s.complete).toHaveBeenCalledTimes(12)
  expect(status(request)).toMatchObject({ delivery_state: 'open' })
  expect(s.store.snapshot(s.task).views.map(view => view.id)).toEqual([viewId])
  const approval = pending()!
  s.store.handle({ type: 'approval.decide', task_id: s.task, approval_id: approval.id, decision: 'approve' })
  await vi.waitFor(() => expect(s.store.snapshot(s.task).surface_updates).toEqual([expect.objectContaining({ action_id: approval.action_id })]))
  await s.store.handle({ type: 'surface.respond', task_id: s.task, action_id: approval.action_id, proceed: true, confirm_discard: false })
  await vi.waitFor(() => expect(status(request)).toMatchObject({ delivery_state: 'complete' }))
  expect(s.store.snapshot(s.task).views.find(view => view.id !== viewId)!.bundle.html).toContain(`${oldText} ${chapterText} ${statisticsText}`)
})

it('returns conflicting handoff coverage to the Router before any Workers run', async () => {
  const runtime = setup({ conversationRouting: true })
  const dispatch = (base_revision: number, draftClaims: string[], publishClaims = ['content']) => invoke(ROUTE_WORK, { action: 'dispatch', base_revision, assignments: [
    { assignment_key: 'collect', instructions: 'Collect the inventory', required: true, requirement_ids: draftClaims, outputs: [{ output_key: 'draft', kind: 'artifact', exposure: 'handoff' }] },
    { assignment_key: 'release', instructions: 'Publish the inventory summary', required: true, requirement_ids: publishClaims, outputs: [{ output_key: 'summary', kind: 'artifact', exposure: 'publish' }], inputs: [{ assignment_key: 'collect', output_key: 'draft' }] }
  ] })
  runtime.complete.mockResolvedValueOnce(dispatch(0, ['content'])).mockResolvedValueOnce(answer('{"kind":"new"}'))
    .mockImplementationOnce(async (_config, _key, messages) => {
      expect(runtime.records('runner.plan.installed')).toHaveLength(0)
      expect(runtime.records('worker.state')).toHaveLength(0)
      expect(messages[0]?.content).toContain('Assignment \\"collect\\" claims final artifact requirements [\\"content\\"]')
      expect(messages[0]?.content).toContain('base_revision: 2')
      return dispatch(2, [], [])
    }).mockResolvedValueOnce(answer('{"kind":"new"}'))
    .mockImplementationOnce(async (_config, _key, messages) => {
      expect(runtime.records('runner.plan.installed')).toHaveLength(0)
      expect(messages[0]?.content).toContain('a publishing artifact output must include')
      expect(messages[0]?.content).toContain('base_revision: 4')
      return dispatch(4, [])
    }).mockResolvedValueOnce(answer('{"kind":"new"}'))
    .mockImplementation(async (_config, _key, messages) => {
      const binding = JSON.parse(messages[0]!.content!.split('Bound data: ').at(-1)!) as Row
      const output = binding.assignment.outputs[0], isDraft = output.exposure === 'handoff'
      const input = JSON.parse(messages.find(message => message.role === 'user')!.content!) as Row
      expect(binding.requirement_ids).toEqual(isDraft ? [] : ['content'])
      if (!isDraft) expect(input.bound.work_outputs).toEqual([expect.objectContaining({ kind: 'artifact', output_key: 'draft', result_revision: 1 })])
      const receipt = messages.find(message => message.tool_call_id === `write-${output.output_key}`)
      if (!receipt) return { ...answer(''), finish: 'tool_calls', calls: [{ id: `write-${output.output_key}`, type: 'function', function: { name: 'write', arguments: JSON.stringify({ operation: 'resource.create', input: { display_name: output.output_key, content: { type: 'json', value: {
        profile: 'managed-v1', html: `<article><p>${isDraft ? 'Internal inventory draft' : 'Published inventory summary'}</p></article>`, css: '', state: { schema: { type: 'object', properties: {}, additionalProperties: false }, initial: {}, compatibility_version: 'static' }, forms: [], behaviors: [], references: [], export: []
      } } } }) } }] }
      const result = JSON.parse(receipt.content!) as Row
      return answer(JSON.stringify({ version: 1, complete: true, answer: null, requirement_ids: binding.requirement_ids, unresolved: [], artifacts: [{
        output_key: output.output_key, section_id: binding.sections[0].section_id, bundle_resource_id: result.data.id, provenance_ref: result.provenance_ref,
        presentation_kind: 'managed-v1', width_constraint: 'full', interaction_kind: 'none', requirement_ids: binding.requirement_ids, unresolved: []
      }] }))
    })
  const request = runtime.submit('Prepare an internal inventory draft, then publish the inventory summary.')
  const pending = () => runtime.store.snapshot(runtime.task).approvals.find(item => item.decision === 'pending' && item.validity === 'valid')
  await vi.waitFor(() => expect(pending()).toBeDefined())
  const approval = pending()!
  runtime.store.handle({ type: 'approval.decide', task_id: runtime.task, approval_id: approval.id, decision: 'approve' })
  await vi.waitFor(() => expect(runtime.store.snapshot(runtime.task).surface_updates).toEqual([expect.objectContaining({ action_id: approval.action_id })]))
  await runtime.store.handle({ type: 'surface.respond', task_id: runtime.task, action_id: approval.action_id, proceed: true, confirm_discard: false })
  await vi.waitFor(() => expect(runtime.store.handle({ type: 'request.status', task_id: runtime.task, request_id: request.request_id })).toMatchObject({ delivery_state: 'complete' }))
  const rejections = runtime.records('worker.result.rejected').map(({ payload }) => payload)
  expect(rejections.map(payload => payload.code)).toEqual(['RUNNER_PLAN_CONFLICT', 'RUNNER_PLAN_CONFLICT'])
  expect(rejections.every(payload => !payload.no_progress)).toBe(true)
  expect(runtime.records('runner.output.handoff').map(({ payload }) => payload.output_key)).toEqual(['draft'])
  const published = runtime.store.snapshot(runtime.task).views.map(view => view.bundle.html)
  expect(published).toEqual([expect.stringContaining('Published inventory summary')])
  expect(published[0]).not.toContain('Internal inventory draft')
})

it.each(['early', 'late', 'missing'] as const)('hands off migration evidence and gates the required reply on publication (%s)', async reply => {
  const s = setup({ conversationRouting: true, releaseProfile: reply === 'missing' }), summary = deferred<Completion>()
  const schedule = 'Node.js 20 End=2026-04-30; 22 End=2027-04-30; 24 End=2028-04-30; 26 End=2029-04-30.'
  const material = importText(s.store, s.task, 'Node.js 官方版本计划节选.md', schedule)
  const riskTag = 'RISK-NODE20-EOL-20261124'
  const evidenceText = `${schedule} Risk tag: ${riskTag}. Project compatibility is not verified.`
  const assignments = [
    { assignment_key: 'evidence', instructions: 'Extract the official dates and produce a private risk tag', required: true, requirement_ids: [], outputs: [{ kind: 'answer', output_key: 'schedule' }] },
    { assignment_key: 'compose', instructions: 'Create the assigned card', required: true, requirement_ids: ['content'], outputs: [{ kind: 'artifact', output_key: 'card', exposure: 'publish' }, { kind: 'artifact', output_key: 'reference', exposure: 'handoff' }], inputs: [{ assignment_key: 'evidence', output_key: 'schedule' }] },
    { assignment_key: 'summarize', instructions: 'Summarize the assigned card', required: true, requirement_ids: reply === 'late' ? [] : ['answer'], outputs: [{ kind: 'answer', output_key: 'summary' }], inputs: [{ assignment_key: 'compose', output_key: 'reference' }] }
  ]
  const dispatch = (base_revision: number, draft = assignments) => invoke(ROUTE_WORK, { action: 'dispatch', base_revision, final_answer: 'summarize', assignments: draft })
  if (reply === 'early') s.complete.mockResolvedValueOnce(dispatch(0, assignments.map(item => ({ ...item, requirement_ids: [] }))))
    .mockResolvedValueOnce(answer('{"kind":"new"}'))
    .mockImplementationOnce(async (_config, _key, messages) => {
      expect(s.records('runner.plan.installed')).toHaveLength(0)
      expect(messages[0]?.content).toContain('a publishing artifact output must include')
      expect(messages[0]?.content).toContain('base_revision: 2')
      return dispatch(2)
    })
  else s.complete.mockResolvedValueOnce(dispatch(0))
  s.complete.mockResolvedValueOnce(answer('{"kind":"new"}'))
    .mockImplementationOnce(async (_config, _key, messages) => {
      const system = messages[0]!.content!
      expect(system).toContain('Extract the official dates and produce a private risk tag')
      expect(system).toContain('Return the assigned text directly as plain text.')
      expect(system).not.toContain('For artifact construction')
      const input = JSON.parse(messages.find(message => message.role === 'user')!.content!) as Row
      expect(input.bound.materials).toContainEqual(expect.objectContaining({ id: material.id }))
      return answer(evidenceText)
    }).mockImplementationOnce(async (_config, _key, messages) => {
      expect(messages[0]?.content).toContain('Create the assigned card')
      expect(body(messages)).not.toContain(riskTag)
      const input = JSON.parse(messages.find(message => message.role === 'user')!.content!) as Row
      const { kind, ...reference } = input.bound.work_outputs[0]
      expect(kind).toBe('answer')
      expect(reference).toMatchObject({ output_key: 'schedule', plan_revision: 1, result_revision: 1 })
      return invoke(READ_WORK_OUTPUT, reference)
    }).mockImplementationOnce(async (_config, _key, messages) => {
      const result = JSON.parse(messages.at(-1)!.content!) as Row
      expect(result).toMatchObject({ execution: 'success', data: { text: evidenceText } })
      return { ...answer(''), finish: 'tool_calls', calls: [{ id: 'write-card', type: 'function', function: { name: 'write', arguments: JSON.stringify({ operation: 'resource.create', input: { display_name: 'card', content: { type: 'json', value: {
        profile: 'managed-v1', html: `<section><h1>Node.js 20 迁移决策卡</h1><p>${result.data.text}</p></section>`, css: '', state: { schema: { type: 'object', properties: {}, additionalProperties: false }, initial: {}, compatibility_version: 'v1' }, forms: [], behaviors: [], references: [], export: []
      } } } }) } }] }
    })
    .mockImplementationOnce(async (_config, _key, messages) => {
      const system = messages[0]?.content ?? ''
      expect(system).toContain('Create the assigned card')
      const binding = JSON.parse(system.split('Bound data: ').at(-1)!) as Row
      const result = JSON.parse(messages.find(message => message.tool_call_id === 'write-card')!.content!) as Row
      const artifact = { section_id: binding.sections[0].section_id, bundle_resource_id: result.data.id, provenance_ref: result.provenance_ref,
        presentation_kind: 'managed-v1', width_constraint: 'full', interaction_kind: 'none', unresolved: [] }
      return answer(JSON.stringify({ version: 1, complete: true, answer: null, requirement_ids: ['content'], unresolved: [], artifacts: [
        { ...artifact, output_key: 'card', requirement_ids: ['content'] }, { ...artifact, output_key: 'reference', requirement_ids: [] }
      ] }))
    }).mockImplementationOnce(async (_config, _key, messages) => {
      expect(messages[0]?.content).toContain('Summarize the assigned card')
      expect(s.records('runner.answer')).toHaveLength(0)
      const input = JSON.parse(messages.find(message => message.role === 'user')!.content!) as Row
      expect(input.bound.work_outputs).toEqual([expect.objectContaining({ kind: 'artifact', output_key: 'reference', artifact_revision: 1, bundle_resource_id: expect.any(String) })])
      expect(body(messages)).not.toContain(riskTag)
      const binding = JSON.parse(messages[0]!.content!.split('Bound data: ').at(-1)!) as Row
      expect(binding.requirement_ids).toEqual(['answer'])
      const { task_id, request_id, intent_revision } = binding.owner
      if (reply === 'missing') return answer(JSON.stringify({ version: 1, complete: true, answer: null, artifacts: [], requirement_ids: [], unresolved: [{ task_id, request_id, intent_revision, requirement_id: 'answer' }] }))
      return reply === 'late' ? summary.promise : answer('The card is ready.')
    }).mockImplementationOnce(async (_config, _key, messages) => {
      expect(reply).toBe('missing')
      expect(messages[0]?.content).toContain('You are the Collator.')
      const input = JSON.parse(messages.find(message => message.role === 'user')!.content!) as Row
      expect(input.structural_issues ?? []).toEqual([])
      expect(body(messages)).not.toContain(riskTag)
      const { task_id, run_id, batch_id, composition_version } = input.batch
      const [index] = input.indexes
      const [section] = input.batch.sections
      return answer(JSON.stringify({ task_id, run_id, batch_id, composition_version, intents: [{
        artifact: { task_id, artifact_id: index.artifact_id, artifact_revision: index.artifact_revision }, section_id: section.section_id,
        section_position_revision: section.position_revision, order_key: section.order_key, slot_id: 'main', layout_mode: 'column', width_constraint: index.width_constraint
      }] }))
    })
  const request = s.submit('用绑定的官方计划制作 Node.js 20 迁移决策卡。由一个 Worker 提取证据和风险标签，另一个 Worker 原样引用标签。卡片发布后，在对话中汇报。', [material.id])
  const pendingApproval = () => s.store.snapshot(s.task).approvals.find(item => item.decision === 'pending' && item.validity === 'valid')
  await vi.waitFor(() => expect(pendingApproval()).toBeDefined())
  expect(s.records('runner.answer')).toHaveLength(0)
  const approval = pendingApproval()!
  s.store.handle({ type: 'approval.decide', task_id: s.task, approval_id: approval.id, decision: 'approve' })
  await vi.waitFor(() => expect(s.store.snapshot(s.task).surface_updates).toEqual([expect.objectContaining({ action_id: approval.action_id })]))
  expect(s.records('runner.answer')).toHaveLength(0)
  await s.store.handle({ type: 'surface.respond', task_id: s.task, action_id: approval.action_id, proceed: true, confirm_discard: false })
  if (reply === 'late') {
    expect(s.records('runner.answer')).toHaveLength(0)
    summary.resolve(answer('The card is ready.'))
  }
  await vi.waitFor(() => expect(s.store.handle({ type: 'request.status', task_id: s.task, request_id: request.request_id })).toMatchObject({ delivery_state: reply === 'missing' ? 'incomplete' : 'complete' }))
  expect(s.records('runner.answer').map(({ payload }) => payload.text)).toEqual(reply === 'missing' ? [] : ['The card is ready.'])
  const views = s.store.snapshot(s.task).views
  expect(views).toHaveLength(1)
  expect(views[0]!.bundle.html).toContain(evidenceText)
  if (reply !== 'missing') expect(s.records('runner.answer')[0]!.sequence).toBeGreaterThan(s.records('surface.published').at(-1)!.sequence)
  const [evidence, handoff] = s.records('runner.output.handoff').map(({ payload }) => payload)
  expect(evidence).toMatchObject({ output_key: 'schedule', plan_revision: 1, result_revision: 1 })
  expect(handoff).toMatchObject({ output_key: 'reference', artifact_revision: 1 })
  if (reply !== 'missing') expect(s.records('runner.composition.rule_plan')[0]!.payload.plan.intents.map((intent: Row) => intent.artifact.artifact_id)).not.toContain(handoff.artifact_id)
  else expect(s.records('runner.delivery.settled')[0]?.payload.missing_requirement_ids).toEqual(['answer'])
  expect(s.complete).toHaveBeenCalledTimes(reply === 'missing' ? 8 : reply === 'early' ? 9 : 7)
})

it.each(['layout', 'feedback', 'feedback-only', 'failure', 'recovered'] as const)('follows the release Collator model decision: %s', async path => {
  let s = setup({ releaseProfile: true })
  const repairGate = deferred<void>()
  const expectsFeedback = path === 'feedback' || path === 'feedback-only' || path === 'recovered'
  const statement = 'PRIVATE_UPSTREAM_EVIDENCE', independent = 'Independent published card', repaired = 'Required detail card'
  const dispatch = (key: string, instructions: string, output: string, artifact = false, requirement_ids: string[] = []) => ({
    assignment_key: key, instructions, required: true, requirement_ids, outputs: [artifact ? { kind: 'artifact', output_key: output, exposure: 'publish' } : { kind: 'answer', output_key: output }]
  })
  const assignments = [
    { ...dispatch('detail', 'Produce required detail', 'detail', true, ['content']), inputs: [{ assignment_key: 'source', output_key: 'evidence' }] },
    dispatch('source', 'Produce private upstream evidence', 'evidence'), ...(path === 'feedback-only' ? [] : [dispatch('independent', 'Produce independent card', 'independent', true)])
  ]
  if (path === 'recovered') {
    const state = new RunnerWorkState(s.db, s.store.epoch)
    const admission = (s.store as unknown as { runnerAdmission: RunnerAdmission }).runnerAdmission, select = admission.next.bind(admission)
    vi.spyOn(admission, 'next').mockImplementation((task, candidates, active, ready) => select(task, candidates.filter(candidate => {
      const work = state.work(candidate.work_id)
      return work.purpose !== 'production' || work.assignment?.instructions !== 'Produce independent card'
    }), active, ready))
  }
  const model = async (_config: unknown, _key: unknown, messages: ChatMessage[]): Promise<Completion> => {
      const system = messages[0]!.content!, input = JSON.parse(messages.find(message => message.role === 'user')!.content!) as Row
      if (system.startsWith('You are the Collator.')) {
        expect(body(messages)).not.toMatch(/PRIVATE_UPSTREAM_EVIDENCE|Independent published card|Required detail card/)
        if (path === 'failure') throw new ModelError('MODEL_STREAM_INTERRUPTED')
        const { task_id, run_id, batch_id, composition_version } = input.batch
        const identity = { task_id, run_id, batch_id, composition_version }
        if (input.structural_issues?.length) {
          expect(expectsFeedback).toBe(true)
          if (path === 'feedback-only') expect(input.indexes).toEqual([])
          expect(input.structural_issues).toEqual([expect.objectContaining({ kind: 'missing_requirement', requirement: expect.objectContaining({ requirement_id: 'content' }) })])
          return answer(JSON.stringify({ ...identity, kind: 'feedback', reports: [{ evidence_id: input.structural_issues[0].evidence_id, recipient: { kind: 'router' } }] }))
        }
        const intents = input.indexes.map((index: Row) => {
          const section = input.batch.sections.find((section: Row) => section.section_id === index.section_id)
          return { artifact: { task_id, artifact_id: index.artifact_id, artifact_revision: index.artifact_revision }, section_id: index.section_id,
            section_position_revision: section.position_revision, order_key: section.order_key, slot_id: 'main', layout_mode: 'column', width_constraint: index.width_constraint }
        })
        return answer(JSON.stringify({ ...identity, intents }))
      }
      const tools = messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content!) as Row)
      if (input.bound?.feedback) {
        if (tools.length) {
          expect(tools[0]).toMatchObject({ execution: 'success' })
          return answer('{"kind":"updated"}')
        }
        return invoke(ROUTE_WORK, { action: 'dispatch', base_revision: input.bound.base_revision, assignments: [dispatch('repair', 'Supply required detail', 'detail', true, ['content'])] })
      }
      if (system.includes('Produce private upstream evidence')) return answer(statement)
      const binding = JSON.parse(system.split('Bound data: ').at(-1)!) as Row
      const content = system.includes('Produce independent card') ? independent : repaired
      const source = system.includes('Produce required detail')
      if (source) {
        const { kind: _kind, ...reference } = input.bound.work_outputs[0]
        if (!tools.length) return invoke(READ_WORK_OUTPUT, reference)
        expect(tools[0]).toMatchObject({ execution: 'success', data: { text: statement } })
        if (expectsFeedback) {
          const { task_id, request_id, intent_revision } = binding.owner
          return answer(JSON.stringify({ version: 1, complete: true, answer: null, artifacts: [], requirement_ids: [], unresolved: [{ task_id, request_id, intent_revision, requirement_id: 'content' }] }))
        }
      } else if (content === repaired) {
        expect(system).toContain('Supply required detail')
        await repairGate.promise
      }
      const resource = tools.find(tool => tool.provenance_ref?.kind === 'resource')
      if (!resource) return { ...answer(''), finish: 'tool_calls', calls: [{ id: 'write-card', type: 'function', function: { name: 'write', arguments: JSON.stringify({ operation: 'resource.create', input: { display_name: 'Card', content: { type: 'json', value: {
        profile: 'managed-v1', html: `<section><p>${content}</p></section>`, css: '', state: { schema: { type: 'object', properties: {}, additionalProperties: false }, initial: {}, compatibility_version: 'card-v1' }, forms: [], behaviors: [], references: [], export: []
      } } } }) } }] }
      const requirement_ids = content === independent ? [] : ['content']
      return answer(JSON.stringify({ version: 1, complete: true, answer: null, requirement_ids, unresolved: [], artifacts: [{ output_key: content === independent ? 'independent' : 'detail',
        section_id: binding.sections[0].section_id, bundle_resource_id: resource.data.id, provenance_ref: resource.provenance_ref, presentation_kind: 'managed-v1', width_constraint: 'full', interaction_kind: 'none', requirement_ids, unresolved: [] }] }))
  }
  s.complete.mockResolvedValueOnce(invoke(ROUTE_WORK, { action: 'dispatch', base_revision: 0, assignments })).mockResolvedValueOnce(answer('{"kind":"new"}')).mockImplementation(model)
  const request = s.submit('Create a document with a required detail and an independent card.')
  if (path === 'recovered') {
    await vi.waitFor(() => expect(s.records('runner.output.accepted')).toHaveLength(2))
    const original = s.records('runner.output.accepted')[0]!.payload.run_id
    await s.store.shutdown()
    s.close()
    s = setup({ directory: s.directory, task: s.task, releaseProfile: true })
    s.complete.mockImplementation(model)
    await s.store.recoverRunnerWork()
    expect(s.records('runner.production.resumed')).toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ previous_run_id: original }) }))
  }
  if (path === 'failure') {
    await vi.waitFor(() => expect(s.store.handle({ type: 'request.status', task_id: s.task, request_id: request.request_id })).toMatchObject({ run_state: 'completed', delivery_state: 'incomplete' }))
    const batches = s.db.prepare("SELECT json_extract(payload_json,'$.state') AS state FROM runner_batches WHERE task_id=?").all(s.task)
    expect(batches).toEqual([{ state: 'failed' }])
    expect(s.records('runner.delivery.settled')[0]?.payload.missing_requirement_ids).toEqual(['content'])
    return
  }
  const publish = async () => {
    const pending = () => s.store.snapshot(s.task).approvals.find(item => item.decision === 'pending' && item.validity === 'valid')
    await vi.waitFor(() => expect(pending()).toBeDefined(), { timeout: 3000 })
    const approval = pending()!
    s.store.handle({ type: 'approval.decide', task_id: s.task, approval_id: approval.id, decision: 'approve' })
    await vi.waitFor(() => expect(s.store.snapshot(s.task).surface_updates).toEqual([expect.objectContaining({ action_id: approval.action_id })]))
    await s.store.handle({ type: 'surface.respond', task_id: s.task, action_id: approval.action_id, proceed: true, confirm_discard: false })
  }
  if (path !== 'feedback-only') await publish()
  if (path === 'feedback') {
    expect(s.store.snapshot(s.task).views.map(view => view.bundle.html).join('')).toContain(independent)
    expect(s.store.snapshot(s.task).views.map(view => view.bundle.html).join('')).not.toContain(repaired)
    expect(s.store.handle({ type: 'request.status', task_id: s.task, request_id: request.request_id })).toMatchObject({ delivery_state: 'open' })
  }
  if (expectsFeedback) {
    await vi.waitFor(() => expect(s.records('runner.repair.plan')).toHaveLength(1))
    expect(s.store.handle({ type: 'request.status', task_id: s.task, request_id: request.request_id })).toMatchObject({ delivery_state: 'open' })
    repairGate.resolve()
    await publish()
  }
  await vi.waitFor(() => expect(s.store.handle({ type: 'request.status', task_id: s.task, request_id: request.request_id })).toMatchObject({ delivery_state: 'complete' }))
  expect(s.store.snapshot(s.task).views.map(view => view.bundle.html).join('')).toContain(repaired)
  expect(s.records('runner.output.handoff')).toHaveLength(1)
  expect(s.records('runner.composition.feedback')).toHaveLength(expectsFeedback ? 1 : 0)
  expect(s.records('runner.repair.plan')).toHaveLength(expectsFeedback ? 1 : 0)
  expect(s.records('runner.answer')).toHaveLength(0)
})

it('lets a waiting Worker release its slot and resume after Router-directed supplemental work', async () => {
  const s = setup({ conversationRouting: true }), independent = deferred<Completion>()
  const assignment = (key: string, instructions: string) => ({ assignment_key: key, instructions, required: true, requirement_ids: [], outputs: [{ kind: 'answer', output_key: 'text' }] })
  const bound = (messages: ChatMessage[]) => (JSON.parse(messages.find(message => message.role === 'user')!.content!) as Row).bound
  const tools = (messages: ChatMessage[]) => messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content!) as Row)
  s.complete.mockResolvedValueOnce(invoke(ROUTE_WORK, { action: 'dispatch', base_revision: 0, final_answer: 'consumer', assignments: [
    { ...assignment('consumer', 'Consume the requested value'), requirement_ids: ['answer'] }, assignment('independent', 'Complete unrelated work')
  ] })).mockResolvedValueOnce(answer('{"kind":"delegate"}')).mockImplementation(async (_config, _key, messages) => {
    const system = messages[0]?.content ?? ''
    if (system.includes('Complete unrelated work')) return independent.promise
    if (system.includes('reported missing input')) {
      const { report, base_revision } = bound(messages)
      expect(report.report.missing).toBe('Missing value')
      expect(s.records('runner.assignment.waiting')).toHaveLength(1)
      expect((s.db.prepare('SELECT state FROM runner_attempts WHERE attempt_id=?').get(report.attempt_id) as Row).state).toBe('revoked')
      const receipts = tools(messages)
      if (!receipts.length) return invoke(ROUTE_WORK, { action: 'dispatch', base_revision, assignments: [assignment('supply', 'Supply the missing value')] })
      if (receipts.length === 1) {
        const { work_id, plan_revision } = receipts[0]!.data.works[0]
        return invoke(ROUTE_WORK, { action: 'bind', base_revision: receipts[0]!.data.revision, work_id: report.work_id, input: { work_id, plan_revision, output_key: 'text' } })
      }
      expect(receipts[1]).toMatchObject({ execution: 'success', data: { revision: 3 } })
      return answer('{"kind":"updated"}')
    }
    if (system.includes('Supply the missing value')) return answer('Exact missing value')
    expect(system).toContain('Consume the requested value')
    const output = bound(messages).work_outputs?.[0]
    if (!output) {
      if (!tools(messages).length) return invoke(ROUTE_WORK, { action: 'dispatch', base_revision: 1, assignments: [assignment('forbidden', 'Forbidden assignment')] })
      expect(tools(messages)[0]).toMatchObject({ execution: 'not_executed', error: { code: 'WORKER_CAPABILITY_DENIED' } })
      return invoke(REPORT_MISSING_INPUT, { missing: 'Missing value', impact: 'Cannot answer exactly', wait: true })
    }
    const { kind: _kind, ...reference } = output
    if (!tools(messages).length) return invoke(READ_WORK_OUTPUT, reference)
    expect(tools(messages)[0]).toMatchObject({ execution: 'success', data: { text: 'Exact missing value' } })
    return answer('The value is available now.')
  })
  const request = s.submit('Find the value and complete the independent work.')
  await vi.waitFor(() => expect(s.records('runner.output.accepted')).toHaveLength(2))
  expect(s.records('runner.answer')).toHaveLength(0)
  const [waiting] = s.records('runner.assignment.waiting')
  const [handoff] = s.records('runner.output.handoff')
  expect(handoff!.payload).toMatchObject({ consumer_work_id: waiting!.payload.work_id, result_revision: 1 })
  expect(handoff!.payload.consumer_attempt_id).not.toBe(waiting!.payload.attempt_id)
  independent.resolve(answer('Independent result.'))
  await vi.waitFor(() => expect(s.store.handle({ type: 'request.status', task_id: s.task, request_id: request.request_id })).toMatchObject({ run_state: 'completed' }))
  expect(s.records('runner.answer').map(({ payload }) => payload.text)).toEqual(['The value is available now.'])
  expect(s.records('runner.input.routed')).toHaveLength(1)
})

it.each(['failure', 'no-progress'] as const)('settles a suspended assignment after missing-input routing shows %s', async result => {
  const s = setup({ conversationRouting: true })
  s.complete.mockResolvedValueOnce(invoke(ROUTE_WORK, { action: 'dispatch', base_revision: 0, final_answer: 'reply', assignments: [
    { assignment_key: 'reply', instructions: 'Use the missing value', required: true, requirement_ids: ['answer'], outputs: [{ kind: 'answer', output_key: 'text' }] }
  ] })).mockResolvedValueOnce(answer('{"kind":"delegate"}'))
    .mockResolvedValueOnce(invoke(REPORT_MISSING_INPUT, { missing: 'Missing value', impact: 'Cannot answer exactly', wait: true }))
  if (result === 'failure') s.complete.mockRejectedValueOnce(new ModelError('MODEL_STREAM_INTERRUPTED', true))
  else s.complete.mockResolvedValue(answer('{"kind":"updated"}'))

  const request = s.submit('Answer with the exact value.')
  const code = result === 'failure' ? 'MODEL_STREAM_INTERRUPTED' : 'RUNNER_PLAN_CONFLICT'
  await vi.waitFor(() => expect(s.store.handle({ type: 'request.status', task_id: s.task, request_id: request.request_id })).toMatchObject({ run_state: 'failed', delivery_state: 'incomplete' }))
  expect(s.records('runner.input.blocked').map(({ payload }) => payload)).toEqual([expect.objectContaining({ request_id: request.request_id, code })])
  expect(s.records('runner.input.routed')).toHaveLength(1)
  expect(s.records('runner.input.clarification')).toHaveLength(0)
  expect(s.records('worker.result.rejected')).toHaveLength(result === 'failure' ? 0 : 2)
})

it('resumes the waiting assignment only for an exact user reply under its confirmed configuration', async () => {
  const s = setup({ conversationRouting: true })
  s.complete.mockResolvedValueOnce(invoke(ROUTE_WORK, { action: 'dispatch', base_revision: 0, final_answer: 'answerer', assignments: [
    { assignment_key: 'answerer', instructions: 'Calculate the specified rate', required: true, requirement_ids: ['answer'], outputs: [{ kind: 'answer', output_key: 'rate' }] }
  ] })).mockResolvedValueOnce(answer('{"kind":"delegate"}'))
    .mockResolvedValueOnce(invoke(REPORT_MISSING_INPUT, { missing: 'Year', impact: 'Rate depends on year', wait: true }))
    .mockResolvedValueOnce(answer('{"kind":"clarification","question":"Which year should I use?"}'))
  const request = s.submit('What rate applies?')
  await vi.waitFor(() => expect(s.messages().filter(message => message.role === 'assistant').map(message => message.text)).toEqual(['Which year should I use?']))
  expect(s.store.handle({ type: 'request.status', task_id: s.task, request_id: request.request_id })).toMatchObject({ run_state: 'waiting' })
  expect(s.records('runner.answer')).toHaveLength(0)
  expect(s.records('runner.plan.revised')).toHaveLength(0)
  expect(s.complete).toHaveBeenCalledTimes(4)
  const clarification = s.records('runner.input.clarification')[0]!
  const originalWait = s.records('runner.assignment.waiting')[0]!
  const status = (request: Row) => s.store.handle({ type: 'request.status', task_id: s.task, request_id: request.request_id }) as Row
  s.complete.mockResolvedValueOnce(answer('{"kind":"reply","text":"The rate request is still waiting."}'))
  const unrelated = s.submit('Can we discuss something else?')
  await vi.waitFor(() => expect(status(unrelated).run_state).toBe('completed'))
  expect(s.records('runner.input.bound')).toHaveLength(0)

  const second = { ...s.config, id: 'another-model', wire_model_id: 'alternate' }
  s.models.configure({ type: 'model.configure', configuration: second, api_key: 'synthetic', confirm_memory_only: true })
  vi.mocked(s.models.list).mockReturnValue([s.config, second].map(config => ({ ...config, revision: 1, roles: ['main'], credential_missing: false })))
  vi.mocked(s.models.acquire).mockImplementation(modelId => {
    const config = modelId === second.id ? second : s.config
    return { id: config.id, revision: 1, config, release() {} }
  })
  const supply = async (_config: unknown, _key: unknown, messages: ChatMessage[]) => {
    const input = JSON.parse(messages.at(-1)!.content!) as Row
    expect(input.pending_worker_inputs).toContainEqual({ id: clarification.id, question: 'Which year should I use?', work_id: originalWait.payload.work_id, request_id: request.request_id })
    const checkpoint = input.work_table.find((entry: Row) => entry.work_id === originalWait.payload.work_id)?.checkpoints[0]?.checkpoint_id
    return answer(JSON.stringify({ kind: 'supply_input', message_id: clarification.id, ...(checkpoint ? { checkpoint_id: checkpoint } : {}) }))
  }
  const material = importText(s.store, s.task, 'Rates by year', '2024: 7%')
  s.complete.mockImplementationOnce(supply)
  const reply = s.submit('Use 2024 and the attached rate table.', [material.id], second.id)
  await vi.waitFor(() => expect(status(reply)).toMatchObject({ state: 'confirmation_required', code: 'REQUEST_CONFIGURATION_CHANGED' }))
  expect(s.records('runner.input.bound')).toHaveLength(0)
  expect(status(request).run_state).toBe('waiting')

  s.complete.mockImplementationOnce(supply).mockImplementationOnce(async (_config, _key, messages) => {
    const input = JSON.parse(messages.at(-1)!.content!) as Row
    expect(input.bound.supplemental_inputs).toEqual([expect.objectContaining({ clarification_id: clarification.id, text: 'Use 2024 and the attached rate table.', resource_ids: [material.id] })])
    expect(input.request_materials).toContainEqual({ kind: 'resource', task_id: s.task, resource_id: material.id })
    return answer('The rate for 2024 is 7%.')
  })
  const resumed = vi.spyOn(s.store, 'executeRunnerProduction')
  await s.store.handle({ type: 'request.resolve', task_id: s.task, request_id: reply.request_id, model_config_id: s.config.id, use_successful: false, replacements: [], confirm: true })
  await vi.waitFor(() => expect(status(reply)).toMatchObject({ state: 'started', code: null }))
  await expect(resumed.mock.results[0]?.value).resolves.toMatchObject({ answer: 'The rate for 2024 is 7%.' })
  await vi.waitFor(() => expect(status(request).run_state).toBe('completed'))
  expect(s.records('runner.input.bound')).toHaveLength(1)
  expect(s.records('runner.checkpoint.reused')).toHaveLength(1)
  const [final] = s.records('runner.answer')
  expect(final!.payload).toMatchObject({ request_id: request.request_id, text: 'The rate for 2024 is 7%.', owner: { work_id: originalWait.payload.work_id } })
  expect(final!.payload.owner.attempt_id).not.toBe(originalWait.payload.attempt_id)
})

it.each(['shutdown', 'restart'] as const)('keeps a settled Worker clarification answerable after %s without replaying its attempt', async boundary => {
  const first = setup({ conversationRouting: true })
  first.complete.mockResolvedValueOnce(invoke(ROUTE_WORK, { action: 'dispatch', base_revision: 0, final_answer: 'reply', assignments: [
    { assignment_key: 'reply', instructions: 'Answer using the requested date', required: true, requirement_ids: ['answer'], outputs: [{ kind: 'answer', output_key: 'date' }] }
  ] })).mockResolvedValueOnce(answer('{"kind":"delegate"}'))
    .mockResolvedValueOnce(invoke(REPORT_MISSING_INPUT, { missing: 'Date', impact: 'The answer depends on the date', wait: true }))
    .mockResolvedValueOnce(answer('{"kind":"clarification","question":"Which date should I use?"}'))
  const request = first.submit('What did we ship on that date?')
  await vi.waitFor(() => expect(first.records('runner.input.clarification')).toHaveLength(1))
  const [clarification] = first.records('runner.input.clarification'), [waiting] = first.records('runner.assignment.waiting')
  if (boundary === 'shutdown') await first.store.shutdown()
  first.close()

  const next = setup({ directory: first.directory, task: first.task, conversationRouting: true })
  const state = new RunnerWorkState(next.db, next.store.epoch)
  await next.store.recoverRunnerWork()
  const work = state.work(waiting!.payload.work_id)
  expect(work).toMatchObject({ state: 'waiting', current_attempt_id: waiting!.payload.attempt_id, plan_revision: waiting!.payload.plan_revision })
  expect(work.run_id).not.toBe(waiting!.payload.run_id)
  expect(state.run(work.run_id)).toMatchObject({ state: 'waiting', commit_valid: true, previous_run_id: waiting!.payload.run_id })
  expect(next.complete).not.toHaveBeenCalled()
  next.complete.mockImplementationOnce(async (_config, _key, messages) => {
    const routing = JSON.parse(messages.at(-1)!.content!) as Row
    expect(routing.pending_worker_inputs).toContainEqual({ id: clarification!.id, question: 'Which date should I use?', work_id: work.work_id, request_id: request.request_id })
    return answer(JSON.stringify({ kind: 'supply_input', message_id: clarification!.id }))
  }).mockImplementationOnce(async (_config, _key, messages) => {
    const input = JSON.parse(messages.at(-1)!.content!) as Row
    expect(input.bound.supplemental_inputs).toEqual([expect.objectContaining({ clarification_id: clarification!.id, text: 'Use October 5.' })])
    return answer('The October 5 release contained the requested fixes.')
  })
  next.submit('Use October 5.')
  await vi.waitFor(() => expect(next.store.handle({ type: 'request.status', task_id: next.task, request_id: request.request_id })).toMatchObject({ run_state: 'completed', delivery_state: 'complete' }))
  expect(state.attempts(work.work_id)).toEqual([
    expect.objectContaining({ run_id: waiting!.payload.run_id, state: 'revoked', attempt_id: waiting!.payload.attempt_id }),
    expect.objectContaining({ run_id: work.run_id, state: 'succeeded', previous_attempt_id: waiting!.payload.attempt_id })
  ])
  expect(next.complete).toHaveBeenCalledTimes(2)
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
