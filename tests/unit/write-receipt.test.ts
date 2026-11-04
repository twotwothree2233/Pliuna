import { expect, it } from 'vitest'
import { projectWriteReceipts } from '../../src/runtime/model/write-receipt'
import { attachEvidence, messageEvidence, requestEvidence } from '../../src/runtime/model/request-evidence'
import { assertContract } from '../../src/shared/validation'
import { capacityPlan } from '../../src/runtime/model/capacity'
import type { ChatMessage } from '../../src/runtime/model/adapter'

function pair(input: unknown, result: any = { request_type: 'write', execution: 'success', delivery: 'delivered', data: { action_id: 'action', revision: 2, views: [{ view_id: 'view', revision: 1 }] } }): ChatMessage[] {
  return [attachEvidence({ role: 'assistant', content: 'publishing', tool_calls: [{ id: 'call', type: 'function', function: { name: 'write', arguments: JSON.stringify(input) } }] }, { kind: 'model.response', representation: 'recorded-message', source: { kind: 'event', id: 'response' }, owner_run_id: 'previous' }), attachEvidence({ role: 'tool', tool_call_id: 'call', content: JSON.stringify(result) }, { kind: 'model.tool_result', representation: 'recorded-message', source: { kind: 'event', id: 'result' }, owner_run_id: 'previous' })]
}
const input = () => ({ operation: 'surface.update', input_json: JSON.stringify({ surface_id: 'surface', expected_revision: 1, snapshot_sources: [{ kind: 'event', id: 'source' }], operations: [{ type: 'view.create', client_ref: 'one', slot_id: 'main', bundle: { type: 'inline', bundle: { html: '<p>' + 'large-body'.repeat(3000) + '</p>', css: '', references: [{ kind: 'resource', id: 'protected' }], state: { initial: { keep: true } }, forms: [], behaviors: [], export: [] } } }] }) })
it('projects completed write arguments only, preserving pairing, original result and all original records', () => {
  const original = pair(input()), before = JSON.stringify(original), projected = projectWriteReceipts(original)
  const receipt = JSON.parse(projected[0]!.tool_calls![0]!.function.arguments)
  expect(receipt.completed_write_receipt).toMatchObject({ operation_id: 'action', source: { id: 'response' }, result_source: { id: 'result' }, execution: 'success', delivery: 'delivered', replayable: false, body_supplied: false })
  expect(receipt.completed_write_receipt.omitted).toMatchObject([{ path: '/operations/0/bundle/bundle/html', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }, { path: '/operations/0/bundle/bundle/css' }])
  expect(receipt.operation_metadata.decoded_input.operations[0].bundle.bundle).toEqual({ references: [{ kind: 'resource', id: 'protected' }], state: { initial: { keep: true } }, forms: [], behaviors: [], export: [] })
  expect(projected[0]!.tool_calls![0]!.id).toBe('call'); expect(projected[1]).toBe(original[1]); expect(JSON.stringify(original)).toBe(before)
  expect(messageEvidence(projected[0]!)).toMatchObject({ representation: 'completed-write-receipt', owner_run_id: 'previous' })
  expect(projectWriteReceipts(projected)).toEqual(projected)
})
it('leaves incomplete, ambiguous, failed, undelivered, unknown and unlinked groups untouched', () => {
  for (const outcome of [{ execution: 'failure' }, { delivery: 'failed' }, { truncated: true }, { data: {} }]) {
    const original = pair(input(), { request_type: 'write', execution: 'success', delivery: 'delivered', data: { action_id: 'action' }, ...outcome })
    expect(projectWriteReceipts(original)).toEqual(original)
  }
  const original = pair(input())
  expect(projectWriteReceipts(original.slice(0, 1))).toEqual(original.slice(0, 1))
  expect(projectWriteReceipts([...original, original[1]!])).toEqual([...original, original[1]!])
  const multiple = structuredClone(original)
  multiple[0]!.tool_calls!.push({ id: 'unfinished', type: 'function', function: { name: 'read', arguments: '{}' } })
  attachEvidence(multiple[0]!, messageEvidence(original[0]!)!); attachEvidence(multiple[1]!, messageEvidence(original[1]!)!)
  expect(projectWriteReceipts(multiple)).toEqual(multiple)
  expect(projectWriteReceipts(structuredClone(original))).toEqual(original)
  const unknown = pair({ operation: 'future-operation', input_json: JSON.stringify({ text: 'x'.repeat(20000) }) })
  expect(projectWriteReceipts(unknown)).toEqual(unknown)
})
it('retains explicitly selected read plaintext and does not project pending writes', () => {
  const original = pair(input()), text = '自主读取中😀'.repeat(1000)
  original.push({ role: 'assistant', content: null, tool_calls: [{ id: 'read', type: 'function', function: { name: 'read', arguments: '{"id":"resource","kind":"resource","selection":{"view":"text"}}' } }] }, { role: 'tool', tool_call_id: 'read', content: JSON.stringify({ request_type: 'read', execution: 'success', delivery: 'delivered', data: { data: { text } } }) })
  const projected = projectWriteReceipts(original)
  expect(projected[2]).toBe(original[2]); expect(projected[3]).toBe(original[3]); expect(projected[3]!.content).toContain(text)
})
it('handles each explicitly supported payload shape, preserving small calls and version conditions', () => {
  for (const value of [{ type: 'resource.create', content: { type: 'text', text: 'x'.repeat(20000) }, references: [] }, { type: 'task_data.create', data: { value: { text: 'x'.repeat(20000) }, schema: { type: 'object' }, references: [] } }, { type: 'task_data.replace', expected_revision: 7, value: { text: 'x'.repeat(20000) }, references: [] }]) {
    const { type, ...body } = value
    const original = pair({ operation: type, input_json: JSON.stringify(body) }), projected = projectWriteReceipts(original)
    expect(projected[0]).not.toBe(original[0]); expect(projected[1]).toBe(original[1])
    if (value.type === 'task_data.replace') expect(JSON.parse(projected[0]!.tool_calls![0]!.function.arguments).operation_metadata.decoded_input.expected_revision).toBe(7)
  }
  const tiny = pair({ operation: 'task_data.replace', input_json: JSON.stringify({ expected_revision: 1, value: {}, references: [] }) })
  expect(projectWriteReceipts(tiny)).toEqual(tiny)
})
it('does not interpret obsolete or invalid write encodings as completed receipts', () => {
  const wire = input(), body = JSON.parse(wire.input_json)
  for (const invalid of [
    { type: wire.operation, ...body }, { operation: wire.operation, input: body },
    { operation: wire.operation, input_json: '{' }, { operation: wire.operation, input_json: 'null' },
    { operation: wire.operation, input_json: JSON.stringify(wire.input_json) }
  ]) {
    const original = pair(invalid)
    expect(projectWriteReceipts(original)[0]).toBe(original[0])
  }
})
it('projects explicit JSON text without confusing decoded paths with string offsets', () => {
  const original = pair(input()), before = JSON.stringify(original)
  const projected = projectWriteReceipts(original), receipt = JSON.parse(projected[0]!.tool_calls![0]!.function.arguments)
  expect(receipt.completed_write_receipt.path_basis).toBe('decoded-input_json')
  expect(receipt.completed_write_receipt.omitted[0].path).toBe('/operations/0/bundle/bundle/html')
  expect(receipt.operation_metadata).not.toHaveProperty('input_json')
  expect(receipt.operation_metadata.decoded_input.expected_revision).toBe(1)
  expect(receipt.operation_metadata.decoded_input.operations[0].bundle.bundle).not.toHaveProperty('html')
  expect(receipt.completed_write_receipt.omitted[0].sha256).toHaveLength(64)
  expect(JSON.stringify(original)).toBe(before)
  expect(projectWriteReceipts(projected)).toEqual(projected)
})
it('reduces a rejected continuation without changing reserves, tools, read content or persisted evidence format', () => {
  const config = { id: 'test', base_url: 'https://example.invalid', wire_model_id: 'test', context_tokens: 240000, max_output_tokens: 128000, compatibility_profile: 'chat-max-tokens' as const }
  const original = [attachEvidence({ role: 'user', content: JSON.stringify({ request: 'Create a resource' }) }, { kind: 'host-state', representation: 'current-state' }), { role: 'user' as const, content: 'x'.repeat(220000) }, ...pair(input())]
  const projected = projectWriteReceipts(original)
  expect(capacityPlan(config, original).fits).toBe(false); expect(capacityPlan(config, projected)).toMatchObject({ fits: true, output_reserve: 128000, available_input: 240000 })
  const messages = projected
  expect(JSON.stringify(messages)).not.toContain('request_evidence')
  const manifest = requestEvidence(messages, 'request', 'main'); assertContract('request_evidence', manifest)
  expect(manifest.entries.find(entry => entry.source?.id === 'response')).toMatchObject({ representation: 'completed-write-receipt' })
  expect(manifest.entries.some(entry => 'owner_run_id' in entry)).toBe(false)
})
