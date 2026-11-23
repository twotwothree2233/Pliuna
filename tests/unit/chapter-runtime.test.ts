import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, expect, test, vi } from 'vitest'
import type { ArtifactCandidate, Bundle, ChapterManifest, ChapterUpdate, ContentOperation, IpcRequest, ModelConfiguration } from '../../src/shared/contracts.generated'
import { ContractError } from '../../src/shared/validation'
import { ChatAdapter, ModelError, type Completion } from '../../src/runtime/model/adapter'
import { ModelService, type ModelLease } from '../../src/runtime/model/service'
import { RunnerArtifactState } from '../../src/runtime/runner/artifact-state'
import { ChapterHost } from '../../src/runtime/runner/chapter-host'
import { ChapterState } from '../../src/runtime/runner/chapter-state'
import { ContentTreeState } from '../../src/runtime/runner/content-tree-state'
import { RunnerWorkState } from '../../src/runtime/runner/work-state'
import { loadConversation } from '../../src/runtime/runner/conversation'
import { RuntimeStore } from '../../src/runtime/store'
import { artifactDraft } from '../helpers/producer-draft'
import type { LiveFlowSnapshot } from '../../src/shared/types'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.restoreAllMocks() })
const answer = (value: unknown): Completion => ({ text: JSON.stringify(value), calls: [], finish: 'stop', usage: { prompt_tokens: 30, completion_tokens: 10 } })
function create(bundle: Bundle): Completion {
  return { text: '', finish: 'tool_calls', usage: { prompt_tokens: 30, completion_tokens: 30 }, calls: [{ id: 'create-bundle', type: 'function', function: { name: 'write', arguments: JSON.stringify({ operation: 'resource.create', input: { display_name: 'Chapter candidate.json', content: { type: 'json', value: bundle } } }) } }] }
}
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done }), resolve: (value: T) => resolve(value) } }
function bundle(): Bundle {
  return { profile: 'managed-v1', html: '<section><h2 id="a-title">Alpha</h2><div id="a-body"><p>Alpha original</p><label for="a-input">Alpha input</label><input id="a-input"></div></section><section><h2 id="b-title">Beta</h2><div id="b-body"><p>Beta original</p><label for="b-input">Beta input</label><input id="b-input"></div></section>', css: '', state: { schema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a', 'b'], additionalProperties: false }, initial: { a: '', b: '' }, compatibility_version: 'chapter-v1' }, forms: [], behaviors: [{ type: 'input', element_id: 'a-input', field: '/a', control: 'text' }, { type: 'input', element_id: 'b-input', field: '/b', control: 'text' }], references: [], export: [] }
}
function setup(conversationRouting = false) {
  const directory = mkdtempSync(join(tmpdir(), 'pliuna-chapter-runtime-')), adapter = new ChatAdapter(), models = new ModelService(adapter)
  const config: ModelConfiguration = { id: 'chapter-model', base_url: 'https://example.invalid/v1', wire_model_id: 'fixture', context_tokens: 100000, max_output_tokens: 8192, compatibility_profile: 'chat-max-tokens' }
  models.configure({ type: 'model.configure', configuration: config, api_key: 'fixture-key', confirm_memory_only: true })
  vi.spyOn(models, 'acquire').mockImplementation((): ModelLease => ({ id: config.id, revision: 1, config, release: vi.fn() }))
  vi.spyOn(models, 'acquireCompaction').mockReturnValue(undefined)
  vi.spyOn(models, 'list').mockReturnValue([{ ...config, revision: 1, roles: ['main'], credential_missing: false }])
  let store = new RuntimeStore(directory, models, { viewReplacement: true, runner: { productionRuns: 2, collator: 'rule', conversationRouting } })
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  const internal = () => store as unknown as { db: Database.Database; epoch: string; features: { viewReplacement: boolean } }
  const task = store.create('Chapter runtime').task.id, complete = vi.spyOn(adapter, 'complete')
  const state = () => new RunnerWorkState(internal().db, internal().epoch)
  const snapshot = () => store.snapshot(task)
  const status = (update_id: string) => store.handle({ type: 'chapter.status', task_id: task, update_id }) as ChapterUpdate
  const records = (kind: string) => (internal().db.prepare('SELECT payload_json FROM records WHERE task_id=? AND kind=? ORDER BY sequence').all(task, kind) as { payload_json: string }[]).map(row => JSON.parse(row.payload_json))
  const restart = () => { store.close(); store = new RuntimeStore(directory, models, { viewReplacement: true, runner: { productionRuns: 2, collator: 'rule', conversationRouting } }); return store }
  return { get store() { return store }, internal, directory, task, complete, state, snapshot, status, records, restart, conversationRouting }
}
type Fixture = ReturnType<typeof setup>

async function awaitHostCheck(s: Fixture, actionId?: string) {
  const snapshot = () => s.snapshot()
  const approval = () => snapshot().approvals.find(item => item.decision === 'pending' && item.validity === 'valid' && (!actionId || item.action_id === actionId))
  const update = () => snapshot().surface_updates.find(item => !actionId || item.action_id === actionId)
  await vi.waitFor(() => expect(approval() ?? update()).toBeDefined())
  const pending = approval()
  if (pending) await s.store.handle({ type: 'approval.decide', task_id: s.task, approval_id: pending.id, decision: 'approve' })
  await vi.waitFor(() => expect(update()).toBeDefined())
  return update()!.action_id
}
async function publish(s: Fixture, actionId?: string) {
  const action = await awaitHostCheck(s, actionId)
  try { await s.store.handle({ type: 'surface.respond', task_id: s.task, action_id: action, proceed: true, confirm_discard: false }) }
  catch (error) { throw new Error(String(error) + ': ' + JSON.stringify(s.internal().db.prepare('SELECT state,result,result_json FROM actions WHERE id=?').get(action)), { cause: error }) }
  return action
}

async function publishOriginal(s: Fixture, content = bundle()) {
  if (s.conversationRouting) s.complete.mockResolvedValueOnce(answer({ kind: 'new' }))
  s.complete.mockResolvedValueOnce(create(content))
  s.complete.mockImplementationOnce(async (_config, _key, messages) => {
    const result = JSON.parse(messages.at(-1)!.content!)
    expect(result).toMatchObject({ execution: 'success', data: { media_type: 'application/json' } })
    const producer = s.state().taskWorks(s.task).find(work => work.role === 'producer')!
    if (producer.purpose !== 'production') throw Error('Expected producer')
    const goal = s.state().goal(producer.request_id), section = new RunnerArtifactState(s.internal().db, s.state()).outline(s.task)!.sections[0]!
    const candidate: ArtifactCandidate = { candidate_id: 'original-candidate', task_id: s.task, request_id: producer.request_id, intent_revision: producer.intent_revision, run_id: producer.run_id, work_id: producer.work_id, attempt_id: producer.current_attempt_id!, artifact_id: 'original-artifact', base_artifact_revision: 0, plan_revision: producer.plan_revision, bundle_resource_id: result.data.id, section_id: section.section_id, section_position_revision: section.position_revision, order_key: section.order_key, presentation_kind: 'managed-v1', width_constraint: 'full', interaction_kind: 'input', provenance_ref: { task_id: s.task, kind: 'record', id: s.state().input(goal.input_event_id).record_id }, requirement_ids: producer.requirement_ids, unresolved: [], dependencies: producer.dependencies }
    return answer({ version: 1, complete: true, answer: '正文已完成。', artifacts: [artifactDraft(candidate)], requirement_ids: producer.requirement_ids, unresolved: [] })
  })
  const text = 'Create two independently editable chapters'
  let run: string
  if (s.conversationRouting) {
    const { request_id } = s.store.handle({ type: 'request.submit', task_id: s.task, text, model_config_id: 'chapter-model', resource_ids: [], import_ids: [] }) as { request_id: string }
    const status = () => s.store.handle({ type: 'request.status', task_id: s.task, request_id }) as { state: string; run_id: string }
    await vi.waitFor(() => expect(status()).toMatchObject({ state: 'started', run_id: expect.any(String) }))
    run = status().run_id
    const message = s.internal().db.prepare("SELECT id FROM records WHERE task_id=? AND kind='message.user' AND json_extract(payload_json,'$.request_id')=?").get(s.task, request_id) as { id: string }
    expect(s.state().run(run)).toMatchObject({ message_id: message.id })
    expect(s.state().consumption(`request:${request_id}`, 'installed')?.result).toMatchObject({ refs: [{ kind: 'run', id: run }] })
  } else run = s.store.start(s.task, text, 'chapter-model', [])
  await vi.waitFor(() => expect(s.state().run(run).state).toBe('completed'))
  await publish(s)
  await vi.waitFor(() => expect(s.snapshot().views).toHaveLength(1))
  return s.snapshot().views[0]!
}
async function original(s: Fixture): Promise<ChapterManifest> {
  const view = await publishOriginal(s)
  return s.store.handle({ type: 'chapters.map', task_id: s.task, view_id: view.id, expected_view_revision: view.revision }) as ChapterManifest
}

test('a question about a published chapter leaves the production scope and View unchanged', async () => {
  const s = setup(true), manifest = await original(s)
  const snapshot = s.snapshot(), goals = s.store.runnerGoals({ task_id: s.task }).goals
  const node = manifest.content_tree!.nodes.find(node => node.kind === 'paragraph')!
  s.complete.mockResolvedValueOnce(answer({ kind: 'query', view_id: manifest.view_id, region_ids: [node.node_id] }))
    .mockResolvedValueOnce({ text: '', finish: 'tool_calls', calls: [{ id: 'read-chapter', type: 'function', function: { name: 'read', arguments: JSON.stringify({ kind: 'content_node', id: node.node_id }) } }] })
    .mockImplementationOnce(async (_config, _key, messages, tools) => {
      expect(tools?.map(tool => tool.function.name)).toEqual(['list', 'read'])
      expect(messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'assistant', content: '正文已完成。' })]))
      expect(messages.at(-1)?.content).toContain('Alpha original')
      return { text: 'Alpha is the first section.', calls: [], finish: 'stop', usage: { prompt_tokens: 20, completion_tokens: 10 } }
    })
  const submitted = s.store.handle({ type: 'request.submit', task_id: s.task, text: 'Explain the first paragraph.', model_config_id: 'chapter-model', resource_ids: [], import_ids: [] }) as { request_id: string }
  await vi.waitFor(() => expect(s.store.handle({ type: 'request.status', task_id: s.task, request_id: submitted.request_id })).toMatchObject({ state: 'started', run_state: 'completed' }))
  expect(s.records('conversation.reply')).toEqual([expect.objectContaining({ request_id: submitted.request_id, text: 'Alpha is the first section.' })])
  expect(s.store.runnerGoals({ task_id: s.task }).goals).toEqual(goals)
  expect(s.snapshot().runner?.scope).toEqual(snapshot.runner?.scope)
  expect(s.snapshot().views).toEqual(snapshot.views)
})

