import { expect, it } from 'vitest'
import { EXPORT_COMPOSITION_BYTES, exportCompositionSummary, validateExportComposition, withExportComposition, type FrozenExportComposition } from '../../src/runtime/export-composition'

function working(): FrozenExportComposition {
  return { version: 1, task_id: 'task', surface_id: 'surface', surface_revision: 3, scope: null, manifest: null, state: 'partial', scope_pending: true, targets: [{ task_id: 'task', request_id: '<goal>', intent_revision: 2 }], publications: [], unresolved: [{ task_id: 'task', request_id: '<goal>', intent_revision: 2, requirement_id: '<missing>' }], omitted: [] }
}

it('retains missing requirement identities as escaped offline metadata and a bounded public summary', () => {
  const fixed = working(), html = withExportComposition('<html><body><p>Already published</p></body></html>', fixed)
  expect(html).toContain('Already published')
  expect(html).toContain('目标 &lt;goal&gt; · 修订 2 · 缺项 &lt;missing&gt;')
  expect(html).not.toContain('<goal>')
  expect(exportCompositionSummary(fixed)).toEqual({ composition_version: null, surface_revision: 3, state: 'partial', scope_pending: true, target_count: 1, published_count: 0, unresolved_count: 1, omitted_count: 0 })
})

it('rejects invented completeness, cross-task metadata and unbound missing requirement identities', () => {
  expect(() => validateExportComposition({ ...working(), state: 'complete' })).toThrow()
  expect(() => validateExportComposition(working(), 'foreign-task')).toThrow()
  expect(() => validateExportComposition({ ...working(), unresolved: [{ ...working().unresolved[0]!, request_id: 'foreign-goal' }] })).toThrow()
  expect(() => validateExportComposition({ ...working(), unresolved: [...working().unresolved, ...working().unresolved] })).toThrow()
})

it('rejects oversized scope metadata before an export snapshot can be installed', () => {
  const fixed = working()
  fixed.targets = Array.from({ length: 3000 }, (_, index) => ({ task_id: 'task', request_id: `${index}-${'g'.repeat(120)}`, intent_revision: 1 }))
  expect(Buffer.byteLength(JSON.stringify(fixed))).toBeGreaterThan(EXPORT_COMPOSITION_BYTES)
  expect(() => validateExportComposition(fixed)).toThrow(expect.objectContaining({ code: 'EXPORT_COMPOSITION_LIMIT' }))
})

it('keeps the existing output size boundary after retaining the frozen manifest', () => {
  const html = '<html><body>' + 'a'.repeat(16 * 1024 * 1024 - 100) + '</body></html>'
  expect(() => withExportComposition(html, working())).toThrow(expect.objectContaining({ code: 'EXPORT_SIZE_LIMIT' }))
})
