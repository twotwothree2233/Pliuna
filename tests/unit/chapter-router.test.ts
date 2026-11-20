import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ChapterManifest } from '../../src/shared/contracts.generated'
import type { ChatMessage, Completion } from '../../src/runtime/model/adapter'
import { runAgent, type AgentHost } from '../../src/runtime/model/agent'
import { ModelService, type ModelLease } from '../../src/runtime/model/service'
import { createChapterRouterProfile, validateChapterRoute, type ChapterRoute } from '../../src/runtime/runner/chapter-router'
import { contentTree } from '../helpers/content-tree'

afterEach(() => vi.restoreAllMocks())

function directory(): ChapterManifest[] {
  const chapter = (name: string, title: string) => ({ region_id: name, revision: 1, title, title_selector: '#secret-title-' + name, body_selector: '#secret-body-' + name, dependencies: [], ownership: { form_ids: [], behavior_ids: [], reference_ids: [], export_ids: [], css_selectors: [] } })
  return [{ task_id: 'task', view_id: 'view-a', view_revision: 2, state_revision: 3, bundle_resource_id: 'private-resource', manifest_revision: 4, shared_revision: 1, request_id: 'request', intent_revision: 1, chapters: [chapter('a', 'Shared title'), chapter('b', 'Another chapter')] }, { task_id: 'task', view_id: 'view-b', view_revision: 1, state_revision: 1, bundle_resource_id: 'another-private-resource', manifest_revision: 1, shared_revision: 1, request_id: 'another-request', intent_revision: 1, chapters: [chapter('c', 'Shared title')] }]
}
const completion = (result: unknown): Completion => ({ text: JSON.stringify(result), calls: [], finish: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 } })

function routerExecution(manifests: ChapterManifest[], responses: Completion[]) {
  const profile = createChapterRouterProfile(manifests), service = new ModelService()
  const lease: ModelLease = { id: 'router', revision: 1, config: { id: 'router', base_url: 'https://example.invalid', wire_model_id: 'fixture', context_tokens: 1000000, compatibility_profile: 'chat-max-tokens' }, release() {} }
  const initial: ChatMessage[] = [{ role: 'user', content: 'Preserve the document requirements.' }, { role: 'assistant', content: 'The document is available.' }, { role: 'user', content: 'Combine the adjacent blocks.' }]
  const sent: ChatMessage[][] = [], installRoute = vi.fn<(route: ChapterRoute) => void>(), record = vi.fn(), tool = vi.fn<AgentHost['tool']>()
  const request = vi.spyOn(service, 'request').mockImplementation(async (_lease, _task, messages) => {
    expect(installRoute).not.toHaveBeenCalled()
    sent.push(structuredClone(messages))
    const response = responses.shift()
    if (!response) throw Error('Unexpected model request')
    return response
  })
  const host: AgentHost = { valid() {}, state() {}, budget() {}, record, tool }
  const execute = () => runAgent(service, lease, 'task', initial, host, new AbortController().signal, undefined, { profile, onResult: installRoute })
  return { execute, profile, initial, sent, installRoute, record, request, tool }
}

