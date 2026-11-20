import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, expect, it, vi } from 'vitest'
import { ChatAdapter, type Completion } from '../../src/runtime/model/adapter'
import { ModelService, type ModelLease } from '../../src/runtime/model/service'
import { RunnerWorkState } from '../../src/runtime/runner/work-state'
import { RunnerArtifactState } from '../../src/runtime/runner/artifact-state'
import { RunnerBudgetLedger } from '../../src/runtime/runner/budget'
import type { RunnerAdmission } from '../../src/runtime/runner/admission'
import { RuntimeStore } from '../../src/runtime/store'
import { artifactDraft } from '../helpers/producer-draft'
import type { ArtifactCandidate, Bundle, ModelConfiguration } from '../../src/shared/contracts.generated'

const stores: RuntimeStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close(); vi.restoreAllMocks() })
const answer = (text: string): Completion => ({ text, calls: [], finish: 'stop', usage: { prompt_tokens: 30, completion_tokens: 8 } })
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done }), resolve: (value: T) => resolve(value) } }
function setup(directory = mkdtempSync(join(tmpdir(), 'pliuna-orchestration-')), revision = 1) {
  const adapter = new ChatAdapter(), models = new ModelService(adapter)
  const config: ModelConfiguration = { id: 'production', base_url: 'https://example.invalid/v1', wire_model_id: 'synthetic', context_tokens: 100000, max_output_tokens: 4096, compatibility_profile: 'chat-max-tokens' }
  models.configure({ type: 'model.configure', configuration: config, api_key: 'synthetic', confirm_memory_only: true })
  vi.spyOn(models, 'acquire').mockImplementation((): ModelLease => ({ id: config.id, revision, config, release: vi.fn() }))
  vi.spyOn(models, 'acquireCompaction').mockReturnValue(undefined)
  const complete = vi.spyOn(adapter, 'complete'), store = new RuntimeStore(directory, models, { viewReplacement: true, runner: { productionRuns: 2 } })
  stores.push(store)
  const internal = store as unknown as { db: Database.Database; record(task: string, kind: string, payload: unknown): string }
  const db = internal.db, state = new RunnerWorkState(db, store.epoch)
  const records = (task: string, kind: string) => (db.prepare('SELECT payload_json FROM records WHERE task_id=? AND kind=? ORDER BY sequence').all(task, kind) as { payload_json: string }[]).map(row => JSON.parse(row.payload_json))
  const request = (run: string) => (db.prepare('SELECT request_id FROM runs WHERE id=?').get(run) as { request_id: string }).request_id
  return { directory, store, db, state, internal, complete, records, request }
}

