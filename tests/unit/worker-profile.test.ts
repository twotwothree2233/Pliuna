import { expect, it, vi } from 'vitest'
import { RunBudget, runAgent, type AgentHost } from '../../src/runtime/model/agent'
import { ModelService, type ModelLease } from '../../src/runtime/model/service'
import type { ChatMessage, Completion } from '../../src/runtime/model/adapter'
import { modelToolRequest } from '../../src/runtime/model/tool-input'
import { modelTools } from '../../src/runtime/model/tools'
import { ContractError } from '../../src/shared/validation'
import { createWorkerProfile, type WorkerProfileInput, type WorkerRole } from '../../src/runtime/runner/worker-profile'

const config = { id: 'worker', base_url: 'https://example.invalid', wire_model_id: 'synthetic', context_tokens: 100000, max_output_tokens: 8192, compatibility_profile: 'chat-max-tokens' as const }
interface Answer { purpose: 'final_answer'; text: string }
const answer: Answer = { purpose: 'final_answer', text: 'Required answer' }
const final = (): Completion => ({ text: JSON.stringify(answer), calls: [], finish: 'stop', request_link: { request_id: 'provider-request', evidence_event_id: 'evidence-record' } })
const read = () => ({ id: 'read-call', type: 'function' as const, function: { name: 'read', arguments: JSON.stringify({ kind: 'resource', id: 'allowed' }) } })
function profile(role: WorkerRole = 'lightweight') {
  return createWorkerProfile({
    id: `${role}-v1`, role, system: `System for ${role}`,
    grants: [{ type: 'read', kind: 'resource', ids: ['allowed'] }],
    parseResult(response): Answer {
      const value = JSON.parse(response.text) as Partial<Answer>
      if (value.purpose !== 'final_answer' || typeof value.text !== 'string') throw Error(`Invalid result: ${response.text}`)
      return { purpose: value.purpose, text: value.text }
    }
  })
}
function setup(responses: Completion[] = [final()]) {
  const service = new ModelService(), lease: ModelLease = { id: config.id, revision: 1, config, release() {} }, controller = new AbortController()
  const inputs: ChatMessage[][] = [], records: { kind: string; payload: Record<string, unknown> }[] = []
  const request = vi.spyOn(service, 'request').mockImplementation(async (_lease, _task, messages, _tools, _signal, _onText, _limit, onStart) => {
    inputs.push(structuredClone(messages)); onStart?.()
    const next = responses.shift()
    if (!next) throw Error('Unexpected extra model request')
    return next
  })
  const tool = vi.fn(async (_request: unknown, _signal: AbortSignal): Promise<unknown> => ({ request_type: 'read', execution: 'success', delivery: 'delivered', truncated: false, data: { value: 'authorized data' } }))
  const host: AgentHost = { valid: vi.fn(), context: vi.fn(async messages => messages), state: vi.fn(), budget: vi.fn(), record(kind, payload) { records.push({ kind, payload }) }, tool }
  const onResult = vi.fn(async (_result: Answer): Promise<void> => {})
  const budget = new RunBudget(config)
  return { service, lease, controller, inputs, records, request, tool, host, onResult, budget }
}
function execute(fixture: ReturnType<typeof setup>, selected = profile()) {
  return runAgent(fixture.service, fixture.lease, 'real-task', [{ role: 'user', content: 'Work request' }], fixture.host, fixture.controller.signal, fixture.budget, { profile: selected, onResult: fixture.onResult })
}

