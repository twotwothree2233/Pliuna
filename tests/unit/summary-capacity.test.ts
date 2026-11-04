import { expect, it } from 'vitest'
import { setup, context, user, answer, lease, toolRound } from '../helpers/compaction'
import { capacityPlan } from '../../src/runtime/model/capacity'
import { compactContext } from '../../src/runtime/model/context'

it('uses saved context as full input capacity and the ten-percent threshold', () => {
  const messages = context(), bytes = new TextEncoder().encode(JSON.stringify({ messages })).length + 256
  expect(capacityPlan({ ...lease.config, context_tokens: bytes }, messages)).toMatchObject({ fits: true, needsCompaction: true, available_input: bytes, remaining: 0 })
  expect(capacityPlan({ ...lease.config, context_tokens: bytes * 2 }, messages)).toMatchObject({ fits: true, needsCompaction: false })
})
it('rejects an oversized exact organizing input before network without truncation or batching', async () => {
  const s = setup(context(), { ...lease.config, context_tokens: 10000 }), original = JSON.stringify(s.messages)
  await expect(s.run()).rejects.toThrow('CONTEXT_BUDGET_EXCEEDED')
  expect(s.request).not.toHaveBeenCalled(); expect(s.install).not.toHaveBeenCalled()
  expect(JSON.stringify(s.messages)).toBe(original)
})
it('rejects an oversized installation without silently reducing the two-round window', async () => {
  const s = setup([context()[0]!, user(), answer('a', 2), answer('b', 3)], { ...lease.config, context_tokens: 12000 })
  s.request.mockResolvedValue({ text: 'x'.repeat(12000), calls: [], finish: 'stop' })
  await expect(s.run()).rejects.toThrow('CONTEXT_MINIMUM_TOO_LARGE')
  expect(s.install).not.toHaveBeenCalled()
})
it('does not use pre-compaction main usage to install an oversized replacement context', async () => {
  const s = setup([context()[0]!, user(), answer('a', 2), answer('b', 3)], { ...lease.config, context_tokens: 12000 })
  const tools = [{ type: 'function' as const, function: { name: 'read', description: '', parameters: {} } }]
  s.budget.observe(s.messages, tools, { prompt_tokens: 100, completion_tokens: 10 })
  s.request.mockResolvedValue({ text: 'x'.repeat(12000), calls: [], finish: 'stop' })
  await expect(compactContext(s.service, { ...lease, config: { ...lease.config, context_tokens: 12000 } }, 'task', s.budget, s.controller.signal, s.messages, 4, tools, s.host)).rejects.toThrow('CONTEXT_MINIMUM_TOO_LARGE')
  expect(s.install).not.toHaveBeenCalled()
})
it.each(['empty', 'tools', 'response', 'cancelled', 'storage'] as const)('retains originals and installs nothing after %s failure', async failure => {
  const s = setup(), before = JSON.stringify(s.messages)
  s.request.mockImplementation(async () => {
    if (failure === 'response') throw Error('INJECTED_RESPONSE_FAILURE')
    if (failure === 'cancelled') s.controller.abort()
    return { text: failure === 'empty' ? '   ' : 'Summary', calls: failure === 'tools' ? [{ id: 'call', type: 'function', function: { name: 'list', arguments: '{}' } }] : [], finish: 'stop' }
  })
  if (failure === 'storage') s.install.mockImplementation(() => { throw Error('INJECTED_DISK_FAILURE') })
  await expect(s.run()).rejects.toThrow()
  if (failure !== 'storage') expect(s.install).not.toHaveBeenCalled()
  expect(JSON.stringify(s.messages)).toBe(before)
})
it('protects an incomplete tool batch before requesting organization', async () => {
  const s = setup([context()[0]!, user(), ...toolRound('partial', 2).slice(0, 2)])
  await expect(s.run()).rejects.toThrow('CONTEXT_NO_SAFE_GROUP')
  expect(s.request).not.toHaveBeenCalled()
})
it.each([undefined, 128000])('does not add or reduce configured output %s', async output => {
  const { max_output_tokens: _, ...base } = lease.config
  const s = setup([context()[0]!, user(), answer('a', 2)], output === undefined ? base : { ...base, max_output_tokens: output })
  await s.run(); expect(s.request.mock.calls[0]![6]).toBe(output)
})
