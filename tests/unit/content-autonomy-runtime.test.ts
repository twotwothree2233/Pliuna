import { afterEach, expect, test, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import type { ArtifactCandidate, Bundle, ChapterManifest, ChapterUpdate, ContentOperation, ModelConfiguration } from '../../src/shared/contracts.generated'
import { ContractError } from '../../src/shared/validation'
import { ChatAdapter, type ChatMessage, type Completion } from '../../src/runtime/model/adapter'
import { ModelService, type ModelLease } from '../../src/runtime/model/service'
import { RunnerWorkState } from '../../src/runtime/runner/work-state'
import { RunnerArtifactState } from '../../src/runtime/runner/artifact-state'
import { ChapterState } from '../../src/runtime/runner/chapter-state'
import { RunnerAdmission } from '../../src/runtime/runner/admission'
import { RuntimeStore } from '../../src/runtime/store'
import defaults from '../../src/shared/contracts/development-defaults.json'
import { artifactDraft } from '../helpers/producer-draft'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.restoreAllMocks() })
const answer = (value: unknown): Completion => ({ text: JSON.stringify(value), calls: [], finish: 'stop', usage: { prompt_tokens: 50, completion_tokens: 20 } })
const tool = (name: string, input: unknown, id = name): Completion => ({ text: '', calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(input) } }], finish: 'tool_calls', usage: { prompt_tokens: 50, completion_tokens: 20 } })
const content = (input: unknown, id = 'submit'): Completion => tool('call', { capability: 'builtin:content-operations:v1', input_json: JSON.stringify(input) }, id)
const latest = (messages: ChatMessage[]) => JSON.parse(messages.at(-1)!.content!)
const body = (value: any) => value.data?.data ?? value.data
function bundle(): Bundle {
  return { profile: 'managed-v1', html: '<section><h2 id="alpha">Alpha</h2><div id="alpha-body"><p>Alpha original</p><p>Alpha retained</p></div></section><section><h2 id="beta">Beta</h2><div id="beta-body"><p>Beta original</p></div></section>', css: '', state: { schema: { type: 'object', properties: {}, additionalProperties: false }, initial: {}, compatibility_version: 'autonomy-v1' }, forms: [], behaviors: [], references: [], export: [] }
}
async function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'pliuna-content-autonomy-')), adapter = new ChatAdapter(), models = new ModelService(adapter)
  const config: ModelConfiguration = { id: 'autonomy-model', base_url: 'https://example.invalid/v1', wire_model_id: 'fixture', context_tokens: 100000, max_output_tokens: 8192, compatibility_profile: 'chat-max-tokens' }
  models.configure({ type: 'model.configure', configuration: config, api_key: 'fixture-key', confirm_memory_only: true })
  vi.spyOn(models, 'acquire').mockImplementation((): ModelLease => ({ id: config.id, revision: 1, config, release() {} }))
  vi.spyOn(models, 'acquireCompaction').mockReturnValue(undefined)
  vi.spyOn(models, 'list').mockReturnValue([{ ...config, revision: 1, roles: ['main'], credential_missing: false }])
  const store = new RuntimeStore(directory, models, { viewReplacement: true, runner: { productionRuns: 2, collator: 'rule', diagnostics: false } })
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  const internal = store as unknown as { db: Database.Database; epoch: string; runnerAdmission: RunnerAdmission; pendingWorkers: Map<string, unknown>; replaceSurface: (...args: any[]) => Promise<unknown> }
  const task = store.create('Content autonomy').task.id, complete = vi.spyOn(adapter, 'complete')
  const work = () => new RunnerWorkState(internal.db, internal.epoch), chapters = new ChapterState(internal.db)
  const records = (kind: string) => (internal.db.prepare('SELECT payload_json FROM records WHERE task_id=? AND kind=? ORDER BY sequence').all(task, kind) as { payload_json: string }[]).map(row => JSON.parse(row.payload_json))
  const snapshot = () => store.snapshot(task)
  const status = (id: string) => store.handle({ type: 'chapter.status', task_id: task, update_id: id }) as ChapterUpdate
  async function publish(action?: string) {
    await vi.waitFor(() => expect(snapshot().approvals.find(item => item.validity === 'valid' && item.decision === 'pending' && (!action || item.action_id === action))).toBeDefined())
    const approval = snapshot().approvals.find(item => item.validity === 'valid' && item.decision === 'pending' && (!action || item.action_id === action))!
    await store.handle({ type: 'approval.decide', task_id: task, approval_id: approval.id, decision: 'approve' })
    await vi.waitFor(() => expect(snapshot().surface_updates.find(item => item.action_id === approval.action_id)).toBeDefined())
    await store.handle({ type: 'surface.respond', task_id: task, action_id: approval.action_id, proceed: true, confirm_discard: false })
  }
  complete.mockResolvedValueOnce(tool('write', { operation: 'resource.create', input: { display_name: 'Original.json', content: { type: 'json', value: bundle() } } }))
  complete.mockImplementationOnce(async (_config, _key, messages) => {
    const result = latest(messages), producer = work().taskWorks(task).find(item => item.role === 'producer')!
    if (producer.purpose !== 'production') throw Error('Expected production')
    const goal = work().goal(producer.request_id), section = new RunnerArtifactState(internal.db, work()).outline(task)!.sections[0]!
    const candidate: ArtifactCandidate = { candidate_id: 'autonomy-original', task_id: task, request_id: producer.request_id, intent_revision: producer.intent_revision, run_id: producer.run_id, work_id: producer.work_id, attempt_id: producer.current_attempt_id!, artifact_id: 'autonomy-artifact', base_artifact_revision: 0, plan_revision: producer.plan_revision, bundle_resource_id: result.data.id, section_id: section.section_id, section_position_revision: section.position_revision, order_key: section.order_key, presentation_kind: 'managed-v1', width_constraint: 'full', interaction_kind: 'none', provenance_ref: { task_id: task, kind: 'record', id: work().input(goal.input_event_id).record_id }, requirement_ids: producer.requirement_ids, unresolved: [], dependencies: producer.dependencies }
    return answer({ version: 1, complete: true, answer: 'Created.', artifacts: [artifactDraft(candidate)], requirement_ids: producer.requirement_ids, unresolved: [] })
  })
  const originalRun = store.start(task, 'Create an editable document.', config.id, [])
  await vi.waitFor(() => expect(work().run(originalRun).state).toBe('completed'))
  await publish()
  const view = snapshot().views[0]!
  const manifest = store.handle({ type: 'chapters.map', task_id: task, view_id: view.id, expected_view_revision: view.revision }) as ChapterManifest
  function start(id: string, regionIds = [manifest.content_tree!.root_id], suggestions?: ContentOperation[]) {
    const current = snapshot().views[0]!
    return store.startChapterUpdate({ type: 'chapter.update', task_id: task, input_event_id: `input:${id}`, update_id: id, view_id: current.id, view_revision: current.revision, state_revision: current.state_revision, region_ids: regionIds, text: 'Revise Alpha while preserving the other content.', model_config_id: config.id, ...(suggestions ? { tree_operations: suggestions.map(operation => 'html' in operation ? (({ html: _html, ...plan }) => plan)(operation) : operation) } : {}) })
  }
  return { store, internal, task, complete, manifest, chapters, records, snapshot, status, work, publish, start }
}

