import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, expect, test, vi } from 'vitest'
import type { ArtifactCandidate, Bundle, ChapterManifest, ChapterUpdate, IpcRequest, ModelConfiguration } from '../../src/shared/contracts.generated'
import { ChatAdapter, type Completion } from '../../src/runtime/model/adapter'
import { ModelService, type ModelLease } from '../../src/runtime/model/service'
import { pluginCapabilityId, pluginContentId } from '../../src/runtime/plugins/directory'
import { RunnerArtifactState } from '../../src/runtime/runner/artifact-state'
import { ChapterState } from '../../src/runtime/runner/chapter-state'
import { RunnerWorkState } from '../../src/runtime/runner/work-state'
import { loadConversation } from '../../src/runtime/runner/conversation'
import { RuntimeStore } from '../../src/runtime/store'
import { saveExport } from '../../src/main/export-save'

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
  const directory = mkdtempSync(join(tmpdir(), 'pliuna-chapter-authority-')), adapter = new ChatAdapter(), models = new ModelService(adapter)
  const config: ModelConfiguration = { id: 'chapter-model', base_url: 'https://example.invalid/v1', wire_model_id: 'fixture', context_tokens: 100000, max_output_tokens: 8192, compatibility_profile: 'chat-max-tokens' }
  models.configure({ type: 'model.configure', configuration: config, api_key: 'fixture-key', confirm_memory_only: true })
  vi.spyOn(models, 'acquire').mockImplementation((): ModelLease => ({ id: config.id, revision: 1, config, release: vi.fn() }))
  vi.spyOn(models, 'acquireCompaction').mockReturnValue(undefined)
  vi.spyOn(models, 'list').mockReturnValue([{ ...config, revision: 1, roles: ['main'], credential_missing: false }])
  let store = new RuntimeStore(directory, models, { viewReplacement: true, runner: { productionRuns: 2, collator: 'rule' } })
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  const internal = () => store as unknown as { db: Database.Database; epoch: string; chapterFlights: Map<string, Promise<void>>; timers: Map<string, ReturnType<typeof setTimeout>>; record(taskId: string, kind: string, payload: unknown): string }
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

