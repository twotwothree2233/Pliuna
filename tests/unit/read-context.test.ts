import { expect, it, vi } from 'vitest'
import { projectContent } from '../../src/runtime/model/read-context'
import { RunBudget, runAgent } from '../../src/runtime/model/agent'
import { assembleContext, historyGroups } from '../../src/runtime/model/context'
import { ModelService, type ModelLease } from '../../src/runtime/model/service'
import type { ChatMessage } from '../../src/runtime/model/adapter'
import { modelTools } from '../../src/runtime/model/tools'

const config = { id: 'isolated', base_url: 'https://example.invalid', wire_model_id: 'synthetic', context_tokens: 100000, max_output_tokens: 8192, compatibility_profile: 'chat-max-tokens' as const }
function read(id: string, text = '中😀\\"'.repeat(1000), overrides: any = {}): ChatMessage {
  return { role: 'tool', tool_call_id: id, content: JSON.stringify({ request_type: 'read', execution: 'success', delivery: 'delivered', truncated: false, data: { content_selection: true, metadata: { id: 'resource', sha256: 'hash' }, content_version: 'version', actual_range: { start_bytes: 0, end_bytes: Buffer.byteLength(text), chars: [...text].length }, selected_range: { start_bytes: 0, end_bytes: Buffer.byteLength(text) * 2 }, next_cursor: 'cursor', truncated: true, partial: false, location_verification: 'tool_reported', data: { text }, ...overrides } }) }
}
it('reuses only exact text while retaining each response envelope, range and cursor without modifying originals', () => {
  const first = read('first'), second = read('second', undefined, { next_cursor: 'different', selected_range: { start_bytes: 0, end_bytes: 999999 } }), saved = second.content
  const result = projectContent([first, second], new Map([[first, 'original-event']]))
  expect(result[0]).toBe(first); expect(second.content).toBe(saved)
  const data = JSON.parse(result[1]!.content!).data
  expect(data.data).not.toHaveProperty('text'); expect(data.data.context_reuse).toMatchObject({ tool_call_id: 'first', source: { kind: 'event', id: 'original-event' } })
  expect(data).toMatchObject({ next_cursor: 'different', partial: false, location_verification: 'tool_reported', selected_range: { end_bytes: 999999 } })
  expect(result[1]!.tool_call_id).toBe('second'); expect(Buffer.byteLength(result[1]!.content!)).toBeLessThan(1600)
})
it.each([
  { content_version: 'other' }, { metadata: { id: 'other-resource', sha256: 'hash' } }, { metadata: { id: 'resource', sha256: 'other-hash' } },
  { actual_range: { start_bytes: 1, end_bytes: 1 + Buffer.byteLength('x'.repeat(10000)), chars: 10000 } }
])('never merges a different identity or range: %j', change => {
  const first = read('first', 'x'.repeat(10000)), second = read('second', 'x'.repeat(10000), change)
  expect(projectContent([first, second])[1]).toBe(second)
})
it('does not merge equal ranges with changed text, overlapping ranges, failed delivery or malformed selections', () => {
  const first = read('first', 'x'.repeat(10000)), changed = read('changed', 'y'.repeat(10000)), overlap = read('overlap', 'x'.repeat(9000), { actual_range: { start_bytes: 1000, end_bytes: 10000, chars: 9000 } })
  const failed = { ...first, content: first.content!.replace('"delivered"', '"failed"') }
  for (const second of [changed, overlap, failed, read('bad', undefined, { actual_range: {} })]) expect(projectContent([first, second])[1]).toBe(second)
})
it('rebuilds without dangling references when the former full fragment leaves the input', () => {
  const first = read('first'), second = read('second'), third = read('third')
  expect(JSON.parse(projectContent([second, third])[0]!.content!).data.data.text).toBeDefined()
  expect(JSON.parse(projectContent([second, third])[1]!.content!).data.data.context_reuse.tool_call_id).toBe('second')
  expect(projectContent([third])[0]).toBe(third)
  expect(JSON.parse(projectContent([first, second])[1]!.content!).data.data.context_reuse.tool_call_id).toBe('first')
})
it('assembles exact historical plaintext without active projection and accounts actual UTF-8 bytes', () => {
  const originals = [read('old'), read('first'), read('second')]
  const records: any[] = originals.flatMap((message, index) => [
    { id: 'response-' + index, sequence: index * 2 + 1, kind: 'model.response', payload: { run_id: index ? 'current' : 'old', message: { role: 'assistant', content: null, tool_calls: [{ id: message.tool_call_id }] } } },
    { id: 'result-' + index, sequence: index * 2 + 2, kind: 'model.tool_result', payload: { run_id: index ? 'current' : 'old', message } }
  ])
  const before = JSON.stringify(records), result = assembleContext([{ role: 'system', content: 'rules' }], null, historyGroups(records, 'current'))
  const tools = result.filter(m => m.role === 'tool')
  expect(JSON.parse(tools[1]!.content!).data.data.text).toBeDefined()
  expect(JSON.parse(tools[2]!.content!).data.data.text).toBeDefined()
  expect(JSON.stringify(records)).toBe(before)
  expect(new RunBudget(config).estimate(result, undefined)).toBe(Buffer.byteLength(JSON.stringify({ messages: result })) + 256)
})
it('persists all results before checking context at the next request boundary, including final output', async () => {
  const service = new ModelService(), lease: ModelLease = { id: config.id, revision: 1, config, release() {} }, records: ChatMessage[] = []
  const request = vi.spyOn(service, 'request').mockResolvedValueOnce({ text: '', finish: 'tool_calls', calls: ['one','two'].map(id => ({ id, type: 'function' as const, function: { name: 'read', arguments: JSON.stringify({ kind: 'resource', id: 'resource', selection: { view: 'text' }, max_chars: 32000 }) } })) }).mockResolvedValueOnce({ text: 'final', calls: [], finish: 'stop' })
  const context = vi.fn(async (messages: ChatMessage[]) => {
    if (records.length) expect(records).toHaveLength(2)
    // Stand in for a validated summary installation, retaining the task request.
    return messages.length > 1 ? [messages[0]!, { role: 'user' as const, content: 'summary' }] : messages
  })
  const tool = vi.fn(async () => JSON.parse(read('result', '中😀'.repeat(16000)).content!))
  await runAgent(service, lease, 'task', [], { context, valid() {}, state() {}, budget() {}, record(kind, payload) { if (kind === 'model.tool_result') records.push(payload.message as ChatMessage) }, tool }, new AbortController().signal)
  expect(tool).toHaveBeenCalledTimes(2); expect(request).toHaveBeenCalledTimes(2); expect(context).toHaveBeenCalledTimes(3)
  for (const record of records) expect(JSON.parse(record.content!).data.data.text).toBe('中😀'.repeat(16000))
  expect(context.mock.calls[1]![0].filter(m => m.role === 'tool')).toHaveLength(2)
  expect(context.mock.calls[2]![0].at(-1)?.content).toBe('final')
})
it('does not dispatch after a read result cannot be persisted', async () => {
  const service = new ModelService(), lease: ModelLease = { id: config.id, revision: 1, config, release() {} }
  const request = vi.spyOn(service, 'request').mockResolvedValue({ text: '', finish: 'tool_calls', calls: [{ id: 'read', type: 'function', function: { name: 'read', arguments: '{"kind":"resource","id":"r","selection":{"view":"text"},"max_chars":4000}' } }] })
  await expect(runAgent(service, lease, 'task', [], { valid() {}, state() {}, budget() {}, record(kind) { if (kind === 'model.tool_result') throw Error('disk failure') }, async tool() { return JSON.parse(read('read').content!) } }, new AbortController().signal)).rejects.toThrow('disk failure')
  expect(request).toHaveBeenCalledOnce()
})