test('one admitted worker publishes inside its tool, then receives delivery in the same conversation', async () => {
  const s = await setup(), tree = s.manifest.content_tree!, target = tree.nodes.find(node => node.kind === 'paragraph')!
  const next = s.internal.runnerAdmission.next.bind(s.internal.runnerAdmission)
  const admission = vi.spyOn(s.internal.runnerAdmission, 'next').mockImplementation((task, candidates, active, ready) => active.length ? null : next(task, candidates, active, ready))
  const previousActive = defaults.queues.model_active_app
  defaults.queues.model_active_app = 1
  cleanups.push(() => { defaults.queues.model_active_app = previousActive })
  let received = false
  s.complete.mockImplementation(async (_config, _key, messages) => {
    if (messages.at(-1)!.role !== 'tool') return tool('read', { kind: 'content_node', id: target.node_id })
    const result = latest(messages)
    if (result.data?.state === 'published') {
      received = true
      expect(messages.some(message => message.role === 'tool' && body(JSON.parse(message.content!))?.node_id === target.node_id)).toBe(true)
      expect(s.snapshot().views[0]!.bundle.html).toContain('Alpha revised')
      return answer('Updated.')
    }
    const read = body(result)
    return content({ operations: [{ type: 'replace', node_ids: [target.node_id], html: read.html.replace('Alpha original', 'Alpha revised') }], read_refs: [read.read_ref] })
  })
  // Router recommends deleting the whole section. The worker chooses a local replacement.
  const update = s.start('one-slot', undefined, [{ type: 'delete', node_ids: [tree.nodes.find(node => node.kind === 'section')!.node_id] }])
  await vi.waitFor(() => expect(s.status(update.update_id)).toMatchObject({ action_id: expect.any(String) }))
  expect(received).toBe(false)
  expect(s.records('worker.ended').filter(record => record.owner.update_id === update.update_id)).toHaveLength(0)
  expect(s.internal.pendingWorkers.size).toBe(0)
  await s.publish(s.status(update.update_id).action_id)
  await vi.waitFor(() => expect(s.work().run(s.status(update.update_id).source!.run_id).state).toBe('completed'))
  expect(received).toBe(true)
  expect(admission.mock.calls.every(([, candidates]) => candidates.every(candidate => candidate.kind !== 'lightweight'))).toBe(true)
  expect(s.snapshot().views[0]!.bundle.html).toContain('Beta original')
  expect(s.status(update.update_id)).toMatchObject({ scope_revision: 1, state: 'succeeded' })
})