test('stopping preserves a missing requirement; removing it creates a scope without changing published content', async () => {
  const s = setup(true), view = await publishOriginal(s)
  const send = (text: string) => s.store.handle({ type: 'request.submit', task_id: s.task, text, model_config_id: 'chapter-model', resource_ids: [], import_ids: [] }) as { request_id: string }
  const status = ({ request_id }: { request_id: string }) => s.store.handle({ type: 'request.status', task_id: s.task, request_id }) as { run_id: string; run_state: string; code: string }
  const message = (request: string) => (s.internal().db.prepare("SELECT id FROM records WHERE task_id=? AND kind='message.user' AND json_extract(payload_json,'$.request_id')=?").get(s.task, request) as { id: string }).id
  const hold = deferred<Completion>(), calls = s.complete.mock.calls.length
  s.complete.mockResolvedValueOnce(answer({ kind: 'new' })).mockImplementationOnce(() => hold.promise)
  const appendix = send('Create a separate appendix.')
  await vi.waitFor(() => expect(s.complete.mock.calls.length).toBe(calls + 2))
  const before = s.snapshot().runner!.scope!
  expect(before).toMatchObject({ required_content_count: 2, unresolved_count: 1 })
  s.store.handle({ type: 'run.cancel', task_id: s.task, run_id: status(appendix).run_id })
  hold.resolve(answer({ version: 1, complete: true, answer: 'late answer', artifacts: [], requirement_ids: ['content'], unresolved: [] }))
  await vi.waitFor(() => expect(status(appendix).run_state).toBe('cancelled'))
  expect(s.snapshot().runner?.scope).toEqual(before)
  expect(s.snapshot().views[0]).toEqual(view)
  expect(s.records('runner.answer').some(record => record.text === 'late answer')).toBe(false)

  s.complete.mockResolvedValueOnce(answer({ kind: 'remove_pending', message_id: message(appendix.request_id) }))
  const removal = send('Drop the undelivered appendix.')
  await vi.waitFor(() => expect(status(removal).run_state).toBe('completed'))
  const after = s.snapshot().runner!.scope!
  expect(after).toMatchObject({ composition_version: before.composition_version + 1, state: 'complete', required_content_count: 1, unresolved_count: 0 })
  expect(s.snapshot().views[0]).toEqual(view)
  expect(s.records('content.requirement.removed')).toEqual([expect.objectContaining({
    message_id: message(removal.request_id), source_message_id: message(appendix.request_id), previous_version: before.composition_version, composition_version: after.composition_version
  })])
  s.complete.mockResolvedValueOnce(answer({ kind: 'remove_pending', message_id: message(view.chapter_manifest!.request_id) }))
  const attempted = send('Drop the published document without editing it.')
  await vi.waitFor(() => expect(status(attempted).code).toBe('CONTENT_ALREADY_PUBLISHED'))
  expect(s.snapshot().runner!.scope).toEqual(after)
  expect(s.snapshot().views[0]).toEqual(view)
})
function chapterModel(s: Fixture) {
  const pending = new Map<string, ReturnType<typeof deferred<Completion>>>()
  const ready = new Set<string>()
  const edits = new Map<string, [string, string][]>()
  const submitted = new Map<string, ContentOperation[]>()
  const targets = new Map<string, string[]>()
  const scopePlans = new Map<string, NonNullable<ChapterUpdate['tree_operations']>>()
  const registrations = new Map<string, { inherited_requirements: unknown[] }>()
  const rejections = new Map<string, { error: { code: string; correctable: boolean }; data: { state: string } }>()
  s.complete.mockImplementation(async (_config, _key, messages) => {
    const system = messages.find(message => message.role === 'system')!.content!
    if (system.includes('Bound scope: ')) {
      const binding = JSON.parse(system.slice(system.lastIndexOf('Bound scope: ') + 'Bound scope: '.length)) as { candidate_node_ids: string[] }
      const request = JSON.parse([...messages].reverse().find(message => message.role === 'user')!.content!).request
      const input = s.records('worker.input').reverse().find(record => record.owner.update_id && record.text === request)!
      const update = s.status(input.owner.update_id)
      if (messages.at(-1)!.role !== 'tool') {
        const gate = deferred<Completion>(); pending.set(update.update_id, gate); ready.add(update.update_id); return gate.promise
      }
      const result = JSON.parse(messages.at(-1)!.content!)
      if (result.error?.correctable) {
        rejections.set(update.update_id, result)
        const gate = deferred<Completion>(); pending.set(update.update_id, gate); ready.add(update.update_id); return gate.promise
      }
      expect(result).toMatchObject({ execution: 'success' })
      if (result.data.state === 'published') return answer('更新已完成。')
      if (result.data.state === 'registered') {
        registrations.set(result.data.update_id, result.data)
        scopePlans.delete(result.data.update_id)
        const gate = deferred<Completion>(); pending.set(result.data.update_id, gate); ready.add(result.data.update_id); return gate.promise
      }
      const selected = targets.get(update.update_id) ?? binding.candidate_node_ids
      const nodes = [...new Map(messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content!)).map(value => value.data?.data ?? value.data).filter(value => selected.includes(value?.node_id)).map(value => [value.node_id, value])).values()]
      const operations = submitted.get(update.update_id) ?? nodes.map(data => {
        let html = data.html as string
        for (const [from, to] of edits.get(update.update_id)!) html = html.replace(from, to)
        return { type: 'replace', node_ids: [data.node_id], html }
      })
      const plans = scopePlans.get(update.update_id)
      return { text: '', finish: 'tool_calls', usage: { prompt_tokens: 30, completion_tokens: 30 }, calls: [{ id: 'submit-content', type: 'function', function: { name: 'call', arguments: JSON.stringify({ capability: 'builtin:content-operations:v1', input_json: JSON.stringify(plans ? { action: 'register', operations: plans } : { operations }) }) } }] }
    }
    const binding = JSON.parse(system.slice(system.lastIndexOf('Bound data: ') + 'Bound data: '.length)) as { update_id: string }
    const update = s.status(binding.update_id)
    if (messages.at(-1)!.role !== 'tool') {
      const gate = deferred<Completion>(); pending.set(update.update_id, gate); ready.add(update.update_id); return gate.promise
    }
    const result = JSON.parse(messages.at(-1)!.content!)
    expect(result).toMatchObject({ execution: 'success', data: { media_type: 'application/json' } })
    return answer({ bundle_resource_id: result.data.id, replacements: [{ previous_region_ids: update.region_ids, chapters: update.base_manifest.chapters.filter(chapter => update.region_ids.includes(chapter.region_id)).map(chapter => ({ ...chapter, revision: chapter.revision + 1, dependencies: update.dependencies })) }] })
  })
  const model = {
    pending,
    registrations,
    rejections,
    async call(updateId: string, input: unknown) {
      await vi.waitFor(() => expect(ready.has(updateId)).toBe(true))
      ready.delete(updateId)
      pending.get(updateId)!.resolve({ text: '', finish: 'tool_calls', usage: { prompt_tokens: 30, completion_tokens: 10 }, calls: [{ id: 'content-request', type: 'function', function: { name: 'call', arguments: JSON.stringify({ capability: 'builtin:content-operations:v1', input_json: JSON.stringify(input) }) } }] })
    },
    async register(updateId: string, operations?: NonNullable<ChapterUpdate['tree_operations']>) {
      await vi.waitFor(() => expect(pending.has(updateId)).toBe(true))
      const update = s.status(updateId)
      scopePlans.set(updateId, operations ?? (update.candidate_region_ids ?? update.region_ids).map(id => ({ type: 'replace', node_ids: [id] })))
      await model.release(updateId, [])
      await vi.waitFor(() => expect(s.status(updateId).scope_revision, JSON.stringify({ update_id: updateId, state: s.status(updateId).state, reason: s.status(updateId).reason, rejected: s.records('content.operations.rejected').at(-1) })).toBeGreaterThan(update.scope_revision ?? 0))
      return s.status(updateId)
    },
    async release(updateId: string, replacements: [string, string][], operations?: ContentOperation[], readIds?: string[]) {
      await vi.waitFor(() => expect(ready.has(updateId), JSON.stringify({ state: s.status(updateId).state, reason: s.status(updateId).reason })).toBe(true))
      ready.delete(updateId)
      const update = s.status(updateId)
      if (update.base_manifest.content_tree) {
        edits.set(updateId, replacements)
        if (operations) submitted.set(updateId, operations)
        const selected = readIds ?? update.candidate_region_ids ?? update.region_ids
        targets.set(updateId, selected)
        pending.get(updateId)!.resolve({ text: '', finish: 'tool_calls', usage: { prompt_tokens: 30, completion_tokens: 10 }, calls: selected.map((id, index) => ({ id: 'read-content-' + index, type: 'function', function: { name: 'read', arguments: JSON.stringify({ kind: 'content_node', id }) } })) })
        return
      }
      const candidate = bundle()
      for (const [from, to] of replacements) candidate.html = candidate.html.replace(from, to)
      pending.get(updateId)!.resolve(create(candidate))
    }
  }
  return model
}

// Retain coverage for work admitted by the application before tree metadata existed.
function useLegacyMapping(s: Fixture): void {
  const map = ChapterHost.prototype.map
  vi.spyOn(ChapterHost.prototype, 'map').mockImplementation(function(this: ChapterHost, task, view, expected) {
    const current = new ChapterState(s.internal().db).manifest(task, view)
    if (current?.view_revision === expected && !current.content_tree) return current
    const { content_tree: _tree, ...manifest } = map.call(this, task, view, expected)
    s.internal().db.prepare('UPDATE runner_chapter_manifests SET payload_json=? WHERE task_id=? AND view_id=? AND manifest_revision=?').run(JSON.stringify(manifest), task, view, manifest.manifest_revision)
    return manifest
  })
}
function start(s: Fixture, manifest: ChapterManifest, name: 'Alpha' | 'Beta', updateId: string): ChapterUpdate {
  return startNodes(s, manifest, [manifest.chapters.find(chapter => chapter.title === name)!.region_id], updateId)
}
function startNodes(s: Fixture, manifest: ChapterManifest, nodeIds: string[], updateId: string, operations?: ChapterUpdate['tree_operations']): ChapterUpdate {
  const view = s.snapshot().views[0]!
  const request: Extract<IpcRequest, { type: 'chapter.update' }> = { type: 'chapter.update', task_id: s.task, input_event_id: 'input-' + updateId, update_id: updateId, view_id: manifest.view_id, view_revision: view.revision, state_revision: view.state_revision, region_ids: nodeIds, text: 'Update selected content: ' + updateId, model_config_id: 'chapter-model', ...(operations ? { tree_operations: operations } : {}) }
  return s.store.handle(request) as ChapterUpdate
}