it.each(['lightweight', 'producer', 'integrator'] as const)('runs %s work through the same tool, recording, budget and typed answer path', async role => {
  const fixture = setup([{ text: '', calls: [read()], finish: 'tool_calls' }, final()]), selected = profile(role)
  await execute(fixture, selected)
  expect(fixture.onResult).toHaveBeenCalledExactlyOnceWith(answer)
  expect(fixture.request).toHaveBeenCalledTimes(2)
  expect(fixture.request.mock.calls.every(call => call[1] === 'real-task' && call[4] === fixture.controller.signal)).toBe(true)
  expect(fixture.request.mock.calls[0]![3]).toEqual([modelTools.find(tool => tool.function.name === 'read')])
  expect(fixture.request.mock.calls[0]![3]![0]).toBe(modelTools.find(tool => tool.function.name === 'read'))
  expect(fixture.inputs[0]![0]).toEqual({ role: 'system', content: selected.system })
  expect(fixture.tool).toHaveBeenCalledExactlyOnceWith(modelToolRequest('read', { kind: 'resource', id: 'allowed' }), fixture.controller.signal)
  expect(fixture.budget.state).toMatchObject({ model_requests: 2, tool_requests: 1 })
  expect(fixture.host.valid).toHaveBeenCalled()
  expect(fixture.host.state).toHaveBeenCalledWith('waiting', 'model_queue')
  expect(fixture.records.map(record => record.kind)).toEqual(['model.response', 'model.tool_result', 'model.response', 'message.assistant'])
  expect(fixture.records.at(-1)?.payload).toMatchObject({ text: JSON.stringify(answer), request_link: final().request_link })
  expect(fixture.inputs[1]!.filter(message => message.role === 'tool')).toHaveLength(1)
  expect(fixture.inputs[1]!.find(message => message.role === 'tool')?.tool_call_id).toBe('read-call')
})

it.each(['lightweight', 'producer'] as const)('checks cancellation before %s dispatch', async role => {
  const fixture = setup(); fixture.controller.abort()
  await expect(execute(fixture, profile(role))).rejects.toMatchObject({ code: 'MODEL_CANCELLED' })
  expect(fixture.request).not.toHaveBeenCalled(); expect(fixture.onResult).not.toHaveBeenCalled()
})

it.each(['lightweight', 'producer'] as const)('checks %s execution qualification before dispatch', async role => {
  const fixture = setup()
  fixture.host.valid = () => { throw new ContractError('SOURCE_INVALID', 'Source revoked') }
  await expect(execute(fixture, profile(role))).rejects.toMatchObject({ code: 'SOURCE_INVALID' })
  expect(fixture.request).not.toHaveBeenCalled(); expect(fixture.onResult).not.toHaveBeenCalled()
})

it.each(['cancelled', 'revoked'] as const)('does not install a result when final context processing is %s', async reason => {
  const fixture = setup(); let valid = true
  fixture.host.valid = () => { if (!valid) throw new ContractError('SOURCE_INVALID', 'Source revoked') }
  fixture.host.context = vi.fn(async messages => {
    if (messages.at(-1)?.role === 'assistant') {
      if (reason === 'cancelled') fixture.controller.abort()
      else valid = false
    }
    return messages
  })
  await expect(execute(fixture)).rejects.toMatchObject({ code: reason === 'cancelled' ? 'MODEL_CANCELLED' : 'SOURCE_INVALID' })
  expect(fixture.onResult).not.toHaveBeenCalled()
  expect(fixture.records.map(record => record.kind)).toEqual(['model.response'])
})

it('retains invalid raw response evidence without final answer delivery or a success callback', async () => {
  const text = JSON.stringify({ purpose: 'wrong', text: 'PRIVATE BODY' }), fixture = setup([{ text, finish: 'stop', calls: [] }])
  await expect(execute(fixture)).rejects.toMatchObject({ code: 'INVALID_WORKER_RESULT', message: 'Worker result does not satisfy its required contract' })
  expect(fixture.onResult).not.toHaveBeenCalled()
  expect(fixture.records.map(record => record.kind)).toEqual(['model.response'])
  expect((fixture.records[0]!.payload.message as ChatMessage).content).toBe(text)
})