it('executes a correction once, isolates the other goal and rejects the late superseded answer', async () => {
  const s = setup(), task = s.store.create('Corrections').task.id, pending = [deferred<Completion>(), deferred<Completion>(), deferred<Completion>()]
  let calls = 0
  s.complete.mockImplementation(async () => pending[calls++]!.promise)
  const alpha = s.store.start(task, 'Alpha original', 'production', []), beta = s.store.start(task, 'Beta independent', 'production', [])
  await vi.waitFor(() => expect(s.complete).toHaveBeenCalledTimes(2))
  const request = s.request(alpha), betaRequest = s.request(beta), budget = s.state.run(alpha).budget_id
  s.store.handle({ type: 'host.runner.input', task_id: task, input_event_id: 'query-beta', kind: 'query', request_id: betaRequest })
  expect(s.state.goal(betaRequest).intent_revision).toBe(1)
  const correction = { type: 'host.runner.input', task_id: task, input_event_id: 'correct-alpha', kind: 'correction', request_id: request, text: 'Use the revised alpha conclusion' }
  const receipt = s.store.handle(correction)
  expect(s.store.handle(correction)).toEqual(receipt)
  expect(s.state.goal(request).intent_revision).toBe(2)
  expect(s.state.run(beta).commit_valid).toBe(true)
  pending[0]!.resolve(answer('LATE OLD ALPHA'))
  await vi.waitFor(() => expect(s.complete).toHaveBeenCalledTimes(3))
  const modelMessages = s.complete.mock.calls[2]![2], messages = JSON.stringify(modelMessages)
  expect(messages).toContain('Alpha original')
  expect(messages).toContain('Use the revised alpha conclusion')
  expect(messages).toContain('Beta independent')
  const system = modelMessages[0]!.content!
  expect(JSON.parse(system.split('\nBound data: ')[1]!)).toMatchObject({
    owner: { request_id: request, intent_revision: 2 },
    goal: { request_id: request, intent_revision: 2 }
  })
  expect(system).not.toContain(betaRequest)
  const successor = s.state.taskWorks(task).find(work => work.purpose === 'production' && work.request_id === request && work.intent_revision === 2)!
  expect(s.state.run(successor.run_id).budget_id).toBe(budget)
  pending[2]!.resolve(answer('Current alpha answer')); pending[1]!.resolve(answer('Independent beta answer'))
  await vi.waitFor(() => expect(s.state.run(successor.run_id).state).toBe('completed'))
  expect(s.records(task, 'runner.answer').map(record => record.text).sort()).toEqual(['Current alpha answer', 'Independent beta answer'].sort())
  expect(s.db.prepare("SELECT COUNT(*) n FROM runner_runs WHERE request_id=? AND intent_revision=2 AND purpose='production'").get(request)).toEqual({ n: 1 })
})

it('keeps a cancelled goal cancelled while a new independent goal completes normally', async () => {
  const s = setup(), task = s.store.create('Cancellation').task.id, pending = deferred<Completion>()
  s.complete.mockImplementationOnce(async () => pending.promise).mockResolvedValue(answer('New independent final'))
  const run = s.store.start(task, 'Cancel this goal', 'production', [])
  await vi.waitFor(() => expect(s.complete).toHaveBeenCalledTimes(1))
  s.store.handle({ type: 'host.runner.input', task_id: task, input_event_id: 'cancel-original', kind: 'cancel_run', run_id: run })
  pending.resolve(answer('Rejected late answer'))
  await vi.waitFor(() => expect(s.state.run(run).state).toBe('cancelled'))
  const next = s.store.start(task, 'New goal', 'production', [])
  await vi.waitFor(() => expect(s.state.run(next).state).toBe('completed'))
  expect(s.db.prepare("SELECT COUNT(*) n FROM runner_runs WHERE request_id=? AND purpose='production'").get(s.request(run))).toEqual({ n: 1 })
  expect(s.records(task, 'runner.answer').map(record => record.text)).toEqual(['New independent final'])
})

function produceFragments(s: ReturnType<typeof setup>, task: string, count: number): Completion {
  const artifacts = new RunnerArtifactState(s.db, s.state), work = s.state.taskWorks(task).find(work => work.purpose === 'production' && work.state === 'running')!
  if (work.purpose !== 'production') throw Error('Expected producer')
  const goal = s.state.goal(work.request_id), section = artifacts.outline(task)!.sections.find(section => section.request_id === work.request_id)!
  const bundle: Bundle = { profile: 'managed-v1', html: '<section><p>Immutable published content</p></section>', css: '', state: { schema: { type: 'object', properties: {}, additionalProperties: false }, initial: {}, compatibility_version: 'v1' }, forms: [], behaviors: [], references: [], export: [] }
  const resource = (s.store.modelTool(task, work.run_id, { type: 'write', input: { type: 'resource.create', display_name: 'Source bundle', content: { type: 'json', value: bundle } } }) as { data: { id: string } }).data.id
  const candidates: ArtifactCandidate[] = Array.from({ length: count }, (_, i) => ({ candidate_id: `candidate-${i}`, task_id: task, request_id: work.request_id, intent_revision: work.intent_revision, run_id: work.run_id, work_id: work.work_id, attempt_id: work.current_attempt_id!, artifact_id: `artifact-${i}`, base_artifact_revision: 0, plan_revision: work.plan_revision, bundle_resource_id: resource, section_id: section.section_id, section_position_revision: section.position_revision, order_key: section.order_key, presentation_kind: 'managed-v1', width_constraint: 'full', interaction_kind: 'none', provenance_ref: { task_id: task, kind: 'record', id: s.state.input(goal.input_event_id).record_id }, requirement_ids: ['answer'], unresolved: [], dependencies: work.dependencies }))
  return answer(JSON.stringify({ version: 1, complete: true, answer: 'Fragmented final', artifacts: candidates.map(artifactDraft), requirement_ids: ['answer'], unresolved: [] }))
}

