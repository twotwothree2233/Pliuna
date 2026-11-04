import { expect, it, vi } from 'vitest'
import { runAgent, type AgentHost } from '../../src/runtime/model/agent'
import { ModelService, type ModelLease } from '../../src/runtime/model/service'
import type { Completion } from '../../src/runtime/model/adapter'

it('stops the remaining tool batch after successful execution with failed delivery', async () => {
  const service = new ModelService(), messages: any[] = [], tool = vi.fn(async () => ({ execution: 'success', delivery: 'failed' }))
  const response: Completion = { text: '', finish: 'tool_calls', calls: ['first', 'second'].map(id => ({ id, type: 'function', function: { name: 'call', arguments: '{"capability":"test","input_json":"{}"}' } })) }
  vi.spyOn(service, 'request').mockResolvedValueOnce(response).mockResolvedValueOnce({ text: 'Output could not be saved. Do not replay.', calls: [], finish: 'stop' })
  const lease: ModelLease = { id: 'isolated', revision: 1, config: { id: 'isolated', base_url: 'https://example.invalid', wire_model_id: 'fixture', context_tokens: 1000000, max_output_tokens: 1024, compatibility_profile: 'chat-max-tokens' }, release() {} }
  const host: AgentHost = { valid() {}, state() {}, budget() {}, record(kind, data) { if (kind === 'model.tool_result') messages.push(data.message) }, tool }
  await runAgent(service, lease, 'task', [], host, new AbortController().signal)
  expect(tool).toHaveBeenCalledOnce()
  expect(JSON.parse(messages[0].content)).toEqual({ execution: 'success', delivery: 'failed' })
  expect(JSON.parse(messages[1].content).error.code).toBe('PREVIOUS_TOOL_FAILED')
})
it('delivers selected Unicode plaintext through the read envelope without raising other tool limits', async () => {
  const service = new ModelService(), text = '中😀'.repeat(16000), payload = { request_type: 'read', execution: 'success', delivery: 'delivered', data: { content_selection: true, data: { text } } }
  const request = vi.spyOn(service, 'request').mockResolvedValueOnce({ text: '', finish: 'tool_calls', calls: [{ id: 'read', type: 'function', function: { name: 'read', arguments: '{"kind":"resource","id":"test","selection":{"view":"text"},"max_chars":32000}' } }] }).mockResolvedValueOnce({ text: 'done', calls: [], finish: 'stop' })
  const lease: ModelLease = { id: 'isolated', revision: 1, config: { id: 'isolated', base_url: 'https://example.invalid', wire_model_id: 'fixture', context_tokens: 1000000, max_output_tokens: 1024, compatibility_profile: 'chat-max-tokens' }, release() {} }
  const recorded: any[] = [], host: AgentHost = { valid() {}, state() {}, budget() {}, record(kind, data) { if (kind === 'model.tool_result') recorded.push(data.message) }, tool: async () => payload }
  await runAgent(service, lease, 'task', [], host, new AbortController().signal)
  expect(JSON.parse(recorded[0].content).data.data.text).toBe(text)
  expect(JSON.parse(request.mock.calls[1]![2].find(message => message.role === 'tool')!.content!).data.data.text).toBe(text)
  const { accountingResultLimit } = await import('../../src/runtime/model/accounting')
  expect(accountingResultLimit({ request_type: 'call', data: { content_selection: true } })).toBe(32768)
  expect(accountingResultLimit(payload)).toBe(262144)
})

it('delivers inner JSON coordinates and contract discovery without executing malformed inputs', async () => {
  const service = new ModelService(), tool = vi.fn(), recorded: any[] = []
  const request = vi.spyOn(service, 'request').mockResolvedValueOnce({ text: '', finish: 'tool_calls', calls: [{ id: 'invalid-json', type: 'function', function: { name: 'write', arguments: JSON.stringify({ operation: 'resource.create', input_json: '{"private":"PRIVATE_SENTINEL","x":}' }) } }] }).mockResolvedValueOnce({ text: 'Stopped', calls: [], finish: 'stop' })
  const lease: ModelLease = { id: 'isolated', revision: 1, config: { id: 'isolated', base_url: 'https://example.invalid', wire_model_id: 'fixture', context_tokens: 1000000, compatibility_profile: 'chat-max-tokens' }, release() {} }
  await runAgent(service, lease, 'task', [], { valid() {}, state() {}, budget() {}, record(kind, data) { if (kind === 'model.tool_result') recorded.push(data.message) }, tool }, new AbortController().signal)
  expect(tool).not.toHaveBeenCalled()
  const error = JSON.parse(recorded[0].content).error
  expect(error.message).toContain('input_json: invalid JSON at offset')
  expect(error.message).not.toContain('PRIVATE_SENTINEL')
  expect(JSON.parse(error.suggestion)).toEqual({ name: 'read', arguments: { kind: 'object_type', id: 'resource.create' } })
  expect(request.mock.calls[1]![2].find(message => message.role === 'tool')!.content).toBe(recorded[0].content)
})