it('accepts only an optional nonempty trusted result correction instruction', () => {
  const input: WorkerProfileInput<Answer> = { id: 'correcting', role: 'lightweight', system: 'rules', grants: [], parseResult: () => answer }
  expect(createWorkerProfile(input).resultCorrection).toBeUndefined()
  expect(createWorkerProfile({ ...input, resultCorrection: 'Return the required result contract.' }).resultCorrection).toBe('Return the required result contract.')
  for (const resultCorrection of ['', null, 3, {}, []]) {
    const invalid = { ...input }
    Object.assign(invalid, { resultCorrection })
    expect(() => createWorkerProfile(invalid)).toThrow(expect.objectContaining({ code: 'INVALID_WORKER_PROFILE' }))
  }
})

it('does not correct or expose an unexpected parser exception even when correction is enabled', async () => {
  const fixture = setup([final(), final()])
  const selected = createWorkerProfile({ id: 'correcting', role: 'lightweight', system: 'rules', grants: [], resultCorrection: 'Correct the contract.', parseResult(): Answer { throw Error('PRIVATE PARSER BODY') } })
  await expect(execute(fixture, selected)).rejects.toMatchObject({ code: 'INVALID_WORKER_RESULT', message: 'Worker result does not satisfy its required contract' })
  expect(fixture.request).toHaveBeenCalledOnce()
  expect(fixture.onResult).not.toHaveBeenCalled()
  expect(fixture.records.map(record => record.kind)).toEqual(['model.response'])
  expect(JSON.stringify(fixture.records)).not.toContain('PRIVATE PARSER BODY')
})

it.each(['resolved', 'rejected'] as const)('does not correct a %s asynchronous parser even when correction is enabled', async state => {
  const fixture = setup([final(), final()])
  const selected = createWorkerProfile({
    id: 'correcting-async', role: 'lightweight', system: 'rules', grants: [], resultCorrection: 'Correct the contract.',
    async parseResult() { if (state === 'rejected') throw new ContractError('INVALID_WORKER_RESULT', 'PRIVATE ASYNC BODY'); return answer }
  })
  const onResult = vi.fn()
  await expect(runAgent(fixture.service, fixture.lease, 'real-task', [], fixture.host, fixture.controller.signal, fixture.budget, { profile: selected, onResult })).rejects.toMatchObject({ code: 'INVALID_WORKER_RESULT', message: 'Worker result does not satisfy its required contract' })
  expect(fixture.request).toHaveBeenCalledOnce()
  expect(onResult).not.toHaveBeenCalled()
  expect(fixture.records.map(record => record.kind)).toEqual(['model.response'])
  expect(JSON.stringify(fixture.records)).not.toContain('PRIVATE ASYNC BODY')
})

it('does not correct a thenable parser result even when correction is enabled', async () => {
  const fixture = setup([final(), final()])
  const selected = createWorkerProfile({
    id: 'correcting-thenable', role: 'lightweight', system: 'rules', grants: [], resultCorrection: 'Correct the contract.',
    parseResult: () => ({ ...answer, then(resolve: (value: Answer) => void) { resolve(answer) } })
  })
  await expect(execute(fixture, selected)).rejects.toMatchObject({ code: 'INVALID_WORKER_RESULT', message: 'Worker result does not satisfy its required contract' })
  expect(fixture.request).toHaveBeenCalledOnce()
  expect(fixture.onResult).not.toHaveBeenCalled()
  expect(fixture.records.map(record => record.kind)).toEqual(['model.response'])
})

