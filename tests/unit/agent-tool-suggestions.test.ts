import { afterEach, expect, it, vi } from 'vitest'
import { ContractError } from '../../src/shared/validation'
import type { ChatMessage, Completion } from '../../src/runtime/model/adapter'
import { runAgent, type AgentHost } from '../../src/runtime/model/agent'
import { ModelService, type ModelLease } from '../../src/runtime/model/service'
import { createWorkerProfile } from '../../src/runtime/runner/worker-profile'

afterEach(() => vi.restoreAllMocks())

const lease: ModelLease = {
  id: 'suggestion', revision: 1,
  config: { id: 'suggestion', base_url: 'https://example.invalid', wire_model_id: 'fixture', context_tokens: 1000000, compatibility_profile: 'chat-max-tokens' },
  release() {}
}
const capability = 'builtin:content-operations:v1'
const call = (name: string, arguments_: unknown): Completion => ({
  text: '', finish: 'tool_calls', calls: [{ id: name, type: 'function', function: { name, arguments: JSON.stringify(arguments_) } }]
})
const final = (): Completion => ({ text: 'complete', calls: [], finish: 'stop' })
const navigation = { name: 'read', arguments: { kind: 'content_tree', id: 'authorized-tree' } }

function setup(suggestion: string | undefined, responses: Completion[]) {
  const service = new ModelService(), messages: ChatMessage[][] = []
  const request = vi.spyOn(service, 'request').mockImplementation(async (_lease, _task, input) => {
    messages.push(structuredClone(input))
    const response = responses.shift()
    if (!response) throw Error('Unexpected model request')
    return response
  })
  const profile = createWorkerProfile({
    id: 'content-suggestion', role: 'producer', system: 'Submit only the authorized operations.',
    grants: [{ type: 'call', capability }, { type: 'read', kind: 'content_tree', ids: ['authorized-tree'] }],
    parseResult(response) { return response.text }
  })
  const tool = vi.fn<AgentHost['tool']>()
    .mockRejectedValueOnce(new ContractError('WORKER_CAPABILITY_DENIED', 'Submitted operations must match the authorized group', suggestion))
    .mockResolvedValue({ execution: 'success', delivery: 'delivered', truncated: false, data: { nodes: [] } })
  const host: AgentHost = { valid() {}, state() {}, budget() {}, record() {}, tool }
  const onResult = vi.fn()
  const execute = () => runAgent(service, lease, 'task', [], host, new AbortController().signal, undefined, { profile, onResult })
  return { request, messages, profile, tool, onResult, execute }
}

it.each([
  ['default capability discovery', undefined],
  ['explicit capability discovery', JSON.stringify({ name: 'read', arguments: { kind: 'capability', id: capability } })],
  ['a different tree', JSON.stringify({ name: 'read', arguments: { kind: 'content_tree', id: 'foreign-tree' } })],
  ['malformed advice', '{'],
  ['an invalid tool request', JSON.stringify({ name: 'read', arguments: { kind: 'content_tree' } })]
])('omits %s when it cannot be executed by the current profile', async (_label, suggestion) => {
  const fixture = setup(suggestion, [call('call', { capability, input_json: '{}' }), final()])

  await fixture.execute()

  const result = fixture.messages[1]?.find(message => message.role === 'tool')
  expect(JSON.parse(result?.content ?? '{}')).toMatchObject({ error: { code: 'WORKER_CAPABILITY_DENIED', message: 'Submitted operations must match the authorized group' } })
  expect(JSON.parse(result?.content ?? '{}').error).not.toHaveProperty('suggestion')
  expect(fixture.tool).toHaveBeenCalledOnce()
  expect(fixture.onResult).toHaveBeenCalledExactlyOnceWith('complete')
})

it('keeps an authorized navigation suggestion for a later model call without replaying the failed operation', async () => {
  const fixture = setup(JSON.stringify(navigation), [call('call', { capability, input_json: '{}' }), call(navigation.name, navigation.arguments), final()])

  await fixture.execute()

  const result = fixture.messages[1]?.find(message => message.role === 'tool')
  expect(JSON.parse(JSON.parse(result?.content ?? '{}').error.suggestion)).toEqual(navigation)
  expect(fixture.tool.mock.calls.map(([request]) => request)).toEqual([
    { type: 'call', input: { capability, arguments: {}, references: [] } },
    { type: 'read', input: { target: { kind: 'content_tree', id: 'authorized-tree' } } }
  ])
  expect(fixture.request).toHaveBeenCalledTimes(3)
  expect(fixture.onResult).toHaveBeenCalledExactlyOnceWith('complete')
  expect(() => fixture.profile.authorize({ type: 'read', input: { target: { kind: 'capability', id: capability } } })).toThrow('does not grant')
})
