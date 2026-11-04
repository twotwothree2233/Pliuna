import { expect, it, vi } from 'vitest'
import { ChatAdapter, ModelError } from '../../src/runtime/model/adapter'
import { RunBudget, runAgent, type AgentHost } from '../../src/runtime/model/agent'
import { ModelService } from '../../src/runtime/model/service'
import { context, setup, lease, answer } from '../helpers/compaction'
import { frame } from '../helpers/model-server'

it('uses the matching provider count instead of treating Unicode bytes as tokens', () => {
  const budget = new RunBudget({ ...lease.config, context_tokens: 10000 })
  const messages = [{ role: 'user' as const, content: '中'.repeat(2000) }]
  const reserved = budget.reserve(messages, undefined)
  budget.settle(reserved, { text: 'done', calls: [], finish: 'stop', usage: { prompt_tokens: 2000, completion_tokens: 10 } }, messages, undefined)
  const next = [...messages, { role: 'assistant' as const, content: 'done' }, { role: 'user' as const, content: '新'.repeat(10000) }]
  expect(budget.plan(next, undefined)).toMatchObject({ measurement: 'provider-usage', estimated_input: 2010, needsCompaction: false, fits: true })
  expect(() => budget.reserve(next, undefined)).not.toThrow()
  expect(new RunBudget(lease.config).plan(messages, undefined).measurement).toBe('serialized-utf8-estimate')
})

it.each([400, 413])('classifies explicit context errors at HTTP %s without leaking the response', async status => {
  const adapter = new ChatAdapter(async () => new Response(JSON.stringify({ error: { code: 'context_length_exceeded', message: 'private details' } }), { status }))
  await expect(adapter.complete(lease.config, '', [], undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'MODEL_CONTEXT_LENGTH_EXCEEDED', message: 'MODEL_CONTEXT_LENGTH_EXCEEDED', retryable: false })
})

it('does not classify arbitrary invalid requests as context overflow', async () => {
  const adapter = new ChatAdapter(async () => new Response(JSON.stringify({ error: { code: 'invalid_parameter', message: 'max_tokens invalid' } }), { status: 400 }))
  await expect(adapter.complete(lease.config, '', [], undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'MODEL_INVALID_REQUEST' })
})

it('falls back only after a response omits usage and keeps model configurations separate', () => {
  const budget = new RunBudget(lease.config), messages = [{ role: 'user' as const, content: 'hello' }]
  budget.settle(budget.reserve(messages, undefined), { text: 'done', calls: [], finish: 'stop', usage: { prompt_tokens: 220000, completion_tokens: 1 } })
  expect(budget.plan(messages, undefined)).toMatchObject({ measurement: 'provider-usage', needsCompaction: true })
  expect(budget.plan(messages, undefined, { ...lease.config, wire_model_id: 'other' }).measurement).toBe('serialized-utf8-estimate')
  budget.settle(budget.reserve(messages, undefined), { text: 'done', calls: [], finish: 'stop' })
  expect(budget.plan(messages, undefined).measurement).toBe('serialized-utf8-estimate')
})

it('invalidates provider measurements when compaction replaces the measured input prefix', () => {
  const budget = new RunBudget(lease.config)
  const original = [{ role: 'system' as const, content: 'rules' }, { role: 'user' as const, content: 'old history' }]
  budget.observe(original, undefined, { prompt_tokens: 220000, completion_tokens: 100 })
  expect(budget.plan([...original, { role: 'assistant', content: 'reply' }], undefined)).toMatchObject({ measurement: 'provider-usage', needsCompaction: true })
  const replaced = [original[0]!, { role: 'user' as const, content: 'working summary' }]
  const plan = budget.plan(replaced, undefined)
  expect(plan).toMatchObject({ measurement: 'serialized-utf8-estimate', needsCompaction: false })
  expect(plan.estimated_input).toBe(budget.estimate(replaced, undefined))
  expect(budget.plan(original.slice(0, 1), undefined).measurement).toBe('serialized-utf8-estimate')
})

it.each([8999, 9000, 9001])('checks the completed request boundary at %i provider tokens', total => {
  const config = { ...lease.config, context_tokens: 10000 }
  const messages = [{ role: 'user' as const, content: 'goal' }], budget = new RunBudget(config)
  budget.observe(messages, undefined, { prompt_tokens: total - 10, completion_tokens: 10 })
  const next = [...messages, { role: 'assistant' as const, content: 'reply' }]
  expect(budget.plan(next, undefined)).toMatchObject({ measurement: 'provider-usage', estimated_input: total, needsCompaction: total >= 9000, fits: true })
  expect(budget.plan(next, undefined, { ...config, max_output_tokens: 1 }).measurement).toBe('serialized-utf8-estimate')
  expect(budget.plan(next, [], config).measurement).toBe('serialized-utf8-estimate')
})

