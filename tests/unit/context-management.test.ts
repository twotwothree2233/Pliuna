import { expect, it } from 'vitest'
import template from '../../src/runtime/model/prompts/summary-v0.1.txt?raw'
import { interactions, retainedContext, restoreMessages } from '../../src/runtime/model/context'
import { requestEvidence } from '../../src/runtime/model/request-evidence'
import { setup, context, toolRound, user, answer, lease } from '../helpers/compaction'

it('sends exact current context plus one instruction, without envelopes, previews or old source loading', async () => {
  const s = setup(), before = JSON.stringify(s.messages)
  const next = await s.run(), sent = s.request.mock.calls[0]![2]
  expect(sent.slice(0, -1)).toEqual(s.messages)
  expect(sent.at(-1)).toEqual({ role: 'system', content: template })
  expect(s.request.mock.calls[0]![3]).toBeUndefined()
  expect(s.request.mock.calls[0]![6]).toBe(128000)
  expect(JSON.stringify(s.messages)).toBe(before)
  expect(next).toEqual([s.messages[0], expect.objectContaining({ content: expect.stringContaining('Current goal;') }), s.messages[1], ...s.messages.slice(3)])
  expect(s.install.mock.calls[0]![0]).toMatchObject({ version: 2, text: 'Current goal; result read; continue.', through_sequence: 6, latest_user_id: 'user', retained_interactions: [['recent'], ['last-response','last-result-a','last-result-b']] })
  expect(next.filter(message => message.role === 'tool').map(message => message.content)).toEqual(s.messages.filter(message => message.role === 'tool').map(message => message.content))
  expect(requestEvidence(sent, 'request', 'summary').originals).toHaveLength(6)
})
it.each([0, 1, 2])('retains all available interactions when only %i exist', async count => {
  const messages = [context()[0]!, user(), ...Array.from({ length: count }, (_, n) => answer('a' + n, n + 2))]
  const s = setup(messages), next = await s.run()
  expect(interactions(next)).toHaveLength(count)
  expect(next.filter(message => message.role === 'user' && message.content?.includes('Current goal'))).toHaveLength(2)
})
it('retains the latest actual user input once, not arbitrary user-shaped summary text', async () => {
  const s = setup([context()[0]!, user('old-user', 1, 'old goal'), answer('old', 2), user('new-user', 3, '最新目标😀'), answer('recent', 4)])
  const next = await s.run()
  expect(s.install.mock.calls[0]![0].latest_user_id).toBe('new-user')
  expect(next.filter(message => message.content?.includes('最新目标😀'))).toHaveLength(1)
  expect(next.some(message => message.content?.includes('old goal'))).toBe(false)
})
it('never splits a multi-tool interaction or accepts an unmatched result', () => {
  const group = toolRound('batch', 1)
  expect(interactions(group)).toEqual([group])
  expect(() => interactions(group.slice(0, 2))).toThrow('CONTEXT_NO_SAFE_GROUP')
  expect(() => interactions(group.slice(1))).toThrow('CONTEXT_NO_SAFE_GROUP')
  expect(() => interactions([group[0]!, answer('other', 10)])).toThrow('CONTEXT_NO_SAFE_GROUP')
})
it('retained context does not mutate or truncate large tool results', async () => {
  const messages = [context()[0]!, user(), ...toolRound('huge', 2, 'é😀\"'.repeat(16000))], before = JSON.stringify(messages)
  const s = setup(messages, { ...lease.config, context_tokens: 1000000 })
  const next = await s.run()
  expect(JSON.stringify(messages)).toBe(before)
  expect(next.slice(-3)).toEqual(messages.slice(-3))
  expect(retainedContext(messages, s.install.mock.calls[0]![0])).toEqual(next)
})

it('wraps incomplete cold-start batches in full without replay, and preserves later valid interactions', () => {
  const records: any[] = [
    { id: 'partial', sequence: 1, kind: 'model.response', payload: { run_id: 'interrupted', message: { role: 'assistant', content: 'FULL_' + 'x'.repeat(20000), tool_calls: [{ id: 'missing' }] } } },
    { id: 'user', sequence: 2, kind: 'message.user', payload: { run_id: 'new', text: 'Continue safely' } },
    { id: 'done', sequence: 3, kind: 'model.response', payload: { run_id: 'new', message: { role: 'assistant', content: 'done' } } }
  ]
  const result = restoreMessages(records)
  expect(JSON.parse(result[0]!.content!).interrupted_history).toEqual([records[0].payload.message])
  expect(result[0]!.content).toContain('x'.repeat(20000))
  expect(interactions(result)).toEqual([[result[2]]])
})
