import { expect, it } from 'vitest'
import { assembleContext, historyGroups, type HistoryRecord } from '../../src/runtime/model/context'
import { RunBudget } from '../../src/runtime/model/agent'
import { messageEvidence } from '../../src/runtime/model/request-evidence'
import { operationContract } from '../../src/runtime/model/operation-contracts'
import { staticDocument } from '../../src/runtime/static-export'
import type { Bundle } from '../../src/shared/contracts.generated'
import { modelTools } from '../../src/runtime/model/tools'

function records(kind: string, execution = 'success'): HistoryRecord[] {
  const target = { kind, id: 'contract' }
  return [
    { id: 'response', sequence: 1, kind: 'model.response', payload: { run_id: 'owner', message: { role: 'assistant', content: null, tool_calls: [{ id: 'read', type: 'function', function: { name: 'read', arguments: JSON.stringify(target) } }] } } },
    { id: 'result', sequence: 2, kind: 'model.tool_result', payload: { run_id: 'owner', message: { role: 'tool', tool_call_id: 'read', content: JSON.stringify({ request_type: 'read', execution, delivery: 'delivered', data: { data: { text: 'CONTRACT_BODY_'.repeat(1400) }, content_version: 'fixed', truncated: true, next_cursor: 'signed-next-page' } }) } } }
  ]
}

it('delivers explicit current-Run contract pages intact, including original cursors and evidence', () => {
  for (const kind of ['object_type', 'capability']) {
    const original = records(kind), before = JSON.stringify(original)
    const supplied = historyGroups(original, 'owner')[0]!.messages.at(-1)!
    expect(supplied.content).toBe(original[1]!.payload.message.content)
    expect(JSON.parse(supplied.content!).data.next_cursor).toBe('signed-next-page')
    expect(messageEvidence(supplied)).toMatchObject({ representation: 'recorded-message', source: { id: 'result' }, read_target: { kind, id: 'contract' }, owner_run_id: 'owner' })
    expect(JSON.stringify(original)).toBe(before)
    expect(historyGroups(original, 'another-run')[0]!.messages.at(-1)!.content).toBe(original[1]!.payload.message.content)
  }
})

it('retains other objects and failed reads intact, and refuses orphan tool results', () => {
  for (const original of [records('resource'), records('object_type', 'not_executed')]) {
    expect(historyGroups(original, 'owner')[0]!.messages.at(-1)!.content).toBe(original[1]!.payload.message.content)
  }
  expect(() => historyGroups(records('object_type').slice(1), 'owner')).toThrow('CONTEXT_NO_SAFE_GROUP')
})

it('accounts intact requested contracts against the unchanged input capacity instead of shortening or bypassing it', () => {
  const original = records('object_type'), fixed = [{ role: 'system' as const, content: 'role' }]
  const input = assembleContext(fixed, null, historyGroups(original, 'owner'))
  expect(input.at(-1)!.content).toBe(original[1]!.payload.message.content)
  const budget = new RunBudget({ id: 'synthetic', base_url: 'https://example.invalid', wire_model_id: 'synthetic', compatibility_profile: 'chat-max-tokens', context_tokens: 10000 })
  expect(budget.fits(fixed, modelTools)).toBe(true)
  expect(budget.fits(input, modelTools)).toBe(false)
})

it('exposes an exact discovery entry without expanding the constant tool schemas', () => {
  const description = modelTools.find(tool => tool.function.name === 'list')!.function.description
  expect(description).toContain('kind="object_type"')
  expect(description).toContain('contract_target')
  for (const tool of modelTools) {
    expect((tool.function.parameters as any).required.length).toBeLessThanOrEqual(2)
    expect(JSON.stringify(tool.function.parameters)).not.toMatch(/\$defs|oneOf|view_op|bundle/)
  }
})

it('exports the exact Surface contract example as classified learning, without omissions or active content', () => {
  const example = operationContract('surface.update')!.example as any
  const bundle: Bundle = JSON.parse(example.input_json).operations[0].bundle.bundle
  const result = staticDocument('Example delivery', [{ bundle, resolve() { throw Error('Example must not require resources') } }])
  expect(result.issues).toEqual([])
  expect(result.html).toContain('内容')
  expect(result.html).not.toContain('此区域未导出')
  expect(result.html).not.toMatch(/<script|<input|<button|<textarea|<iframe/)
})
