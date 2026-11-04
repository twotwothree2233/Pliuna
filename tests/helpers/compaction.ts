import { vi } from 'vitest'
import { compactContext, recordedMessage, type InstalledSummary } from '../../src/runtime/model/context'
import { RunBudget } from '../../src/runtime/model/agent'
import { ModelService, type ModelLease } from '../../src/runtime/model/service'
import type { ChatMessage } from '../../src/runtime/model/adapter'
export const lease: ModelLease = { id: 'isolated', revision: 1, release() {}, config: { id: 'isolated', base_url: 'https://example.invalid', wire_model_id: 'synthetic', context_tokens: 240000, max_output_tokens: 128000, compatibility_profile: 'chat-max-tokens' } }
export const user = (id = 'user', sequence = 1, text = 'Current goal') => recordedMessage({ id, sequence, kind: 'message.user', payload: { text } })!
export const answer = (id: string, sequence: number, content = id): ChatMessage => recordedMessage({ id, sequence, kind: 'model.response', payload: { message: { role: 'assistant', content } } })!
export const toolRound = (id: string, sequence: number, text = '中😀'.repeat(8000)): ChatMessage[] => [
  recordedMessage({ id: id + '-response', sequence, kind: 'model.response', payload: { message: { role: 'assistant', content: id, tool_calls: ['a','b'].map(suffix => ({ id: id + suffix, type: 'function', function: { name: 'read', arguments: '{"kind":"resource","id":"resource"}' } })) } } })!,
  ...['a','b'].map((suffix, index) => recordedMessage({ id: id + '-result-' + suffix, sequence: sequence + index + 1, kind: 'model.tool_result', payload: { message: { role: 'tool', tool_call_id: id + suffix, content: JSON.stringify({ request_type: 'read', execution: 'success', delivery: 'delivered', data: { text, next_cursor: 'cursor-' + suffix } }) } } })!)
]
export const context = (): ChatMessage[] => [{ role: 'system', content: 'Current rules' }, user(), answer('old', 2), answer('recent', 3), ...toolRound('last', 4)]
export function setup(messages = context(), config = lease.config) {
  const service = new ModelService(), install = vi.fn<(value: InstalledSummary) => void>(), controller = new AbortController(), budget = new RunBudget(config)
  const request = vi.spyOn(service, 'request').mockResolvedValue({ text: 'Current goal; result read; continue.', calls: [], finish: 'stop' })
  const host = { valid() {}, state: vi.fn(), budget: vi.fn(), install }
  return { service, install, controller, budget, request, host, messages, run: () => compactContext(service, { ...lease, config }, 'task', budget, controller.signal, messages, 6, undefined, host) }
}
