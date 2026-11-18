import { expect, it } from 'vitest'
import type { ArtifactIndex, Bundle, ModelRequestLayout, PresentationPlan, PublicationEntry } from '../../src/shared/contracts.generated'
import { validateRunnerContract } from '../../src/shared/runner-validation'
import { validateModel } from '../../src/shared/validation'
import { compilePresentation, type CompiledPresentation, type PresentationCompileInput, type PresentationSource } from '../../src/runtime/runner/presentation'

function body(text = 'source-body-marker', compatibility = 'v1', initial = ''): Bundle {
  return { profile: 'managed-v1', html: `<p>${text}</p>`, css: '', state: { schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false }, initial: { answer: initial }, compatibility_version: compatibility }, forms: [], behaviors: [], references: [], export: [] }
}
function index(id = 'artifact', section = 'section', order = 'a', width: ArtifactIndex['width_constraint'] = 'full'): ArtifactIndex {
  return { task_id: 'task', request_id: 'goal', intent_revision: 1, run_id: 'production', work_id: 'producer', attempt_id: 'attempt', artifact_id: id, artifact_revision: 1, bundle_resource_id: `source-${id}`, section_id: section, order_key: order, presentation_kind: 'managed-v1', width_constraint: width, interaction_kind: 'none', provenance_ref: { task_id: 'task', kind: 'record', id: 'record' }, acceptance_state: 'accepted' }
}
function plan(indexes: ArtifactIndex[], changes: Record<string, unknown> = {}): PresentationPlan {
  return validateRunnerContract('runner_presentation_plan', { task_id: 'task', run_id: 'composition', batch_id: 'batch', composition_version: 1, intents: indexes.map(index => ({ artifact: { task_id: index.task_id, artifact_id: index.artifact_id, artifact_revision: index.artifact_revision }, section_id: index.section_id, section_position_revision: 1, order_key: index.order_key, slot_id: 'main', layout_mode: 'column', width_constraint: index.width_constraint })), ...changes })
}
function source(index: ArtifactIndex, value = body()): PresentationSource { return { task_id: 'task', resource_id: index.bundle_resource_id, byte_length: Buffer.byteLength(JSON.stringify(value)), bundle: value } }
function setup(indexes = [index()]): PresentationCompileInput {
  return { plan: plan(indexes), indexes, sections: [...new Map(indexes.map(index => [index.section_id, { section_id: index.section_id, request_id: index.request_id, intent_revision: index.intent_revision, order_key: index.order_key, position_revision: 1 }])).values()], surface: { task_id: 'task', surface_id: 'surface', revision: 8, layout: { slots: [{ id: 'main', groups: [{ id: 'input-group', type: 'column', views: ['input-view'], gap: 'large', align: 'start' }] }] } }, views: [{ view_id: 'input-view', view_revision: 4, state_revision: 7, bundle_resource_id: 'form-published' }], mappings: [], sources: indexes.map(index => source(index)), features: { viewReplacement: true } }
}
function layout(result: CompiledPresentation): ModelRequestLayout {
  const op = result.request.input.operations.find(op => op.type === 'layout.set')
  if (!op || op.type !== 'layout.set') throw new Error('Expected complete layout')
  return op.layout
}
function entry(index: ArtifactIndex, view = `view-${index.artifact_id}`): PublicationEntry {
  return { task_id: index.task_id, batch_id: 'previous-batch', request_id: index.request_id, intent_revision: index.intent_revision, artifact_id: index.artifact_id, artifact_revision: index.artifact_revision, section_id: index.section_id, source_bundle_resource_id: index.bundle_resource_id, published_bundle_resource_id: `normalized-${index.artifact_id}`, view_id: view, view_revision: 3, state_revision: 2, surface_history_id: 'surface-history' }
}
function published(input: PresentationCompileInput): PresentationCompileInput {
  const result = compilePresentation(input), next = structuredClone(input)
  next.mappings = input.indexes.map(index => entry(index))
  const created = new Map(result.bindings.flatMap(binding => binding.view.type === 'created' ? [[binding.view.client_ref, next.mappings.find(mapping => mapping.artifact_id === binding.artifact_id)!.view_id] as const] : []))
  next.views.push(...next.mappings.map(mapping => ({ view_id: mapping.view_id, view_revision: mapping.view_revision, state_revision: 9, bundle_resource_id: mapping.published_bundle_resource_id })))
  next.surface.layout = { slots: layout(result).slots.map(slot => ({ id: slot.slot_id, groups: slot.groups.map(group => ({ id: group.id, type: group.mode, views: group.views.map(locator => locator.type === 'existing' ? locator.view_id : created.get(locator.client_ref)!), gap: group.gap, align: group.align, ...(group.column_weights ? { column_weights: [...group.column_weights] } : {}) })) })) }
  next.sources = []
  return next
}

