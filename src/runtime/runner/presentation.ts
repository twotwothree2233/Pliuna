import type { ArtifactIndex, Bundle, ModelRequest, ModelRequestViewLocator, OutlineSection, PresentationPlan, PublicationEntry } from '../../shared/contracts.generated'
import defaults from '../../shared/contracts/development-defaults.json'
import { validateRunnerContract } from '../../shared/runner-validation'
import { assertContract, ContractError, validateBundle } from '../../shared/validation'
import { replacementDraft } from '../surface-transition'

export type PresentationSurfaceWrite = { type: 'write'; input: Extract<Extract<ModelRequest, { type: 'write' }>['input'], { type: 'surface.update' }> }
type LayoutMode = 'column' | 'responsive_columns'
type Gap = 'none' | 'small' | 'medium' | 'large'
type Align = 'start' | 'center' | 'stretch'
export interface PresentationLayoutGroup { id: string; type: LayoutMode; views: string[]; gap?: Gap; align?: Align; column_weights?: number[] }
export interface PresentationSurface {
  task_id: string
  surface_id: string
  revision: number
  layout: { slots: { id: string; groups: PresentationLayoutGroup[] }[] }
}
export interface PresentationView {
  view_id: string
  view_revision: number
  state_revision: number
  bundle_resource_id: string
  // Only replacements need body/state data. A placement-only compilation does
  // not require the host to load any source or current View body.
  bundle?: Bundle
  draft?: Record<string, unknown>
}
export interface PresentationSource { task_id: string; resource_id: string; byte_length: number; bundle: Bundle }
export interface PresentationCompileInput {
  plan: PresentationPlan
  indexes: ArtifactIndex[]
  sections: OutlineSection[]
  surface: PresentationSurface
  views: PresentationView[]
  mappings: PublicationEntry[]
  sources: PresentationSource[]
  features: { viewReplacement: boolean }
  reset_artifact_ids?: string[]
}
export interface PresentationBinding {
  artifact_id: string
  artifact_revision: number
  source_bundle_resource_id: string
  // Creates/replacements receive their normalized published resource only
  // after the Store prepares and commits the existing Surface operation.
  published_bundle_resource_id: string | null
  view: ModelRequestViewLocator
  operation: 'reuse' | 'create' | 'replace'
}
export interface CompiledPresentation { request: PresentationSurfaceWrite; bindings: PresentationBinding[] }
type Group = { id: string; mode: LayoutMode; views: ModelRequestViewLocator[]; gap: Gap; align: Align; column_weights?: number[] }

function fail(code: string, message: string): never { throw new ContractError(code, message) }
function distinct(values: string[], name: string): void { if (new Set(values).size !== values.length) fail('RUNNER_PRESENTATION_CONFLICT', `Duplicate ${name}`) }
function revision(value: number): void { if (!Number.isSafeInteger(value) || value < 1) fail('RUNNER_PRESENTATION_CONFLICT', 'Presentation requires exact positive Surface, View and state revisions') }
function stable(prefix: string, identity: string): string { return prefix + Buffer.from(identity, 'utf8').toString('base64url') }
function groupId(sectionId: string): string { return stable('runner-section-', sectionId) }
function locatorKey(locator: ModelRequestViewLocator): string { return locator.type === 'existing' ? `view:${locator.view_id}` : `created:${locator.client_ref}` }
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
function bundle(source: PresentationSource, taskId: string): Bundle {
  if (source.task_id !== taskId) fail('RUNNER_OWNERSHIP_INVALID', 'Presentation source must belong to this Task')
  if (!Number.isSafeInteger(source.byte_length) || source.byte_length < 0 || source.byte_length > defaults.surface.inline_bundle_bytes) fail('BUNDLE_SIZE_LIMIT', 'Presentation source exceeds the enabled bundle capacity')
  try {
    const value = validateBundle(source.bundle)
    if (Buffer.byteLength(JSON.stringify(value)) > defaults.surface.inline_bundle_bytes) fail('BUNDLE_SIZE_LIMIT', 'Presentation source exceeds the enabled bundle capacity')
    return value
  } catch (error) {
    if (error instanceof ContractError && error.code === 'BUNDLE_SIZE_LIMIT') throw error
    return fail('INVALID_BUNDLE_SOURCE', 'Presentation source is not a supported bundle')
  }
}
function checkedWrite(value: unknown): PresentationSurfaceWrite {
  try { assertContract<PresentationSurfaceWrite>('model_request', value) } catch { fail('INVALID_LAYOUT', 'Presentation cannot be expressed by the enabled Surface contract') }
  return value
}