it('honors cancellation after adding a correction to the same conversation', async () => {
  const fixture = setup([{ ...final(), text: 'invalid result' }, final()]), correction = 'Correct the contract.'
  const selected = createWorkerProfile({
    id: 'correcting-cancel', role: 'lightweight', system: 'rules', grants: [], resultCorrection: correction,
    parseResult(): Answer { throw new ContractError('INVALID_WORKER_RESULT', 'PRIVATE REJECTION BODY') }
  })
  fixture.host.context = vi.fn(async messages => {
    if (messages[0]?.role === 'system' && messages[0].content?.includes(correction)) fixture.controller.abort()
    return messages
  })
  await expect(execute(fixture, selected)).rejects.toMatchObject({ code: 'MODEL_CANCELLED' })
  expect(fixture.request).toHaveBeenCalledOnce()
  expect(fixture.onResult).not.toHaveBeenCalled()
  expect(fixture.records.map(record => record.kind)).toEqual(['model.response', 'worker.result.rejected'])
  expect(JSON.stringify(fixture.records)).not.toContain('PRIVATE REJECTION BODY')
})

it('waits for the typed result installation before recording the final answer', async () => {
  const fixture = setup(); let finish!: () => void
  fixture.onResult.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
  const running = execute(fixture)
  await vi.waitFor(() => expect(fixture.onResult).toHaveBeenCalledOnce())
  expect(fixture.records.map(record => record.kind)).toEqual(['model.response'])
  finish(); await running
  expect(fixture.records.at(-1)?.kind).toBe('message.assistant')
})

it('propagates result installation failure without recording a final answer', async () => {
  const fixture = setup()
  fixture.onResult.mockRejectedValue(new ContractError('INSTALL_FAILED', 'Installation failed'))
  await expect(execute(fixture)).rejects.toMatchObject({ code: 'INSTALL_FAILED' })
  expect(fixture.records.map(record => record.kind)).toEqual(['model.response'])
})

it.each(['resolved', 'rejected'] as const)('rejects a %s asynchronous result parser without leaking its result or rejection', async state => {
  const fixture = setup(), selected = createWorkerProfile({ id: 'async', role: 'lightweight', system: 'rules', grants: [], async parseResult() { if (state === 'rejected') throw Error('PRIVATE BODY'); return answer } })
  const onResult = vi.fn()
  await expect(runAgent(fixture.service, fixture.lease, 'real-task', [], fixture.host, fixture.controller.signal, fixture.budget, { profile: selected, onResult })).rejects.toMatchObject({ code: 'INVALID_WORKER_RESULT' })
  expect(onResult).not.toHaveBeenCalled(); expect(fixture.records.map(record => record.kind)).toEqual(['model.response'])
})

it('refuses a custom public tool definition even if a supplied profile includes it', async () => {
  const fixture = setup(), selected = profile()
  await expect(execute(fixture, { ...selected, tools: [{ type: 'function', function: { name: 'new_entry', description: 'unsupported', parameters: {} } }] })).rejects.toMatchObject({ code: 'INVALID_WORKER_PROFILE' })
  expect(fixture.request).not.toHaveBeenCalled()
})

it('denies an ungranted body read before the host tool, retaining complete tool pairing', async () => {
  const forbidden = read(); forbidden.function.arguments = JSON.stringify({ kind: 'resource', id: 'private-body' })
  const fixture = setup([{ text: '', finish: 'tool_calls', calls: [forbidden, { ...read(), id: 'after-failure' }] }, final()])
  await execute(fixture)
  expect(fixture.tool).not.toHaveBeenCalled()
  const results = fixture.records.filter(record => record.kind === 'model.tool_result').map(record => record.payload.message as ChatMessage)
  expect(results.map(message => message.tool_call_id)).toEqual(['read-call', 'after-failure'])
  expect(JSON.parse(results[0]!.content!)).toMatchObject({ execution: 'not_executed', error: { code: 'WORKER_CAPABILITY_DENIED', message: 'Worker profile does not grant this object or operation' } })
  expect(JSON.parse(results[1]!.content!)).toMatchObject({ error: { code: 'PREVIOUS_TOOL_FAILED' } })
  expect(results[0]!.content).not.toContain('private-body')
})

