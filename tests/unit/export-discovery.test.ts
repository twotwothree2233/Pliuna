import { expect, it } from 'vitest'
import { contractRepresentation, operationContract } from '../../src/runtime/model/operation-contracts'
import { modelReadOptions, modelToolRequest, modelToolSuggestion } from '../../src/runtime/model/tool-input'
import { ContractError, assertContract } from '../../src/shared/validation'
import { ReadCursors } from '../../src/runtime/model/read-cursor'
import { staticDocument } from '../../src/runtime/static-export'

it('discovers branch required fields with complete valid Surface operation examples', () => {
  const contract = operationContract('surface.update')!
  for (const type of ['view.create', 'view.replace', 'view.remove', 'layout.set']) {
    const guide: any = contractRepresentation(contract, { view: 'guide', section: type })
    const schema: any = contractRepresentation(contract, { view: 'schema', section: type })
    expect(guide.fields.filter((f: any) => f.required).map((f: any) => f.name)).toEqual(schema.required)
    expect(guide.outer_fields.filter((f: any) => f.required).map((f: any) => f.name)).toEqual(['surface_id', 'expected_revision', 'operations'])
    const example: any = contractRepresentation(contract, { view: 'example', section: type })
    const request = modelToolRequest('write', example)
    expect(() => assertContract('model_request', request)).not.toThrow()
    expect((request.input as any).operations[0].type).toBe(type)
    if (type === 'view.create' || type === 'view.replace') {
      const issues = staticDocument('Example', [{ bundle: (request.input as any).operations[0].bundle.bundle, resolve: () => { throw Error('no resources') } }]).issues
      expect(issues).toEqual([])
    }
  }
  const rules: any = contractRepresentation(contract, { view: 'schema', section: 'export-rules' })
  expect(rules.categories.learning).toContain('verification table')
  expect(rules.categories.answer).toContain('formally submitted')
  expect(rules.snapshot_sources).toContain('Only same-task task_data')
  expect(() => modelToolRequest('read', rules.check)).not.toThrow()
  expect(contractRepresentation(contract, { view: 'guide', section: 'export-rules' })).toEqual(rules)
  const root: any = contractRepresentation(contract, { view: 'guide' })
  const link = root.sections.find((section: any) => section.id === 'state-and-references').read
  expect(() => modelToolRequest('read', link)).not.toThrow()
  const state: any = contractRepresentation(contract, link.selection)
  expect(state.draft).toContain('raw control representations')
  expect(state.draft).toContain('strings')
  expect(state.preserve).toContain('unchanged state schema')
  expect(state.references).toContain('snapshot_sources')
  expect(() => modelToolRequest('read', state.history)).not.toThrow()
})

it('accepts only explicit View export checks and keeps exact revision in ephemeral options', () => {
  const request = modelToolRequest('read', { kind: 'view', id: 'v', selection: { view: 'export_check', revision: 2 }, max_chars: 30 })
  expect(request.input).toEqual({ target: { kind: 'view', id: 'v', expected_revision: 2 } })
  expect(modelReadOptions(request)).toMatchObject({ max_chars: 30, selection: { view: 'export_check', revision: 2 } })
  for (const raw of [
    { kind: 'resource' }, { selection: { view: 'export_check', lines: [1, 2] } },
    { selection: { view: 'export_check', find: 'x' } }, { selection: { view: 'export_check', pages: [1, 1] } },
    { selection: { view: 'export_check', section: 'x' } }
  ]) expect(() => modelToolRequest('read', { kind: 'view', id: 'v', selection: { view: 'export_check' }, ...raw })).toThrow()
})

it('provides a minimal recoverable cursor only after signature and scope verification', async () => {
  const cursors = new ReadCursors(), read = (raw: any) => modelToolRequest('read', { kind: 'resource', id: 'r', ...raw }) as any
  const first = await cursors.read('task', 'run', read({ max_chars: 30, selection: { find: '中😀' } }), () => ({ next_cursor: 'inner' }))
  try {
    await cursors.read('task', 'run', read({ cursor: first.next_cursor, max_chars: 31 }), () => { throw Error('must not query') })
    throw Error('Expected conflict')
  } catch (error) {
    expect(error).toMatchObject({ code: 'INVALID_CURSOR', message: expect.stringContaining('max_chars') })
    const suggestion = JSON.parse((error as ContractError).suggestion!)
    expect(suggestion).toEqual({ name: 'read', arguments: { kind: 'resource', id: 'r', cursor: first.next_cursor } })
    const next: any = await cursors.read('task', 'run', read(suggestion.arguments), request => ({ options: modelReadOptions(request) }))
    expect(next.options.max_chars).toBe(30)
  }
  await expect(cursors.read('foreign', 'run', read({ cursor: first.next_cursor, max_chars: 31 }), () => null)).rejects.toMatchObject({ suggestion: undefined })
  expect(modelToolSuggestion('call', { capability: 'builtin:monty:v1' }, new ContractError('MONTY_INPUT_INVALID', 'invalid'))).toBe(JSON.stringify({ name: 'read', arguments: { kind: 'capability', id: 'builtin:monty:v1' } }))
  expect(modelToolSuggestion('write', { operation: 'surface.update', input_json: '/private/sentinel' }, new ContractError('INVALID_REQUEST', 'invalid'))).not.toContain('sentinel')
  const advice = JSON.parse(modelToolSuggestion('write', { operation: 'surface.update' }, new ContractError('PERSONAL_BINDING_REQUIRED', 'invalid'))!)
  expect(advice.arguments.selection).toEqual({ view: 'guide', section: 'export-rules' })
})