test('a paragraph operation commits the View, tree, artifact coverage and immutable source together', async () => {
  const s = setup(), mapped = await original(s), model = chapterModel(s), before = s.snapshot().views[0]!
  const tree = mapped.content_tree!, alpha = tree.nodes.find(node => node.kind === 'paragraph' && before.bundle.html.slice(node.span.start, node.span.end).includes('Alpha original'))!
  const beta = tree.nodes.find(node => node.kind === 'paragraph' && before.bundle.html.slice(node.span.start, node.span.end).includes('Beta original'))!
  const update = startNodes(s, mapped, [alpha.node_id], 'paragraph-update')
  await model.release(update.update_id, [['Alpha original', 'Alpha paragraph revised']])
  await vi.waitFor(() => expect(s.status(update.update_id).action_id).toBeDefined())
  expect(s.snapshot().views[0]!.bundle).toEqual(before.bundle)
  await publish(s, s.status(update.update_id).action_id)
  await vi.waitFor(() => expect(s.status(update.update_id).state).toBe('succeeded'))
  const after = s.snapshot().views[0]!, manifest = after.chapter_manifest!, trees = new ContentTreeState(s.internal().db)
  const current = trees.snapshot(s.task, after.id)!, old = trees.snapshot(s.task, after.id, tree.revision)!
  expect(after.bundle.html).toBe(before.bundle.html.replace('Alpha original', 'Alpha paragraph revised'))
  expect(current).toMatchObject({ view_revision: after.revision, state_revision: after.state_revision, bundle_resource_id: manifest.bundle_resource_id })
  expect(current.tree).toEqual(manifest.content_tree)
  expect(current.tree.nodes.find(node => node.node_id === alpha.node_id)).toMatchObject({ revision: alpha.revision + 1, position_revision: alpha.position_revision })
  expect(current.tree.nodes.find(node => node.node_id === beta.node_id)).toMatchObject({ revision: beta.revision, position_revision: beta.position_revision })
  expect(old.tree).toEqual(tree)
  expect(old.bundle_resource_id).toBe(mapped.bundle_resource_id)
  const artifacts = new RunnerArtifactState(s.internal().db, s.state()), index = artifacts.artifact(s.task, mapped.artifact_id!)!
  expect(index).toMatchObject({ artifact_revision: mapped.artifact_revision! + 1, bundle_resource_id: manifest.bundle_resource_id })
  const originalCandidate = s.internal().db.prepare('SELECT candidate_id FROM runner_artifacts WHERE task_id=? AND artifact_id=? AND artifact_revision=?').get(s.task, mapped.artifact_id, mapped.artifact_revision) as { candidate_id: string }
  expect(artifacts.checkChapterAssembly(index)?.requirement_ids).toEqual(artifacts.candidate(s.task, originalCandidate.candidate_id)!.candidate.requirement_ids)
  expect(artifacts.resolveChapterReference(artifacts.artifact(s.task, mapped.artifact_id!, mapped.artifact_revision!)!)).toEqual(index)
  const proposal = new ChapterState(s.internal().db).proposal(s.task, s.status(update.update_id).proposal_id!)!
  expect(proposal).toMatchObject({ replacements: [], tree_operations: [{ type: 'replace', node_ids: [alpha.node_id], html: '<p>Alpha paragraph revised</p>' }] })
  expect(s.records('content.node.read')).toContainEqual(expect.objectContaining({ node_id: alpha.node_id, revision: alpha.revision, owner: expect.objectContaining({ attempt_id: update.source!.attempt_id }) }))
})

test('an invalid operation releases registered scope and is corrected in the same content conversation', async () => {
  const s = setup(), mapped = await original(s), model = chapterModel(s), before = s.snapshot().views[0]!
  const paragraph = mapped.content_tree!.nodes.find(node => node.kind === 'paragraph')!
  const update = startNodes(s, mapped, [paragraph.node_id], 'correct-invalid-operation')
  const registered = await model.register(update.update_id), owner = registered.source!
  expect(registered.scope_active).toBe(true)
  await model.call(update.update_id, { operations: [{ type: 'replace', node_ids: [paragraph.node_id] }] })
  await vi.waitFor(() => expect(model.rejections.get(update.update_id)).toMatchObject({ error: { code: 'CONTENT_OPERATION_INVALID', correctable: true }, data: { state: 'correction_required' } }))
  expect(s.status(update.update_id)).toMatchObject({ state: 'generating', scope_revision: registered.scope_revision, scope_active: false, source: owner })
  expect(s.snapshot().views[0]!.bundle).toEqual(before.bundle)
  expect(s.records('content.operations.submitted')).toEqual([])
  expect(() => s.state().qualify(owner.attempt_id)).not.toThrow()
  await model.release(update.update_id, [['Alpha original', 'Corrected in the original conversation']])
  await vi.waitFor(() => expect(s.status(update.update_id).action_id).toBeDefined())
  expect(s.status(update.update_id)).toMatchObject({ scope_revision: registered.scope_revision! + 1, source: owner })
  await publish(s, s.status(update.update_id).action_id)
  await vi.waitFor(() => expect(s.status(update.update_id).state).toBe('succeeded'))
  expect(s.snapshot().views[0]!.bundle.html).toBe(before.bundle.html.replace('Alpha original', 'Corrected in the original conversation'))
  expect(s.records('worker.input').filter(record => record.owner.update_id === update.update_id)).toHaveLength(1)
})

test('a content worker chooses a different operation from its routing suggestion', async () => {
  const s = setup(), mapped = await original(s), model = chapterModel(s), before = s.snapshot().views[0]!
  const paragraph = mapped.content_tree!.nodes.find(node => node.kind === 'paragraph')!
  const update = startNodes(s, mapped, [paragraph.node_id], 'autonomous-delete', [{ type: 'replace', node_ids: [paragraph.node_id] }])
  await model.release(update.update_id, [], [{ type: 'delete', node_ids: [paragraph.node_id] }])
  await vi.waitFor(() => expect(s.status(update.update_id).action_id).toBeDefined())
  const registered = s.status(update.update_id)
  expect(registered.candidate_operations).toEqual([{ type: 'replace', node_ids: [paragraph.node_id] }])
  expect(registered.tree_operations).toEqual([{ type: 'delete', node_ids: [paragraph.node_id] }])
  expect(s.records('runner.answer').some(record => record.update_id === update.update_id)).toBe(false)
  await publish(s, registered.action_id)
  await vi.waitFor(() => expect(s.status(update.update_id).state).toBe('succeeded'))
  const after = s.snapshot().views[0]!
  expect(after.bundle.html).toBe(before.bundle.html.slice(0, paragraph.span.start) + before.bundle.html.slice(paragraph.span.end))
  expect(after.bundle.html).toContain('Beta original')
})

test('a tree installation failure rolls back the whole content publication', async () => {
  const s = setup(), mapped = await original(s), model = chapterModel(s), before = s.snapshot()
  const trees = new ContentTreeState(s.internal().db), previousTree = trees.snapshot(s.task, mapped.view_id)!
  const artifacts = new RunnerArtifactState(s.internal().db, s.state()), previousArtifact = artifacts.artifact(s.task, mapped.artifact_id!)!
  const update = start(s, mapped, 'Alpha', 'tree-install-failure')
  await model.release(update.update_id, [['Alpha original', 'Must roll back']])
  await vi.waitFor(() => expect(s.status(update.update_id).action_id).toBeDefined())
  const action = await awaitHostCheck(s, s.status(update.update_id).action_id)
  vi.spyOn(ContentTreeState.prototype, 'install').mockImplementationOnce(() => { throw new Error('Injected tree installation failure') })
  await Promise.resolve(s.store.handle({ type: 'surface.respond', task_id: s.task, action_id: action, proceed: true, confirm_discard: false })).catch(() => {})
  await vi.waitFor(() => expect(s.status(update.update_id).state).toBe('failed'))
  const after = s.snapshot()
  expect(after.surface).toEqual(before.surface)
  expect(after.views).toEqual(before.views.map(view => ({ ...view, chapter_updates: after.views[0]!.chapter_updates })))
  expect(trees.snapshot(s.task, mapped.view_id)).toEqual(previousTree)
  expect(artifacts.artifact(s.task, mapped.artifact_id!)).toEqual(previousArtifact)
  expect(s.records('surface.published')).toHaveLength(1)
  expect(s.internal().db.prepare('SELECT COUNT(*) n FROM runner_chapter_assemblies WHERE task_id=?').get(s.task)).toEqual({ n: 0 })
  expect(s.internal().db.prepare('SELECT COUNT(*) n FROM view_history WHERE task_id=?').get(s.task)).toEqual({ n: 1 })
})

test('a legacy host template publishes with only a real resource identity from the model', async () => {
  const s = setup(); useLegacyMapping(s)
  const mapped = await original(s), before = s.snapshot().views[0]!
  s.complete.mockImplementationOnce(async () => {
    const input = s.records('worker.input').find(record => record.owner.update_id === 'template-result')!
    const candidate = structuredClone(input.bound.chapter_template) as Bundle
    expect(candidate.html).toContain('Alpha original')
    expect(candidate.html).not.toContain('Beta original')
    expect(input.bound.chapter_context.html).not.toContain('Beta original')
    candidate.html = candidate.html.replace('Alpha original', 'Alpha templated')
    return create(candidate)
  })
  s.complete.mockImplementationOnce(async (_config, _key, messages) => {
    const result = JSON.parse(messages.at(-1)!.content!)
    expect(result).toMatchObject({ execution: 'success', data: { media_type: 'application/json' } })
    return answer({ bundle_resource_id: result.data.id })
  })
  const update = start(s, mapped, 'Alpha', 'template-result')
  await vi.waitFor(() => expect(s.status(update.update_id).action_id).toBeDefined())
  expect(s.snapshot().views[0]!.bundle.html).toBe(before.bundle.html)
  await publish(s, s.status(update.update_id).action_id)
  await vi.waitFor(() => expect(s.status(update.update_id).state).toBe('succeeded'))
  const after = s.snapshot().views[0]!
  expect(after.bundle.html).toBe(before.bundle.html.replace('Alpha original', 'Alpha templated'))
  expect(after.chapter_manifest!.chapters.map(chapter => chapter.revision)).toEqual([2, 1])
})

test('real chapter execution publishes only its selected body and preserves the newest whole-View draft', async () => {
  const s = setup(), mapped = await original(s), model = chapterModel(s)
  const begun = start(s, mapped, 'Alpha', 'alpha-update')
  expect(begun.request_id).toBe(mapped.request_id)
  await model.release(begun.update_id, [['Alpha original', 'Alpha revised'], ['Beta original', 'Unrequested Beta replacement']])
  await vi.waitFor(() => expect(s.status(begun.update_id).action_id).toBeDefined())
  const action = await awaitHostCheck(s, s.status(begun.update_id).action_id)
  const before = s.snapshot().views[0]!
  const saved = s.store.handle({ type: 'draft.save', task_id: s.task, view_id: before.id, view_revision: before.revision, expected_state_revision: before.state_revision, fields: [{ path: '/b', value: 'latest Beta draft' }] }) as { state_revision: number }
  await Promise.resolve(s.store.handle({ type: 'surface.respond', task_id: s.task, action_id: action, proceed: true, confirm_discard: false })).catch(error => expect(error).toHaveProperty('code'))
  // A changed draft needs a newly compiled exact publication, not a second model.
  await vi.waitFor(() => expect(s.status(begun.update_id).publication_operation_id).toBeDefined())
  if (s.status(begun.update_id).state !== 'succeeded') {
    await vi.waitFor(() => expect(s.status(begun.update_id).action_id).not.toBe(action))
    await publish(s, s.status(begun.update_id).action_id)
  }
  await vi.waitFor(() => expect(s.status(begun.update_id).state).toBe('succeeded'))
  const after = s.snapshot().views[0]!
  expect(after.id).toBe(before.id)
  expect(after.bundle.html).toContain('Alpha revised')
  expect(after.bundle.html).toContain('Beta original')
  expect(after.bundle.html).not.toContain('Unrequested Beta replacement')
  expect(after.draft).toEqual({ a: '', b: 'latest Beta draft' })
  expect(after.state_revision).toBeGreaterThan(saved.state_revision)
  expect(s.records('runner.answer').filter(record => record.update_id === begun.update_id).map(record => record.text)).toEqual(['更新已完成。'])
  expect(s.internal().db.prepare('SELECT COUNT(*) n FROM runner_current_content_plans WHERE task_id=?').get(s.task)).toEqual({ n: 1 })
})

