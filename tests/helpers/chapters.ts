import type { Bundle, ChapterManifest, ChapterProposal, ChapterPublication, ChapterRegion, ChapterUpdate, ExecutionScope } from '../../src/shared/contracts.generated'

export function chapterRegion(id: string, revision = 1): ChapterRegion {
  return { region_id: id, revision, title: id.toUpperCase(), title_selector: `#${id}-title`, body_selector: `#${id}-body`, dependencies: [], ownership: { form_ids: [], behavior_ids: [], reference_ids: [], export_ids: [], css_selectors: [] } }
}
export function chapterManifest(): ChapterManifest {
  return { task_id: 'task', view_id: 'view', view_revision: 1, state_revision: 1, bundle_resource_id: 'original', manifest_revision: 1, shared_revision: 1, request_id: 'goal', intent_revision: 1, chapters: [chapterRegion('a'), chapterRegion('b')] }
}
export function chapterUpdate(id = 'update-a', regions = ['a'], manifest = chapterManifest()): ChapterUpdate {
  return { task_id: 'task', update_id: id, input_event_id: `input-${id}`, record_id: 'record', request_id: 'goal', intent_revision: 1, view_id: 'view', base_manifest: manifest, region_ids: regions, region_intents: regions.map(region_id => ({ region_id, intent_revision: 1 })), dependencies: [{ kind: 'chapter', task_id: 'task', view_id: 'view', revision: 1 }], state: 'queued', text: 'Revise the selected chapter', model_config_id: 'model', previous_update_ids: [] }
}
export function chapterSource(update = chapterUpdate()): ExecutionScope {
  return { task_id: 'task', run_id: 'run', work_id: 'work', attempt_id: 'attempt', role: 'producer', purpose: 'production', request_id: 'goal', intent_revision: 1, update_id: update.update_id }
}
export function chapterProposal(update = chapterUpdate()): ChapterProposal {
  return { task_id: 'task', update_id: update.update_id, proposal_id: `proposal-${update.update_id}`, intent_revision: 1, bundle_resource_id: 'candidate', replacements: [{ previous_region_ids: update.region_ids, chapters: update.region_ids.map(id => chapterRegion(id, 2)) }], dependencies: update.dependencies, source: chapterSource(update) }
}
export function chapterBundle(): Bundle {
  return { profile: 'managed-v1', html: '<h2 id="a-title">A</h2><div id="a-body">New A</div><h2 id="b-title">B</h2><div id="b-body">Old B</div>', css: '', state: { compatibility_version: 'v1', schema: { type: 'object', properties: {}, additionalProperties: false }, initial: {} }, forms: [], behaviors: [], references: [], export: [] }
}
export function chapterPublication(update = chapterUpdate()): ChapterPublication {
  return { task_id: 'task', operation_id: 'publication', update_id: update.update_id, proposal_id: `proposal-${update.update_id}`, base_manifest_revision: 1, assembled_bundle_resource_id: 'assembled', view_id: 'view', expected_view_revision: 1, expected_state_revision: 1, request: { type: 'write', input: { type: 'surface.update', surface_id: 'surface', expected_revision: 1, operations: [{ type: 'view.replace', view_id: 'view', expected_view_revision: 1, bundle: { type: 'inline', bundle: chapterBundle() }, state_transition: { type: 'preserve', expected_state_revision: 1, compatibility_version: 'v1' } }] } }, source_bundle_resource_ids: ['original', 'candidate'], state: 'registered' }
}