it('automatically publishes the first fragment and drains multiple fixed batches without a false blocker', async () => {
  const s = setup(), task = s.store.create('Progressive publication').task.id
  s.complete.mockImplementation(async () => produceFragments(s, task, 17))
  const run = s.store.start(task, 'Produce seventeen bounded fragments', 'production', [])
  await vi.waitFor(() => expect(s.state.run(run).state).toBe('completed'))
  for (let batch = 0; batch < 2; batch++) {
    await vi.waitFor(() => expect(s.store.snapshot(task).approvals.some(approval => approval.decision === 'pending' && approval.validity === 'valid')).toBe(true))
    const approval = s.store.snapshot(task).approvals.find(approval => approval.decision === 'pending' && approval.validity === 'valid')!
    s.store.handle({ type: 'approval.decide', task_id: task, approval_id: approval.id, decision: 'approve' })
    await vi.waitFor(() => expect(s.store.snapshot(task).surface_updates.some(update => update.action_id === approval.action_id)).toBe(true))
    await s.store.handle({ type: 'surface.respond', task_id: task, action_id: approval.action_id, proceed: true, confirm_discard: false })
  }
  await vi.waitFor(() => expect(s.db.prepare('SELECT COUNT(*) n FROM runner_view_mappings WHERE task_id=?').get(task)).toEqual({ n: 17 }), { timeout: 5000 })
  expect(s.records(task, 'runner.composition.prepared').map(record => record.batch_id)).toHaveLength(2)
  await vi.waitFor(() => expect(s.store.runnerGoals({ task_id: task }).scope?.state).toBe('complete'))
  expect(s.records(task, 'runner.composition.blocked')).toEqual([])
  expect(s.complete).toHaveBeenCalledTimes(1)
})

it.each(['close', 'shutdown'] as const)('resumes proven undispatched work after %s under new identities and the original cumulative budget', async exit => {
  const first = setup(), task = first.store.create('Undispatched restart').task.id
  vi.spyOn((first.store as unknown as { runnerAdmission: RunnerAdmission }).runnerAdmission, 'next').mockReturnValue(null)
  const originalRun = first.store.start(task, 'Resume exact work', 'production', []), originalWork = first.state.taskWorks(task)[0]!, originalBudget = first.state.run(originalRun).budget_id
  expect(first.state.attempt(originalWork.current_attempt_id!)).toMatchObject({ state: 'queued', dispatch_state: 'not_dispatched' })
  expect(first.complete).not.toHaveBeenCalled()
  await first.store[exit]()
  const next = setup(first.directory); next.complete.mockResolvedValue(answer('Recovered final'))
  await next.store.recoverRunnerWork()
  await vi.waitFor(() => expect(next.records(task, 'runner.answer')).toHaveLength(1))
  const work = next.state.work(originalWork.work_id), run = next.state.run(work.run_id)
  expect(work.plan_revision).toBe(2)
  expect(work.run_id).not.toBe(originalRun)
  expect(run).toMatchObject({ previous_run_id: originalRun, budget_id: originalBudget, runtime_epoch: next.store.epoch })
  expect(next.state.attempt(work.current_attempt_id!)).toMatchObject({ previous_attempt_id: originalWork.current_attempt_id, attempt_number: 2 })
  expect(next.state.attempt(originalWork.current_attempt_id!).state).toBe('revoked')
  await next.store.recoverRunnerWork()
  expect(next.complete).toHaveBeenCalledTimes(1)
})