it('uses the latest single request rather than cumulative Run usage and separates tool-bearing requests', () => {
  const budget = new RunBudget({ ...lease.config, context_tokens: 10000 }), messages = [{ role: 'user' as const, content: 'goal' }]
  const tools = [{ type: 'function' as const, function: { name: 'list', description: '', parameters: {} } }]
  for (let n = 0; n < 5; n++) budget.settle(budget.reserve(messages, tools), { text: 'done', calls: [], finish: 'stop', usage: { prompt_tokens: 2000, completion_tokens: 10 } })
  expect(budget.state.tokens).toBe(10050)
  expect(budget.plan(messages, tools)).toMatchObject({ estimated_input: 2010, needsCompaction: false })
  budget.settle(budget.reserve(messages, undefined), { text: 'summary', calls: [], finish: 'stop', usage: { prompt_tokens: 9500, completion_tokens: 10 } })
  expect(budget.plan(messages, tools)).toMatchObject({ estimated_input: 2010, needsCompaction: false })
  expect(budget.plan(messages, undefined)).toMatchObject({ estimated_input: 9510, needsCompaction: true })
})

it('classifies a streamed context failure and cancels without dispatching partial tool arguments', async () => {
  let cancelled = false
  const adapter = new ChatAdapter(async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(frame({ tool_calls: [{ index: 0, id: 'unfinished', type: 'function', function: { name: 'write', arguments: '{' } }] }) + 'data: {"error":{"code":"context_length_exceeded"}}\n\n'))
  }, cancel() { cancelled = true } }), { headers: { 'content-type': 'text/event-stream' } }))
  await expect(adapter.complete(lease.config, '', [], [{ type: 'function', function: { name: 'write', description: '', parameters: {} } }], new AbortController().signal)).rejects.toMatchObject({ code: 'MODEL_CONTEXT_LENGTH_EXCEEDED', partial: true })
  expect(cancelled).toBe(true)
})

it('recovers a rejected request before resending and never executes its unfinished tool calls', async () => {
  const service = new ModelService(), contextHook = vi.fn<NonNullable<AgentHost['context']>>(async (messages, recovery) => recovery ? messages.slice(0, 1) : messages), tool = vi.fn(), record = vi.fn()
  const request = vi.spyOn(service, 'request').mockImplementationOnce(async (...args) => { args[5]?.('unfinished text'); throw new ModelError('MODEL_CONTEXT_LENGTH_EXCEEDED', true) }).mockResolvedValue({ text: 'final', calls: [], finish: 'stop' })
  await runAgent(service, lease, 'task', [{ role: 'user', content: 'long history'.repeat(100) }], { context: contextHook, valid() {}, state() {}, budget() {}, record, tool }, new AbortController().signal)
  expect(contextHook.mock.calls.some(call => call[1]?.overflow && call[1]?.partial === 'unfinished text')).toBe(true)
  expect(request).toHaveBeenCalledTimes(2); expect(tool).not.toHaveBeenCalled()
  expect(record).toHaveBeenCalledWith('message.assistant.partial', expect.objectContaining({ text: 'unfinished text', incomplete: true }))
})

it('temporarily excludes the current complete batch and restores it verbatim after compaction', async () => {
  const messages = context(); messages[2] = answer('old', 2, 'older context'.repeat(1000))
  const s = setup(messages)
  const { compactContext } = await import('../../src/runtime/model/context')
  const next = await compactContext(s.service, lease, 'task', s.budget, s.controller.signal, s.messages, 6, undefined, s.host, { overflow: true, partial: 'unfinished answer' })
  const input = s.request.mock.calls[0]![2]
  expect(input.some(message => message.role === 'tool')).toBe(false)
  expect(next.slice(-4)).toEqual(s.messages.slice(-4))
  expect(next[1]!.content).toContain('unfinished answer')
  expect(next[1]!.content).toContain('处理到一半')
  expect(s.install).toHaveBeenCalledOnce()
})

it('recovers when the organizing request itself is rejected, installing only the successful summary', async () => {
  const messages = context(); messages[2] = answer('old', 2, 'older context'.repeat(1000))
  const s = setup(messages)
  s.request.mockRejectedValueOnce(new ModelError('MODEL_CONTEXT_LENGTH_EXCEEDED')).mockResolvedValueOnce({ text: 'recovered summary', calls: [], finish: 'stop' })
  const next = await s.run()
  expect(s.request).toHaveBeenCalledTimes(2); expect(s.install).toHaveBeenCalledOnce()
  expect(s.request.mock.calls[0]![2].some(message => message.role === 'tool')).toBe(true)
  expect(s.request.mock.calls[1]![2].some(message => message.role === 'tool')).toBe(false)
  expect(next.slice(-4)).toEqual(s.messages.slice(-4))
})

it.each(['same-size', 'cancelled'] as const)('stops recovery after %s without another request', async reason => {
  const service = new ModelService(), controller = new AbortController()
  const request = vi.spyOn(service, 'request').mockRejectedValue(new ModelError('MODEL_CONTEXT_LENGTH_EXCEEDED'))
  const recover = vi.fn<NonNullable<AgentHost['context']>>(async (messages, recovery) => { if (recovery && reason === 'cancelled') controller.abort(); return messages })
  await expect(runAgent(service, lease, 'task', [], { context: recover, valid() {}, state() {}, budget() {}, record() {}, async tool() {} }, controller.signal)).rejects.toMatchObject({ code: reason === 'cancelled' ? 'MODEL_CANCELLED' : 'CONTEXT_RECOVERY_NO_PROGRESS' })
  expect(request).toHaveBeenCalledOnce()
})
