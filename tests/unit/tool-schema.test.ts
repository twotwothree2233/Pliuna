import { expect, it } from 'vitest'
import Ajv2020 from 'ajv/dist/2020.js'
import { modelTools } from '../../src/runtime/model/tools'
import { operationContract, operationDirectory } from '../../src/runtime/model/operation-contracts'
import { modelToolRequest } from '../../src/runtime/model/tool-input'

it('keeps exactly four small tools, at most two required fields, with valid approved examples', () => {
  expect(modelTools.map(tool => tool.function.name)).toEqual(['list', 'read', 'write', 'call'])
  expect(Buffer.byteLength(JSON.stringify(modelTools))).toBeLessThan(4000)
  for (const tool of modelTools) {
    const schema = tool.function.parameters as any
    expect(schema.required.length).toBeLessThanOrEqual(2)
    expect(schema.additionalProperties).toBe(false)
    expect(JSON.stringify(schema)).not.toMatch(/\$defs|oneOf|view_op|bundle|forms|layout/)
    const example = JSON.parse(tool.function.description.split('示例：')[1]!)
    expect(new Ajv2020({ strict: false }).compile(schema)(example)).toBe(true)
    expect(() => modelToolRequest(tool.function.name, example)).not.toThrow()
  }
})

it('serves only the requested operation with complete reachable host validation and a valid example', () => {
  expect(operationDirectory.every(item => item.contract_target.id === item.id)).toBe(true)
  for (const id of ['surface.update', 'task_data.create', 'task_data.replace', 'task_data.remove', 'resource.create']) {
    const contract = operationContract(id) as any
    expect(contract.operation).toBe(id)
    const validate = new Ajv2020({ strict: false }).compile(contract.input_schema)
    expect(validate(contract.example.input ?? JSON.parse(contract.example.input_json)), JSON.stringify(validate.errors)).toBe(true)
    expect(() => modelToolRequest('write', contract.example)).not.toThrow()
    if (id !== 'surface.update') expect(JSON.stringify(contract)).not.toMatch(/view_op|layout|behaviors|forms/)
  }
  expect(operationContract('future')).toBeUndefined()
})

it('discovers structured resource input without exposing the full operation schema to every request', () => {
  const write = modelTools.find(tool => tool.function.name === 'write')!
  const schema = write.function.parameters as any
  const validate = new Ajv2020({ strict: false }).compile(schema)
  const example = operationContract('resource.create')!.example as any
  expect(example).toEqual({ operation: 'resource.create', input: { display_name: '说明', content: { type: 'text', text: '正文' } } })
  expect(schema.required).toEqual(['operation'])
  expect(schema.properties.input).toEqual({ type: 'object' })
  expect(schema.properties.input_json).toEqual({ type: 'string' })
  expect(validate(example)).toBe(true)
  expect(validate({ operation: 'resource.create', input_json: JSON.stringify(example.input) })).toBe(true)
  expect(modelToolRequest('write', example)).toEqual(modelToolRequest('write', { operation: 'resource.create', input_json: JSON.stringify(example.input) }))
  expect(() => modelToolRequest('write', { ...example, input_json: JSON.stringify(example.input) })).toThrow()
  expect(() => modelToolRequest('write', { operation: 'resource.create' })).toThrow()
})

it('keeps detailed tool contracts in the new wire and leaves business call discovery intact', () => {
  const read = operationContract('tool.read') as any
  const validate = new Ajv2020({ strict: false }).compile(read.input_schema)
  expect(validate(read.example)).toBe(true)
  expect(validate({ kind: 'task_data', id: 'd', selection: { revision: 1, lines: [1, 2] } })).toBe(true)
  expect(validate({ target: { kind: 'resource', id: 'r' } })).toBe(false)
  expect(validate({ kind: 'resource', id: 'r', selection: { max_chars: 20 } })).toBe(false)
  expect(validate({ kind: 'resource', id: 'r', max_chars: 32001 })).toBe(false)
  const call = operationContract('tool.call') as any
  expect(new Ajv2020({ strict: false }).compile(call.input_schema)({ capability: 'example', input_json: 'null' })).toBe(true)
  expect(operationContract('call')).toBeUndefined()
})