test.each(['boundaries', 'body container', 'shared CSS'])('a legacy candidate with invalid %s is corrected before accepting or publishing the chapter', async reason => {
  const s = setup(); useLegacyMapping(s)
  const mapped = await original(s), candidate = bundle()
  candidate.html = candidate.html.replace('Alpha original', 'Alpha corrected')
  const invalid = reason === 'shared CSS' ? { ...candidate, css: 'p{color:red}' } : { ...candidate, html: reason === 'boundaries' ? candidate.html.replace(' id="a-title"', '').replace(' id="a-body"', '') : candidate.html.replace('<div id="a-body"><p>Alpha corrected</p>', '<p id="a-body">Alpha corrected').replace('</div></section>', '</p><p>Extra example</p></section>') }
  const rejected: string[] = []
  const proposal = (resource: string) => {
    const update = s.status('correct-mapping')
    return { bundle_resource_id: resource, replacements: [{ previous_region_ids: update.region_ids, chapters: update.base_manifest.chapters.filter(chapter => update.region_ids.includes(chapter.region_id)).map(chapter => ({ ...chapter, revision: chapter.revision + 1, dependencies: update.dependencies })) }] }
  }
  s.complete.mockResolvedValueOnce(create(invalid))
  s.complete.mockImplementationOnce(async (_config, _key, messages) => {
    const result = JSON.parse(messages.at(-1)!.content!)
    rejected.push(result.data.id)
    return answer(proposal(result.data.id))
  })
  s.complete.mockImplementationOnce(async (_config, _key, messages) => {
    expect(messages[0]!.content).toContain(reason === 'shared CSS' ? 'CHAPTER_STYLE_SCOPE' : 'CHAPTER_MAPPING_INVALID')
    expect(s.status('correct-mapping').state).toBe('generating')
    expect(s.records('chapter.proposal.accepted')).toEqual([])
    expect(s.snapshot().views[0]!.bundle.html).toBe(bundle().html)
    return create(candidate)
  })
  s.complete.mockImplementationOnce(async (_config, _key, messages) => answer(proposal(JSON.parse(messages.at(-1)!.content!).data.id)))
  const update = start(s, mapped, 'Alpha', 'correct-mapping')
  await vi.waitFor(() => expect(s.status(update.update_id).action_id).toBeDefined())
  expect(s.records('worker.result.rejected')).toHaveLength(1)
  expect(s.records('chapter.proposal.accepted')).toHaveLength(1)
  expect(s.records('worker.result').filter(record => record.owner.update_id === update.update_id).every(record => !rejected.includes(record.value.bundle_resource_id))).toBe(true)
  await publish(s, s.status(update.update_id).action_id)
  await vi.waitFor(() => expect(s.status(update.update_id).state).toBe('succeeded'))
  expect(s.snapshot().views[0]!.bundle.html).toBe(candidate.html)
})

test('independent content updates publish in reverse order using an immutable successor action', async () => {
  const s = setup(), mapped = await original(s), model = chapterModel(s)
  const alpha = start(s, mapped, 'Alpha', 'parallel-alpha'), beta = start(s, mapped, 'Beta', 'parallel-beta')
  await model.release(alpha.update_id, [['Alpha original', 'Alpha concurrent']])
  await model.release(beta.update_id, [['Beta original', 'Beta concurrent']])
  await vi.waitFor(() => expect(s.status(alpha.update_id).action_id).toBeDefined())
  await vi.waitFor(() => expect(s.status(beta.update_id).action_id).toBeDefined())
  const originalAlpha = s.status(alpha.update_id), alphaAction = originalAlpha.action_id!
  const originalRequest = s.internal().db.prepare('SELECT request_json FROM actions WHERE id=?').get(alphaAction)
  await publish(s, s.status(beta.update_id).action_id)
  await vi.waitFor(() => expect(s.status(beta.update_id).state).toBe('succeeded'))
  await vi.waitFor(() => expect(s.snapshot().surface_updates.some(item => item.action_id === alphaAction) || s.status(alpha.update_id).action_id !== alphaAction).toBe(true))
  if (s.snapshot().surface_updates.some(item => item.action_id === alphaAction)) await Promise.resolve(s.store.handle({ type: 'surface.respond', task_id: s.task, action_id: alphaAction, proceed: true, confirm_discard: false })).catch(error => expect(error).toHaveProperty('code'))
  await vi.waitFor(() => expect(s.status(alpha.update_id).action_id).not.toBe(alphaAction))
  const successor = s.status(alpha.update_id)
  expect(s.internal().db.prepare('SELECT request_json FROM actions WHERE id=?').get(alphaAction)).toEqual(originalRequest)
  expect(s.internal().db.prepare('SELECT previous_operation_id FROM runner_chapter_publications WHERE operation_id=?').get(successor.publication_operation_id)).toEqual({ previous_operation_id: originalAlpha.publication_operation_id })
  await publish(s, successor.action_id)
  await vi.waitFor(() => expect(s.status(alpha.update_id).state).toBe('succeeded'))
  expect(s.snapshot().views[0]!.bundle.html).toContain('Alpha concurrent')
  expect(s.snapshot().views[0]!.bundle.html).toContain('Beta concurrent')
  expect(model.pending.size).toBe(2)
})

test('same-chapter correction revokes a late result before accepting the new intent', async () => {
  const s = setup(), mapped = await original(s), model = chapterModel(s)
  const first = start(s, mapped, 'Alpha', 'old-alpha')
  await model.register(first.update_id)
  const next = start(s, mapped, 'Alpha', 'new-alpha')
  expect(s.status(first.update_id).state).toBe('generating')
  const registered = await model.register(next.update_id)
  expect(s.status(first.update_id).state).toBe('superseded')
  expect(registered.previous_update_ids).toContain(first.update_id)
  await model.release(first.update_id, [['Alpha original', 'Late old result']])
  await model.release(next.update_id, [['Alpha original', 'Newest Alpha result']])
  expect(model.registrations.get(next.update_id)!.inherited_requirements).toContainEqual({ source_record_id: first.record_id, request_id: first.request_id, intent_revision: first.intent_revision, node_ids: registered.region_ids, gaps: [], text: first.text, effect: 'retain_unless_superseded', superseding_record_id: next.record_id })
  await vi.waitFor(() => expect(s.status(next.update_id).action_id).toBeDefined())
  await publish(s, s.status(next.update_id).action_id)
  await vi.waitFor(() => expect(s.status(next.update_id).state).toBe('succeeded'))
  expect(s.snapshot().views[0]!.bundle.html).toContain('Newest Alpha result')
  expect(s.snapshot().views[0]!.bundle.html).not.toContain('Late old result')
  expect(s.status(first.update_id).state).toBe('superseded')
  expect(s.records('chapter.proposal.accepted').some(record => record.update_id === first.update_id)).toBe(false)
})

test('a child takeover continues the parent remainder without expanding its write authority', async () => {
  const s = setup(), mapped = await original(s), model = chapterModel(s), tree = mapped.content_tree!
  const html = s.snapshot().views[0]!.bundle.html, paragraph = tree.nodes.find(node => node.kind === 'paragraph' && html.slice(node.span.start, node.span.end).includes('Alpha original'))!
  const parent = start(s, mapped, 'Alpha', 'parent-intent')
  const registeredParent = await model.register(parent.update_id)
  const child = startNodes(s, mapped, [paragraph.node_id], 'child-takeover')
  await model.register(child.update_id)
  expect(s.status(parent.update_id).state).toBe('superseded')
  await model.release(parent.update_id, [['Alpha original', 'Late parent result']])
  let relation!: { retained_node_ids: string[]; continuation_update_id: string; continuation_state: string }
  await vi.waitFor(() => {
    const row = s.internal().db.prepare('SELECT payload_json FROM runner_content_intent_relations WHERE task_id=? AND update_id=? AND previous_update_id=?').get(s.task, child.update_id, parent.update_id) as { payload_json: string }
    relation = JSON.parse(row.payload_json)
    expect(relation.continuation_state).toBe('started')
    expect(model.pending.has(relation.continuation_update_id)).toBe(true)
  })
  const continuation = await model.register(relation.continuation_update_id)
  expect(continuation).toMatchObject({ text: parent.text, request_id: parent.request_id, intent_revision: parent.intent_revision, region_ids: relation.retained_node_ids })
  expect(continuation.region_ids).not.toContain(registeredParent.region_ids[0])
  expect(continuation.region_ids).not.toContain(paragraph.node_id)
  const accepted = s.records('chapter.input.received').find(record => record.chapter_input.update_id === continuation.update_id)!
  expect(accepted).toMatchObject({ source_record_id: parent.record_id, text: parent.text })
  await s.store.workerTool(continuation.source!.attempt_id, { type: 'read', input: { target: { kind: 'content_node', id: paragraph.node_id } } }, new AbortController().signal)
  await expect(s.store.workerTool(continuation.source!.attempt_id, { type: 'call', input: { capability: 'builtin:content-operations:v1', arguments: { operations: [{ type: 'replace', node_ids: [paragraph.node_id], html: '<p>Forbidden remainder write</p>' }] }, references: [] } }, new AbortController().signal)).resolves.toMatchObject({ execution: 'not_executed', error: { code: 'WORKER_CAPABILITY_DENIED', correctable: true } })
  expect(s.records('content.operations.submitted')).toEqual([])
  for (const update of [continuation, child]) {
    await model.release(update.update_id, update.update_id === continuation.update_id ? [['Alpha input', 'Continued Alpha input']] : [['Alpha original', 'New child paragraph']])
    await vi.waitFor(() => expect(s.status(update.update_id).action_id).toBeDefined())
    await publish(s, s.status(update.update_id).action_id)
    await vi.waitFor(() => expect(s.status(update.update_id).state).toBe('succeeded'))
  }
  expect(s.snapshot().views[0]!.bundle.html).toContain('New child paragraph')
  expect(s.snapshot().views[0]!.bundle.html).toContain('Continued Alpha input')
  expect(s.snapshot().views[0]!.bundle.html).not.toContain('Late parent result')
  expect(s.snapshot().views[0]!.bundle.html).not.toContain('Forbidden remainder write')
})