it.each(['cancelled', 'failed'] as const)('keeps explicitly %s work terminal across normal shutdown', async terminal => {
  const first = setup(), task = first.store.create('Terminal work shutdown').task.id
  vi.spyOn(first.store, 'executeRunnerProduction').mockResolvedValue({ version: 1, complete: true, answer: 'not executed', artifacts: [], requirement_ids: ['answer'], unresolved: [] })
  const originalRun = first.store.start(task, 'Do not resume ended work', 'production', []), originalWork = first.state.taskWorks(task)[0]!
  if (terminal === 'cancelled') first.store.handle({ type: 'run.cancel', task_id: task, run_id: originalRun })
  else (first.store as unknown as { finish(task: string, run: string, state: string, reason: string): void }).finish(task, originalRun, 'failed', 'RUN_WALL_LIMIT')
  await first.store.shutdown()
  const next = setup(first.directory)
  await next.store.recoverRunnerWork()
  expect(next.state.run(originalRun).state).toBe(terminal)
  expect(next.state.work(originalWork.work_id).state).toBe(terminal)
  expect(next.complete).not.toHaveBeenCalled()
  expect(next.db.prepare('SELECT COUNT(*) n FROM runner_runs WHERE task_id=?').get(task)).toEqual({ n: 1 })
})

it('consumes a saved stop before admitting any old undispatched work', async () => {
  const first = setup(), task = first.store.create('Pending durable stop').task.id
  vi.spyOn(first.store, 'executeRunnerProduction').mockResolvedValue({ version: 1, complete: true, answer: 'not executed', artifacts: [], requirement_ids: ['answer'], unresolved: [] })
  first.store.start(task, 'Must remain stopped', 'production', [])
  const record = first.internal.record(task, 'runner.input.received', { text: 'Stop task' })
  first.store.receiveRunnerInput({ input_event_id: 'saved-stop', task_id: task, kind: 'stop_task', stage: 'received', record_id: record })
  first.store.close()
  const next = setup(first.directory); next.complete.mockResolvedValue(answer('Must not execute'))
  await next.store.recoverRunnerWork()
  expect(next.store.snapshot(task).task.state).toBe('stopped')
  expect(next.complete).not.toHaveBeenCalled()
  expect(next.db.prepare("SELECT COUNT(*) n FROM runner_consumptions WHERE input_event_id='saved-stop' AND stage='installed'").get()).toEqual({ n: 1 })
})

it.each(['close', 'shutdown'] as const)('retains unknown dispatch and refuses automatic replay after %s', async exit => {
  const first = setup(), task = first.store.create('Unknown restart').task.id, pending = deferred<Completion>()
  first.complete.mockImplementation(async () => pending.promise)
  const original = first.store.start(task, 'External execution may have occurred', 'production', [])
  await vi.waitFor(() => expect(first.complete).toHaveBeenCalledTimes(1))
  await first.store[exit]()
  const next = setup(first.directory); next.complete.mockResolvedValue(answer('Must not replay'))
  await next.store.recoverRunnerWork()
  expect(next.state.run(original).state).toBe('interrupted')
  expect(next.state.attempts(next.state.taskWorks(task)[0]!.work_id)[0]!.state).toBe('unknown')
  expect(next.complete).not.toHaveBeenCalled()
  expect(next.db.prepare('SELECT COUNT(*) n FROM runner_runs WHERE task_id=?').get(task)).toEqual({ n: 1 })
  pending.resolve(answer('Old execution returned'))
})

