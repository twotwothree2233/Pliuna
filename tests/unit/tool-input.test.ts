import { expect, it } from 'vitest'
import { decodeModelInput, modelReadOptions, modelToolRequest, modelToolResult } from '../../src/runtime/model/tool-input'
import { operationContract } from '../../src/runtime/model/operation-contracts'
import { montyContract } from '../../src/runtime/monty/contract'

it('reports only relevant input fields and unambiguous read-unit rules', () => {
  expect(() => modelToolRequest('list', { kind: 'contract_target' })).toThrow('object_type')
  expect(() => modelToolRequest('call', { capability: 'x', input_json: '{}', unexpected: true })).toThrow('unexpected')
  expect(() => modelToolRequest('read', { kind: 'resource', id: 'r', selection: { view: 'text', unit: 'lines', start: 1, end: 2 } })).toThrow('unit')
  expect(() => modelToolRequest('write', { operation: 'task_data.remove', input_json: '{"id":"d","expected_revision":0}' })).toThrow('expected_revision')
  expect(() => modelToolRequest('write', { operation: 'resource.create', input_json: '{"display_name":"x","content":{"type":"text","text":3}}' })).toThrow('/content/text must be string')
  try { modelToolRequest('list', { kind: 'contract_target' }) } catch (error) {
    expect((error as Error).message).not.toMatch(/oneOf|schemaPath|anyOf/)
    expect((error as Error).message.length).toBeLessThan(500)
  }
  const rules = JSON.stringify(operationContract('tool.read'))
  expect(rules).toContain('search scan is not body delivery')
  expect(rules).toContain('saved page index')
  expect(montyContract.description).toContain('references do not bind variables or load resource content')
})

it('maps minimal wire into unchanged strict execution contracts', () => {
  expect(modelToolRequest('list', { kind: 'resource' })).toEqual({ type: 'list', input: { kind: 'resource' } })
  const text = modelToolRequest('read', { kind: 'resource', id: 'r', max_chars: 32000, selection: { lines: [4, 10] } })
  expect(text.input).toEqual({ target: { kind: 'resource', id: 'r' } })
  const data = modelToolRequest('read', { kind: 'task_data', id: 'd', selection: { revision: 2, lines: [1, 2] } })
  expect(data.input).toEqual({ target: { kind: 'task_data', id: 'd', expected_revision: 2 } })
  expect(modelReadOptions(data)).toMatchObject({ max_chars: 4000, selection: { view: 'object', revision: 2, lines: [1, 2] } })
  const input = { id: 'd', expected_revision: 1, value: { stage: 'updated', literal: '{"x":1}' }, references: [] }
  expect(modelToolRequest('write', { operation: 'task_data.replace', input_json: JSON.stringify(input) }).input).toEqual({ type: 'task_data.replace', ...input })
  for (const args of [null, true, 2, 'text', '{"code":"literal"}', [1, 2], { code: 'result = 1' }]) expect(modelToolRequest('call', { capability: 'builtin:monty:v1', input_json: JSON.stringify(args) }).input).toEqual({ capability: 'builtin:monty:v1', arguments: args, references: [] })
})

it('rejects invalid encoding, overrides and selections before dispatch', () => {
  for (const raw of [null, [], 1, 'text', '{"value":1}']) expect(() => modelToolRequest('write', { operation: 'task_data.replace', input_json: JSON.stringify(raw) })).toThrow()
  for (const [name, raw] of [
    ['write', { operation: 'task_data.remove', input_json: '{' }],
    ['write', { operation: 'task_data.remove', input_json: '{"type":"task_data.remove","id":"d","expected_revision":1}' }],
    ['write', { operation: 'task_data.remove', input_json: '{"id":"d","expected_revision":0}' }],
    ['write', { operation: 'task_data.remove', input: { id: 'd', expected_revision: 1 } }],
    ['call', { capability: 'x', arguments: {} }],
    ['call', { capability: 'x', input_json: '{}', references: null }],
    ['call', { capability: 'x', input_json: '{}', extra: true }],
    ['call', { capability: 'x', input_json: '```json\n{}\n```' }],
    ['read', { kind: 'resource', id: 'r', selection: { max_chars: 4 } }],
    ['read', { kind: 'resource', id: 'r', max_chars: 32001 }],
    ['read', { kind: 'resource', id: 'r', max_chars: 0 }],
    ['read', { kind: 'resource', id: 'r', selection: { start: 0 } }],
    ['read', { kind: 'resource', id: 'r', selection: { view: 'text', revision: 1 } }],
    ['read', { kind: 'resource', id: 'r', selection: { view: 'text', unit: 'bytes', start: -1 } }],
    ['read', { kind: 'resource', id: 'r', selection: { view: 'text', unit: 'pages', start: 1 } }],
    ['read', { kind: 'resource', id: 'r', selection: { view: 'text', unit: 'lines', start: 1, end: 2 } }],
    ['read', { kind: 'resource', id: 'r', selection: { unit: 'lines', start: 3, end: 2 } }],
    ['read', { kind: 'resource', id: 'r', selection: { view: 'schema' } }],
    ['read', { kind: 'resource', id: 'r', selection: { section: 'x' } }],
    ['list', { kind: 'resource', filters: { sql: 'anything' } }],
    ['future', {}]
  ]) expect(() => modelToolRequest(name as string, raw)).toThrow()
})

it('returns exact continuation calls only for successfully delivered pages', () => {
  const raw = { kind: 'resource', id: 'r', selection: { view: 'text' }, max_chars: 10 }, result = { execution: 'success', delivery: 'delivered', data: { next_cursor: 'signed' } }
  expect(modelToolResult('read', raw, result)).toMatchObject({ data: { next_call: { name: 'read', arguments: { kind: 'resource', id: 'r', cursor: 'signed' } } } })
  expect(result.data).not.toHaveProperty('next_call')
  for (const change of [{ execution: 'not_executed' }, { delivery: 'failed' }, { data: { next_cursor: null } }]) { const value = { ...result, ...change }; expect(modelToolResult('read', raw, value)).toBe(value) }
})

it('locates malformed JSON without echoing payload contents or repairing it', () => {
  const input = '{\n"private":"保密😀",\n"x": }'
  try { decodeModelInput(input); throw Error('must reject') } catch (error) {
    expect((error as Error).message).toContain('input_json: invalid JSON at offset ' + input.indexOf('}'))
    expect((error as Error).message).toContain('UTF-16 code units), line 3, column 6')
    expect((error as Error).message).not.toContain('保密')
  }
  expect(() => decodeModelInput('{"x":')).toThrow('offset 5')
})

it('reports replace/remove branch fields, never unrelated create fields', () => {
  for (const type of ['view.replace', 'view.remove']) {
    const input = { surface_id: 's', expected_revision: 1, operations: [{ type, view_id: 'v', expected_view_revision: 1 }] }
    try { modelToolRequest('write', { operation: 'surface.update', input_json: JSON.stringify(input) }); throw Error('must reject') } catch (error) {
      expect((error as Error).message).toMatch(/bundle|state_transition|expected_state_revision/)
      expect((error as Error).message).not.toMatch(/client_ref|slot_id/)
    }
  }
  const input = JSON.parse((operationContract('surface.update')!.example as any).input_json)
  input.operations.push({ type: 'view.replace', view_id: 'v', expected_view_revision: 1, bundle: { type: 'resource', resource: { kind: 'resource' } }, state_transition: { type: 'reset', expected_state_revision: 1 } })
  expect(() => modelToolRequest('write', { operation: 'surface.update', input_json: JSON.stringify(input) })).toThrow('/operations/1/bundle/resource')
})