test('a gap takeover publishes before the retained neighboring nodes resume', async () => {
  const s = setup(), mapped = await original(s), model = chapterModel(s), root = mapped.content_tree!.root_id
  const alpha = mapped.chapters.find(chapter => chapter.title === 'Alpha')!.region_id, beta = mapped.chapters.find(chapter => chapter.title === 'Beta')!.region_id
  const parent = startNodes(s, mapped, [root], 'whole-document-intent')
  await model.register(parent.update_id)
  const plan = { type: 'insert' as const, parent_id: root, position: 'before' as const, anchor_id: beta }
  const insertion = startNodes(s, mapped, [root], 'gap-takeover', [plan])
  await model.register(insertion.update_id, [plan])
  const readRelation = () => JSON.parse((s.internal().db.prepare('SELECT payload_json FROM runner_content_intent_relations WHERE task_id=? AND update_id=? AND previous_update_id=?').get(s.task, insertion.update_id, parent.update_id) as { payload_json: string }).payload_json) as { retained_node_ids: string[]; continuation_update_id?: string; continuation_state?: string }
  expect(s.status(parent.update_id).state).toBe('superseded')
  expect(readRelation().retained_node_ids).toEqual(expect.arrayContaining([alpha, beta]))
  expect(readRelation().continuation_update_id).toBeUndefined()
  await model.release(parent.update_id, [['Alpha original', 'Late whole-document content']])
  await model.release(insertion.update_id, [], [{ ...plan, html: '<p>Inserted between chapters</p>' }])
  await vi.waitFor(() => expect(s.status(insertion.update_id).action_id).toBeDefined())
  expect(s.status(insertion.update_id).state).toBe('waiting_input')
  expect(readRelation().continuation_update_id).toBeUndefined()
  await publish(s, s.status(insertion.update_id).action_id)
  await vi.waitFor(() => expect(s.status(insertion.update_id).state).toBe('succeeded'))
  await vi.waitFor(() => expect(readRelation().continuation_state).toBe('started'))
  const continuation = await model.register(readRelation().continuation_update_id!)
  expect(continuation.region_ids).toEqual(expect.arrayContaining([alpha, beta]))
  expect(continuation.base_manifest.view_revision).toBe(s.snapshot().views[0]!.revision)
  await model.release(continuation.update_id, [['Alpha original', 'Continued Alpha'], ['Beta original', 'Continued Beta']])
  await vi.waitFor(() => expect(s.status(continuation.update_id).action_id).toBeDefined())
  await publish(s, s.status(continuation.update_id).action_id)
  await vi.waitFor(() => expect(s.status(continuation.update_id).state).toBe('succeeded'))
  const html = s.snapshot().views[0]!.bundle.html
  expect(html).toContain('Continued Alpha')
  expect(html).toContain('Continued Beta')
  expect(html).toContain('Inserted between chapters')
  expect(html).not.toContain('Late whole-document content')
  expect(s.status(insertion.update_id).state).toBe('succeeded')
})

test('a correction of continued content retains the original user requirement source', async () => {
  const s = setup(), mapped = await original(s), model = chapterModel(s), tree = mapped.content_tree!
  const html = s.snapshot().views[0]!.bundle.html, paragraph = tree.nodes.find(node => node.kind === 'paragraph' && html.slice(node.span.start, node.span.end).includes('Alpha original'))!
  const parent = start(s, mapped, 'Alpha', 'source-parent')
  await model.register(parent.update_id)
  const child = startNodes(s, mapped, [paragraph.node_id], 'source-child')
  await model.register(child.update_id)
  await model.release(parent.update_id, [])
  await model.release(child.update_id, [['Alpha original', 'Newest child content']])
  await vi.waitFor(() => expect(s.status(child.update_id).action_id).toBeDefined())
  await publish(s, s.status(child.update_id).action_id)
  await vi.waitFor(() => expect(s.status(child.update_id).state).toBe('succeeded'))
  let continuation!: ChapterUpdate
  await vi.waitFor(() => {
    const row = s.internal().db.prepare('SELECT payload_json FROM runner_content_intent_relations WHERE task_id=? AND update_id=? AND previous_update_id=?').get(s.task, child.update_id, parent.update_id) as { payload_json: string }
    const relation = JSON.parse(row.payload_json)
    expect(relation.continuation_state).toBe('started')
    continuation = s.status(relation.continuation_update_id)
    expect(model.pending.has(continuation.update_id)).toBe(true)
  })
  continuation = await model.register(continuation.update_id)
  const next = startNodes(s, mapped, continuation.region_ids, 'continued-source-correction')
  const registeredNext = await model.register(next.update_id)
  await model.release(continuation.update_id, [])
  await vi.waitFor(() => expect(model.registrations.has(next.update_id)).toBe(true))
  expect(registeredNext.previous_update_ids).toContain(continuation.update_id)
  expect(s.status(continuation.update_id).state).toBe('superseded')
  const requirements = model.registrations.get(next.update_id)!.inherited_requirements
  expect(requirements).toContainEqual(expect.objectContaining({ source_record_id: parent.record_id, text: parent.text, node_ids: continuation.region_ids }))
  expect(requirements.some(requirement => (requirement as { source_record_id: string }).source_record_id === continuation.record_id)).toBe(false)
})

test('restart resumes a reserved remainder identity once when no continuation update was installed', async () => {
  const s = setup(), mapped = await original(s), model = chapterModel(s), tree = mapped.content_tree!
  const before = s.snapshot().views[0]!, paragraph = tree.nodes.find(node => node.kind === 'paragraph' && before.bundle.html.slice(node.span.start, node.span.end).includes('Alpha original'))!
  const parent = start(s, mapped, 'Alpha', 'reserved-parent')
  await model.register(parent.update_id)
  const pause = vi.spyOn(s.store as unknown as { resumeContentRemainders(task: string): void }, 'resumeContentRemainders').mockImplementation(() => {})
  const child = startNodes(s, mapped, [paragraph.node_id], 'reserved-child')
  await model.release(child.update_id, [['Alpha original', 'Published child before crash']])
  await vi.waitFor(() => expect(s.status(child.update_id).action_id).toBeDefined())
  await publish(s, s.status(child.update_id).action_id)
  await vi.waitFor(() => expect(s.status(child.update_id).state).toBe('succeeded'))
  const row = s.internal().db.prepare('SELECT payload_json FROM runner_content_intent_relations WHERE task_id=? AND update_id=? AND previous_update_id=?').get(s.task, child.update_id, parent.update_id) as { payload_json: string }
  const reservedId = 'reserved-remainder-after-crash', relation = { ...JSON.parse(row.payload_json), continuation_update_id: reservedId, continuation_state: 'starting' }
  s.internal().db.prepare('UPDATE runner_content_intent_relations SET payload_json=? WHERE task_id=? AND update_id=? AND previous_update_id=?').run(JSON.stringify(relation), s.task, child.update_id, parent.update_id)
  expect(s.internal().db.prepare('SELECT update_id FROM runner_chapter_updates WHERE task_id=? AND update_id=?').get(s.task, reservedId)).toBeUndefined()
  // The injected service represents model configuration restored by the host.
  const keepModels = vi.spyOn(s.store.models, 'close').mockImplementation(() => {})
  const configuredAcquire = vi.mocked(s.store.models.acquire).getMockImplementation()!
  let configured = false
  vi.mocked(s.store.models.acquire).mockImplementation((...input) => {
    if (!configured) throw new ContractError('MODEL_NOT_CONFIGURED', 'Model configuration is unavailable during startup')
    return configuredAcquire(...input)
  })
  s.restart()
  keepModels.mockRestore()
  pause.mockRestore()
  await s.store.recoverRunnerWork()
  const unavailable = JSON.parse((s.internal().db.prepare('SELECT payload_json FROM runner_content_intent_relations WHERE task_id=? AND update_id=? AND previous_update_id=?').get(s.task, child.update_id, parent.update_id) as { payload_json: string }).payload_json)
  expect(unavailable).toMatchObject({ continuation_state: 'deferred', continuation_update_id: reservedId, code: 'MODEL_NOT_CONFIGURED' })
  expect(s.internal().db.prepare('SELECT update_id FROM runner_chapter_updates WHERE task_id=? AND update_id=?').get(s.task, reservedId)).toBeUndefined()
  configured = true
  await s.store.recoverRunnerWork()
  await vi.waitFor(() => {
    const persisted = JSON.parse((s.internal().db.prepare('SELECT payload_json FROM runner_content_intent_relations WHERE task_id=? AND update_id=? AND previous_update_id=?').get(s.task, child.update_id, parent.update_id) as { payload_json: string }).payload_json)
    expect(model.pending.has(reservedId), JSON.stringify({ relation: persisted, ended: s.records('chapter.update.ended') })).toBe(true)
  })
  const continuation = s.status(reservedId)
  expect(continuation).toMatchObject({ text: parent.text, request_id: parent.request_id, candidate_region_ids: relation.retained_node_ids, region_ids: [] })
  await s.store.recoverRunnerWork()
  await s.store.recoverRunnerWork()
  expect(s.records('chapter.input.received').filter(record => record.chapter_input.update_id === reservedId)).toHaveLength(1)
  expect(s.records('worker.input').filter(record => record.owner.update_id === reservedId)).toHaveLength(1)
  await model.release(reservedId, [['Alpha input', 'Recovered Alpha input']])
  await vi.waitFor(() => expect(s.status(reservedId).action_id).toBeDefined())
  await publish(s, s.status(reservedId).action_id)
  await vi.waitFor(() => expect(s.status(reservedId).state).toBe('succeeded'))
  expect(s.snapshot().views[0]!.bundle.html).toContain('Published child before crash')
  expect(s.snapshot().views[0]!.bundle.html).toContain('Recovered Alpha input')
  expect(s.internal().db.prepare('SELECT COUNT(*) n FROM runner_chapter_publications WHERE task_id=? AND update_id=?').get(s.task, reservedId)).toEqual({ n: 1 })
})

test('cancellation and model failure retain the original chapter and do not revive after restart', async () => {
  const s = setup(), mapped = await original(s), model = chapterModel(s)
  const cancelled = start(s, mapped, 'Alpha', 'cancelled-alpha')
  await vi.waitFor(() => expect(model.pending.has(cancelled.update_id)).toBe(true))
  s.store.handle({ type: 'chapter.cancel', task_id: s.task, update_id: cancelled.update_id })
  await model.release(cancelled.update_id, [['Alpha original', 'Cancelled late result']])
  expect(s.status(cancelled.update_id).state).toBe('cancelled')
  s.complete.mockRejectedValueOnce(new ModelError('REMOTE_FAILURE'))
  const failed = start(s, mapped, 'Beta', 'failed-beta')
  await vi.waitFor(() => expect(s.status(failed.update_id).state).toBe('failed'))
  expect(s.snapshot().views[0]!.bundle.html).toBe(bundle().html)
  const requests = s.complete.mock.calls.length
  s.restart()
  expect(s.status(cancelled.update_id).state).toBe('cancelled')
  expect(s.status(failed.update_id).state).toBe('failed')
  expect(s.snapshot().views[0]!.bundle.html).toBe(bundle().html)
  expect(s.complete).toHaveBeenCalledTimes(requests)
})

test('a disabled publication settles the known failure and retains the original chapter', async () => {
  const s = setup(), mapped = await original(s), before = s.snapshot().views[0]!
  s.internal().features.viewReplacement = false
  const model = chapterModel(s), update = start(s, mapped, 'Alpha', 'disabled-publication')
  await model.release(update.update_id, [['Alpha original', 'Undelivered Alpha result']])
  await vi.waitFor(() => expect(s.status(update.update_id)).toMatchObject({ state: 'failed', reason: 'CAPABILITY_DISABLED' }))
  const failed = s.status(update.update_id)
  expect(s.internal().db.prepare('SELECT state,result,result_json FROM actions WHERE id=?').get(failed.action_id)).toEqual({ state: 'ended', result: 'not_executed', result_json: JSON.stringify({ code: 'CAPABILITY_DISABLED' }) })
  expect(s.internal().db.prepare('SELECT state FROM runner_chapter_publications WHERE operation_id=?').get(failed.publication_operation_id)).toEqual({ state: 'failure' })
  expect(s.snapshot().views[0]!.bundle.html).toBe(before.bundle.html)
  expect(s.snapshot().views[0]!.revision).toBe(before.revision)
  expect(s.snapshot().surface_updates).toEqual([])
  await vi.waitFor(() => expect(s.state().run(update.source!.run_id).state).toBe('failed'))
  expect(s.internal().db.prepare('SELECT COUNT(*) n FROM runner_chapter_publications WHERE update_id=?').get(update.update_id)).toEqual({ n: 1 })
})