it('keeps undispatched work blocked when the original configuration revision changed', async () => {
  const first = setup(), task = first.store.create('Changed configuration').task.id
  vi.spyOn(first.store, 'executeRunnerProduction').mockResolvedValue({ version: 1, complete: true, answer: 'not executed', artifacts: [], requirement_ids: ['answer'], unresolved: [] })
  const original = first.store.start(task, 'Keep exact model binding', 'production', [])
  first.store.close()
  const next = setup(first.directory, 2); next.complete.mockResolvedValue(answer('Must not execute'))
  await next.store.recoverRunnerWork()
  expect(next.complete).not.toHaveBeenCalled()
  expect(next.records(task, 'runner.goal.waiting')).toMatchObject([{ previous_run_id: original, reason: 'MODEL_CONFIGURATION_CHANGED' }])
  expect(next.db.prepare('SELECT COUNT(*) n FROM runner_runs WHERE task_id=?').get(task)).toEqual({ n: 1 })
})

it('installs a saved correction before resuming production and retains its original budget', async () => {
  const first = setup(), task = first.store.create('Durable correction').task.id
  vi.spyOn(first.store, 'executeRunnerProduction').mockResolvedValue({ version: 1, complete: true, answer: 'not executed', artifacts: [], requirement_ids: ['answer'], unresolved: [] })
  const original = first.store.start(task, 'Original requirement', 'production', []), request = first.request(original), budget = first.state.run(original).budget_id
  const record = first.internal.record(task, 'runner.input.received', { text: 'Use the corrected requirement' })
  first.store.receiveRunnerInput({ input_event_id: 'saved-correction', task_id: task, kind: 'correction', request_id: request, stage: 'received', record_id: record })
  first.store.close()
  const next = setup(first.directory); next.complete.mockResolvedValue(answer('Corrected recovered answer'))
  await next.store.recoverRunnerWork()
  await vi.waitFor(() => expect(next.records(task, 'runner.answer')).toHaveLength(1))
  expect(next.state.goal(request).intent_revision).toBe(2)
  const current = next.state.taskWorks(task).find(work => work.purpose === 'production' && work.intent_revision === 2)!
  expect(next.state.run(current.run_id).budget_id).toBe(budget)
  expect(JSON.stringify(next.complete.mock.calls[0]![2])).toContain('Use the corrected requirement')
  expect(next.records(task, 'runner.answer')[0]).toMatchObject({ request_id: request, intent_revision: 2, text: 'Corrected recovered answer' })
  await next.store.recoverRunnerWork()
  expect(next.complete).toHaveBeenCalledTimes(1)
})

it('records one explicit blocker for an unavailable recovery profile without dispatching it', async () => {
  const first = setup(), task = first.store.create('Unavailable recovery factory').task.id
  vi.spyOn(first.store, 'executeRunnerProduction').mockResolvedValue({ version: 1, complete: true, answer: 'not executed', artifacts: [], requirement_ids: ['answer'], unresolved: [] })
  const original = first.store.start(task, 'Keep original profile', 'production', []), work = first.state.taskWorks(task)[0]!, attempt = first.state.attempt(work.current_attempt_id!)
  first.db.prepare('UPDATE runner_attempts SET payload_json=? WHERE attempt_id=?').run(JSON.stringify({ ...attempt, profile_id: 'specialized-unavailable-v1' }), attempt.attempt_id)
  first.store.close()
  const next = setup(first.directory)
  await next.store.recoverRunnerWork(); await next.store.recoverRunnerWork()
  expect(next.complete).not.toHaveBeenCalled()
  expect(next.records(task, 'runner.goal.waiting')).toMatchObject([{ previous_run_id: original, reason: 'RUNNER_RECOVERY_PROFILE_UNAVAILABLE' }])
  expect(next.state.attempt(attempt.attempt_id).profile_id).toBe('specialized-unavailable-v1')
})

