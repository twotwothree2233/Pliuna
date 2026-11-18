import { expect, it, vi } from 'vitest'
import { runAgent, type AgentHost } from '../../src/runtime/model/agent'
import { ModelService, type ModelLease } from '../../src/runtime/model/service'
import type { Completion } from '../../src/runtime/model/adapter'
import { ContractError } from '../../src/shared/validation'
import { modelErrorMessage } from '../../src/renderer/src/model-errors'

const lease: ModelLease = {
  id: 'isolated', revision: 1,
  config: { id: 'isolated', base_url: 'https://example.invalid', wire_model_id: 'fixture', context_tokens: 1000000, compatibility_profile: 'chat-max-tokens' },
  release() {}
}
const done: Completion = { text: 'done', calls: [], finish: 'stop' }
function write(id: string, input: string): Completion {
  return { text: '', finish: 'tool_calls', calls: [{ id, type: 'function', function: { name: 'write', arguments: JSON.stringify({ operation: 'resource.create', input_json: input }) } }] }
}
function host(tool: AgentHost['tool']) {
  const results: unknown[] = []
  const value: AgentHost = { valid() {}, state() {}, budget() {}, tool, record(kind, payload) { if (kind === 'model.tool_result') results.push(payload.message) } }
  return { value, results }
}

it('ends an unchanged malformed tool loop after returning its error to the model', async () => {
  const service = new ModelService(), tool = vi.fn(), recorded = host(tool)
  const invalid = '{"display_name":"讲义","content":}'
  const request = vi.spyOn(service, 'request')
    .mockResolvedValueOnce(write('first', invalid))
    .mockImplementationOnce(async (_lease, _task, messages) => {
      const feedback = messages.find(message => message.role === 'tool')
      expect(JSON.parse(feedback?.content ?? '{}').error.code).toBe('INVALID_REQUEST')
      return write('different-call-id', invalid)
    })
    .mockResolvedValueOnce(done)
  await expect(runAgent(service, lease, 'task', [], recorded.value, new AbortController().signal)).rejects.toMatchObject({ code: 'MODEL_TOOL_NO_PROGRESS' })
  expect(request).toHaveBeenCalledTimes(2)
  expect(tool).not.toHaveBeenCalled()
  expect(recorded.results).toHaveLength(2)
  expect(modelErrorMessage('MODEL_TOOL_NO_PROGRESS')).toContain('本次执行已结束')
})

it('allows changed rejected inputs to be corrected without a request-count limit', async () => {
  const service = new ModelService(), tool = vi.fn<AgentHost['tool']>(async () => ({ execution: 'success', delivery: 'delivered' })), recorded = host(tool)
  const request = vi.spyOn(service, 'request')
    .mockResolvedValueOnce(write('first', '{"content":}'))
    .mockResolvedValueOnce(write('second', '{"display_name":"讲义","content":}'))
    .mockResolvedValueOnce(write('corrected', JSON.stringify({ display_name: '讲义', content: { type: 'text', text: '正文' } })))
    .mockResolvedValueOnce(done)
  await runAgent(service, lease, 'task', [], recorded.value, new AbortController().signal)
  expect(request).toHaveBeenCalledTimes(4)
  expect(tool).toHaveBeenCalledOnce()
  expect(tool.mock.calls[0]?.[0]).toMatchObject({ type: 'write', input: { type: 'resource.create', content: { type: 'text', text: '正文' } } })
})

it('permits repeated successful tools and rejects only unchanged invalid input', async () => {
  const service = new ModelService(), tool = vi.fn(async () => ({ execution: 'success', delivery: 'delivered', data: {} })), recorded = host(tool)
  const request = vi.spyOn(service, 'request')
  for (let index = 0; index < 5; index++) request.mockResolvedValueOnce({ text: '', finish: 'tool_calls', calls: [{ id: String(index), type: 'function', function: { name: 'read', arguments: JSON.stringify({ kind: 'resource', id: 'same-resource' }) } }] })
  request.mockResolvedValueOnce(done)
  await runAgent(service, lease, 'task', [], recorded.value, new AbortController().signal)
  expect(request).toHaveBeenCalledTimes(6)
  expect(tool).toHaveBeenCalledTimes(5)
})

it('does not treat a dispatched host error as an unchanged input rejection', async () => {
  const service = new ModelService(), tool = vi.fn<AgentHost['tool']>(async () => { throw new ContractError('INVALID_REQUEST', 'Host state changed') }), recorded = host(tool)
  const valid = JSON.stringify({ display_name: '讲义', content: { type: 'text', text: '正文' } })
  vi.spyOn(service, 'request').mockResolvedValueOnce(write('first', valid)).mockResolvedValueOnce(write('second', valid)).mockResolvedValueOnce(done)
  await runAgent(service, lease, 'task', [], recorded.value, new AbortController().signal)
  expect(tool).toHaveBeenCalledTimes(2)
})