test('successful original-result lookup survives restart without replaying a chapter write', async () => {
  const s = setup(), mapped = await original(s), model = chapterModel(s)
  const update = start(s, mapped, 'Alpha', 'recovered-alpha')
  await model.release(update.update_id, [['Alpha original', 'Durable Alpha result']])
  await vi.waitFor(() => expect(s.status(update.update_id).action_id).toBeDefined())
  await publish(s, s.status(update.update_id).action_id)
  await vi.waitFor(() => expect(s.status(update.update_id).state).toBe('succeeded'))
  const completed = s.status(update.update_id), content = s.snapshot().views[0]!, requests = s.complete.mock.calls.length
  s.restart()
  expect(s.status(update.update_id)).toMatchObject({ state: 'succeeded', publication_operation_id: completed.publication_operation_id, action_id: completed.action_id })
  expect(s.snapshot().views[0]!.bundle.html).toBe(content.bundle.html)
  expect(s.snapshot().views[0]!.revision).toBe(content.revision)
  expect(s.complete).toHaveBeenCalledTimes(requests)
  expect(s.internal().db.prepare('SELECT COUNT(*) n FROM runner_chapter_publications WHERE update_id=?').get(update.update_id)).toEqual({ n: 1 })
})

test.each(['move', 'delete'] as const)('a published %s keeps its tree and original operation stable after restart', async kind => {
  const s = setup(), mapped = await original(s), model = chapterModel(s), tree = mapped.content_tree!
  const runtime = s.store as unknown as { replaceSurface(...input: unknown[]): Promise<unknown> }
  const replaceSurface = runtime.replaceSurface.bind(runtime)
  const lostAcknowledgement = kind === 'move' ? vi.spyOn(runtime, 'replaceSurface').mockImplementationOnce(async (...input) => {
    await replaceSurface(...input)
    throw new Error('Publication acknowledgement lost after commit')
  }) : undefined
  const paragraph = tree.nodes.find(node => node.kind === 'paragraph')!, beta = mapped.chapters.find(chapter => chapter.title === 'Beta')!
  const operation = kind === 'move'
    ? { type: 'move' as const, node_ids: [paragraph.node_id], parent_id: tree.root_id, position: 'before' as const, anchor_id: beta.region_id }
    : { type: 'delete' as const, node_ids: [paragraph.node_id] }
  const update = startNodes(s, mapped, [tree.root_id], 'recovered-' + kind, [operation])
  await model.release(update.update_id, [], [operation])
  await vi.waitFor(() => expect(s.status(update.update_id).action_id).toBeDefined())
  await publish(s, s.status(update.update_id).action_id)
  await vi.waitFor(() => expect(s.status(update.update_id).state).toBe('succeeded'))
  if (lostAcknowledgement) expect(lostAcknowledgement).toHaveBeenCalledTimes(1)
  const completed = s.status(update.update_id), view = s.snapshot().views[0]!, currentTree = view.chapter_manifest!.content_tree!
  if (kind === 'move') expect(currentTree.nodes.find(node => node.node_id === paragraph.node_id)).toMatchObject({ parent_id: tree.root_id, revision: paragraph.revision, position_revision: paragraph.position_revision + 1 })
  else {
    expect(currentTree.nodes.some(node => node.node_id === paragraph.node_id)).toBe(false)
    expect(currentTree.lineage).toContainEqual(expect.objectContaining({ previous_node_id: paragraph.node_id, successor_node_ids: [] }))
  }
  const originalPublication = new ChapterState(s.internal().db).publication(s.task, completed.publication_operation_id!)
  const action = s.internal().db.prepare('SELECT request_json,result_json FROM actions WHERE id=?').get(completed.action_id)
  const actionCount = s.internal().db.prepare('SELECT COUNT(*) n FROM actions WHERE task_id=?').get(s.task), requests = s.complete.mock.calls.length
  s.restart()
  for (let query = 0; query < 2; query++) {
    expect(s.status(update.update_id)).toEqual(completed)
    expect(new ChapterState(s.internal().db).publication(s.task, completed.publication_operation_id!)).toEqual(originalPublication)
  }
  expect(s.snapshot().views[0]!.bundle.html).toBe(view.bundle.html)
  expect(s.snapshot().views[0]!.chapter_manifest!.content_tree).toEqual(currentTree)
  expect(s.internal().db.prepare('SELECT request_json,result_json FROM actions WHERE id=?').get(completed.action_id)).toEqual(action)
  expect(s.internal().db.prepare('SELECT COUNT(*) n FROM actions WHERE task_id=?').get(s.task)).toEqual(actionCount)
  expect(s.internal().db.prepare('SELECT COUNT(*) n FROM runner_chapter_publications WHERE update_id=?').get(update.update_id)).toEqual({ n: 1 })
  expect(s.complete).toHaveBeenCalledTimes(requests)
})

test('restart interrupts generation and never revives a late chapter result', async () => {
  const s = setup(), mapped = await original(s), model = chapterModel(s)
  const update = start(s, mapped, 'Alpha', 'interrupted-generation')
  await vi.waitFor(() => expect(model.pending.has(update.update_id)).toBe(true))
  const calls = s.complete.mock.calls.length, before = s.snapshot().views[0]!
  s.restart()
  expect(s.status(update.update_id).state).toBe('interrupted')
  await model.release(update.update_id, [['Alpha original', 'Late result after restart']])
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(s.status(update.update_id).state).toBe('interrupted')
  expect(s.snapshot().views[0]!.bundle.html).toBe(before.bundle.html)
  expect(s.snapshot().views[0]!.revision).toBe(before.revision)
  expect(s.complete).toHaveBeenCalledTimes(calls)
  expect(s.records('chapter.proposal.accepted').some(record => record.update_id === update.update_id)).toBe(false)
})

test('restart settles the original pending publication without replaying or changing content', async () => {
  const s = setup(), mapped = await original(s), model = chapterModel(s)
  const update = start(s, mapped, 'Alpha', 'interrupted-publication')
  await model.release(update.update_id, [['Alpha original', 'Unconfirmed result']])
  await vi.waitFor(() => expect(s.status(update.update_id).action_id).toBeDefined())
  const action = await awaitHostCheck(s, s.status(update.update_id).action_id)
  const pending = s.status(update.update_id), before = s.snapshot().views[0]!, calls = s.complete.mock.calls.length
  s.restart()
  const recovered = s.status(update.update_id)
  expect(recovered).toMatchObject({ state: 'interrupted', action_id: action, publication_operation_id: pending.publication_operation_id })
  expect(s.snapshot().views[0]!.bundle.html).toBe(before.bundle.html)
  expect(s.snapshot().views[0]!.revision).toBe(before.revision)
  expect(s.snapshot().surface_updates).toEqual([])
  expect(s.complete).toHaveBeenCalledTimes(calls)
  expect(s.internal().db.prepare('SELECT COUNT(*) n FROM runner_chapter_publications WHERE update_id=?').get(update.update_id)).toEqual({ n: 1 })
  expect(s.internal().db.prepare('SELECT state,result FROM actions WHERE id=?').get(action)).toEqual({ state: 'ended', result: 'not_executed' })
})

test('a follow-up waits for the exact chapter update and uses its published reply', async () => {
  const s = setup(true), mapped = await original(s), model = chapterModel(s)
  s.complete.mockResolvedValueOnce(answer({ kind: 'update', view_id: mapped.view_id, region_ids: [mapped.chapters[0]!.region_id] }))
  const routerIndex = s.complete.mock.calls.length
  const request = s.store.handle({ type: 'request.submit', task_id: s.task, text: 'Rewrite the first section using the earlier context.', model_config_id: 'chapter-model', resource_ids: [], import_ids: [] }) as { request_id: string }
  const status = () => s.store.handle({ type: 'request.status', task_id: s.task, request_id: request.request_id }) as { state: string; run_id: string }
  await vi.waitFor(() => expect(status().state).toBe('started'))
  const update = s.status('chapter-update:' + request.request_id)
  await vi.waitFor(() => expect(model.pending.has(update.update_id)).toBe(true))
  const accepted = s.records('chapter.input.received').find(record => record.chapter_input.update_id === update.update_id)!
  const userRecords = s.internal().db.prepare("SELECT id,payload_json FROM records WHERE task_id=? AND kind='message.user' AND json_extract(payload_json,'$.request_id')=?").all(s.task, request.request_id) as { id: string; payload_json: string }[]
  expect(userRecords).toHaveLength(1)
  expect(accepted.source_record_id).toBe(userRecords[0]!.id)
  expect(update.request_id).toBe(mapped.request_id)
  expect(update.source?.run_id).toBe(status().run_id)
  expect(s.state().run(status().run_id)).toMatchObject({ message_id: userRecords[0]!.id })
  expect(s.internal().db.prepare('SELECT COUNT(*) n FROM runner_current_content_plans WHERE task_id=?').get(s.task)).toEqual({ n: 1 })
  const routeCall = s.complete.mock.calls[routerIndex]!
  expect(routeCall[3]!.map(tool => tool.function.name)).toEqual(['list', 'read'])
  expect(routeCall[2].some(message => message.role === 'tool')).toBe(false)
  const exactMessage = userRecords[0]!.id, followText = 'Follow up only after that chapter is updated.'
  const admissions = vi.spyOn(s.store as unknown as { startQueuedRequest(...args: unknown[]): unknown }, 'startQueuedRequest')
  const resumeChapter = s.complete.getMockImplementation()!
  s.complete.mockResolvedValueOnce(answer({ kind: 'depends', message_id: exactMessage }))
  s.complete.mockImplementation((...args) => {
    const last = args[2].at(-1)?.content
    if (!last?.includes(followText)) return resumeChapter(...args)
    expect(JSON.parse(last).preceding_result).toMatchObject({ kind: 'runner.answer', text: '更新已完成。' })
    return Promise.resolve(answer({ kind: 'reply', text: 'I used the updated chapter result.' }))
  })
  const follow = s.store.handle({ type: 'request.submit', task_id: s.task, text: followText, model_config_id: 'chapter-model', resource_ids: [], import_ids: [] }) as { request_id: string }
  const followStatus = () => s.store.handle({ type: 'request.status', task_id: s.task, request_id: follow.request_id })
  await vi.waitFor(() => expect(admissions.mock.calls.filter(args => args[4] === follow.request_id).length).toBeGreaterThanOrEqual(2))
  expect(followStatus()).toMatchObject({ state: 'queued', code: 'CONVERSATION_WAITING_FOR_RESULT' })
  await model.release(update.update_id, [['Alpha original', 'Alpha revised from the conversation']])
  await vi.waitFor(() => expect(s.status(update.update_id).action_id).toBeDefined())
  await publish(s, s.status(update.update_id).action_id)
  await vi.waitFor(() => expect(s.status(update.update_id).state).toBe('succeeded'))
  expect(s.snapshot().views).toHaveLength(1)
  expect(s.snapshot().views[0]).toMatchObject({ id: mapped.view_id, revision: mapped.view_revision + 1 })
  expect(s.snapshot().views[0]!.bundle.html).toContain('Alpha revised from the conversation')
  expect(s.snapshot().views[0]!.bundle.html).toContain('Beta original')
  await vi.waitFor(() => expect(followStatus()).toMatchObject({ state: 'started', run_state: 'completed' }))
  expect(s.records('conversation.reply')).toMatchObject([{ request_id: follow.request_id, text: 'I used the updated chapter result.' }])
})