describe('chapter semantic route boundary', () => {
  test('provides legacy metadata and grants only bounded structure navigation', () => {
    const input = directory(), profile = createChapterRouterProfile(input)
    expect(profile.tools.map(tool => tool.function.name)).toEqual(['list', 'read'])
    expect(() => profile.authorize({ type: 'read', input: { target: { kind: 'content_tree', id: 'view-a' } } })).not.toThrow()
    expect(() => profile.authorize({ type: 'read', input: { target: { kind: 'content_node', id: 'a' } } })).toThrow(expect.objectContaining({ code: 'WORKER_CAPABILITY_DENIED' }))
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
    for (const kind of ['update', 'query', 'explanation'] as const) {
      const route = { kind, view_id: 'view-a' }
      expect(profile.parseResult(completion(route))).toEqual(route)
    }
  })

  test('passes an entire replacement group without adding body-generation authority', () => {
    const manifest = { ...directory()[0]!, content_tree: contentTree() }, profile = createChapterRouterProfile([manifest])
    const operation = { type: 'replace', node_ids: ['node-a', 'node-b'] }
    const route = { kind: 'update', view_id: manifest.view_id, region_ids: operation.node_ids, tree_operations: [operation] }
    expect(profile.parseResult(completion(route))).toEqual(route)
    expect(() => profile.parseResult(completion({ ...route, tree_operations: [{ ...operation, html: '<p>Combined</p>' }] }))).toThrow(expect.objectContaining({ code: 'INVALID_WORKER_RESULT' }))
    expect(() => profile.authorize({ type: 'read', input: { target: { kind: 'content_node', id: 'node-a' } } })).toThrow(expect.objectContaining({ code: 'WORKER_CAPABILITY_DENIED' }))
    expect(() => profile.authorize({ type: 'call', input: { capability: 'builtin:content-operations:v1', arguments: { operations: [] }, references: [] } })).toThrow(expect.objectContaining({ code: 'WORKER_CAPABILITY_DENIED' }))
  })

  test.each([
    ['undeclared operation', { type: 'merge', node_ids: ['node-a', 'node-b'], parent_id: 'document' }],
    ['undeclared fields', { type: 'replace', node_ids: ['node-a', 'node-b'], parent_id: 'document' }],
    ['missing operation fields', { type: 'insert', parent_id: 'document' }]
  ])('corrects %s in the same conversation before installing a route', async (_label, operation) => {
    const manifest = { ...directory()[0]!, content_tree: contentTree() }
    const route = { kind: 'update', view_id: manifest.view_id, region_ids: ['node-a', 'node-b'], tree_operations: [{ type: 'replace', node_ids: ['node-a', 'node-b'] }] }
    const rejected = { ...route, tree_operations: [operation] }
    const s = routerExecution([manifest], [completion(rejected), completion(route)])

    await expect(s.execute()).resolves.toBeUndefined()

    expect(s.installRoute).toHaveBeenCalledExactlyOnceWith(route)
    expect(s.sent).toHaveLength(2)
    expect(s.sent[1]!.slice(1)).toEqual([...s.initial, { role: 'assistant', content: JSON.stringify(rejected) }])
    expect(s.sent[1]![0]!.content).toBe(s.profile.system + '\n\n' + s.profile.resultCorrection)
    expect(s.record).toHaveBeenCalledWith('worker.result.rejected', { code: 'INVALID_WORKER_RESULT' })
    expect(s.tool).not.toHaveBeenCalled()
  })

  test('stops a repeated invalid route without installing any plan', async () => {
    const manifest = { ...directory()[0]!, content_tree: contentTree() }
    const operation = { type: 'merge', node_ids: ['node-a', 'node-b'], parent_id: 'document' }
    const route = { kind: 'update', view_id: manifest.view_id, region_ids: ['node-a', 'node-b'], tree_operations: [operation] }
    const repeated = { tree_operations: [operation], region_ids: route.region_ids, view_id: route.view_id, kind: route.kind }
    const s = routerExecution([manifest], [completion(route), completion(repeated)])

    await expect(s.execute()).rejects.toMatchObject({ code: 'INVALID_WORKER_RESULT' })

    expect(s.request).toHaveBeenCalledTimes(2)
    expect(s.installRoute).not.toHaveBeenCalled()
    expect(s.record.mock.calls.filter(([kind]) => kind === 'worker.result.rejected')).toHaveLength(1)
    expect(s.tool).not.toHaveBeenCalled()
  })

  test('rejects guessed, mixed, duplicated or incomplete scopes and extra authority', () => {
    const profile = createChapterRouterProfile(directory())
    for (const result of [
      { kind: 'update' }, { kind: 'update', view_id: 'view-a', region_ids: [] },
      { kind: 'update', view_id: 'view-a', region_ids: ['Shared title'] },
      { kind: 'update', view_id: 'view-a', region_ids: ['a', 'c'] },
      { kind: 'update', view_id: 'view-a', region_ids: ['a', 'a'] },
      { kind: 'update', view_id: 'missing', region_ids: ['a'] },
      { kind: 'update', region_ids: ['a'] }, { kind: 'ambiguous', view_id: 'view-a', region_ids: ['a'] },
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
