import { describe, expect, it } from 'vitest'
import { validateIpc } from '../../src/shared/validation'
import { dependencyKey, sameDependencies, validateRunnerContract } from '../../src/shared/runner-validation'
import { chapterManifest, chapterProposal, chapterPublication, chapterRegion, chapterSource, chapterUpdate } from '../helpers/chapters'

describe('chapter identity contracts', () => {
  it('retains separate chapter, update, proposal, inheritance and publication bindings', () => {
    const manifest = chapterManifest(), update = chapterUpdate()
    expect(validateRunnerContract('runner_chapter_manifest', manifest)).toEqual(manifest)
    expect(validateRunnerContract('runner_chapter_update', update)).toEqual(update)
    expect(validateRunnerContract('runner_chapter_proposal', chapterProposal())).toEqual(chapterProposal())
    expect(validateRunnerContract('runner_chapter_publication', chapterPublication())).toEqual(chapterPublication())
    expect(validateRunnerContract('runner_execution_scope', chapterSource()).purpose).toBe('production')
    expect(validateRunnerContract('runner_chapter_inheritance', { task_id: 'task', update_id: update.update_id, view_id: 'view', region_id: 'b', region_revision: 1, source_bundle_resource_id: 'original', source_manifest_revision: 1, request_id: 'goal', intent_revision: 1, requirement_ids: ['content'], dependencies: [], valid: true }).region_id).toBe('b')
  })
  it('rejects unknown fields, duplicate identities and mismatched update scope', () => {
    expect(() => validateRunnerContract('runner_chapter_manifest', { ...chapterManifest(), section_id: 'outline-only' })).toThrow()
    expect(() => validateRunnerContract('runner_chapter_manifest', { ...chapterManifest(), chapters: [chapterRegion('a'), chapterRegion('a')] })).toThrow()
    expect(() => validateRunnerContract('runner_chapter_region', { ...chapterRegion('a'), body_selector: '#a-title' })).toThrow()
    expect(() => validateRunnerContract('runner_chapter_update', { ...chapterUpdate(), region_intents: [{ region_id: 'b', intent_revision: 1 }] })).toThrow()
    expect(() => validateRunnerContract('runner_chapter_proposal', { ...chapterProposal(), source: { ...chapterSource(), update_id: 'other' } })).toThrow()
    expect(() => validateRunnerContract('runner_chapter_update', { ...chapterUpdate(), source: { ...chapterSource(), request_id: 'other' } })).toThrow()
  })
  it('rejects reused ownership across chapters and cross-task dependency claims', () => {
    const first = chapterRegion('a'), second = chapterRegion('b')
    first.ownership.behavior_ids = ['shared-control']; second.ownership.behavior_ids = ['shared-control']
    expect(() => validateRunnerContract('runner_chapter_manifest', { ...chapterManifest(), chapters: [first, second] })).toThrow()
    expect(() => validateRunnerContract('runner_chapter_update', { ...chapterUpdate(), dependencies: [{ kind: 'chapter', task_id: 'other', view_id: 'view', revision: 1 }] })).toThrow()
  })
  it('distinguishes exact shared and chapter dependencies without using the container revision', () => {
    const a = { kind: 'chapter' as const, task_id: 'task', view_id: 'view', region_id: 'a', revision: 2 }
    const b = { kind: 'chapter' as const, task_id: 'task', view_id: 'view', region_id: 'b', revision: 2 }
    const shared = { kind: 'chapter' as const, task_id: 'task', view_id: 'view', revision: 2 }
    expect(new Set([a, b, shared].map(dependencyKey)).size).toBe(3)
    expect(sameDependencies([a, shared], [shared, a])).toBe(true)
    expect(sameDependencies([a], [{ ...a, revision: 3 }])).toBe(false)
  })
  it('requires precise IPC source versions and a nonempty chapter selection', () => {
    const input = { type: 'chapter.update', task_id: 'task', input_event_id: 'input', update_id: 'update', view_id: 'view', view_revision: 1, state_revision: 1, region_ids: ['a'], text: 'Revise', model_config_id: 'model' }
    expect(validateIpc(input)).toEqual(input)
    expect(validateIpc({ ...input, source_request_id: 'clarification-request' })).toEqual({ ...input, source_request_id: 'clarification-request' })
    expect(validateIpc({ type: 'chapters.map', task_id: 'task', view_id: 'view', expected_view_revision: 1 }).type).toBe('chapters.map')
    expect(validateIpc({ type: 'chapter.cancel', task_id: 'task', update_id: 'update' }).type).toBe('chapter.cancel')
    expect(validateIpc({ type: 'chapter.status', task_id: 'task', update_id: 'update' }).type).toBe('chapter.status')
    expect(() => validateIpc({ ...input, region_ids: [] })).toThrow()
    expect(() => validateIpc({ ...input, ignored_version: true })).toThrow()
    expect(() => validateIpc({ ...input, source_request_id: '' })).toThrow()
    expect(() => validateIpc({ ...input, source_request_id: 1 })).toThrow()
  })
  it('binds a published view to one composition or chapter operation source', () => {
    const entry = { task_id: 'task', request_id: 'goal', intent_revision: 1, artifact_id: 'artifact', artifact_revision: 1, section_id: 'section', source_bundle_resource_id: 'source', published_bundle_resource_id: 'published', view_id: 'view', view_revision: 1, state_revision: 1, surface_history_id: 'history' }
    expect(validateRunnerContract('runner_publication_entry', { ...entry, batch_id: 'batch' }).batch_id).toBe('batch')
    expect(validateRunnerContract('runner_publication_entry', { ...entry, chapter_update_id: 'update', chapter_operation_id: 'operation' }).chapter_operation_id).toBe('operation')
    for (const source of [{}, { chapter_update_id: 'update' }, { chapter_operation_id: 'operation' }, { batch_id: 'batch', chapter_update_id: 'update', chapter_operation_id: 'operation' }]) {
      expect(() => validateRunnerContract('runner_publication_entry', { ...entry, ...source })).toThrow()
    }
  })
})