test('view-only routing lets the worker read before registering its precise target', async () => {
  const s = setup(), mapped = await original(s), model = chapterModel(s), before = s.snapshot().views[0]!
  s.complete.mockResolvedValueOnce(answer({ kind: 'update', view_id: mapped.view_id }))
  const submitted = s.store.handle({ type: 'request.submit', task_id: s.task, text: 'Rewrite the introductory paragraph while preserving the rest.', model_config_id: 'chapter-model', resource_ids: [], import_ids: [] }) as { request_id: string }
  const updateId = 'chapter-update:' + submitted.request_id
  await vi.waitFor(() => expect(model.pending.has(updateId)).toBe(true))
  const exploring = s.status(updateId)
  expect(exploring.scope_revision).toBe(0)
  expect(exploring.candidate_region_ids).toEqual([mapped.content_tree!.root_id])
  expect(exploring.region_ids).toEqual([])
  expect(s.snapshot().views[0]!.bundle).toEqual(before.bundle)
  const paragraph = mapped.content_tree!.nodes.find(node => node.kind === 'paragraph')!
  await model.release(updateId, [['Alpha original', 'Introduction revised']], undefined, [paragraph.node_id])
  await vi.waitFor(() => expect(s.status(updateId).action_id).toBeDefined())
  expect(s.status(updateId)).toMatchObject({ scope_revision: 1, region_ids: [paragraph.node_id] })
  expect(s.records('runner.answer').some(record => record.update_id === updateId)).toBe(false)
  await publish(s, s.status(updateId).action_id)
  await vi.waitFor(() => expect(s.status(updateId).state).toBe('succeeded'))
  expect(s.snapshot().views[0]!.bundle.html).toBe(before.bundle.html.replace('Alpha original', 'Introduction revised'))
})

test('the first modification of a structured legacy View installs a reliable chapter mapping before routing', async () => {
  const s = setup(), previous = await original(s)
  // A View published by an older application version has no chapter metadata.
  s.internal().db.transaction(() => {
    s.internal().db.prepare('DELETE FROM runner_chapter_heads WHERE task_id=?').run(s.task)
    s.internal().db.prepare('DELETE FROM runner_chapter_manifests WHERE task_id=?').run(s.task)
    s.internal().db.prepare("DELETE FROM runner_chapter_resources WHERE task_id=? AND owner_kind='manifest'").run(s.task)
    s.internal().db.prepare('DELETE FROM runner_content_tree_heads WHERE task_id=?').run(s.task)
    s.internal().db.prepare('DELETE FROM runner_content_trees WHERE task_id=?').run(s.task)
  })()
  expect(s.snapshot().views[0]!.chapter_manifest).toBeUndefined()
  const model = chapterModel(s)
  s.complete.mockImplementationOnce(async () => {
    const restored = s.snapshot().views[0]!.chapter_manifest!
    expect(restored.chapters.map(chapter => chapter.title)).toEqual(['Alpha', 'Beta'])
    expect(restored.request_id).toBe(previous.request_id)
    return answer({ kind: 'update', view_id: restored.view_id, region_ids: [restored.chapters[0]!.region_id] })
  })
  const request = s.store.handle({ type: 'request.submit', task_id: s.task, text: 'Rewrite the first chapter using the earlier context.', model_config_id: 'chapter-model', resource_ids: [], import_ids: [] }) as { request_id: string }
  await vi.waitFor(() => expect(s.store.handle({ type: 'request.status', task_id: s.task, request_id: request.request_id })).toMatchObject({ state: 'started' }))
  const update = s.status('chapter-update:' + request.request_id)
  expect(update.request_id).toBe(previous.request_id)
  await model.release(update.update_id, [['Alpha original', 'Legacy Alpha revised']])
  await vi.waitFor(() => expect(s.status(update.update_id).action_id).toBeDefined())
  await publish(s, s.status(update.update_id).action_id)
  await vi.waitFor(() => expect(s.status(update.update_id).state).toBe('succeeded'))
  expect(s.snapshot().views[0]!.bundle.html).toContain('Legacy Alpha revised')
  expect(s.snapshot().views[0]!.bundle.html).toContain('Beta original')
  expect(s.internal().db.prepare('SELECT COUNT(*) n FROM runner_current_content_plans WHERE task_id=?').get(s.task)).toEqual({ n: 1 })
})

test('generic content receives a tree while ambiguous routing preserves the published content', async () => {
  const s = setup(), content = bundle()
  content.html = '<section><h2 id="a-title">Alpha</h2><p>Alpha original</p><label for="a-input">Alpha input</label><input id="a-input"><h2 id="b-title">Beta</h2><p>Beta original</p><label for="b-input">Beta input</label><input id="b-input"></section>'
  const before = await publishOriginal(s, content), calls = s.complete.mock.calls.length, runs = s.snapshot().runs.length
  expect(before.chapter_manifest?.content_tree).toBeDefined()
  s.complete.mockResolvedValueOnce(answer({ kind: 'ambiguous' }))
  const text = 'Please revise the relevant part using the earlier context.'
  const request = s.store.handle({ type: 'request.submit', task_id: s.task, text, model_config_id: 'chapter-model', resource_ids: [], import_ids: [] }) as { request_id: string }
  await vi.waitFor(() => expect(s.store.handle({ type: 'request.status', task_id: s.task, request_id: request.request_id })).toMatchObject({ state: 'confirmation_required', code: 'CHAPTER_SCOPE_REQUIRED' }))
  const routeCall = s.complete.mock.calls[calls]!
  expect(routeCall[3]!.map(tool => tool.function.name)).toEqual(['list', 'read'])
  expect(routeCall[2][0]!.content).toContain('Content directory: ')
  expect(routeCall[2][0]!.content).not.toContain('Alpha original')
  const stored = s.internal().db.prepare('SELECT input_json FROM requests WHERE id=?').get(request.request_id) as { input_json: string }
  expect(JSON.parse(stored.input_json).text).toBe(text)
  expect(s.snapshot().views[0]!.bundle.html).toBe(content.html)
  expect(s.snapshot().views[0]!.revision).toBe(before.revision)
  expect(s.snapshot().views[0]!.chapter_manifest).toEqual(before.chapter_manifest)
  expect(s.snapshot().runs).toHaveLength(runs)
  expect(s.complete).toHaveBeenCalledTimes(calls + 1)
  expect(s.internal().db.prepare('SELECT COUNT(*) n FROM runner_chapter_updates WHERE task_id=?').get(s.task)).toEqual({ n: 0 })
  expect(s.internal().db.prepare('SELECT COUNT(*) n FROM runner_current_content_plans WHERE task_id=?').get(s.task)).toEqual({ n: 1 })
})

test('ambiguous routing preserves the complete request, selection, materials and conversation for explicit scope', async () => {
  const s = setup(), mapped = await original(s), model = chapterModel(s)
  s.complete.mockResolvedValueOnce(answer({ kind: 'ambiguous' }))
  const text = '请修改相关章节。\n' + '这条详细要求需要完整保留。'.repeat(80) + '\n原文末尾也必须保留。'
  const before = s.snapshot().views[0]!, runs = s.snapshot().runs.length
  const request = s.store.handle({ type: 'request.submit', task_id: s.task, text, model_config_id: 'chapter-model', resource_ids: [mapped.bundle_resource_id], import_ids: [] }) as { request_id: string }
  const status = () => s.store.handle({ type: 'request.status', task_id: s.task, request_id: request.request_id }) as { state: string; code: string; text: string; text_truncated: boolean; model_selection: unknown }
  await vi.waitFor(() => expect(status()).toMatchObject({ state: 'confirmation_required', code: 'CHAPTER_SCOPE_REQUIRED', text_truncated: true }))
  const raw = s.internal().db.prepare('SELECT input_json,config_selection_json FROM requests WHERE id=?').get(request.request_id) as { input_json: string; config_selection_json: string }
  const originalInput = JSON.parse(raw.input_json)
  expect(s.snapshot().views[0]!.bundle.html).toBe(before.bundle.html)
  expect(s.snapshot().views[0]!.chapter_updates).toEqual([])
  expect(s.snapshot().runs).toHaveLength(runs)
  const chosen = s.store.handle({ type: 'chapter.update', task_id: s.task, input_event_id: 'clarification-input', update_id: 'clarification-update', source_request_id: request.request_id, view_id: mapped.view_id, view_revision: before.revision, state_revision: before.state_revision, region_ids: [mapped.chapters[0]!.region_id], text: status().text, model_config_id: 'unrelated-current-selection' }) as ChapterUpdate
  await vi.waitFor(() => expect(model.pending.has(chosen.update_id)).toBe(true))
  expect(chosen.text).toBe(text)
  expect(chosen.model_config_id).toBe('chapter-model')
  expect(status().state).toBe('started')
  expect(status().model_selection).toEqual(JSON.parse(raw.config_selection_json))
  const accepted = s.records('chapter.input.received').find(record => record.chapter_input.update_id === chosen.update_id)!
  expect(accepted).toMatchObject({ text, source_record_id: originalInput.user_record_id, material_resource_ids: [mapped.bundle_resource_id] })
  expect(accepted.conversation).toEqual(originalInput.conversation)
  const workerInput = s.records('worker.input').find(record => record.owner.update_id === chosen.update_id)!
  expect(workerInput.text).toBe(text)
  const conversation = loadConversation(s.internal().db, s.task, originalInput.conversation)
  expect(workerInput.conversation_history.refs).toEqual(conversation.refs)
  expect(s.records('worker.conversation').filter(record => record.owner.update_id === chosen.update_id).map(record => ({ source: record.conversation_source, message: record.message }))).toEqual(conversation.messages)
  expect(s.internal().db.prepare('SELECT COUNT(*) n FROM runner_current_content_plans WHERE task_id=?').get(s.task)).toEqual({ n: 1 })
})

