import { expect, it } from 'vitest'
import { setup, context, answer, toolRound } from '../helpers/compaction'
import { compactContext, interactions } from '../../src/runtime/model/context'
import { RunBudget } from '../../src/runtime/model/agent'
import { lease } from '../helpers/compaction'

it('passes large already-read bodies exactly, without adding unread material', async () => {
  const messages = [...context().slice(0, 2), ...toolRound('read', 2, 'READ_FULL_BODY_'.repeat(6000))]
  const s = setup(messages)
  await s.run()
  const sent = s.request.mock.calls[0]![2]
  expect(sent.slice(0, -1)).toEqual(messages)
  expect(sent.filter(message => message.role === 'tool')).toEqual(messages.slice(-2))
  expect(JSON.stringify(sent)).not.toMatch(/previous_sources|output_schema|candidate_capacity|historical-preview/)
})
it('uses the current summary in consecutive compactions, never reloading already removed bodies', async () => {
  const s = setup(), inputs: any[] = []
  s.request.mockImplementation(async (_lease, _task, messages) => {
    inputs.push(structuredClone(messages))
    return { text: 'SUMMARY_GENERATION_' + inputs.length, calls: [], finish: 'stop' }
  })
  let messages = s.messages
  for (let n = 1; n <= 5; n++) {
    if (n > 1) messages = [...messages, answer('new-' + n, 10 + n, 'New evidence ' + n)]
    const before = structuredClone(messages)
    messages = await compactContext(s.service, lease, 'task', new RunBudget(lease.config), s.controller.signal, messages, 10 + n, undefined, s.host)
    expect(inputs.at(-1).slice(0, -1)).toEqual(before)
    expect(messages.filter(message => message.content?.startsWith('工作摘要：'))).toHaveLength(1)
    expect(interactions(messages)).toHaveLength(2)
    if (n > 3) expect(JSON.stringify(inputs.at(-1))).not.toContain('中😀')
    if (n > 1) expect(JSON.stringify(inputs.at(-1))).toContain('SUMMARY_GENERATION_' + (n - 1))
  }
  expect(s.install).toHaveBeenCalledTimes(5)
  expect(messages.some(message => message.content?.includes('SUMMARY_GENERATION_4'))).toBe(false)
})