it('resumes recovery after prior work exceeded legacy cumulative limits and elapsed time', async () => {
  const first = setup(), task = first.store.create('Legacy recovery limits').task.id
  vi.spyOn(first.store, 'executeRunnerProduction').mockResolvedValue({ version: 1, complete: true, answer: 'not executed', artifacts: [], requirement_ids: ['answer'], unresolved: [] })
  const original = first.store.start(task, 'Continue the original work on restart', 'production', []), budget = first.state.run(original).budget_id, ledger = new RunnerBudgetLedger(first.db)
  first.db.prepare('UPDATE runner_budgets SET limits_json=?,created_at=? WHERE budget_id=?').run(JSON.stringify({ model_requests: 1, tool_requests: 1, tokens: 1, wall_ms: 1 }), '2000-01-01T00:00:00.000Z', budget)
  ledger.reserve('prior-planning-cost', budget, 'prior-planning-operation', { model_requests: 2, tool_requests: 2, tokens: 10 })
  ledger.markDispatched('prior-planning-cost'); ledger.settle('prior-planning-cost', { tokens: 10 })
  const before = ledger.snapshot(budget)
  first.store.close()
  const next = setup(first.directory); next.complete.mockResolvedValue(answer('Recovered beyond the legacy limits'))
  await next.store.recoverRunnerWork()
  await vi.waitFor(() => expect(next.records(task, 'runner.answer')).toHaveLength(1))
  expect(next.complete).toHaveBeenCalledTimes(1)
  expect(next.records(task, 'runner.goal.waiting')).toEqual([])
  const work = next.state.taskWorks(task).find(value => value.purpose === 'production')!
  expect(next.state.run(work.run_id)).toMatchObject({ previous_run_id: original, budget_id: budget })
  expect(new RunnerBudgetLedger(next.db).snapshot(budget).total).toEqual({ model_requests: before.total.model_requests + 1, tool_requests: before.total.tool_requests, tokens: before.total.tokens + 38 })
  expect(next.db.prepare('SELECT COUNT(*) n FROM runner_budgets WHERE task_id=?').get(task)).toEqual({ n: 1 })
})

it('rechecks the original material metadata before granting resumed execution', async () => {
  const first = setup(), task = first.store.create('Changed recovery material').task.id
  const registration = first.store.handle({ type: 'material.internal.register', task_id: task, items: [{ display_name: 'original.txt', source: 'text' }] }) as { items: { operation_id: string }[] }
  const operation = registration.items[0]!.operation_id, body = Buffer.from('Original immutable material')
  first.store.handle({ type: 'material.internal.begin', task_id: task, operation_id: operation, byte_length: body.length, media_type: 'text/plain; charset=utf-8' })
  first.store.handle({ type: 'material.internal.chunk', task_id: task, operation_id: operation, offset: 0, data: body.toString('base64') })
  const imported = first.store.handle({ type: 'material.internal.finish', task_id: task, operation_id: operation }) as { resource: { id: string } }
  const request = 'material-request', text = 'Use the original bound material'
  first.db.prepare("INSERT INTO requests(id,task_id,state,config_selection_json,input_json,created_at) VALUES (?,?,'queued',?,?,?)").run(request, task, JSON.stringify({ id: 'production', revision: 1, approval_mode: 'manual' }), JSON.stringify({ text, epoch: first.store.epoch, binding_version: 1, resource_ids: [imported.resource.id], import_ids: [] }), new Date().toISOString())
  vi.spyOn(first.store, 'executeRunnerProduction').mockResolvedValue({ version: 1, complete: true, answer: 'not executed', artifacts: [], requirement_ids: ['answer'], unresolved: [] })
  const original = first.store.start(task, text, 'production', [{ id: imported.resource.id }], request)
  first.db.prepare('UPDATE resources SET display_name=? WHERE id=?').run('changed.txt', imported.resource.id)
  first.store.close()
  const next = setup(first.directory)
  await next.store.recoverRunnerWork()
  expect(next.complete).not.toHaveBeenCalled()
  expect(next.records(task, 'runner.goal.waiting')).toMatchObject([{ previous_run_id: original, reason: 'REQUEST_MATERIAL_UNAVAILABLE' }])
  expect(next.db.prepare('SELECT COUNT(*) n FROM runner_runs WHERE task_id=?').get(task)).toEqual({ n: 1 })
})