// Pure host compilation. The Store owns resource loading/normalization,
// authorization, host confirmation and the final atomic version recheck.
export function compilePresentation(input: PresentationCompileInput): CompiledPresentation {
  const plan = validateRunnerContract('runner_presentation_plan', input.plan)
  if (!input.features.viewReplacement) fail('CAPABILITY_DISABLED', 'Surface update is disabled by the current capability gate')
  if (!plan.intents.length) fail('RUNNER_PRESENTATION_EMPTY', 'Presentation requires at least one accepted artifact')
  if (input.surface.task_id !== plan.task_id) fail('RUNNER_OWNERSHIP_INVALID', 'Presentation Surface belongs to another Task')
  revision(input.surface.revision)
  distinct(plan.intents.map(intent => intent.artifact.artifact_id), 'presentation artifacts')
  distinct(input.views.map(view => view.view_id), 'current Views')
  const indexes = input.indexes.map(index => validateRunnerContract('runner_artifact_index', index))
  const sections = input.sections.map(section => validateRunnerContract('runner_outline_section', section))
  const mappings = input.mappings.map(mapping => validateRunnerContract('runner_publication_entry', mapping))
  if (indexes.some(index => index.task_id !== plan.task_id) || mappings.some(mapping => mapping.task_id !== plan.task_id)) fail('RUNNER_OWNERSHIP_INVALID', 'Presentation metadata belongs to another Task')
  distinct(indexes.map(index => `${index.artifact_id}:${index.artifact_revision}`), 'accepted artifact versions')
  distinct(sections.map(section => section.section_id), 'outline sections')
  distinct(mappings.map(mapping => mapping.artifact_id), 'stable artifact mappings')
  distinct(mappings.map(mapping => mapping.view_id), 'mapped Views')
  distinct(input.sources.map(source => source.resource_id), 'source resources')
  const reset = new Set(input.reset_artifact_ids ?? [])
  distinct(input.reset_artifact_ids ?? [], 'reset artifacts')
  if ([...reset].some(artifactId => !plan.intents.some(intent => intent.artifact.artifact_id === artifactId))) fail('RUNNER_PRESENTATION_CONFLICT', 'State reset must name a selected artifact')
  const views = new Map(input.views.map(view => { revision(view.view_revision); revision(view.state_revision); return [view.view_id, view] }))
  const sectionMap = new Map(sections.map(section => [section.section_id, section]))
  const mappingViews = new Map(mappings.map(mapping => [mapping.view_id, mapping]))
  const layout = input.surface.layout
  if (layout.slots.length !== 1 || layout.slots[0]!.id !== 'main') fail('INVALID_LAYOUT', 'Only the enabled main slot can be compiled')
  const current = layout.slots[0]!.groups
  distinct(current.map(group => group.id), 'layout groups')
  const currentIds = current.flatMap(group => group.views)
  distinct(currentIds, 'layout Views')
  if (currentIds.length !== views.size || currentIds.some(viewId => !views.has(viewId))) fail('INVALID_LAYOUT', 'Current layout must enumerate every current View exactly once')
  for (const group of current) {
    if (group.views.length > 50 || !['column', 'responsive_columns'].includes(group.type) || group.column_weights && (group.type !== 'responsive_columns' || group.column_weights.length !== group.views.length)) fail('INVALID_LAYOUT', 'Current group exceeds the supported layout constraints')
  }
  const operations: unknown[] = [], bindings: PresentationBinding[] = []
  const selected = new Set<string>(), placements = new Map<string, { mode: LayoutMode; locators: ModelRequestViewLocator[] }>()
  for (const intent of plan.intents) {
    const reference = intent.artifact
    const index = indexes.find(index => index.task_id === reference.task_id && index.artifact_id === reference.artifact_id && index.artifact_revision === reference.artifact_revision)
    const section = sectionMap.get(intent.section_id)
    if (reference.task_id !== plan.task_id || !index || !section || index.section_id !== intent.section_id || index.request_id !== section.request_id || index.intent_revision !== section.intent_revision || index.width_constraint !== intent.width_constraint || section.position_revision !== intent.section_position_revision || section.order_key !== intent.order_key) fail('RUNNER_OWNERSHIP_INVALID', 'Presentation must retain its exact accepted artifact and current section position')
    if (intent.slot_id !== 'main' || intent.width_constraint === 'full' && intent.layout_mode !== 'column') fail('INVALID_LAYOUT', 'Presentation width or slot is unsupported')
    const placement = placements.get(intent.section_id) ?? { mode: intent.layout_mode, locators: [] }
    if (placement.mode !== intent.layout_mode) fail('INVALID_LAYOUT', 'One section cannot request conflicting layout modes')
    placements.set(intent.section_id, placement)
    const mapping = mappings.find(mapping => mapping.artifact_id === index.artifact_id)
    let view: ModelRequestViewLocator, operation: PresentationBinding['operation'], published: string | null = null
    if (mapping) {
      const currentView = views.get(mapping.view_id)
      if (!currentView || mapping.section_id !== index.section_id || mapping.request_id !== index.request_id || mapping.artifact_revision > index.artifact_revision || currentView.view_revision !== mapping.view_revision || currentView.bundle_resource_id !== mapping.published_bundle_resource_id) fail('RUNNER_PRESENTATION_CONFLICT', 'Stable artifact mapping no longer identifies its current View content')
      view = { type: 'existing', view_id: currentView.view_id }; selected.add(currentView.view_id)
      if (mapping.artifact_revision === index.artifact_revision) {
        if (mapping.source_bundle_resource_id !== index.bundle_resource_id || mapping.intent_revision !== index.intent_revision || reset.has(index.artifact_id)) fail('RUNNER_PRESENTATION_CONFLICT', 'Placement-only reuse must retain the exact published artifact')
        operation = 'reuse'; published = currentView.bundle_resource_id
      } else {
        const source = input.sources.find(source => source.resource_id === index.bundle_resource_id)
        if (!source || !currentView.bundle || !currentView.draft) fail('RUNNER_PRESENTATION_INPUT_INVALID', 'Content replacement requires its exact source and current View state')
        const next = bundle(source, plan.task_id)
        const transition = reset.has(index.artifact_id)
          ? { type: 'reset' as const, expected_state_revision: currentView.state_revision, initial: structuredClone(next.state.initial) }
          : { type: 'preserve' as const, expected_state_revision: currentView.state_revision, compatibility_version: currentView.bundle.state.compatibility_version }
        replacementDraft(currentView.bundle, next, currentView.draft, transition)
        operations.push({ type: 'view.replace', view_id: currentView.view_id, expected_view_revision: currentView.view_revision, bundle: { type: 'resource', resource: { kind: 'resource', id: index.bundle_resource_id } }, state_transition: transition })
        operation = 'replace'
      }
    } else {
      if (reset.has(index.artifact_id)) fail('RUNNER_PRESENTATION_CONFLICT', 'New Views do not require a replacement state reset')
      const source = input.sources.find(source => source.resource_id === index.bundle_resource_id)
      if (!source) fail('RUNNER_PRESENTATION_INPUT_INVALID', 'Content creation requires its exact accepted source resource')
      bundle(source, plan.task_id)
      view = { type: 'created', client_ref: stable('runner-artifact-', index.artifact_id) }
      operations.push({ type: 'view.create', client_ref: view.client_ref, slot_id: 'main', bundle: { type: 'resource', resource: { kind: 'resource', id: index.bundle_resource_id } } })
      operation = 'create'
    }
    placement.locators.push(view)
    bindings.push({ artifact_id: index.artifact_id, artifact_revision: index.artifact_revision, source_bundle_resource_id: index.bundle_resource_id, published_bundle_resource_id: published, view, operation })
  }
  const groups = new Map<string, Group>(), managed = new Map<string, string>()
  for (const old of current) {
    const remaining = old.views.filter(viewId => !selected.has(viewId))
    const group: Group = { id: old.id, mode: old.type, views: remaining.map(view_id => ({ type: 'existing', view_id })), gap: old.gap ?? 'medium', align: old.align ?? 'stretch', ...(old.column_weights ? { column_weights: old.column_weights.filter((_weight, position) => !selected.has(old.views[position]!)) } : {}) }
    if (remaining.length) groups.set(old.id, group)
    const section = sections.find(section => groupId(section.section_id) === old.id)
    if (section && old.views.every(viewId => mappingViews.get(viewId)?.section_id === section.section_id)) managed.set(old.id, section.section_id)
  }
  for (const [sectionId, placement] of placements) {
    const id = groupId(sectionId), old = current.find(group => group.id === id), remaining = groups.get(id)
    if (old && !managed.has(id)) fail('RUNNER_PRESENTATION_CONFLICT', 'Stable section group is occupied by unrelated Views')
    if (remaining && remaining.mode !== placement.mode) fail('INVALID_LAYOUT', 'Local placement cannot change the layout mode of unselected Views')
    const wanted = new Map(placement.locators.map(locator => [locatorKey(locator), locator]))
    const ordered: ModelRequestViewLocator[] = []
    for (const viewId of old?.views ?? []) {
      const locator = wanted.get(`view:${viewId}`)
      if (locator) { ordered.push(locator); wanted.delete(`view:${viewId}`) }
      else if (!selected.has(viewId)) ordered.push({ type: 'existing', view_id: viewId })
    }
    ordered.push(...wanted.values())
    if (old?.column_weights && (ordered.length !== old.views.length || ordered.some((locator, position) => locator.type !== 'existing' || locator.view_id !== old.views[position]))) fail('INVALID_LAYOUT', 'Weighted groups require an explicit complete layout intent before adding or moving Views')
    groups.set(id, { id, mode: placement.mode, views: ordered, gap: old?.gap ?? 'medium', align: old?.align ?? 'stretch', ...(old?.column_weights ? { column_weights: [...old.column_weights] } : {}) })
    managed.set(id, sectionId)
  }
  const sorted = [...managed.keys()].filter(id => groups.has(id)).sort((left, right) => {
    const a = sectionMap.get(managed.get(left)!)!, b = sectionMap.get(managed.get(right)!)!
    return compare(a.order_key, b.order_key) || compare(a.section_id, b.section_id)
  })
  const final: Group[] = []
  let offset = 0
  for (const old of current) {
    if (managed.has(old.id)) { if (offset < sorted.length) final.push(groups.get(sorted[offset++]!)!) }
    else if (groups.has(old.id)) final.push(groups.get(old.id)!)
  }
  while (offset < sorted.length) final.push(groups.get(sorted[offset++]!)!)
  if (final.some(group => group.views.length > 50)) fail('SURFACE_LAYOUT_LIMIT', 'Presentation exceeds the enabled fifty-View group capacity')
  const finalLocators = final.flatMap(group => group.views)
  distinct(finalLocators.map(locatorKey), 'remaining View locators')
  const existing = finalLocators.flatMap(locator => locator.type === 'existing' ? [locator.view_id] : [])
  if (existing.length !== views.size || existing.some(viewId => !views.has(viewId))) fail('INVALID_LAYOUT', 'Presentation must retain every current View exactly once')
  operations.push({ type: 'layout.set', layout: { slots: [{ slot_id: 'main', groups: final }] } })
  if (operations.length > 100) fail('SURFACE_OPERATION_LIMIT', 'Presentation exceeds the enabled Surface operation capacity')
  const request = checkedWrite({ type: 'write', input: { type: 'surface.update', surface_id: input.surface.surface_id, expected_revision: input.surface.revision, operations } })
  return { request, bindings }
}