it('compiles source resource references and retains every unrelated View and form group', () => {
  const input = setup(), before = structuredClone(input), result = compilePresentation(input)
  expect(result.request.input).toMatchObject({ type: 'surface.update', surface_id: 'surface', expected_revision: 8 })
  expect(result.request.input.operations).toHaveLength(2)
  expect(result.request.input.operations[0]).toMatchObject({ type: 'view.create', slot_id: 'main', bundle: { type: 'resource', resource: { kind: 'resource', id: 'source-artifact' } } })
  expect(layout(result).slots[0]!.groups[0]).toEqual({ id: 'input-group', mode: 'column', views: [{ type: 'existing', view_id: 'input-view' }], gap: 'large', align: 'start' })
  expect(result.bindings[0]).toMatchObject({ artifact_id: 'artifact', source_bundle_resource_id: 'source-artifact', published_bundle_resource_id: null, operation: 'create' })
  expect(JSON.stringify(result.request)).not.toContain('source-body-marker')
  expect(compilePresentation(input)).toEqual(result)
  expect(validateModel(result.request)).toEqual(result.request)
  expect(input).toEqual(before)
})

it('uses only layout.set for the exact published artifact without loading source or View bodies', () => {
  const input = published(setup()), result = compilePresentation(input)
  expect(input.sources).toEqual([])
  expect(input.views.every(view => view.bundle === undefined)).toBe(true)
  expect(result.request.input.operations.map(op => op.type)).toEqual(['layout.set'])
  expect(result.bindings).toEqual([{ artifact_id: 'artifact', artifact_revision: 1, source_bundle_resource_id: 'source-artifact', published_bundle_resource_id: 'normalized-artifact', view: { type: 'existing', view_id: 'view-artifact' }, operation: 'reuse' }])
  expect(result.request.input.operations.some(op => op.type === 'view.replace' || op.type === 'view.remove')).toBe(false)
})

it('replaces a changed artifact in its stable View using exact content and latest draft revisions', () => {
  const input = published(setup()), current = input.views.find(view => view.view_id === 'view-artifact')!
  current.bundle = body('old'); current.draft = { answer: 'saved answer' }
  const next = { ...input.indexes[0]!, artifact_revision: 2, bundle_resource_id: 'new-source' }
  input.indexes = [next]; input.plan = plan([next]); input.sources = [source(next, body('new', 'v1', 'new initial'))]
  const before = structuredClone(input), result = compilePresentation(input)
  expect(result.request.input.operations[0]).toEqual({ type: 'view.replace', view_id: 'view-artifact', expected_view_revision: 3, bundle: { type: 'resource', resource: { kind: 'resource', id: 'new-source' } }, state_transition: { type: 'preserve', expected_state_revision: 9, compatibility_version: 'v1' } })
  expect(result.bindings[0]).toMatchObject({ operation: 'replace', view: { type: 'existing', view_id: 'view-artifact' }, source_bundle_resource_id: 'new-source', published_bundle_resource_id: null })
  expect(result.request.input.operations.some(op => op.type === 'view.create' || op.type === 'view.remove')).toBe(false)
  expect(input).toEqual(before)
})