test('a known ineffective publication returns to the same worker and creates a linked successor', async () => {
  const s = await setup(), target = s.manifest.content_tree!.nodes.find(node => node.kind === 'paragraph')!
  const replace = s.internal.replaceSurface.bind(s.internal), attempts: string[] = []
  const injected = vi.spyOn(s.internal, 'replaceSurface').mockImplementation(async (...args) => {
    const context = args[4] as { id: string }
    if (!attempts.length) {
      attempts.push(context.id)
      s.internal.db.prepare("UPDATE actions SET state='ended',result='not_executed',commit_valid=0,result_json=? WHERE id=?").run(JSON.stringify({ code: 'CONTENT_BASELINE_STALE' }), context.id)
      throw new ContractError('CONTENT_BASELINE_STALE', 'The target changed before installation')
    }
    attempts.push(context.id)
    return replace(...args)
  })
  let corrected = false, oldRead = ''
  s.complete.mockImplementation(async (_config, _key, messages) => {
    if (messages.at(-1)!.role !== 'tool') return tool('read', { kind: 'content_node', id: target.node_id }, 'first-read')
    const result = latest(messages)
    if (result.error) {
      corrected = true
      expect(result).toMatchObject({ execution: 'not_executed', error: { correctable: true }, data: { state: 'correction_required' } })
      expect(s.status('correct')).toMatchObject({ scope_active: false, scope_revision: 1 })
      expect(messages.some(message => message.role === 'tool' && body(JSON.parse(message.content!))?.read_ref === oldRead)).toBe(true)
      return tool('read', { kind: 'content_node', id: target.node_id }, 'refresh-read')
    }
    if (result.data?.state === 'published') return answer('Updated.')
    const read = body(result)
    if (!oldRead) oldRead = read.read_ref
    return content({ operations: [{ type: 'replace', node_ids: [target.node_id], html: read.html.replace('Alpha original', corrected ? 'Alpha corrected' : 'Alpha first') }], read_refs: [read.read_ref] })
  })
  s.start('correct')
  await vi.waitFor(() => expect(corrected && s.status('correct').scope_revision === 2 && s.status('correct').action_id).toBeTruthy())
  await s.publish(s.status('correct').action_id)
  await vi.waitFor(() => expect(s.work().run(s.status('correct').source!.run_id).state).toBe('completed'))
  expect(injected).toHaveBeenCalledTimes(2)
  const publications = (s.internal.db.prepare('SELECT operation_id,previous_operation_id,state FROM runner_chapter_publications WHERE task_id=? ORDER BY rowid').all(s.task) as { operation_id: string; previous_operation_id: string | null; state: string }[])
  expect(publications).toHaveLength(2)
  expect(publications[0]!.state).toBe('failure')
  expect(publications[1]).toMatchObject({ previous_operation_id: publications[0]!.operation_id, state: 'published' })
  const proposals = s.records('content.operations.submitted')
  expect(proposals.map(proposal => proposal.scope_revision)).toEqual([1, 2])
  expect(proposals[1]!.read_refs).not.toContain(oldRead)
  expect(new Set(s.records('worker.input').filter(record => record.owner.update_id === 'correct').map(record => record.owner.attempt_id)).size).toBe(1)
  expect(s.snapshot().views[0]!.bundle.html).toContain('Alpha corrected')
  expect(s.snapshot().views[0]!.bundle.html).toContain('Beta original')
})