it('authorizes only exact list kinds, read objects, write operations and capabilities', () => {
  const selected = createWorkerProfile({ id: 'precise', role: 'producer', system: 'rules', grants: [{ type: 'list', kind: 'resource' }, { type: 'read', kind: 'resource', ids: ['allowed'] }, { type: 'write', operation: 'resource.create' }, { type: 'call', capability: 'builtin:monty:v1' }], parseResult: () => answer })
  const allowed = [modelToolRequest('list', { kind: 'resource' }), modelToolRequest('read', { kind: 'resource', id: 'allowed' }), modelToolRequest('write', { operation: 'resource.create', input_json: JSON.stringify({ display_name: 'Result', content: { type: 'text', text: 'Body' } }) }), modelToolRequest('call', { capability: 'builtin:monty:v1', input_json: '{}' })]
  for (const request of allowed) expect(() => selected.authorize(request)).not.toThrow()
  const rejected = [modelToolRequest('list', { kind: 'view' }), modelToolRequest('read', { kind: 'resource', id: 'elsewhere' }), modelToolRequest('read', { kind: 'message', id: 'allowed' }), modelToolRequest('call', { capability: 'different:capability', input_json: '{}' })]
  for (const request of rejected) expect(() => selected.authorize(request)).toThrow(expect.objectContaining({ code: 'WORKER_CAPABILITY_DENIED' }))
})

it.each(['unknown-type', 'unknown-root-field', 'unknown-input-field', 'unknown-target-field'] as const)('denies %s with a constant error at the reusable host authorization Interface', reason => {
  const selected = profile(), request = modelToolRequest('read', { kind: 'resource', id: 'allowed' })
  if (reason === 'unknown-type') Object.assign(request, { type: 'PRIVATE BODY' })
  if (reason === 'unknown-root-field') Object.assign(request, { private_field: 'PRIVATE BODY' })
  if (reason === 'unknown-input-field') Object.assign(request.input, { private_field: 'PRIVATE BODY' })
  if (reason === 'unknown-target-field' && request.type === 'read') Object.assign(request.input.target, { private_field: 'PRIVATE BODY' })
  expect(() => selected.authorize(request)).toThrow(expect.objectContaining({ code: 'WORKER_CAPABILITY_DENIED', message: 'Worker profile does not grant this object or operation' }))
})

it('freezes copied grants and exposes only existing tool definitions', () => {
  const ids = ['allowed'], grants = [{ type: 'read' as const, kind: 'resource', ids }]
  const selected = createWorkerProfile({ id: 'fixed', role: 'lightweight', system: 'rules', grants, parseResult: () => answer })
  ids.push('new-object'); grants[0]!.kind = 'message'
  expect(() => selected.authorize(modelToolRequest('read', { kind: 'resource', id: 'allowed' }))).not.toThrow()
  expect(() => selected.authorize(modelToolRequest('read', { kind: 'resource', id: 'new-object' }))).toThrow(expect.objectContaining({ code: 'WORKER_CAPABILITY_DENIED' }))
  expect(Object.isFrozen(selected.tools)).toBe(true)
  expect(selected.tools).toHaveLength(1); expect(selected.tools[0]).toBe(modelTools.find(tool => tool.function.name === 'read'))
})

it.each(['unknown-grant-type', 'unknown-grant-field', 'unknown-profile-field'] as const)('rejects %s while building the trusted profile', reason => {
  const input = { id: 'bad', role: 'lightweight' as const, system: 'rules', grants: [{ type: 'read' as const, kind: 'resource' }], parseResult: () => answer }
  if (reason === 'unknown-grant-type') Object.assign(input.grants[0]!, { type: 'delete' })
  if (reason === 'unknown-grant-field') Object.assign(input.grants[0]!, { body: 'PRIVATE BODY' })
  if (reason === 'unknown-profile-field') Object.assign(input, { body: 'PRIVATE BODY' })
  expect(() => createWorkerProfile(input)).toThrow(expect.objectContaining({ code: 'INVALID_WORKER_PROFILE' }))
})