async function original(s: Fixture, content: Bundle = bundle()): Promise<ChapterManifest> {
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
  const view = s.snapshot().views[0]!
  return s.store.handle({ type: 'chapters.map', task_id: s.task, view_id: view.id, expected_view_revision: view.revision }) as ChapterManifest
}
function chapterModel(s: Fixture, source: () => Bundle = bundle) {
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
      const candidate = source()
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

function expectRevoked(s: Fixture, update: ChapterUpdate): void {
  expect(() => s.state().qualify(update.source!.attempt_id, 'dispatch')).toThrow()
  expect(s.records('chapter.proposal.accepted').some(record => record.update_id === update.update_id)).toBe(false)
  expect(s.status(update.update_id).action_id).toBeUndefined()
  expect(['interrupted', 'cancelled', 'superseded', 'failed']).toContain(s.status(update.update_id).state)
}

test('whole-goal correction revokes all chapter producers before late model results arrive', async () => {
  const s = setup(), mapped = await original(s), model = chapterModel(s)
  const alpha = start(s, mapped, 'Alpha', 'correction-alpha'), beta = start(s, mapped, 'Beta', 'correction-beta')
  await vi.waitFor(() => expect(model.pending.size).toBe(2))
  const flights = [s.internal().chapterFlights.get(alpha.update_id)!, s.internal().chapterFlights.get(beta.update_id)!]
  const before = s.snapshot().views[0]!, successor = deferred<Completion>()
  s.complete.mockImplementation(async () => successor.promise)
  const correction = { type: 'host.runner.input', task_id: s.task, input_event_id: 'correct-whole-document', kind: 'correction', request_id: mapped.request_id, text: 'Replace the document using the revised overall requirements.' }
  s.store.handle(correction)
  expect(s.state().goal(mapped.request_id).intent_revision).toBe(mapped.intent_revision + 1)
  for (const update of [alpha, beta]) expect(() => s.state().qualify(update.source!.attempt_id, 'dispatch')).toThrow()
  await model.release(alpha.update_id, [['Alpha original', 'Late Alpha after goal correction']])
  await model.release(beta.update_id, [['Beta original', 'Late Beta after goal correction']])
  await Promise.all(flights)
  for (const update of [alpha, beta]) expectRevoked(s, update)
  expect(s.snapshot().views[0]).toMatchObject({ id: before.id, revision: before.revision })
  expect(s.snapshot().views[0]!.bundle.html).toBe(before.bundle.html)
  s.store.handle({ type: 'task.stop', task_id: s.task })
  successor.resolve(answer('Late superseding production answer'))
})

test('task.stop revokes a generating chapter and cannot publish its late result', async () => {
  const s = setup(), mapped = await original(s), model = chapterModel(s)
  const update = start(s, mapped, 'Alpha', 'stop-alpha')
  await vi.waitFor(() => expect(model.pending.has(update.update_id)).toBe(true))
  const flight = s.internal().chapterFlights.get(update.update_id)!, before = s.snapshot().views[0]!
  s.store.handle({ type: 'task.stop', task_id: s.task })
  expect(() => s.state().qualify(update.source!.attempt_id, 'dispatch')).toThrow()
  await model.release(update.update_id, [['Alpha original', 'Late stopped chapter']])
  await flight
  expectRevoked(s, update)
  expect(s.snapshot().views[0]).toMatchObject({ id: before.id, revision: before.revision })
  expect(s.snapshot().views[0]!.bundle.html).toBe(before.bundle.html)
  expect(s.snapshot().surface_updates).toHaveLength(0)
})

test('approved View deletion revokes chapter authority and late results cannot recreate the View', async () => {
  const s = setup(), mapped = await original(s), model = chapterModel(s)
  const update = start(s, mapped, 'Alpha', 'remove-alpha')
  await vi.waitFor(() => expect(model.pending.has(update.update_id)).toBe(true))
  const flight = s.internal().chapterFlights.get(update.update_id)!, before = s.snapshot(), view = before.views[0]!
  const run = s.store.start(s.task, 'fixture held for deterministic removal', 'fixture', [])
  clearTimeout(s.internal().timers.get(run)); s.internal().timers.delete(run)
  const removal = s.store.agentTool(s.task, run, { type: 'write', input: { type: 'surface.update', surface_id: before.surface.id, expected_revision: before.surface.revision, operations: [{ type: 'view.remove', view_id: view.id, expected_view_revision: view.revision, expected_state_revision: view.state_revision }] } }, new AbortController().signal).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
  const action = await approve(s)
  await s.store.handle({ type: 'surface.respond', task_id: s.task, action_id: action, proceed: true, confirm_discard: true })
  expect((await removal).error).toBeUndefined()
  expect(s.snapshot().views).toHaveLength(0)
  expect(() => s.state().qualify(update.source!.attempt_id, 'dispatch')).toThrow()
  await model.release(update.update_id, [['Alpha original', 'Late deleted chapter']])
  await flight
  expectRevoked(s, update)
  expect(s.snapshot().views).toHaveLength(0)
  expect(s.snapshot().surface_updates).toHaveLength(0)
  expect(s.records('surface.published')).toHaveLength(2)
})

function material(s: Fixture, text: string, task = s.task, name = 'source.txt'): string {
  const body = Buffer.from(text), registered = s.store.handle({ type: 'material.internal.register', task_id: task, items: [{ display_name: name, source: 'file' }] }) as { items: { operation_id: string }[] }
  const operation_id = registered.items[0]!.operation_id
  s.store.handle({ type: 'material.internal.begin', task_id: task, operation_id, byte_length: body.length, media_type: 'text/plain; charset=utf-8' })
  s.store.handle({ type: 'material.internal.chunk', task_id: task, operation_id, offset: 0, data: body.toString('base64') })
  const result = s.store.handle({ type: 'material.internal.finish', task_id: task, operation_id }) as { resource: { id: string } }
  return result.resource.id
}

const queryTool = (name: 'list' | 'read', input: unknown, callId: string): Completion => ({ text: '', finish: 'tool_calls', usage: { prompt_tokens: 30, completion_tokens: 10 }, calls: [{ id: callId, type: 'function', function: { name, arguments: JSON.stringify(input) } }] })
const readResource = (id: string, callId: string): Completion => queryTool('read', { kind: 'resource', id }, callId)

test('actual chapter tools discover same-Task resources and retain declared chapter dependencies after publication', async () => {
  const s = setup(), originalManifest = await original(s), chapters = new ChapterState(s.internal().db)
  const beta = originalManifest.chapters.find(chapter => chapter.title === 'Beta')!
  const dependency = { kind: 'chapter' as const, task_id: s.task, view_id: originalManifest.view_id, region_id: beta.region_id, revision: beta.revision }
  const mapped = chapters.installManifest({ ...originalManifest, manifest_revision: originalManifest.manifest_revision + 1, chapters: originalManifest.chapters.map(chapter => chapter.title === 'Alpha' ? { ...chapter, dependencies: [dependency] } : chapter) }, originalManifest.manifest_revision)
  const allowedText = 'Explicit material supplied for the requested revision.', availableText = 'Additional material available in the same Task.', secret = 'OTHER TASK MATERIAL MUST STAY PRIVATE'
  const allowed = material(s, allowedText, s.task, 'selected.txt'), available = material(s, availableText, s.task, 'available.txt')
  const otherTask = s.store.create('Private material Task').task.id, foreign = material(s, secret, otherTask, 'foreign.txt'), observed = new Map<string, unknown>()
  let createdResource = ''
  const candidate = bundle(); candidate.html = candidate.html.replace('Alpha original', 'Alpha updated using the supplied material and Beta dependency')
  s.complete.mockResolvedValueOnce(answer({ kind: 'update', view_id: mapped.view_id, region_ids: [mapped.chapters[0]!.region_id] }))
  s.complete.mockImplementation(async (_config, _key, messages) => {
    const last = messages.at(-1)!
    if (last.role !== 'tool') return queryTool('list', { kind: 'resource' }, 'discover-materials')
    const result = JSON.parse(last.content!); observed.set(last.tool_call_id!, result)
    if (last.tool_call_id === 'discover-materials') {
      const discovered = result.data.items.find((item: { display_name: string }) => item.display_name === 'available.txt')
      expect(discovered).toBeDefined()
      return readResource(discovered.id, 'read-discovered')
    }
    if (last.tool_call_id === 'read-discovered') return readResource(allowed, 'read-material')
    if (last.tool_call_id === 'read-material') return queryTool('read', { kind: 'resource', id: mapped.bundle_resource_id, selection: { view: 'object' } }, 'read-whole-source')
    if (last.tool_call_id === 'read-whole-source') return readResource(foreign, 'read-other-task')
    if (last.tool_call_id === 'read-other-task') return create(candidate)
    if (last.tool_call_id === 'create-bundle') {
      createdResource = result.data.id
      return readResource(createdResource, 'read-created')
    }
    const system = messages.find(message => message.role === 'system')!.content!
    const binding = JSON.parse(system.slice(system.lastIndexOf('Bound data: ') + 'Bound data: '.length)) as { update_id: string }
    const update = s.status(binding.update_id)
    return answer({ bundle_resource_id: createdResource, replacements: [{ previous_region_ids: update.region_ids, chapters: update.base_manifest.chapters.filter(chapter => update.region_ids.includes(chapter.region_id)).map(chapter => ({ ...chapter, revision: chapter.revision + 1, dependencies: update.dependencies })) }] })
  })
  const request = s.store.handle({ type: 'request.submit', task_id: s.task, text: 'Revise Alpha using this material and its declared dependency.', model_config_id: 'chapter-model', resource_ids: [allowed], import_ids: [] }) as { request_id: string }
  const updateId = 'chapter-update:' + request.request_id
  await vi.waitFor(() => expect(s.status(updateId).action_id).toBeDefined())
  const listing = observed.get('discover-materials') as { execution: string; data: { items: { id: string }[] } }
  expect(listing.execution).toBe('success')
  expect(listing.data.items.map(item => item.id)).toEqual(expect.arrayContaining([allowed, available, mapped.bundle_resource_id]))
  expect(listing.data.items.map(item => item.id)).not.toContain(foreign)
  for (const id of ['read-material', 'read-discovered', 'read-whole-source', 'read-created']) expect(observed.get(id)).toMatchObject({ execution: 'success' })
  expect(JSON.stringify(observed.get('read-material'))).toContain(allowedText)
  expect(JSON.stringify(observed.get('read-discovered'))).toContain(availableText)
  expect(JSON.stringify(observed.get('read-whole-source'))).toContain('Alpha original')
  expect(JSON.stringify(observed.get('read-created'))).toContain('Alpha updated using the supplied material and Beta dependency')
  expect(observed.get('read-other-task')).toMatchObject({ execution: 'not_executed', error: { code: 'NOT_FOUND' } })
  expect(JSON.stringify([...observed.values()])).not.toContain(secret)
  const update = s.status(updateId)
  expect(update.dependencies).toContainEqual(dependency)
  expect(s.state().work(update.source!.work_id).dependencies).toContainEqual({ kind: 'resource', task_id: s.task, resource_id: allowed })
  expect(chapters.proposal(s.task, update.proposal_id!)!.dependencies).toEqual(update.dependencies)
  await publish(s, update.action_id)
  await vi.waitFor(() => expect(s.status(updateId).state).toBe('succeeded'))
  const published = chapters.manifest(s.task, mapped.view_id)!
  expect(published.chapters.find(chapter => chapter.title === 'Alpha')!.dependencies).toContainEqual(dependency)
  expect(published.chapters.find(chapter => chapter.title === 'Beta')!.revision).toBe(beta.revision)
  expect(s.snapshot().views[0]!.bundle.html).toContain('Alpha updated using the supplied material and Beta dependency')
  expect(s.snapshot().views[0]!.bundle.html).toContain('Beta original')
})

test('actual chapter tools read captured conversation events while denying unrelated Task events', async () => {
  const s = setup(), mapped = await original(s), observed = new Map<string, unknown>()
  const history = s.internal().db.prepare("SELECT id FROM records WHERE task_id=? AND kind='runner.answer' ORDER BY sequence DESC LIMIT 1").get(s.task) as { id: string }
  const secret = 'UNRELATED TASK EVENT MUST STAY PRIVATE', unrelated = s.internal().record(s.task, 'test.private', { text: secret })
  s.complete.mockImplementation(async (_config, _key, messages) => {
    const last = messages.at(-1)!
    if (last.role !== 'tool') return queryTool('read', { kind: 'event', id: history.id }, 'read-history')
    const result = JSON.parse(last.content!); observed.set(last.tool_call_id!, result)
    if (last.tool_call_id === 'read-history') return queryTool('read', { kind: 'event', id: unrelated }, 'read-unrelated-event')
    if (last.tool_call_id === 'read-unrelated-event') return queryTool('list', { kind: 'event' }, 'list-events')
    if (last.tool_call_id === 'list-events') return create(bundle())
    const system = messages.find(message => message.role === 'system')!.content!
    const binding = JSON.parse(system.slice(system.lastIndexOf('Bound data: ') + 'Bound data: '.length)) as { update_id: string }
    const update = s.status(binding.update_id)
    return answer({ bundle_resource_id: result.data.id, replacements: [{ previous_region_ids: update.region_ids, chapters: update.base_manifest.chapters.filter(chapter => update.region_ids.includes(chapter.region_id)).map(chapter => ({ ...chapter, revision: chapter.revision + 1, dependencies: update.dependencies })) }] })
  })
  const update = start(s, mapped, 'Alpha', 'history-access')
  await vi.waitFor(() => expect(s.status(update.update_id).action_id).toBeDefined())
  expect(observed.get('read-history')).toMatchObject({ execution: 'success' })
  expect(JSON.stringify(observed.get('read-history'))).toContain('正文已完成。')
  for (const id of ['read-unrelated-event', 'list-events']) expect(observed.get(id)).toMatchObject({ execution: 'not_executed', error: { code: 'WORKER_CAPABILITY_DENIED' } })
  expect(JSON.stringify([...observed.values()])).not.toContain(secret)
  await publish(s, s.status(update.update_id).action_id)
  await vi.waitFor(() => expect(s.status(update.update_id).state).toBe('succeeded'))
})

test('actual chapter tools discover and read Task data, enabled plugin content and capability contracts', async () => {
  const s = setup(), mapped = await original(s), taskData = 'chapter-reference-data', observed = new Map<string, unknown>()
  s.internal().db.prepare('INSERT INTO task_data(id,task_id,revision,schema_json,value_json,references_json,creator_run_id,auto_edit_valid) VALUES (?,?,1,?,?,?,NULL,0)').run(taskData, s.task, JSON.stringify({ type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false }), JSON.stringify({ label: 'Available chapter reference data' }), '[]')
  const source = join(s.directory, 'discovery-plugin')
  mkdirSync(source)
  writeFileSync(join(source, 'workflow.md'), 'Available chapter editing workflow')
  writeFileSync(join(source, 'backend.cjs'), '// Discovery fixture; no capability is invoked.\n')
  writeFileSync(join(source, 'tool.json'), JSON.stringify({ id: 'echo', description: 'Return supplied data', when_to_use: 'Return supplied data', input_schema: { type: 'object', required: ['value'] }, output_schema: { type: 'object', required: ['value'] }, effect: 'read', timeout_ms: 2000, errors: [], examples: [] }))
  writeFileSync(join(source, 'manifest.json'), JSON.stringify({ manifest_version: '0.1', protocol_version: '0.1', id: 'fixture.chapter-discovery', version: '1.0.0', access_level: 'task', contributes: [{ id: 'workflow', kind: 'workflow', entry: 'workflow.md', description: 'Chapter editing workflow' }, { id: 'echo', kind: 'tool', entry: 'tool.json', description: 'Return supplied data' }], backend: { runtime: 'app-node', entry: 'backend.cjs' } }))
  const installed = await s.store.handle({ type: 'plugin.internal.install', source }) as { digest: string }
  await s.store.handle({ type: 'plugin.trust', digest: installed.digest, confirm_local_code: true, confirm_cross_task: false })
  const plan = await s.store.handle({ type: 'plugin.plan', task_id: s.task, digest: installed.digest }) as { fingerprint: string }
  await s.store.handle({ type: 'plugin.enable', task_id: s.task, digest: installed.digest, fingerprint: plan.fingerprint, confirm_cross_task: false })
  const capability = pluginCapabilityId(installed.digest, 'echo')
  s.complete.mockImplementation(async (_config, _key, messages) => {
    const last = messages.at(-1)!
    if (last.role !== 'tool') return queryTool('list', { kind: 'task_data' }, 'discover-task-data')
    const result = JSON.parse(last.content!); observed.set(last.tool_call_id!, result)
    if (last.tool_call_id === 'discover-task-data') {
      const discovered = result.data.items.find((item: { id: string }) => item.id === taskData)
      expect(discovered).toBeDefined()
      return queryTool('read', { kind: 'task_data', id: discovered.id }, 'read-task-data')
    }
    if (last.tool_call_id === 'read-task-data') return queryTool('list', { kind: 'plugin' }, 'discover-plugin')
    if (last.tool_call_id === 'discover-plugin') {
      const discovered = result.data.items.find((item: { id: string }) => item.id === 'package:' + installed.digest)
      expect(discovered).toMatchObject({ enabled: true })
      return queryTool('read', { kind: 'plugin', id: discovered.id }, 'read-plugin')
    }
    if (last.tool_call_id === 'read-plugin') return queryTool('read', { kind: 'plugin', id: pluginContentId(installed.digest, 'workflow') }, 'read-workflow')
    if (last.tool_call_id === 'read-workflow') return queryTool('list', { kind: 'capability' }, 'discover-capability')
    if (last.tool_call_id === 'discover-capability') {
      const discovered = result.data.items.find((item: { id: string }) => item.id === capability)
      expect(discovered).toBeDefined()
      return queryTool('read', { kind: 'capability', id: discovered.id, selection: { view: 'schema' } }, 'read-capability')
    }
    if (last.tool_call_id === 'read-capability') return create(bundle())
    const system = messages.find(message => message.role === 'system')!.content!
    const binding = JSON.parse(system.slice(system.lastIndexOf('Bound data: ') + 'Bound data: '.length)) as { update_id: string }
    const update = s.status(binding.update_id)
    return answer({ bundle_resource_id: result.data.id, replacements: [{ previous_region_ids: update.region_ids, chapters: update.base_manifest.chapters.filter(chapter => update.region_ids.includes(chapter.region_id)).map(chapter => ({ ...chapter, revision: chapter.revision + 1, dependencies: update.dependencies })) }] })
  })
  const update = start(s, mapped, 'Alpha', 'discover-content-tools')
  await vi.waitFor(() => expect(s.status(update.update_id).action_id).toBeDefined())
  for (const id of ['discover-task-data', 'read-task-data', 'discover-plugin', 'read-plugin', 'read-workflow', 'discover-capability', 'read-capability']) expect(observed.get(id)).toMatchObject({ execution: 'success' })
  expect(JSON.stringify(observed.get('read-task-data'))).toContain('Available chapter reference data')
  expect(JSON.stringify(observed.get('read-plugin'))).toContain('fixture.chapter-discovery')
  expect(JSON.stringify(observed.get('read-workflow'))).toContain('Available chapter editing workflow')
  expect(observed.get('read-capability')).toMatchObject({ data: { data: { type: 'object', required: ['value'] } } })
  await publish(s, s.status(update.update_id).action_id)
  await vi.waitFor(() => expect(s.status(update.update_id).state).toBe('succeeded'))
})

function exportableBundle(): Bundle {
  const content = bundle()
  content.export = ['a-title', 'a-body', 'b-title', 'b-body'].map(element_id => ({ id: element_id, category: 'learning', source: { type: 'element', element_id } }))
  return content
}

async function savedExport(s: Fixture, name: string): Promise<string> {
  const job = s.store.handle({ type: 'export.prepare', task_id: s.task, answer_ids: [] }) as { id: string; phase: string }
  expect(job.phase).toBe('preview')
  const target = join(s.directory, name + '.html'), operation_id = job.id
  const result = await saveExport(target, null, {
    begin: async temporary => s.store.handle({ type: 'export.internal.begin', task_id: s.task, operation_id, partial: true, target, temporary }) as { html: string },
    created: async identity => s.store.handle({ type: 'export.internal.created', task_id: s.task, operation_id, identity }),
    valid: async () => s.store.handle({ type: 'export.internal.valid', task_id: s.task, operation_id }),
    finish: async (phase, reason) => s.store.handle({ type: 'export.internal.finish', task_id: s.task, operation_id, phase, reason })
  })
  expect(result).toMatchObject({ id: operation_id, phase: 'saved' })
  return readFileSync(target, 'utf8')
}

function expectNoChapterPresentation(value: unknown): void {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value)
  for (const marker of ['data-chapter-update', 'data-chapter-region', 'data-chapter-body-hidden', '正在更新这一章', '更新已排队', '查看上一版', '取消更新', '查询原操作']) expect(serialized).not.toContain(marker)
}