test('duplicate HTML identities return to the same worker for correction before publication', async () => {
  const s = await setup(), target = s.manifest.content_tree!.nodes.find(node => node.kind === 'paragraph')!
  let corrected = false
  s.complete.mockImplementation(async (_config, _key, messages) => {
    if (messages.at(-1)!.role !== 'tool') return tool('read', { kind: 'content_node', id: target.node_id })
    const result = latest(messages)
    if (result.error) {
      expect(result).toMatchObject({ execution: 'not_executed', error: { code: 'EXPORT_FRAGMENT_INVALID', correctable: true }, data: { state: 'correction_required' } })
      expect(s.status('duplicate-id')).toMatchObject({ state: 'generating', scope_active: false })
      expect(s.records('chapter.publication.prepared')).toHaveLength(0)
      expect(s.snapshot().views[0]!.bundle.html).toContain('Alpha original')
      corrected = true
      return tool('read', { kind: 'content_node', id: target.node_id }, 'refresh-read')
    }
    if (result.data?.state === 'published') return answer('Updated.')
    const read = body(result)
    return content({ operations: [{ type: 'replace', node_ids: [target.node_id], html: corrected ? '<p>Alpha corrected</p>' : '<p id="beta">Duplicate identity</p>' }], read_refs: [read.read_ref] })
  })
  s.start('duplicate-id')
  await vi.waitFor(() => expect(s.status('duplicate-id')).toMatchObject({ action_id: expect.any(String), scope_revision: 2 }))
  await s.publish(s.status('duplicate-id').action_id)
  await vi.waitFor(() => expect(s.work().run(s.status('duplicate-id').source!.run_id).state).toBe('completed'))
  expect(corrected).toBe(true)
  expect(new Set(s.records('worker.input').filter(record => record.owner.update_id === 'duplicate-id').map(record => record.owner.attempt_id)).size).toBe(1)
  expect(s.records('chapter.publication.prepared')).toHaveLength(1)
  expect(s.snapshot().views[0]!.bundle.html).toContain('Alpha corrected')
  expect(s.snapshot().views[0]!.bundle.html).toContain('Beta original')
})

test('a fatal candidate failure settles its undispatched publisher and releases the Run', async () => {
  const s = await setup(), target = s.manifest.content_tree!.nodes.find(node => node.kind === 'paragraph')!
  const runtime = s.store as unknown as { checkedBundle(...args: unknown[]): unknown }
  const check = runtime.checkedBundle.bind(runtime)
  vi.spyOn(runtime, 'checkedBundle').mockImplementation((...args) => {
    if ((args[1] as Bundle).html.includes('Unpublished candidate')) throw new ContractError('RESOURCE_UNAVAILABLE', 'Candidate storage is unavailable')
    return check(...args)
  })
  s.complete.mockImplementation(async (_config, _key, messages) => {
    if (messages.at(-1)!.role !== 'tool') return tool('read', { kind: 'content_node', id: target.node_id })
    const read = body(latest(messages))
    return content({ operations: [{ type: 'replace', node_ids: [target.node_id], html: '<p>Unpublished candidate</p>' }], read_refs: [read.read_ref] })
  })
  s.start('fatal-candidate')
  await vi.waitFor(() => expect(s.status('fatal-candidate')).toMatchObject({ state: 'failed', reason: 'RESOURCE_UNAVAILABLE' }))
  const runId = s.status('fatal-candidate').source!.run_id
  await vi.waitFor(() => expect(s.work().run(runId).state).toBe('failed'))
  expect(s.work().taskWorks(s.task).filter(work => work.run_id === runId && work.required).every(work => work.state === 'failed')).toBe(true)
  expect(s.internal.pendingWorkers.size).toBe(0)
  expect(s.records('worker.ended').find(record => record.owner.update_id === 'fatal-candidate')).toMatchObject({ state: 'failed', code: 'RESOURCE_UNAVAILABLE' })
  expect(s.records('chapter.publication.prepared')).toHaveLength(0)
  expect(s.snapshot().views[0]!.bundle.html).toContain('Alpha original')
})