it('requires an explicit host reset selection for incompatible replacement state', () => {
  const input = published(setup()), current = input.views.find(view => view.view_id === 'view-artifact')!
  current.bundle = body('old'); current.draft = { answer: 'retain until confirmation' }
  const next = { ...input.indexes[0]!, artifact_revision: 2, bundle_resource_id: 'new-source' }
  input.indexes = [next]; input.plan = plan([next]); input.sources = [source(next, body('new', 'v2', 'reset initial'))]
  expect(() => compilePresentation(input)).toThrow('same schema and compatibility version')
  input.reset_artifact_ids = ['artifact']
  expect(compilePresentation(input).request.input.operations[0]).toMatchObject({ type: 'view.replace', state_transition: { type: 'reset', expected_state_revision: 9, initial: { answer: 'reset initial' } } })
  expect(current.draft).toEqual({ answer: 'retain until confirmation' })
})

it('moves a stable section around unselected published content while retaining every View', () => {
  const a = index('a', 'section-a', 'a'), b = index('b', 'section-b', 'b'), input = published(setup([a, b]))
  input.indexes = [a]
  input.sections.find(section => section.section_id === 'section-a')!.order_key = 'c'
  input.sections.find(section => section.section_id === 'section-a')!.position_revision = 2
  input.plan = plan([a], { intents: [{ ...plan([a]).intents[0]!, section_position_revision: 2, order_key: 'c' }] })
  const result = compilePresentation(input)
  expect(result.request.input.operations.map(op => op.type)).toEqual(['layout.set'])
  expect(layout(result).slots[0]!.groups.flatMap(group => group.views)).toEqual([{ type: 'existing', view_id: 'input-view' }, { type: 'existing', view_id: 'view-b' }, { type: 'existing', view_id: 'view-a' }])
  expect(input.indexes[0]!.order_key).toBe('a')
  expect(input.mappings.map(mapping => mapping.published_bundle_resource_id)).toEqual(['normalized-a', 'normalized-b'])
})

it('supports responsive placement for flexible fragments and preserves other group attributes', () => {
  const a = index('a', 'section', 'a', 'flexible'), b = index('b', 'section', 'a', 'flexible'), input = setup([a, b])
  input.plan = plan([a, b], { intents: plan([a, b]).intents.map(intent => ({ ...intent, layout_mode: 'responsive_columns' })) })
  const result = compilePresentation(input)
  expect(layout(result).slots[0]!.groups[1]).toMatchObject({ mode: 'responsive_columns', gap: 'medium', align: 'stretch' })
  expect(layout(result).slots[0]!.groups[1]!.views).toHaveLength(2)
})

it('retains unrelated responsive groups and their exact column weights', () => {
  const input = setup()
  input.views.push({ view_id: 'second-input', view_revision: 2, state_revision: 5, bundle_resource_id: 'second-form' })
  input.surface.layout.slots[0]!.groups[0] = { id: 'input-group', type: 'responsive_columns', views: ['input-view', 'second-input'], gap: 'small', align: 'center', column_weights: [1, 3] }
  expect(layout(compilePresentation(input)).slots[0]!.groups[0]).toEqual({ id: 'input-group', mode: 'responsive_columns', views: [{ type: 'existing', view_id: 'input-view' }, { type: 'existing', view_id: 'second-input' }], gap: 'small', align: 'center', column_weights: [1, 3] })
})

it('blocks implicit weight reassignment when adding content to a weighted section', () => {
  const a = index('a', 'section', 'a', 'flexible'), b = index('b', 'section', 'a', 'flexible'), first = setup([a])
  first.plan.intents[0]!.layout_mode = 'responsive_columns'
  const input = published(first)
  input.surface.layout.slots[0]!.groups[1]!.column_weights = [2]
  input.indexes = [b]; input.plan = plan([b]); input.plan.intents[0]!.layout_mode = 'responsive_columns'; input.sources = [source(b)]
  const before = structuredClone(input)
  expect(() => compilePresentation(input)).toThrow('Weighted groups require an explicit complete layout intent')
  expect(input).toEqual(before)
})