test('formal saved exports keep the published chapter during generation and confirmation, then use only the committed revision', async () => {
  const s = setup(), mapped = await original(s, exportableBundle()), model = chapterModel(s, exportableBundle)
  const before = s.snapshot().views[0]!, update = start(s, mapped, 'Alpha', 'export-alpha')
  await vi.waitFor(() => expect(model.pending.has(update.update_id)).toBe(true))
  const flight = s.internal().chapterFlights.get(update.update_id)!
  expect(s.status(update.update_id).state).toBe('generating')
  expect(s.snapshot().views[0]!.bundle).toEqual(before.bundle)
  expectNoChapterPresentation(s.snapshot().views[0]!.bundle)
  const generating = await savedExport(s, 'while-generating')
  expect(generating).toContain('Alpha original')
  expect(generating).toContain('Beta original')
  expect(generating).not.toContain('Alpha committed revision')
  expectNoChapterPresentation(generating)

  await model.release(update.update_id, [['Alpha original', 'Alpha committed revision']])
  await vi.waitFor(() => expect(s.status(update.update_id).action_id).toBeDefined())
  const action = await approve(s, s.status(update.update_id).action_id)
  expect(s.snapshot().surface_updates.find(item => item.action_id === action)).toBeDefined()
  expect(s.snapshot().views[0]!.bundle).toEqual(before.bundle)
  expectNoChapterPresentation(s.snapshot().views[0]!.bundle)
  const awaitingConfirmation = await savedExport(s, 'before-confirmation')
  expect(awaitingConfirmation).toContain('Alpha original')
  expect(awaitingConfirmation).toContain('Beta original')
  expect(awaitingConfirmation).not.toContain('Alpha committed revision')
  expectNoChapterPresentation(awaitingConfirmation)

  await s.store.handle({ type: 'surface.respond', task_id: s.task, action_id: action, proceed: true, confirm_discard: false })
  await flight
  expect(s.status(update.update_id).state).toBe('succeeded')
  const current = s.snapshot().views[0]!
  expect(current).toMatchObject({ id: before.id, revision: before.revision + 1 })
  expect(current.bundle.html).toContain('Alpha committed revision')
  expect(current.bundle.html).not.toContain('Alpha original')
  expect(current.bundle.html).toContain('Beta original')
  expectNoChapterPresentation(current.bundle)
  const committed = await savedExport(s, 'after-publication')
  expect(committed).toContain('Alpha committed revision')
  expect(committed).toContain('Beta original')
  expect(committed).not.toContain('Alpha original')
  expectNoChapterPresentation(committed)
  expect(readFileSync(join(s.directory, 'while-generating.html'), 'utf8')).toBe(generating)
  expect(readFileSync(join(s.directory, 'before-confirmation.html'), 'utf8')).toBe(awaitingConfirmation)
})