test('an explicit user boundary remains binding when the worker corrects a rejected scope', async () => {
  const s = await setup(), sections = s.manifest.content_tree!.nodes.filter(node => node.kind === 'section'), targets = s.manifest.content_tree!.nodes.filter(node => node.kind === 'paragraph')
  const alpha = targets[0]!, beta = targets.at(-1)!
  let rejected = false
  s.complete.mockImplementation(async (_config, _key, messages) => {
    if (messages.at(-1)!.role !== 'tool') return tool('read', { kind: 'content_node', id: beta.node_id }, 'wrong-candidate')
    const result = latest(messages)
    if (result.error) {
      rejected = true
      expect(result.error.code).toBe('WORKER_CAPABILITY_DENIED')
      return tool('read', { kind: 'content_node', id: alpha.node_id }, 'correct-candidate')
    }
    if (result.data?.state === 'published') return answer('Updated.')
    const read = body(result)
    return content({ operations: [{ type: 'replace', node_ids: [read.node_id], html: rejected ? '<p>Alpha corrected</p>' : '<p>Forbidden Beta change</p>' }], read_refs: [read.read_ref] })
  })
  s.start('boundary', [sections[0]!.node_id])
  await vi.waitFor(() => expect(s.status('boundary')).toMatchObject({ action_id: expect.any(String) }))
  await s.publish(s.status('boundary').action_id)
  await vi.waitFor(() => expect(s.status('boundary').state).toBe('succeeded'))
  expect(rejected).toBe(true)
  expect(s.records('content.operations.submitted')).toHaveLength(1)
  expect(s.snapshot().views[0]!.bundle.html).toContain('Beta original')
  expect(s.snapshot().views[0]!.bundle.html).not.toContain('Forbidden')
})

test('a stale effective read is replaced without deleting its conversation evidence', async () => {
  const s = await setup(), target = s.manifest.content_tree!.nodes.find(node => node.kind === 'paragraph')!
  let changed = false, refreshed = false, oldRead = ''
  s.complete.mockImplementation(async (_config, _key, messages) => {
    if (messages.at(-1)!.role !== 'tool') return tool('read', { kind: 'content_node', id: target.node_id })
    const result = latest(messages)
    if (result.error) {
      expect(result.error).toMatchObject({ code: 'CONTENT_DEPENDENCY_STALE', correctable: true })
      refreshed = true
      return tool('read', { kind: 'content_node', id: target.node_id }, 'refreshed-read')
    }
    if (result.data?.state === 'published') return answer('Updated.')
    const read = body(result)
    if (!changed) {
      oldRead = read.read_ref
      const manifest = structuredClone(s.chapters.manifest(s.task, s.manifest.view_id)!)
      manifest.manifest_revision++
      manifest.content_tree!.revision++
      manifest.content_tree!.nodes.find(node => node.node_id === target.node_id)!.revision++
      s.chapters.installManifest(manifest, manifest.manifest_revision - 1)
      changed = true
    }
    return content({ operations: [{ type: 'replace', node_ids: [target.node_id], html: '<p>Alpha refreshed</p>' }], read_refs: [read.read_ref] })
  })
  s.start('stale-read')
  await vi.waitFor(() => expect(s.status('stale-read')).toMatchObject({ action_id: expect.any(String) }))
  await s.publish(s.status('stale-read').action_id)
  await vi.waitFor(() => expect(s.status('stale-read').state).toBe('succeeded'))
  expect(refreshed).toBe(true)
  expect(s.records('content.node.read')).toHaveLength(2)
  expect(s.records('content.operations.submitted')[0]!.read_refs).not.toContain(oldRead)
  expect(s.snapshot().views[0]!.bundle.html).toContain('Beta original')
})

