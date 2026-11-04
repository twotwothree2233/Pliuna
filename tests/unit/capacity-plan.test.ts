import { expect, it } from 'vitest'
import { capacityPlan, inputCapacity, serializedInput } from '../../src/runtime/model/capacity'
import { RunBudget } from '../../src/runtime/model/agent'

it('shares the exact projected serialization and configured role reserves without hidden output defaults', () => {
  const messages = [{ role: 'user' as const, content: 'Unicode 容量 "\\\n' }]
  const config = { id: 'test', base_url: 'https://example.invalid', wire_model_id: 'test', context_tokens: 240000, max_output_tokens: 128000, compatibility_profile: 'chat-max-tokens' as const }
  const budget = new RunBudget(config), plan = capacityPlan(config, messages)
  expect(inputCapacity(config)).toBe(240000)
  expect(plan).toMatchObject({ output_reserve: 128000, available_input: 240000, fits: true })
  expect(plan.estimated_input).toBe(budget.estimate(messages, undefined))
  expect(serializedInput(messages)).toBe(Buffer.byteLength(JSON.stringify({ messages })) + 256)
  const { max_output_tokens: _output, ...unset } = config
  expect(capacityPlan(unset, messages).output_reserve).toBeNull()
  expect(unset).not.toHaveProperty('max_output_tokens')
})

it('triggers at exactly ten percent remaining without reserving output or rejecting a threshold crossing', () => {
  const messages = [{ role: 'user' as const, content: 'x'.repeat(10000) }]
  const size = serializedInput(messages), config = { id: 'test', base_url: 'https://example.invalid', wire_model_id: 'test', context_tokens: 20000, compatibility_profile: 'chat-max-tokens' as const }
  const body = (size: number) => [{ role: 'user' as const, content: 'x'.repeat(size - serializedInput([{ role: 'user', content: '' }])) }]
  for (const max_output_tokens of [undefined, 20000, 128000]) {
    const saved = { ...config, ...(max_output_tokens === undefined ? {} : { max_output_tokens }) }
    expect(capacityPlan(saved, body(17999))).toMatchObject({ fits: true, needsCompaction: false, remaining: 2001 })
    expect(capacityPlan(saved, body(18000))).toMatchObject({ fits: true, needsCompaction: true, remaining: 2000 })
    expect(capacityPlan(saved, body(20000))).toMatchObject({ fits: true, needsCompaction: true, remaining: 0 })
    expect(capacityPlan(saved, body(20001))).toMatchObject({ fits: false, needsCompaction: true })
    expect(new RunBudget(saved).reserve(messages, undefined)).toBe(size + (max_output_tokens ?? 0))
  }
})
