import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, expect, test, vi } from 'vitest'
import type { ArtifactCandidate, Bundle, ChapterManifest, ChapterUpdate, IpcRequest, ModelConfiguration } from '../../src/shared/contracts.generated'
import { ChatAdapter, ModelError, type Completion } from '../../src/runtime/model/adapter'
import { ModelService, type ModelLease } from '../../src/runtime/model/service'
import { RunnerArtifactState } from '../../src/runtime/runner/artifact-state'
import { RunnerWorkState } from '../../src/runtime/runner/work-state'
import { loadConversation } from '../../src/runtime/runner/conversation'
import { RuntimeStore } from '../../src/runtime/store'

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
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'pliuna-chapter-runtime-')), adapter = new ChatAdapter(), models = new ModelService(adapter)
  const config: ModelConfiguration = { id: 'chapter-model', base_url: 'https://example.invalid/v1', wire_model_id: 'fixture', context_tokens: 100000, max_output_tokens: 8192, compatibility_profile: 'chat-max-tokens' }
  models.configure({ type: 'model.configure', configuration: config, api_key: 'fixture-key', confirm_memory_only: true })
  vi.spyOn(models, 'acquire').mockImplementation((): ModelLease => ({ id: config.id, revision: 1, config, release: vi.fn() }))
  vi.spyOn(models, 'acquireCompaction').mockReturnValue(undefined)
  vi.spyOn(models, 'list').mockReturnValue([{ ...config, revision: 1, roles: ['main'], credential_missing: false }])
  let store = new RuntimeStore(directory, models, { viewReplacement: true, runner: { productionRuns: 2, collator: 'rule' } })
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  const internal = () => store as unknown as { db: Database.Database; epoch: string; features: { viewReplacement: boolean } }
  const task = store.create('Chapter runtime').task.id, complete = vi.spyOn(adapter, 'complete')
  const state = () => new RunnerWorkState(internal().db, internal().epoch)
  const snapshot = () => store.snapshot(task)
  const status = (update_id: string) => store.handle({ type: 'chapter.status', task_id: task, update_id }) as ChapterUpdate
  const records = (kind: string) => (internal().db.prepare('SELECT payload_json FROM records WHERE task_id=? AND kind=? ORDER BY sequence').all(task, kind) as { payload_json: string }[]).map(row => JSON.parse(row.payload_json))
  const restart = () => { store.close(); store = new RuntimeStore(directory, models, { viewReplacement: true, runner: { productionRuns: 2, collator: 'rule' } }); return store }
  return { get store() { return store }, internal, directory, task, complete, state, snapshot, status, records, restart }
}
type Fixture = ReturnType<typeof setup>

async function approval(s: Fixture, actionId?: string) {
  await vi.waitFor(() => expect(s.snapshot().approvals.find(item => item.decision === 'pending' && item.validity === 'valid' && (!actionId || item.action_id === actionId))).toBeDefined())
  return s.snapshot().approvals.find(item => item.decision === 'pending' && item.validity === 'valid' && (!actionId || item.action_id === actionId))!
}
async function approve(s: Fixture, actionId?: string) {
  const pending = await approval(s, actionId)
  await s.store.handle({ type: 'approval.decide', task_id: s.task, approval_id: pending.id, decision: 'approve' })
  await vi.waitFor(() => expect(s.snapshot().surface_updates.find(item => item.action_id === pending.action_id)).toBeDefined())
  return pending.action_id
}
async function publish(s: Fixture, actionId?: string) {
  const action = await approve(s, actionId)
  try { await s.store.handle({ type: 'surface.respond', task_id: s.task, action_id: action, proceed: true, confirm_discard: false }) }
  catch (error) { throw new Error(String(error) + ': ' + JSON.stringify(s.internal().db.prepare('SELECT state,result,result_json FROM actions WHERE id=?').get(action)), { cause: error }) }
  return action
}

