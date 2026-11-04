import { afterEach, expect, it, vi } from 'vitest'
import { ChatAdapter } from '../../src/runtime/model/adapter'
import { ModelService, type ModelLease } from '../../src/runtime/model/service'
import { RunBudget, runAgent } from '../../src/runtime/model/agent'
import { compactContext } from '../../src/runtime/model/context'
import { requestAccounting } from '../../src/runtime/model/accounting'
import { deadline } from '../../src/runtime/model/limits'
import { assertContract } from '../../src/shared/validation'
import type { ModelConfiguration } from '../../src/shared/contracts.generated'
import { frame } from '../helpers/model-server'

const config: ModelConfiguration = { id: 'limits', base_url: 'https://example.invalid/v1', wire_model_id: 'synthetic', context_tokens: 1000000, max_output_tokens: 32768, compatibility_profile: 'chat-max-tokens' }
const reply = (text: string) => new Response(frame({ content: text }) + frame({}, 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

it.each(['chat-max-tokens', 'chat-max-completion-tokens'] as const)('sends exact configured output or omits both parameters for %s', async profile => {
  const bodies: any[] = [], adapter = new ChatAdapter(async (_url, init) => { bodies.push(JSON.parse(String(init!.body))); return reply('ok') })
  const { max_output_tokens: _, ...unset } = config
  await adapter.complete({ ...config, compatibility_profile: profile }, '', [], undefined, new AbortController().signal)
  await adapter.complete({ ...unset, compatibility_profile: profile }, '', [], undefined, new AbortController().signal)
  expect(bodies[0][profile === 'chat-max-tokens' ? 'max_tokens' : 'max_completion_tokens']).toBe(32768)
  expect(bodies[1]).not.toHaveProperty('max_tokens'); expect(bodies[1]).not.toHaveProperty('max_completion_tokens')
})

it.each([32768, undefined])('all synthetic roles use configured output %s without a test cap', async output => {
  const adapter = new ChatAdapter(), service = new ModelService(adapter), { max_output_tokens: _, ...base } = config
  const configured = output === undefined ? base : { ...base, max_output_tokens: output }
  service.configure({ type: 'model.configure', configuration: configured, api_key: '', confirm_memory_only: true })
  const complete = vi.spyOn(adapter, 'complete').mockImplementation(async (_c, _k, messages) => {
    const prompt = messages[0]!.content!
    if (prompt.startsWith('Synthetic compaction')) return { text: JSON.stringify({ schema_version: '0.1', coverage: { snapshot_id: 'synthetic', through_sequence: 0 }, goals: [], constraints: [], completed: [], evidence: [], pending: [], uncertainties: [] }), calls: [], finish: 'stop' }
    if (prompt.startsWith('Synthetic approval')) return { text: '{"decision":"escalate","reason":"test"}', calls: [], finish: 'stop' }
    return messages.at(-1)!.role === 'tool' ? { text: 'OK', calls: [], finish: 'stop' } : { text: '', calls: [{ id: 'test', type: 'function', function: { name: 'list', arguments: '{"kind":"capability"}' } }], finish: 'tool_calls' }
  })
  try { for (const role of ['main', 'compaction', 'approval'] as const) await service.test(config.id, role); expect(complete).toHaveBeenCalledTimes(4); expect(complete.mock.calls.every(args => args[6] === output)).toBe(true) } finally { service.close() }
})

it.each([32768, undefined])('main and summary dispatch exact configured output %s', async output => {
  const c = { ...config }; if (output === undefined) delete c.max_output_tokens; else c.max_output_tokens = output
  const lease: ModelLease = { id: c.id, revision: 1, config: c, release() {} }, service = new ModelService(), request = vi.spyOn(service, 'request').mockResolvedValue({ text: 'done', calls: [], finish: 'stop' })
  await runAgent(service, lease, 'task', [], { valid() {}, state() {}, budget() {}, record() {}, async tool() {} }, new AbortController().signal)
  expect(request.mock.calls[0]![6]).toBe(output)
  request.mockResolvedValue({ text: 'Summary', calls: [], finish: 'stop' })
  await compactContext(service, lease, 'task', new RunBudget(c), new AbortController().signal, [{ role: 'system', content: 'rules' }], 1, undefined, { valid() {}, state() {}, budget() {}, install() {} })
  expect(request.mock.calls[1]![6]).toBe(output)
})

it('has no hidden Run request/tool/time/token ceiling, but enforces explicit limits and unknown output conflicts', () => {
  const budget = new RunBudget(config, Date.now() - 7200000)
  for (let n = 0; n < 201; n++) { const reserved = budget.reserve([], undefined); budget.settle(reserved, { text: '', calls: [], finish: 'stop', usage: { prompt_tokens: 1000, completion_tokens: 500 } }); budget.tool() }
  expect(budget.state.model_requests).toBe(201); expect(budget.state.tokens).toBe(301500)
  const limited = new RunBudget({ ...config, limits: { run_model_requests: 1, run_tool_requests: 1, run_tokens: 50000 } }); limited.reserve([], undefined); expect(() => limited.reserve([], undefined)).toThrow('RUN_BUDGET_EXCEEDED'); limited.tool(); expect(() => limited.tool()).toThrow('RUN_BUDGET_EXCEEDED')
  expect(() => new RunBudget({ ...config, limits: { run_wall_ms: 5 } }, Date.now() - 6).check()).toThrow('RUN_WALL_LIMIT')
  const { max_output_tokens: _, ...unset } = config
  expect(() => new RunBudget({ ...unset, limits: { run_tokens: 50000 } }).reserve([], undefined)).toThrow('OUTPUT_BUDGET_UNKNOWN')
  const full = new RunBudget(config); expect(full.reserve([], undefined)).toBe(full.estimate([], undefined) + 32768)
})

it('records v2 unknown reserve and continues accepting unchanged v1 records', () => {
  const { max_output_tokens: _, ...unset } = config, events: any[] = []
  requestAccounting({ id: config.id, revision: 1, config: unset, release() {}, accounting: e => events.push(e) }, [], undefined, undefined, 'main')('reserved')
  expect(events[0]).toMatchObject({ version: 2, output_policy: 'service-default', output_reserve: null }); expect(() => assertContract('request_accounting', events[0])).not.toThrow()
  const { output_policy: _policy, ...v1 } = events[0]; expect(() => assertContract('request_accounting', { ...v1, version: 1, output_reserve: 1024 })).not.toThrow()
})

it('does not cap cumulative SSE bytes unless explicitly configured, keeping independent frame protection', async () => {
  const transport = async () => new Response(Array.from({ length: 2200 }, () => frame({ content: 'x'.repeat(1000) })).join('') + frame({}, 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  expect((await new ChatAdapter(transport).complete(config, '', [], undefined, new AbortController().signal)).text).toHaveLength(2200000)
  await expect(new ChatAdapter(transport).complete({ ...config, limits: { response_bytes: 1000 } }, '', [], undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'MODEL_OUTPUT_LIMIT' })
  await expect(new ChatAdapter(async () => reply('x'.repeat(1048577))).complete(config, '', [], undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'MODEL_FRAME_LIMIT' })
})

it('does not arm absent deadlines or overflow long configured timers', () => {
  vi.useFakeTimers(); const expire = vi.fn(), clear = deadline(undefined, expire)
  vi.advanceTimersByTime(120001); expect(expire).not.toHaveBeenCalled(); clear()
  const cancel = deadline(2147483648, expire); vi.advanceTimersByTime(2147483647); expect(expire).not.toHaveBeenCalled(); vi.advanceTimersByTime(1); expect(expire).toHaveBeenCalledOnce(); cancel()
})

it('accepts valid capacities beyond the old arbitrary catalogue and configuration ceilings', async () => {
  const large = { ...config, context_tokens: 20000000, max_output_tokens: 2000000 }
  expect(() => assertContract('model_configuration', large)).not.toThrow()
  const catalogue = await new ChatAdapter(async () => new Response(JSON.stringify({ data: [{ id: 'large', context_tokens: large.context_tokens, max_output_tokens: large.max_output_tokens }] }))).catalogue(config, '', new AbortController().signal)
  expect(catalogue.models[0]).toMatchObject({ context_tokens: 20000000, max_output_tokens: 2000000 })
})
