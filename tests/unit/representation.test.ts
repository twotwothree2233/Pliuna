import { expect, it } from 'vitest'
import { RepresentationPager } from '../../src/runtime/model/representation'
import { contractRepresentation, operationContract } from '../../src/runtime/model/operation-contracts'
import { modelReadOptions, modelToolRequest } from '../../src/runtime/model/tool-input'
import { checkBundle } from '../../src/runtime/managed'

it('preserves JSON root types and pages exact Unicode representation', () => {
  const pager = new RepresentationPager()
  for (const value of [null, 2, true, 'value', [1], { x: 1 }]) expect(pager.page(value, ['task', 'run'], { max_chars: 4000, selection: { view: 'object' } }).data).toEqual(value)
  for (const value of [{ text: '中😀\n"\\'.repeat(2000) }, { text: 'x'.repeat(18000) }]) {
    const options = { max_chars: 37, selection: { view: 'object' as const } }, parts: string[] = []
    let cursor: string | undefined
    do {
      const result = pager.page(value, ['task', 'run'], options, cursor)
      expect([...result.data.text].length).toBeLessThanOrEqual(37)
      expect(result.actual_range).not.toHaveProperty('chars')
      if (result.next_cursor) expect(result.next_cursor.length).toBeLessThanOrEqual(200)
      parts.push(result.data.text); cursor = result.next_cursor ?? undefined
    } while (cursor)
    expect(parts.join('')).toBe(JSON.stringify(value, null, 2))
  }
})

it('retains exact line selection and rejects changed task, source, version, view and page size', () => {
  const pager = new RepresentationPager(), value = { a: '😀'.repeat(80), b: 2 }, options = { max_chars: 7, selection: { view: 'object' as const, lines: [2, 2] as [number, number], revision: 1 } }
  const first = pager.page(value, ['task', 'run'], options), parts = [first.data.text]
  let cursor = first.next_cursor
  while (cursor) { const result = pager.page(value, ['task', 'run'], options, cursor); parts.push(result.data.text); cursor = result.next_cursor }
  expect(parts.join('')).toBe(JSON.stringify(value, null, 2).split('\n')[1] + '\n')
  for (const binding of [['other', 'run'], ['task', 'other']]) expect(() => pager.page(value, binding, options, first.next_cursor)).toThrow('Cursor')
  expect(() => pager.page({ ...value, b: 3 }, ['task', 'run'], options, first.next_cursor)).toThrow('changed')
  for (const next of [{ ...options, max_chars: 8 }, { ...options, selection: { ...options.selection, view: 'schema' as const } }, { ...options, selection: { ...options.selection, lines: [2, 3] as [number, number] } }]) expect(() => pager.page(value, ['task', 'run'], next, first.next_cursor)).toThrow('Cursor')
  expect(() => pager.page(value, ['task', 'run'], options, first.next_cursor.slice(0, -2) + 'xx')).toThrow('Cursor')
  pager.reset(); expect(() => pager.page(value, ['task', 'run'], options, first.next_cursor)).toThrow('Cursor')
})

it('keeps byte protection independent of requested characters without truncating silently', () => {
  const pager = new RepresentationPager(), value = { text: '\u0000'.repeat(40000) }, options = { max_chars: 32000, selection: { view: 'object' as const } }
  const first = pager.page(value, 'task', options)
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(32768)
  expect(first.truncated).toBe(true); expect(first.next_cursor).toBeTruthy()
  expect([...first.data.text].length).toBeLessThan(32000)
})

it('discovers complete contract sections from the same schema and executable vocabulary', () => {
  const contract = operationContract('surface.update')!, guide: any = contractRepresentation(contract, { view: 'guide' })
  expect(guide.complete).toBe(false)
  expect(guide.sections.map((s: any) => s.id)).toEqual(expect.arrayContaining(['input', 'example', 'html-css', 'view_op', 'bundle', 'state_transition', 'sections']))
  expect(contractRepresentation(contract, { view: 'schema', section: 'sections' })).toEqual(expect.arrayContaining(['view.create', 'view.replace', 'view.remove', 'bundle.html', 'bundle.css', 'bundle.forms', 'bundle.behaviors', 'bundle.export']))
  const example: any = contractRepresentation(contract, { view: 'example' })
  const body = JSON.parse(example.input_json)
  expect(() => checkBundle(body.operations[0].bundle.bundle, 'example')).not.toThrow()
  for (const section of guide.sections) expect(() => contractRepresentation(contract, section.read.selection)).not.toThrow()
  const vocabulary: any = contractRepresentation(contract, { view: 'schema', section: 'html-css' })
  expect(vocabulary.css.structure).toContain('Browser CSS'); expect(vocabulary.execution).toContain('No scripts'); expect(vocabulary).not.toHaveProperty('css_properties')
  expect(() => contractRepresentation(contract, { view: 'schema', section: 'invented' })).toThrow('Unknown contract section')
  expect(contractRepresentation(contract, { view: 'object' })).toBe(contract)
})

it('does not turn max_chars into implicit text selection or lose ephemeral read options', () => {
  const request = modelToolRequest('read', { kind: 'resource', id: 'id', max_chars: 5 })
  expect(request.input).not.toHaveProperty('content')
  expect(modelReadOptions(request)?.selection.view).toBeUndefined()
  const contract = modelToolRequest('read', { kind: 'object_type', id: 'surface.update' })
  expect(modelReadOptions(contract)?.selection.view).toBe('guide')
})
