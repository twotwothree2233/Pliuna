import { expect, it } from 'vitest'
import { rejectedContext, capacityPlan, ContextRejectedError } from '../../src/runtime/model/capacity'
import { RunBudget } from '../../src/runtime/model/agent'
import { attachEvidence } from '../../src/runtime/model/request-evidence'
import { assertContract } from '../../src/shared/validation'
import type { ChatMessage } from '../../src/runtime/model/adapter'

const config = { id: 'isolated', base_url: 'https://example.invalid/v1', wire_model_id: 'synthetic', context_tokens: 240000, max_output_tokens: 128000, compatibility_profile: 'chat-max-tokens' as const }
const messages: ChatMessage[] = [{ role: 'system', content: 'PRIVATE_RULE' }, { role: 'user', content: 'PRIVATE_HISTORY' }, { role: 'user', content: JSON.stringify({ working_summary: 'PRIVATE_SUMMARY' }) }, attachEvidence({ role: 'user', content: JSON.stringify({ host_context: {}, request: 'PRIVATE_CURRENT' }) }, { kind: 'host-state', representation: 'current-state' }), { role: 'tool', tool_call_id: 'tool', content: 'PRIVATE_TOOL_中😀' }]
const tools = [{ type: 'function' as const, function: { name: 'read', description: 'PRIVATE_CONTRACT', parameters: {} } }]
it('measures the exact final projection with additive numeric components and unchanged reserves', () => {
  const error = rejectedContext(config, messages, tools, 'protected-input', 'CONTEXT_MINIMUM_TOO_LARGE'), data = error.diagnostic
  expect(error).toBeInstanceOf(ContextRejectedError)
  expect(data).toMatchObject({ stage: 'protected-input', output_reserve: 128000, safety_reserve: 0, available_input: 240000, estimation_overhead: 256 })
  expect(data.input_bytes).toBe(Buffer.byteLength(JSON.stringify({ messages, tools })))
  expect(data.estimated_input).toBe(data.input_bytes + 256)
  expect(Object.values(data.components).reduce((sum, value) => sum + value, 0)).toBe(data.input_bytes)
  expect(Object.values(data.components).every(value => Number.isSafeInteger(value) && value > 0)).toBe(true)
  expect(data.estimated_input).toBe(capacityPlan(config, messages, tools).estimated_input)
  expect(JSON.stringify(data)).not.toMatch(/PRIVATE_|example.invalid|synthetic/)
  assertContract('context_rejected', { version: 1, run_id: 'run', model_revision: 1, ...data })
})
it('keeps output unset, empty tools and Unicode inputs without hidden defaults', () => {
  const { max_output_tokens: _output, ...unset } = config
  const data = rejectedContext(unset, [{ role: 'user', content: '中😀' }], undefined, 'main-input').diagnostic
  expect(data.output_reserve).toBeNull(); expect(data.available_input).toBe(240000); expect(data.components.tools).toBe(0)
  expect(Object.values(data.components).reduce((sum, value) => sum + value, 0)).toBe(data.input_bytes)
  expect(unset).not.toHaveProperty('max_output_tokens')
})
it('rejects unknown versions, fields and malformed measurements instead of storing free-form content', () => {
  const event = { version: 1, run_id: 'run', model_revision: 1, ...rejectedContext(config, [], undefined, 'main-input').diagnostic }
  for (const change of [{ version: 2 }, { text: 'PRIVATE_BODY' }, { stage: 'arbitrary' }, { model_revision: 0 }, { input_bytes: -1 }, { measurement: 'exact-tokens' }, { components: { ...event.components, secret: 'KEY' } }]) expect(() => assertContract('context_rejected', { ...event, ...change })).toThrow()
})
it('does not reserve or dispatch a locally rejected input, preserving the role settings', () => {
  const budget = new RunBudget(config), input: ChatMessage[] = [{ role: 'user', content: 'x'.repeat(250000) }], before = structuredClone(budget.state)
  try { budget.reserve(input, undefined, config, 'summary-correction'); throw Error('Expected capacity rejection') }
  catch (error) { expect(error).toBeInstanceOf(ContextRejectedError); expect((error as ContextRejectedError).diagnostic).toMatchObject({ stage: 'summary-correction', output_reserve: 128000 }) }
  expect(budget.state).toEqual(before)
})
it('validates every rejection stage without turning the diagnostic into a provider request', () => {
  for (const stage of ['main-input', 'protected-input', 'summary-input', 'summary-correction', 'summary-merge', 'summary-install', 'approval-input'] as const) {
    const error = rejectedContext(config, [{ role: 'user', content: 'x'.repeat(250000) }], undefined, stage)
    const event = { version: 1, run_id: 'run', model_revision: 2, ...error.diagnostic }
    assertContract('context_rejected', event)
    expect(event).not.toHaveProperty('request_id'); expect(event).not.toHaveProperty('usage')
  }
})