test.each([false, true])('a clarification merges both attachments and validates them before starting (missing=%s)', async missing => {
  const s = setup(true), mapped = await original(s), model = chapterModel(s)
  const db = s.internal().db
  const send = (text: string, resource_ids: string[] = []) => s.store.handle({ type: 'request.submit', task_id: s.task, text, model_config_id: 'chapter-model', resource_ids, import_ids: [] }) as { request_id: string }
  const status = (request: { request_id: string }) => s.store.handle({ type: 'request.status', task_id: s.task, request_id: request.request_id })
  s.complete.mockResolvedValueOnce(answer({ kind: 'ambiguous' })).mockResolvedValueOnce(answer({ kind: 'ambiguous' }))
  const originalRequest = send('Please revise the introduction.', [mapped.bundle_resource_id]), other = send('Please expand the comparison.')
  await vi.waitFor(() => expect(status(originalRequest)).toMatchObject({ state: 'confirmation_required', code: 'CHAPTER_SCOPE_REQUIRED' }))
  await vi.waitFor(() => expect(status(other)).toMatchObject({ state: 'confirmation_required', code: 'CHAPTER_SCOPE_REQUIRED' }))
  const reply = db.prepare("SELECT id FROM records WHERE task_id=? AND kind='chapter.route.clarification' AND json_extract(payload_json,'$.request_id')=?").get(s.task, originalRequest.request_id) as { id: string }
  const operation_id = (s.store.handle({ type: 'material.internal.register', task_id: s.task, items: [{ display_name: 'Clarification.txt', source: 'text' }] }) as { items: { operation_id: string }[] }).items[0]!.operation_id
  const attachment = Buffer.from('Extra notes for the revised introduction.')
  s.store.handle({ type: 'material.internal.begin', task_id: s.task, operation_id, byte_length: attachment.length, media_type: 'text/plain; charset=utf-8' })
  s.store.handle({ type: 'material.internal.chunk', task_id: s.task, operation_id, offset: 0, data: attachment.toString('base64') })
  const extra = (s.store.handle({ type: 'material.internal.finish', task_id: s.task, operation_id }) as { resource: { id: string } }).resource.id
  s.complete.mockImplementationOnce(async () => {
    if (missing) db.prepare('DELETE FROM task_resources WHERE task_id=? AND resource_id=?').run(s.task, extra)
    return answer({ kind: 'clarify', message_id: reply.id, update: { kind: 'update', view_id: mapped.view_id, region_ids: [mapped.chapters[0]!.region_id] } })
  })
  const clarified = send('For the introduction request, revise only the Alpha section.', [mapped.bundle_resource_id, extra])
  if (missing) {
    await vi.waitFor(() => expect(status(clarified)).toMatchObject({ state: 'confirmation_required', code: 'NOT_FOUND' }))
    expect(status(originalRequest)).toMatchObject({ state: 'confirmation_required', code: 'CHAPTER_SCOPE_REQUIRED' })
    expect(s.records('chapter.input.received')).toEqual([])
    return
  }
  const updateId = 'chapter-update:' + clarified.request_id
  await vi.waitFor(() => expect(model.pending.has(updateId)).toBe(true))
  expect(s.status(updateId).text).toContain('Please revise the introduction.')
  expect(s.status(updateId).text).toContain('revise only the Alpha section')
  expect(status(originalRequest)).toMatchObject({ state: 'started' })
  expect(status(other)).toMatchObject({ state: 'confirmation_required' })
  expect(s.records('chapter.input.received')).toMatchObject([{ material_resource_ids: [mapped.bundle_resource_id, extra] }])
  expect(s.state().taskWorks(s.task).find(work => work.run_id === s.status(updateId).source?.run_id && work.role === 'producer')?.dependencies).toContainEqual({ kind: 'resource', task_id: s.task, resource_id: extra })
  expect(s.internal().db.prepare("SELECT json_extract(input_json,'$.conversation_reference') AS reference FROM requests WHERE id=?").get(clarified.request_id)).toEqual({ reference: reply.id })
  await model.release(updateId, [['Alpha original', 'Alpha revised after clarification']])
  await vi.waitFor(() => expect(s.status(updateId).action_id).toBeDefined())
  await publish(s, s.status(updateId).action_id)
  await vi.waitFor(() => expect(s.status(updateId).state).toBe('succeeded'))
  expect(s.snapshot().views[0]!.bundle.html).toContain('Alpha revised after clarification')
})

test('scoped explanation reads exact content without hiding or updating it', async () => {
  const s = setup(), mapped = await original(s), gate = deferred<Completion>()
  let observed: { data: { data: { html: string } } } | undefined
  s.complete.mockImplementation(async (_config, _key, messages) => {
    const last = messages.at(-1)!
    if (last.role !== 'tool') return { text: '', finish: 'tool_calls', usage: { prompt_tokens: 30, completion_tokens: 10 }, calls: [{ id: 'explanation-content', type: 'function', function: { name: 'read', arguments: JSON.stringify({ kind: 'content_node', id: mapped.chapters[0]!.region_id }) } }] }
    observed = JSON.parse(last.content!)
    return gate.promise
  })
  s.complete.mockResolvedValueOnce(answer({ kind: 'explanation', view_id: mapped.view_id, region_ids: [mapped.chapters[0]!.region_id] }))
  const before = s.snapshot().views[0]!
  const request = s.store.handle({ type: 'request.submit', task_id: s.task, text: 'Explain this section without changing it.', model_config_id: 'chapter-model', resource_ids: [], import_ids: [] }) as { request_id: string }
  await vi.waitFor(() => expect(s.records('worker.input').some(record => record.owner.request_id === request.request_id)).toBe(true))
  const input = s.records('worker.input').find(record => record.owner.request_id === request.request_id)!
  expect(input.bound.content_query).toEqual({ view_id: mapped.view_id, node_ids: [mapped.chapters[0]!.region_id] })
  await vi.waitFor(() => expect(observed).toBeDefined())
  expect(observed!.data.data.html).toContain('Alpha original')
  expect(observed!.data.data.html).not.toContain('Beta original')
  expect(s.snapshot().views[0]!.bundle.html).toBe(before.bundle.html)
  expect(s.snapshot().views[0]!.chapter_updates).toEqual([])
  expect(s.internal().db.prepare('SELECT COUNT(*) n FROM runner_chapter_updates WHERE task_id=?').get(s.task)).toEqual({ n: 0 })
})

test('cancelling a pending semantic route prevents a late response from starting a Run', async () => {
  const s = setup(), mapped = await original(s), gate = deferred<Completion>()
  let routingSignal: AbortSignal | undefined
  s.complete.mockImplementationOnce(async (_config, _key, _messages, _tools, signal) => { routingSignal = signal; return gate.promise })
  const before = s.snapshot().runs.map(run => run.id)
  const request = s.store.handle({ type: 'request.submit', task_id: s.task, text: 'Please revise this part.', model_config_id: 'chapter-model', resource_ids: [], import_ids: [] }) as { request_id: string }
  await vi.waitFor(() => expect(routingSignal).toBeDefined())
  s.store.handle({ type: 'request.cancel', task_id: s.task, request_id: request.request_id })
  expect(routingSignal!.aborted).toBe(true)
  gate.resolve(answer({ kind: 'update', view_id: mapped.view_id, region_ids: [mapped.chapters[0]!.region_id] }))
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(s.store.handle({ type: 'request.status', task_id: s.task, request_id: request.request_id })).toMatchObject({ state: 'cancelled' })
  expect(s.snapshot().runs.map(run => run.id)).toEqual(before)
  expect(s.snapshot().views[0]!.chapter_updates).toEqual([])
  expect(s.records('chapter.route.resolved').some(record => record.request_id === request.request_id)).toBe(false)
})

test('a cancelled host check retains the original chapter and never creates a successor action', async () => {
  const s = setup(), mapped = await original(s), model = chapterModel(s)
  const update = start(s, mapped, 'Alpha', 'denied-publication')
  await model.release(update.update_id, [['Alpha original', 'Denied replacement']])
  await vi.waitFor(() => expect(s.status(update.update_id).action_id).toBeDefined())
  const before = s.status(update.update_id), action = await awaitHostCheck(s, before.action_id)
  expect(s.snapshot().approvals.filter(item => item.action_id === action)).toHaveLength(0)
  await s.store.handle({ type: 'surface.respond', task_id: s.task, action_id: action, proceed: false, confirm_discard: false })
  await vi.waitFor(() => expect(s.status(update.update_id).state).toBe('failed'))
  expect(s.status(update.update_id)).toMatchObject({ action_id: before.action_id, publication_operation_id: before.publication_operation_id })
  expect(s.snapshot().views[0]!.bundle.html).toBe(bundle().html)
  expect(s.snapshot().surface_updates).toEqual([])
  expect(s.internal().db.prepare('SELECT COUNT(*) n FROM runner_chapter_publications WHERE update_id=?').get(update.update_id)).toEqual({ n: 1 })
  expect(s.snapshot().approvals.filter(item => item.action_id === before.action_id)).toHaveLength(0)
  expect(s.records('chapter.publication.rebased').some(record => record.update_id === update.update_id)).toBe(false)
})

test.each(['replace', 'move', 'delete'] as const)('an uncertain %s action remains queryable after restart without a successor or model replay', async kind => {
  const s = setup(), mapped = await original(s), model = chapterModel(s)
  const tree = mapped.content_tree!, paragraph = tree.nodes.find(node => node.kind === 'paragraph')!, beta = mapped.chapters.find(chapter => chapter.title === 'Beta')!
  const operation = kind === 'move'
    ? { type: 'move' as const, node_ids: [paragraph.node_id], parent_id: tree.root_id, position: 'before' as const, anchor_id: beta.region_id }
    : { type: 'delete' as const, node_ids: [paragraph.node_id] }
  const update = kind === 'replace' ? start(s, mapped, 'Alpha', 'unknown-publication') : startNodes(s, mapped, [tree.root_id], 'unknown-' + kind, [operation])
  await model.release(update.update_id, [['Alpha original', 'Uncertain replacement']], kind === 'replace' ? undefined : [operation])
  await vi.waitFor(() => expect(s.status(update.update_id).action_id).toBeDefined())
  const action = await awaitHostCheck(s, s.status(update.update_id).action_id)
  const pending = s.status(update.update_id), calls = s.complete.mock.calls.length
  const live = () => (s.store.handle({ type: 'host.runner.flow', task_id: s.task }) as LiveFlowSnapshot).lanes
  expect(live().Host.items).toMatchObject([{ id: `chapter:${update.update_id}`, handoff: { from: 'Worker', kind: 'plan' } }])
  expect(live().Worker.items).toEqual([])
  const request = s.internal().db.prepare('SELECT request_json FROM actions WHERE id=?').get(action)
  const actionCount = s.internal().db.prepare('SELECT COUNT(*) n FROM actions WHERE task_id=?').get(s.task)
  // Emulate a persisted action whose transport closed without a known outcome.
  s.internal().db.prepare("UPDATE actions SET state='ended',result='unknown',result_json=?,commit_valid=0 WHERE id=?").run(JSON.stringify({ code: 'CONNECTION_LOST' }), action)
  s.restart()
  for (let query = 0; query < 2; query++) expect(s.status(update.update_id)).toMatchObject({ state: 'unknown', action_id: action, publication_operation_id: pending.publication_operation_id })
  expect(live().Host.items).toMatchObject([{ id: `chapter:${update.update_id}`, state: 'unknown' }])
  expect(s.snapshot().views[0]!.bundle.html).toBe(bundle().html)
  expect(s.snapshot().views[0]!.chapter_manifest!.content_tree).toEqual(tree)
  expect(s.internal().db.prepare('SELECT request_json FROM actions WHERE id=?').get(action)).toEqual(request)
  expect(s.internal().db.prepare('SELECT COUNT(*) n FROM actions WHERE task_id=?').get(s.task)).toEqual(actionCount)
  expect(s.internal().db.prepare('SELECT COUNT(*) n FROM runner_chapter_publications WHERE update_id=?').get(update.update_id)).toEqual({ n: 1 })
  expect(s.complete).toHaveBeenCalledTimes(calls)
})