test.each(['CONFIRMED_NO_EFFECT', 'CONTENT_BASELINE_STALE'])('an unknown publication waits for its original action before handling %s', async code => {
  const s = await setup(), target = s.manifest.content_tree!.nodes.find(node => node.kind === 'paragraph')!
  const replaceSurface = s.internal.replaceSurface.bind(s.internal)
  let corrected = false, dispatched = false
  const replace = vi.spyOn(s.internal, 'replaceSurface').mockImplementation(async (...args) => {
    if (dispatched) return replaceSurface(...args)
    dispatched = true
    const context = args[4] as { id: string }
    s.internal.db.prepare("UPDATE actions SET state='ended',result='unknown',result_json=? WHERE id=?").run(JSON.stringify({ code: 'OUTCOME_UNCONFIRMED' }), context.id)
    throw new ContractError('CONTENT_BASELINE_STALE', 'A transport error cannot establish the effect')
  })
  s.complete.mockImplementation(async (_config, _key, messages) => {
    if (messages.at(-1)!.role !== 'tool') return tool('read', { kind: 'content_node', id: target.node_id })
    const result = latest(messages)
    if (result.error) {
      expect(result.error).toMatchObject({ code: 'CONTENT_BASELINE_STALE', correctable: true })
      corrected = true
      return tool('read', { kind: 'content_node', id: target.node_id }, 'after-reconciliation')
    }
    if (result.data?.state === 'published') return answer('Updated.')
    const read = body(result)
    return content({ operations: [{ type: 'replace', node_ids: [target.node_id], html: corrected ? '<p>Alpha reconciled</p>' : '<p>Unconfirmed change</p>' }], read_refs: [read.read_ref] })
  })
  s.start('uncertain')
  await vi.waitFor(() => expect(s.status('uncertain').state).toBe('unknown'))
  const calls = s.complete.mock.calls.length, update = s.status('uncertain')
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(s.complete).toHaveBeenCalledTimes(calls)
  expect(replace).toHaveBeenCalledTimes(1)
  expect(s.records('content.operations.rejected')).toHaveLength(0)
  expect(() => s.chapters.reviseScope(s.task, update.update_id, { source: update.source!, operations: [{ type: 'delete', node_ids: [target.node_id] }] })).toThrow(/original publication/)
  s.internal.db.prepare("UPDATE actions SET result='not_executed',result_json=? WHERE id=?").run(JSON.stringify({ code }), update.action_id)
  if (code === 'CONTENT_BASELINE_STALE') {
    await vi.waitFor(() => expect(s.status('uncertain')).toMatchObject({ scope_revision: 2, action_id: expect.any(String) }))
    await s.publish(s.status('uncertain').action_id)
    await vi.waitFor(() => expect(s.work().run(update.source!.run_id).state).toBe('completed'))
    expect(corrected).toBe(true)
    expect(s.chapters.publication(s.task, s.status('uncertain').publication_operation_id!)!.operation.previous_operation_id).toBe(update.publication_operation_id)
    expect(s.snapshot().views[0]!.bundle.html).toContain('Alpha reconciled')
  } else {
    await vi.waitFor(() => expect(s.status('uncertain').state).toBe('failed'))
    await vi.waitFor(() => expect(s.work().run(update.source!.run_id).state).not.toBe('waiting'))
    expect(s.complete).toHaveBeenCalledTimes(calls)
  }
  expect(s.chapters.publication(s.task, update.publication_operation_id!)!.operation.state).toBe('failure')
  expect(s.snapshot().views[0]!.bundle.html).not.toContain('Unconfirmed')
})

test.each(['deny', 'cancel'] as const)('%s during publication cannot restore correction authority', async mode => {
  const s = await setup(), target = s.manifest.content_tree!.nodes.find(node => node.kind === 'paragraph')!
  s.complete.mockImplementation(async (_config, _key, messages) => {
    if (messages.at(-1)!.role !== 'tool') return tool('read', { kind: 'content_node', id: target.node_id })
    const read = body(latest(messages))
    return content({ operations: [{ type: 'replace', node_ids: [target.node_id], html: '<p>Disallowed change</p>' }], read_refs: [read.read_ref] })
  })
  s.start(`ended-${mode}`)
  await vi.waitFor(() => expect(s.status(`ended-${mode}`)).toMatchObject({ action_id: expect.any(String) }))
  const update = s.status(`ended-${mode}`)
  if (mode === 'cancel') s.store.handle({ type: 'chapter.cancel', task_id: s.task, update_id: update.update_id })
  else {
    await vi.waitFor(() => expect(s.snapshot().approvals.find(item => item.action_id === update.action_id && item.decision === 'pending')).toBeDefined())
    const approval = s.snapshot().approvals.find(item => item.action_id === update.action_id && item.decision === 'pending')!
    await s.store.handle({ type: 'approval.decide', task_id: s.task, approval_id: approval.id, decision: 'deny' })
  }
  await vi.waitFor(() => expect(['failed', 'cancelled']).toContain(s.status(update.update_id).state))
  expect(() => s.chapters.reviseScope(s.task, update.update_id, { source: update.source!, operations: [{ type: 'delete', node_ids: [target.node_id] }] })).toThrow()
  expect(s.records('content.operations.rejected')).toHaveLength(0)
  expect(s.records('chapter.publication.prepared')).toHaveLength(1)
  expect(s.snapshot().views[0]!.bundle.html).not.toContain('Disallowed')
})
