import { describe, expect, test } from 'vitest'
import type { ChapterManifest } from '../../src/shared/contracts.generated'
import type { Completion } from '../../src/runtime/model/adapter'
import { createChapterRouterProfile, validateChapterRoute } from '../../src/runtime/runner/chapter-router'

function directory(): ChapterManifest[] {
  const chapter = (name: string, title: string) => ({ region_id: name, revision: 1, title, title_selector: '#secret-title-' + name, body_selector: '#secret-body-' + name, dependencies: [], ownership: { form_ids: [], behavior_ids: [], reference_ids: [], export_ids: [], css_selectors: [] } })
  return [{ task_id: 'task', view_id: 'view-a', view_revision: 2, state_revision: 3, bundle_resource_id: 'private-resource', manifest_revision: 4, shared_revision: 1, request_id: 'request', intent_revision: 1, chapters: [chapter('a', 'Shared title'), chapter('b', 'Another chapter')] }, { task_id: 'task', view_id: 'view-b', view_revision: 1, state_revision: 1, bundle_resource_id: 'another-private-resource', manifest_revision: 1, shared_revision: 1, request_id: 'another-request', intent_revision: 1, chapters: [chapter('c', 'Shared title')] }]
}
const completion = (result: unknown): Completion => ({ text: JSON.stringify(result), calls: [], finish: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 } })

describe('chapter semantic route boundary', () => {
  test('provides the whole stable directory without body, resource or read tools', () => {
    const input = directory(), profile = createChapterRouterProfile(input)
    expect(profile.tools).toEqual([])
    for (const chapter of input.flatMap(manifest => manifest.chapters)) expect(profile.system).toContain(JSON.stringify(chapter.region_id))
    expect(profile.system).toContain('view-b')
    expect(profile.system).toContain('Shared title')
    expect(profile.system).not.toContain('secret-body')
    expect(profile.system).not.toContain('private-resource')
    expect(() => profile.authorize({ type: 'read', input: { target: { kind: 'resource', id: 'private-resource' }, section: 'body' } })).toThrow(expect.objectContaining({ code: 'WORKER_CAPABILITY_DENIED' }))
  })

  test('accepts exact chapter sets and keeps queries and explanations read only', () => {
    const profile = createChapterRouterProfile(directory())
    for (const kind of ['update', 'query', 'explanation'] as const) {
      const route = { kind, view_id: 'view-a', region_ids: ['a', 'b'] }
      expect(profile.parseResult(completion(route))).toEqual(route)
    }
    for (const kind of ['query', 'explanation', 'ambiguous', 'new'] as const) expect(profile.parseResult(completion({ kind }))).toEqual({ kind })
  })

  test('rejects guessed, mixed, duplicated or incomplete scopes and extra authority', () => {
    const profile = createChapterRouterProfile(directory())
    for (const result of [
      { kind: 'update' }, { kind: 'update', view_id: 'view-a', region_ids: [] },
      { kind: 'update', view_id: 'view-a', region_ids: ['Shared title'] },
      { kind: 'update', view_id: 'view-a', region_ids: ['a', 'c'] },
      { kind: 'update', view_id: 'view-a', region_ids: ['a', 'a'] },
      { kind: 'update', view_id: 'missing', region_ids: ['a'] },
      { kind: 'query', view_id: 'view-a' }, { kind: 'ambiguous', view_id: 'view-a', region_ids: ['a'] },
      { kind: 'new', region_ids: ['a'] }, { kind: 'update', view_id: 'view-a', region_ids: ['a'], allow_read: true }
    ]) expect(() => profile.parseResult(completion(result))).toThrow(expect.objectContaining({ code: 'INVALID_WORKER_RESULT' }))
  })

  test('freezes candidates and rechecks live chapter identities before routing', () => {
    const input = directory(), profile = createChapterRouterProfile(input)
    input[0]!.chapters[0]!.region_id = 'replacement'
    const route = { kind: 'update', view_id: 'view-a', region_ids: ['a'] }
    expect(profile.parseResult(completion(route))).toEqual(route)
    expect(() => validateChapterRoute(route, input)).toThrow(expect.objectContaining({ code: 'INVALID_WORKER_RESULT' }))
    expect(() => profile.parseResult(completion({ ...route, region_ids: ['replacement'] }))).toThrow(expect.objectContaining({ code: 'INVALID_WORKER_RESULT' }))
  })

  test('unfinished responses and tool calls never install a guessed route', () => {
    const profile = createChapterRouterProfile(directory()), result = completion({ kind: 'query' })
    expect(() => profile.parseResult({ ...result, finish: 'tool_calls' })).toThrow()
    expect(() => profile.parseResult({ ...result, calls: [{ id: 'read', type: 'function', function: { name: 'read', arguments: '{}' } }] })).toThrow()
    expect(() => profile.parseResult({ ...result, text: '```json\n{"kind":"update"}\n```' })).toThrow()
  })
})