async function publishOriginal(s: Fixture, content = bundle()) {
  s.complete.mockResolvedValueOnce(create(content))
  s.complete.mockImplementationOnce(async (_config, _key, messages) => {
    const result = JSON.parse(messages.at(-1)!.content!)
    expect(result).toMatchObject({ execution: 'success', data: { media_type: 'application/json' } })
    const producer = s.state().taskWorks(s.task).find(work => work.role === 'producer')!
    if (producer.purpose !== 'production') throw Error('Expected producer')
    const goal = s.state().goal(producer.request_id), section = new RunnerArtifactState(s.internal().db, s.state()).outline(s.task)!.sections[0]!
    const candidate: ArtifactCandidate = { candidate_id: 'original-candidate', task_id: s.task, request_id: producer.request_id, intent_revision: producer.intent_revision, run_id: producer.run_id, work_id: producer.work_id, attempt_id: producer.current_attempt_id!, artifact_id: 'original-artifact', base_artifact_revision: 0, plan_revision: producer.plan_revision, bundle_resource_id: result.data.id, section_id: section.section_id, section_position_revision: section.position_revision, order_key: section.order_key, presentation_kind: 'managed-v1', width_constraint: 'full', interaction_kind: 'input', provenance_ref: { task_id: s.task, kind: 'record', id: s.state().input(goal.input_event_id).record_id }, requirement_ids: producer.requirement_ids, unresolved: [], dependencies: producer.dependencies }
    return answer({ version: 1, complete: true, answer: '正文已完成。', artifacts: [candidate], requirement_ids: producer.requirement_ids, unresolved: [] })
  })
  const run = s.store.start(s.task, 'Create two independently editable chapters', 'chapter-model', [])
  await vi.waitFor(() => expect(s.state().run(run).state).toBe('completed'))
  await publish(s)
  await vi.waitFor(() => expect(s.snapshot().views).toHaveLength(1))
  return s.snapshot().views[0]!
}
async function original(s: Fixture): Promise<ChapterManifest> {
  const view = await publishOriginal(s)
  return s.store.handle({ type: 'chapters.map', task_id: s.task, view_id: view.id, expected_view_revision: view.revision }) as ChapterManifest
}
function chapterModel(s: Fixture) {
  const pending = new Map<string, ReturnType<typeof deferred<Completion>>>()
  s.complete.mockImplementation(async (_config, _key, messages) => {
    const system = messages.find(message => message.role === 'system')!.content!
    const binding = JSON.parse(system.slice(system.lastIndexOf('Bound data: ') + 'Bound data: '.length)) as { update_id: string }
    const update = s.status(binding.update_id)
    if (messages.at(-1)!.role !== 'tool') {
      const gate = deferred<Completion>(); pending.set(update.update_id, gate); return gate.promise
    }
    const result = JSON.parse(messages.at(-1)!.content!)
    expect(result).toMatchObject({ execution: 'success', data: { media_type: 'application/json' } })
    return answer({ bundle_resource_id: result.data.id, replacements: [{ previous_region_ids: update.region_ids, chapters: update.base_manifest.chapters.filter(chapter => update.region_ids.includes(chapter.region_id)).map(chapter => ({ ...chapter, revision: chapter.revision + 1, dependencies: update.dependencies })) }] })
  })
  return {
    pending,
    async release(updateId: string, replacements: [string, string][]) {
      await vi.waitFor(() => expect(pending.has(updateId)).toBe(true))
      const candidate = bundle()
      for (const [from, to] of replacements) candidate.html = candidate.html.replace(from, to)
      pending.get(updateId)!.resolve(create(candidate))
    }
  }
}
function start(s: Fixture, manifest: ChapterManifest, name: 'Alpha' | 'Beta', updateId: string): ChapterUpdate {
  const view = s.snapshot().views[0]!
  const request: Extract<IpcRequest, { type: 'chapter.update' }> = { type: 'chapter.update', task_id: s.task, input_event_id: 'input-' + updateId, update_id: updateId, view_id: view.id, view_revision: view.revision, state_revision: view.state_revision, region_ids: [manifest.chapters.find(chapter => chapter.title === name)!.region_id], text: 'Update ' + name + ' only: ' + updateId, model_config_id: 'chapter-model' }
  return s.store.handle(request) as ChapterUpdate
}