async function approvePublication(s: ReturnType<typeof setup>, task: string) {
  await vi.waitFor(() => expect(s.store.snapshot(task).approvals.some(approval => approval.decision === 'pending' && approval.validity === 'valid')).toBe(true))
  const approval = s.store.snapshot(task).approvals.find(approval => approval.decision === 'pending' && approval.validity === 'valid')!
  s.store.handle({ type: 'approval.decide', task_id: task, approval_id: approval.id, decision: 'approve' })
  await vi.waitFor(() => expect(s.store.snapshot(task).surface_updates.some(update => update.action_id === approval.action_id)).toBe(true))
  await s.store.handle({ type: 'surface.respond', task_id: task, action_id: approval.action_id, proceed: true, confirm_discard: false })
}

it('resumes an undispatched composition batch and keeps its publication stable across the next restart', async () => {
  const first = setup(), task = first.store.create('Composition recovery').task.id
  vi.spyOn(first.store as any, 'scheduleRunnerComposition').mockImplementation(() => {})
  first.complete.mockImplementation(async () => produceFragments(first, task, 1))
  const run = first.store.start(task, 'One bounded fragment', 'production', [])
  await vi.waitFor(() => expect(first.state.run(run).state).toBe('completed'))
  const prepared = first.store.prepareRunnerComposition(task, first.request(run)), budget = first.state.run(prepared.run_id).budget_id
  first.store.close()
  const next = setup(first.directory)
  await next.store.recoverRunnerWork()
  await approvePublication(next, task)
  await vi.waitFor(() => expect(next.store.runnerGoals({ task_id: task }).scope?.state).toBe('complete'))
  expect(next.complete).not.toHaveBeenCalled()
  const successor = next.records(task, 'runner.composition.prepared').at(-1)!
  expect(successor.batch_id).not.toBe(prepared.batch.batch_id)
  expect(next.state.run(successor.run_id).budget_id).toBe(budget)
  const views = next.store.snapshot(task).views, operation = next.store.runnerPublicationOperation(task, successor.operation_id)
  next.store.close()
  const third = setup(first.directory)
  await third.store.recoverRunnerWork()
  expect(third.store.snapshot(task).views).toEqual(views)
  expect(third.store.runnerPublicationOperation(task, successor.operation_id)).toEqual(operation)
  expect(third.records(task, 'runner.composition.prepared')).toHaveLength(2)
  expect(third.complete).not.toHaveBeenCalled()
})

it('revokes a pending publication approval and rejects its old attempt after restart', async () => {
  const first = setup(), task = first.store.create('Revoked publication approval').task.id
  vi.spyOn(first.store as any, 'scheduleRunnerComposition').mockImplementation(() => {})
  first.complete.mockImplementation(async () => produceFragments(first, task, 1))
  const run = first.store.start(task, 'One approved publication', 'production', [])
  await vi.waitFor(() => expect(first.state.run(run).state).toBe('completed'))
  const prepared = first.store.prepareRunnerComposition(task, first.request(run))
  const pending = first.store.publishRunnerComposition(task, prepared.batch.batch_id, prepared.collator.rulePlan()).catch(() => undefined)
  await vi.waitFor(() => expect(first.store.snapshot(task).approvals.some(approval => approval.decision === 'pending')).toBe(true))
  const approval = first.store.snapshot(task).approvals.find(approval => approval.action_id === prepared.batch.action_id)!
  first.store.close(); await pending
  const next = setup(first.directory)
  await next.store.recoverRunnerWork()
  expect(next.store.snapshot(task).approvals.find(item => item.id === approval.id)?.validity).toBe('revoked')
  expect(() => next.store.handle({ type: 'approval.decide', task_id: task, approval_id: approval.id, decision: 'approve' })).toThrow()
  expect(() => next.state.qualify(prepared.publisher_attempt_id, 'commit')).toThrow()
  expect(next.store.snapshot(task).views).toEqual([])
  expect(next.complete).not.toHaveBeenCalled()
})