it.each(['feature', 'full-width', 'wrong-revision', 'wrong-section-position', 'foreign-source', 'missing-source', 'foreign-index', 'unknown-layout', 'hidden-current-view'] as const)('rejects %s without producing an action', fault => {
  const input = setup()
  if (fault === 'feature') input.features.viewReplacement = false
  else if (fault === 'full-width') input.plan.intents[0]!.layout_mode = 'responsive_columns'
  else if (fault === 'wrong-revision') input.indexes[0]!.artifact_revision = 2
  else if (fault === 'wrong-section-position') input.plan.intents[0]!.section_position_revision = 2
  else if (fault === 'foreign-source') input.sources[0]!.task_id = 'other'
  else if (fault === 'missing-source') input.sources = []
  else if (fault === 'foreign-index') input.indexes[0]!.task_id = 'other'
  else if (fault === 'unknown-layout') (input.plan.intents[0]! as { layout_mode: string }).layout_mode = 'arbitrary-grid'
  else input.surface.layout.slots[0]!.groups = []
  expect(() => compilePresentation(input)).toThrow()
})

it.each(['missing-view', 'replaced-view-content', 'changed-view-revision', 'wrong-source-id', 'older-artifact'] as const)('keeps stable mappings from taking over %s', fault => {
  const input = published(setup())
  if (fault === 'missing-view') { input.views.pop(); input.surface.layout.slots[0]!.groups.pop() }
  else if (fault === 'replaced-view-content') input.views[1]!.bundle_resource_id = 'unrelated-form'
  else if (fault === 'changed-view-revision') input.views[1]!.view_revision++
  else if (fault === 'wrong-source-id') input.mappings[0]!.source_bundle_resource_id = 'different-source'
  else input.mappings[0]!.artifact_revision = 2
  expect(() => compilePresentation(input)).toThrow(/Stable artifact mapping|exact published artifact/)
})

it('accepts the existing exact bundle capacity and rejects larger declared or serialized bodies', () => {
  const input = setup(), value = body('')
  value.html = ''
  value.html = 'x'.repeat(262144 - Buffer.byteLength(JSON.stringify(value)))
  input.sources = [source(input.indexes[0]!, value)]
  expect(input.sources[0]!.byte_length).toBe(262144)
  expect(compilePresentation(input).bindings[0]?.operation).toBe('create')
  input.sources[0]!.byte_length++
  expect(() => compilePresentation(input)).toThrow('enabled bundle capacity')
  input.sources[0]!.byte_length = 2; value.html += 'x'
  expect(() => compilePresentation(input)).toThrow('enabled bundle capacity')
})

it('blocks a fifty-first View in one section without dropping existing content', () => {
  const input = setup(), stableGroup = layout(compilePresentation(input)).slots[0]!.groups[1]!
  const existing = Array.from({ length: 50 }, (_item, position) => entry(index(`old-${position}`)))
  input.mappings = existing
  input.views.push(...existing.map(mapping => ({ view_id: mapping.view_id, view_revision: mapping.view_revision, state_revision: mapping.state_revision, bundle_resource_id: mapping.published_bundle_resource_id })))
  input.surface.layout.slots[0]!.groups.push({ id: stableGroup.id, type: 'column', views: existing.map(mapping => mapping.view_id) })
  const before = structuredClone(input)
  expect(() => compilePresentation(input)).toThrow('fifty-View group capacity')
  expect(input).toEqual(before)
})

it('keeps deterministic host identifiers within the existing action schema for UTF-8 IDs', () => {
  const input = setup([{ ...index('你'.repeat(42), '节'.repeat(42)), bundle_resource_id: 'short-resource-id' }]), result = compilePresentation(input)
  expect(validateModel(result.request)).toEqual(result.request)
  expect(result).toEqual(compilePresentation(input))
})

it('does not expose rejected bundle text in compiler errors', () => {
  const input = setup()
  input.sources[0]!.bundle = { ...body(), unsupported: 'private-rejected-body-marker' } as Bundle
  expect(() => compilePresentation(input)).toThrow('not a supported bundle')
  try { compilePresentation(input) } catch (error) { expect(String(error)).not.toContain('private-rejected-body-marker') }
})