test('the host template publishes with only a real resource identity from the model', async () => {
  const s = setup(), mapped = await original(s), before = s.snapshot().views[0]!
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
  const action = await approve(s, s.status(begun.update_id).action_id)
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
  expect(s.internal().db.prepare('SELECT COUNT(*) n FROM runner_goal_heads WHERE task_id=?').get(s.task)).toEqual({ n: 1 })
})

test.each(['boundaries', 'body container', 'shared CSS'])('a candidate with invalid %s is corrected before accepting or publishing the chapter', async reason => {
  const s = setup(), mapped = await original(s), candidate = bundle()
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

test('independent chapters reassemble on the newest publication using an immutable successor action', async () => {
  const s = setup(), mapped = await original(s), model = chapterModel(s)
  const alpha = start(s, mapped, 'Alpha', 'parallel-alpha'), beta = start(s, mapped, 'Beta', 'parallel-beta')
  await model.release(alpha.update_id, [['Alpha original', 'Alpha concurrent']])
  await model.release(beta.update_id, [['Beta original', 'Beta concurrent']])
  await vi.waitFor(() => expect(s.status(alpha.update_id).action_id).toBeDefined())
  await vi.waitFor(() => expect(s.status(beta.update_id).action_id).toBeDefined())
  const originalBeta = s.status(beta.update_id), betaAction = originalBeta.action_id!
  const originalRequest = s.internal().db.prepare('SELECT request_json FROM actions WHERE id=?').get(betaAction)
  await publish(s, s.status(alpha.update_id).action_id)
  await vi.waitFor(() => expect(s.status(alpha.update_id).state).toBe('succeeded'))
  const oldApproval = await approval(s, betaAction)
  await s.store.handle({ type: 'approval.decide', task_id: s.task, approval_id: oldApproval.id, decision: 'approve' })
  await vi.waitFor(() => expect(s.snapshot().surface_updates.some(item => item.action_id === betaAction) || s.status(beta.update_id).action_id !== betaAction).toBe(true))
  if (s.snapshot().surface_updates.some(item => item.action_id === betaAction)) await Promise.resolve(s.store.handle({ type: 'surface.respond', task_id: s.task, action_id: betaAction, proceed: true, confirm_discard: false })).catch(error => expect(error).toHaveProperty('code'))
  await vi.waitFor(() => expect(s.status(beta.update_id).action_id).not.toBe(betaAction))
  const successor = s.status(beta.update_id)
  expect(s.internal().db.prepare('SELECT request_json FROM actions WHERE id=?').get(betaAction)).toEqual(originalRequest)
  expect(s.internal().db.prepare('SELECT previous_operation_id FROM runner_chapter_publications WHERE operation_id=?').get(successor.publication_operation_id)).toEqual({ previous_operation_id: originalBeta.publication_operation_id })
  await publish(s, successor.action_id)
  await vi.waitFor(() => expect(s.status(beta.update_id).state).toBe('succeeded'))
  expect(s.snapshot().views[0]!.bundle.html).toContain('Alpha concurrent')
  expect(s.snapshot().views[0]!.bundle.html).toContain('Beta concurrent')
  expect(model.pending.size).toBe(2)
})

test('same-chapter correction revokes a late result before accepting the new intent', async () => {
  const s = setup(), mapped = await original(s), model = chapterModel(s)
  const first = start(s, mapped, 'Alpha', 'old-alpha')
  await vi.waitFor(() => expect(model.pending.has(first.update_id)).toBe(true))
  const next = start(s, mapped, 'Alpha', 'new-alpha')
  expect(s.status(first.update_id).state).toBe('superseded')
  expect(next.previous_update_ids).toContain(first.update_id)
  await model.release(first.update_id, [['Alpha original', 'Late old result']])
  await model.release(next.update_id, [['Alpha original', 'Newest Alpha result']])
  await vi.waitFor(() => expect(s.status(next.update_id).action_id).toBeDefined())
  await publish(s, s.status(next.update_id).action_id)
  await vi.waitFor(() => expect(s.status(next.update_id).state).toBe('succeeded'))
  expect(s.snapshot().views[0]!.bundle.html).toContain('Newest Alpha result')
  expect(s.snapshot().views[0]!.bundle.html).not.toContain('Late old result')
  expect(s.status(first.update_id).state).toBe('superseded')
  expect(s.records('chapter.proposal.accepted').some(record => record.update_id === first.update_id)).toBe(false)
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
  const action = await approve(s, s.status(update.update_id).action_id)
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

test('semantic update routing keeps the original user record and business goal', async () => {
  const s = setup(), mapped = await original(s), model = chapterModel(s)
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
  expect(s.internal().db.prepare('SELECT COUNT(*) n FROM runner_goal_heads WHERE task_id=?').get(s.task)).toEqual({ n: 1 })
  const routeCall = s.complete.mock.calls[routerIndex]!
  expect(routeCall[3]).toEqual([])
  expect(routeCall[2].some(message => message.role === 'tool')).toBe(false)
})

test('the first modification of a structured legacy View installs a reliable chapter mapping before routing', async () => {
  const s = setup(), previous = await original(s)
  // A View published by an older application version has no chapter metadata.
  s.internal().db.transaction(() => {
    s.internal().db.prepare('DELETE FROM runner_chapter_heads WHERE task_id=?').run(s.task)
    s.internal().db.prepare('DELETE FROM runner_chapter_manifests WHERE task_id=?').run(s.task)
    s.internal().db.prepare("DELETE FROM runner_chapter_resources WHERE task_id=? AND owner_kind='manifest'").run(s.task)
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
  expect(s.internal().db.prepare('SELECT COUNT(*) n FROM runner_goal_heads WHERE task_id=?').get(s.task)).toEqual({ n: 1 })
})

test('an unstructured legacy View routes an ambiguous modification without hiding or replacing its content', async () => {
  const s = setup(), content = bundle()
  content.html = '<section><h2 id="a-title">Alpha</h2><p>Alpha original</p><label for="a-input">Alpha input</label><input id="a-input"><h2 id="b-title">Beta</h2><p>Beta original</p><label for="b-input">Beta input</label><input id="b-input"></section>'
  const before = await publishOriginal(s, content), calls = s.complete.mock.calls.length, runs = s.snapshot().runs.length
  expect(before.chapter_manifest).toBeUndefined()
  s.complete.mockResolvedValueOnce(answer({ kind: 'ambiguous' }))
  const text = 'Please revise the relevant part using the earlier context.'
  const request = s.store.handle({ type: 'request.submit', task_id: s.task, text, model_config_id: 'chapter-model', resource_ids: [], import_ids: [] }) as { request_id: string }
  await vi.waitFor(() => expect(s.store.handle({ type: 'request.status', task_id: s.task, request_id: request.request_id })).toMatchObject({ state: 'confirmation_required', code: 'CHAPTER_SCOPE_REQUIRED' }))
  const routeCall = s.complete.mock.calls[calls]!
  expect(routeCall[3]).toEqual([])
  expect(routeCall[2][0]!.content).toContain('Chapter directory: []')
  const stored = s.internal().db.prepare('SELECT input_json FROM requests WHERE id=?').get(request.request_id) as { input_json: string }
  expect(JSON.parse(stored.input_json).text).toBe(text)
  expect(s.snapshot().views[0]!.bundle.html).toBe(content.html)
  expect(s.snapshot().views[0]!.revision).toBe(before.revision)
  expect(s.snapshot().views[0]!.chapter_manifest).toBeUndefined()
  expect(s.snapshot().runs).toHaveLength(runs)
  expect(s.complete).toHaveBeenCalledTimes(calls + 1)
  expect(s.internal().db.prepare('SELECT COUNT(*) n FROM runner_chapter_updates WHERE task_id=?').get(s.task)).toEqual({ n: 0 })
  expect(s.internal().db.prepare('SELECT COUNT(*) n FROM runner_goal_heads WHERE task_id=?').get(s.task)).toEqual({ n: 1 })
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
  expect(s.internal().db.prepare('SELECT COUNT(*) n FROM runner_goal_heads WHERE task_id=?').get(s.task)).toEqual({ n: 1 })
})

test('scoped explanation receives chapter content without hiding or updating it', async () => {
  const s = setup(), mapped = await original(s), gate = deferred<Completion>()
  s.complete.mockImplementation(() => gate.promise)
  s.complete.mockResolvedValueOnce(answer({ kind: 'explanation', view_id: mapped.view_id, region_ids: [mapped.chapters[0]!.region_id] }))
  const before = s.snapshot().views[0]!
  const request = s.store.handle({ type: 'request.submit', task_id: s.task, text: 'Explain this section without changing it.', model_config_id: 'chapter-model', resource_ids: [], import_ids: [] }) as { request_id: string }
  await vi.waitFor(() => expect(s.records('worker.input').some(record => record.owner.request_id === request.request_id)).toBe(true))
  const input = s.records('worker.input').find(record => record.owner.request_id === request.request_id)!
  expect(input.bound.chapter_context.html).toContain('Alpha original')
  expect(input.bound.chapter_context.html).not.toContain('Beta original')
  expect(input.bound.region_ids).toEqual([mapped.chapters[0]!.region_id])
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

test('a denied publication retains the original chapter and never creates a successor action', async () => {
  const s = setup(), mapped = await original(s), model = chapterModel(s)
  const update = start(s, mapped, 'Alpha', 'denied-publication')
  await model.release(update.update_id, [['Alpha original', 'Denied replacement']])
  await vi.waitFor(() => expect(s.status(update.update_id).action_id).toBeDefined())
  const before = s.status(update.update_id), pending = await approval(s, before.action_id)
  await s.store.handle({ type: 'approval.decide', task_id: s.task, approval_id: pending.id, decision: 'deny' })
  await vi.waitFor(() => expect(s.status(update.update_id).state).toBe('failed'))
  expect(s.status(update.update_id)).toMatchObject({ action_id: before.action_id, publication_operation_id: before.publication_operation_id })
  expect(s.snapshot().views[0]!.bundle.html).toBe(bundle().html)
  expect(s.snapshot().surface_updates).toEqual([])
  expect(s.internal().db.prepare('SELECT COUNT(*) n FROM runner_chapter_publications WHERE update_id=?').get(update.update_id)).toEqual({ n: 1 })
  expect(s.snapshot().approvals.filter(item => item.action_id === before.action_id)).toHaveLength(1)
  expect(s.records('chapter.publication.rebased').some(record => record.update_id === update.update_id)).toBe(false)
})

test('an uncertain original action remains queryable after restart without a successor or model replay', async () => {
  const s = setup(), mapped = await original(s), model = chapterModel(s)
  const update = start(s, mapped, 'Alpha', 'unknown-publication')
  await model.release(update.update_id, [['Alpha original', 'Uncertain replacement']])
  await vi.waitFor(() => expect(s.status(update.update_id).action_id).toBeDefined())
  const action = await approve(s, s.status(update.update_id).action_id)
  const pending = s.status(update.update_id), calls = s.complete.mock.calls.length
  const request = s.internal().db.prepare('SELECT request_json FROM actions WHERE id=?').get(action)
  // Emulate a persisted action whose transport closed without a known outcome.
  s.internal().db.prepare("UPDATE actions SET state='ended',result='unknown',result_json=?,commit_valid=0 WHERE id=?").run(JSON.stringify({ code: 'CONNECTION_LOST' }), action)
  s.restart()
  for (let query = 0; query < 2; query++) expect(s.status(update.update_id)).toMatchObject({ state: 'unknown', action_id: action, publication_operation_id: pending.publication_operation_id })
  expect(s.snapshot().views[0]!.bundle.html).toBe(bundle().html)
  expect(s.internal().db.prepare('SELECT request_json FROM actions WHERE id=?').get(action)).toEqual(request)
  expect(s.internal().db.prepare('SELECT COUNT(*) n FROM runner_chapter_publications WHERE update_id=?').get(update.update_id)).toEqual({ n: 1 })
  expect(s.complete).toHaveBeenCalledTimes(calls)
})
