import { describe, expect, it } from 'vitest'
import { checkExportFragments } from '../../src/runtime/export-fragments'
import { checkBundle } from '../../src/runtime/managed'
import type { Bundle } from '../../src/shared/contracts.generated'

const bundle = (): Bundle => ({ profile: 'managed-v1', html: '<section id="parent"><p id="child">One</p></section><p id="sibling">Two</p>', css: '', state: { schema: { type: 'object', properties: {}, additionalProperties: false }, initial: {}, compatibility_version: 'static' }, forms: [], behaviors: [], references: [], export: [] })
const element = (id: string, root: string): Bundle['export'][number] => ({ id, category: 'learning', source: { type: 'element', element_id: root } })
describe('publication export declarations', () => {
  it('accepts siblings and independent static fragments', () => {
    const b = bundle(); b.export = [element('one', 'parent'), element('two', 'sibling'), { id: 'static', category: 'learning', source: { type: 'static', html: '<p>Independent</p>', css: '' } }]
    expect(() => checkExportFragments(b)).not.toThrow()
  })
  it.each([
    ['duplicate fragment', [element('same', 'parent'), element('same', 'sibling')], 'EXPORT_FRAGMENT_INVALID'],
    ['duplicate root', [element('one', 'parent'), element('two', 'parent')], 'EXPORT_FRAGMENT_INVALID'],
    ['missing root', [element('one', 'missing')], 'EXPORT_FRAGMENT_INVALID'],
    ['parent first', [element('one', 'parent'), element('two', 'child')], 'EXPORT_FRAGMENT_OVERLAP'],
    ['child first', [element('one', 'child'), element('two', 'parent')], 'EXPORT_FRAGMENT_OVERLAP']
  ] as const)('rejects %s without blocking legacy rendering', (_name, fragments, code) => {
    const b = bundle(); b.export = [...fragments]
    expect(() => checkExportFragments(b)).toThrow(expect.objectContaining({ code }))
    expect(() => checkBundle(b, 'legacy')).not.toThrow()
  })
})
