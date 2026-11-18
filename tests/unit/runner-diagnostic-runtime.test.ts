import type Database from 'better-sqlite3'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ExecutionScope, LogicalWork, ModelConfiguration } from '../../src/shared/contracts.generated'
import { ChatAdapter, type Completion } from '../../src/runtime/model/adapter'
import { ModelService, type ModelLease } from '../../src/runtime/model/service'
import { RunnerArtifactState } from '../../src/runtime/runner/artifact-state'
import { RunnerBudgetLedger } from '../../src/runtime/runner/budget'
import { RunnerHostProgress } from '../../src/runtime/runner/host-progress'
import { RunnerWorkState } from '../../src/runtime/runner/work-state'
import { createWorkerProfile } from '../../src/runtime/runner/worker-profile'
import { RuntimeStore } from '../../src/runtime/store'

const stores: RuntimeStore[] = [], secret = 'PRIVATE GOAL BODY, TOOL DATA AND TASK SUMMARY'
afterEach(() => { for (const store of stores.splice(0)) store.close(); vi.restoreAllMocks() })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const completion = (text: string): Completion => ({ text, calls: [], finish: 'stop', usage: { prompt_tokens: 25, completion_tokens: 5 } })
function suggestion(metadata: { reason: string; calls: { record_id: string }[] }): Completion {
  return completion(JSON.stringify({ version: 1, assessment: metadata.reason, evidence_record_ids: [metadata.calls.at(-1)!.record_id], recommendation: 'review_goal', automatic_replay: false, execution_permission: false, recovery_permission: false }))
}

function openRuntime(directory = mkdtempSync(join(tmpdir(), 'pliuna-diagnostic-')), diagnostics = true, outputTokens = 1024) {
  const adapter = new ChatAdapter(), service = new ModelService(adapter)
  const config: ModelConfiguration = { id: 'diagnostic-model', base_url: 'https://example.invalid/v1', wire_model_id: 'synthetic', context_tokens: 1000000, max_output_tokens: outputTokens, compatibility_profile: 'chat-max-tokens' }
  service.configure({ type: 'model.configure', configuration: config, api_key: 'synthetic', confirm_memory_only: true })
  const lease: ModelLease = { id: config.id, revision: 1, config, release: vi.fn() }
  vi.spyOn(service, 'acquire').mockReturnValue(lease); vi.spyOn(service, 'acquireCompaction').mockReturnValue(undefined)
  const complete = vi.spyOn(adapter, 'complete').mockImplementation(async (_config, _key, messages) => suggestion(JSON.parse(messages[1]!.content!)))
  const features = { viewReplacement: false, runner: { productionRuns: 1 as const, diagnostics } }
  const store = new RuntimeStore(directory, service, features); stores.push(store)
  const internal = store as unknown as {
    db: Database.Database
    epoch: string
    record(task: string, kind: string, value: Record<string, unknown>): string
    observeRunnerGoal(owner: ExecutionScope, force?: boolean): void
    aggregateWorkerRun(task: string, run: string): void
    pumpRunnerWorkers(task: string): void
  }
  const { db, epoch } = internal, state = new RunnerWorkState(db, epoch), ledger = new RunnerBudgetLedger(db)
  const records = (task: string, kind: string) => (db.prepare('SELECT id,sequence,payload_json FROM records WHERE task_id=? AND kind=? ORDER BY sequence').all(task, kind) as { id: string; sequence: number; payload_json: string }[]).map(row => ({ ...row, payload: JSON.parse(row.payload_json) }))
  return { directory, config, store, complete, service, internal, db, epoch, state, ledger, features, records }
}

function setup(options: { diagnostics?: boolean; modelRequests?: number; tokens?: number; outputTokens?: number; dispatched?: boolean; works?: number } = {}) {
  const runtime = openRuntime(undefined, options.diagnostics ?? true, options.outputTokens), { store, config, internal, db, epoch, state, ledger } = runtime
  const task = store.create('Diagnostic goal').task.id, run = 'run', request = 'goal'
  db.prepare("INSERT INTO requests(id,task_id,state,config_selection_json,input_json,created_at) VALUES (?,?, 'started','{}',?,?)").run(request, task, JSON.stringify({ text: secret }), new Date().toISOString())
  const record = (kind: string, value: Record<string, unknown>) => internal.record(task, kind, value)
  const input = record('message.user', { text: secret })
  state.receive({ input_event_id: 'input', task_id: task, kind: 'request', record_id: input, request_id: request, stage: 'received' })
  state.installGoal({ task_id: task, request_id: request, intent_revision: 1, input_event_id: 'input', state: 'active', requirements: [{ requirement_id: 'answer', kind: 'answer', required: true, provenance_required: false }] })
  ledger.create({ budget_id: 'budget', task_id: task, purpose: 'production', request_id: request })
  db.prepare("UPDATE runner_budgets SET limits_json=? WHERE budget_id='budget'").run(JSON.stringify({ model_requests: options.modelRequests ?? 30, tool_requests: 40, tokens: options.tokens ?? 1000000, wall_ms: 60000 }))
  db.prepare("INSERT INTO runs(id,task_id,request_id,state,runtime_epoch,limits_json,budget_json,created_at) VALUES (?,?,?,'running',?,'{}','{}',?)").run(run, task, request, epoch, new Date().toISOString())
  state.registerRun({ run_id: run, task_id: task, runtime_epoch: epoch, state: 'running', commit_valid: true, budget_id: 'budget', purpose: 'production', request_id: request, intent_revision: 1 })
  const works: LogicalWork[] = Array.from({ length: options.works ?? 1 }, (_, index) => ({ work_id: `producer-${index}`, task_id: task, run_id: run, plan_revision: 1, role: 'producer', required: true, requirement_ids: ['answer'], dependencies: [{ kind: 'goal', task_id: task, request_id: request, intent_revision: 1 }], state: 'planned', max_attempts: 1, purpose: 'production', request_id: request, intent_revision: 1 }))
  state.installPlan(works)
  for (const work of works) {
    state.createAttempt({ attempt_id: `attempt-${work.work_id}`, work_id: work.work_id, task_id: task, run_id: run, runtime_epoch: epoch, attempt_number: 1, profile_id: 'producer-test', model_config_id: config.id, model_config_revision: 1, input_versions: work.dependencies, state: 'registered', dispatch_state: 'not_dispatched', usage_refs: [], purpose: 'production', request_id: request, intent_revision: 1 })
    if (options.dispatched !== false) {
      state.updateAttempt({ ...state.attempt(`attempt-${work.work_id}`), state: 'dispatched', dispatch_state: 'dispatched', operation_id: `operation-${work.work_id}` })
      state.updateAttempt({ ...state.attempt(`attempt-${work.work_id}`), state: 'running' })
    }
  }
  const owner: ExecutionScope = { task_id: task, run_id: run, work_id: works[0]!.work_id, attempt_id: `attempt-${works[0]!.work_id}`, role: 'producer', purpose: 'production', request_id: request, intent_revision: 1 }
  if (options.dispatched !== false) record('worker.input', { owner, plan_revision: 1, text: secret })
  record('context.summary.installed', { text: secret, through_sequence: 1 })
  const records = (kind: string) => runtime.records(task, kind)
  const calls = (execution = 'success', count = 8) => Array.from({ length: count }, (_, index) => record('model.tool_result', { owner, run_id: run, message: { role: 'tool', tool_call_id: `read-${index}`, content: JSON.stringify({ request_type: 'read', execution, delivery: 'delivered', data: secret, ...(execution === 'failure' ? { error: { code: 'SOURCE_BUSY', message: secret } } : {}) }) } }))
  const observe = () => internal.observeRunnerGoal(owner, true)
  const waitForResult = () => vi.waitFor(() => { expect(records('runner.progress.diagnostic.result')).toHaveLength(1) })
  return { ...runtime, task, run, owner, record, records, calls, observe, waitForResult }
}

it('executes eligible diagnosis through an owned real model request and the existing shared budget', async () => {
  const s = setup(), evidence = s.calls(); s.observe(); await s.waitForResult()
  expect(s.complete).toHaveBeenCalledTimes(1)
  const request = s.complete.mock.calls[0]!, messages = request[2], metadata = JSON.parse(messages[1]!.content!)
  expect(request[3]).toEqual([])
  expect(request[6]).toBe(s.config.max_output_tokens)
  expect(metadata).toMatchObject({ task_id: s.task, request_id: 'goal', intent_revision: 1, work_id: s.owner.work_id, plan_revision: 1, reason: 'suspected_stall', automatic_replay: false, execution_permission: false, recovery_permission: false })
  expect(metadata.calls.map((call: { record_id: string }) => call.record_id)).toEqual(evidence)
  expect(JSON.stringify(messages)).not.toContain(secret)
  const result = s.records('runner.progress.diagnostic.result')[0]!.payload
  expect(result.owner).toMatchObject({ task_id: s.task, run_id: s.run, purpose: 'production', request_id: 'goal', intent_revision: 1, role: 'diagnostic' })
  expect(s.records('model.request.evidence')[0]!.payload.owner).toEqual(result.owner)
  const reservations = s.db.prepare('SELECT budget_id,attempt_id,state FROM runner_budget_reservations').all()
  expect(reservations).toEqual([{ budget_id: 'budget', attempt_id: result.owner.attempt_id, state: 'settled' }])
  expect(s.ledger.snapshot('budget')).toMatchObject({ settled: { model_requests: 1, tokens: 30 }, unknown: { model_requests: 0 }, reserved: { model_requests: 0 } })
  expect(s.state.work(result.owner.work_id)).toMatchObject({ required: false, requirement_ids: [], role: 'diagnostic', state: 'succeeded' })
  expect(s.state.work(s.owner.work_id).state).toBe('running')
  expect(s.db.prepare('SELECT COUNT(*) n FROM runner_deliveries').get()).toEqual({ n: 0 })
  expect(s.records('message.assistant')).toEqual([])
  s.observe(); expect(s.complete).toHaveBeenCalledTimes(1)
  expect(s.records('runner.progress.diagnostic.queued')).toHaveLength(1)
})

it('keeps a pending diagnosis from reserving the producer output capacity', async () => {
  const s = setup({ tokens: 200000, outputTokens: 131072 }), pending = deferred<Completion>()
  s.ledger.reserve('producer-history', 'budget', 'producer-history', { model_requests: 11, tokens: 37000 }, s.owner.attempt_id)
  s.ledger.markDispatched('producer-history')
  s.ledger.settle('producer-history', { tokens: 37000 })
  s.complete.mockReturnValueOnce(pending.promise)
  s.calls(); s.observe()
  try {
    await vi.waitFor(() => { expect(s.complete).toHaveBeenCalledTimes(1) })
    expect(() => s.ledger.reserve('producer-next', 'budget', 'producer-next', { model_requests: 1, tokens: 144000 }, s.owner.attempt_id)).not.toThrow()
    expect(s.complete.mock.calls[0]![6]).toBe(4096)
    const reservation = s.records('model.request.accounting').find(record => record.payload.phase === 'reserved')!
    expect(reservation.payload.output_reserve).toBe(4096)
    expect(s.state.work(s.owner.work_id).state).toBe('running')
  } finally {
    pending.resolve(suggestion(JSON.parse(s.complete.mock.calls[0]![2][1]!.content!)))
    await s.waitForResult()
  }
})

it('observes repeated failures without tools, error text or replaying the source operation', async () => {
  const s = setup(); s.calls('failure', 3); s.observe(); await s.waitForResult()
  expect(s.complete).toHaveBeenCalledTimes(1)
  const metadata = JSON.parse(s.complete.mock.calls[0]![2][1]!.content!)
  expect(metadata).toMatchObject({ reason: 'repeated_failure', error_source: 'SOURCE_BUSY' })
  expect(JSON.stringify(metadata)).not.toContain(secret)
  expect(s.db.prepare('SELECT COUNT(*) n FROM calls').get()).toEqual({ n: 0 })
  expect(s.state.attempt(s.owner.attempt_id)).toMatchObject({ attempt_number: 1, state: 'running' })
})

it('records the observation without model consumption when diagnostics are disabled', async () => {
  const s = setup({ diagnostics: false }); s.calls(); s.observe(); await Promise.resolve()
  expect(s.records('runner.progress.diagnosis')[0]!.payload.model_diagnosis).toBe('capability_blocked')
  expect(s.records('runner.progress.diagnostic.queued')).toEqual([])
  expect(s.complete).not.toHaveBeenCalled()
  expect(s.records('model.request.evidence')).toEqual([])
  expect(s.ledger.snapshot('budget').total).toEqual({ model_requests: 0, tool_requests: 0, tokens: 0 })
})

it.each([
  { modelRequests: 0, label: 'model request' },
  { tokens: 0, label: 'token' },
  { tokens: 1, label: 'dispatch token reservation' }
])('executes diagnosis and records usage above the legacy $label cap', async options => {
  const s = setup(options); s.calls(); s.observe(); await s.waitForResult()
  expect(s.complete).toHaveBeenCalledTimes(1)
  expect(s.records('runner.progress.diagnosis')[0]!.payload.model_diagnosis).toBe('eligible')
  expect(s.ledger.snapshot('budget')).toMatchObject({ settled: { model_requests: 1, tokens: 30 }, reserved: { model_requests: 0 }, unknown: { model_requests: 0 } })
  expect(s.state.work(s.owner.work_id).state).toBe('running')
})

it.each(['input', 'approval', 'background', 'unpublished', 'unknown'] as const)('keeps %s evidence silent instead of consuming a diagnostic request', async kind => {
  const s = setup(); s.calls()
  if (kind === 'input' || kind === 'approval') {
    s.state.updateAttempt({ ...s.state.attempt(s.owner.attempt_id), state: 'waiting' })
    s.record('worker.state', { owner: s.owner, state: 'waiting', reason: kind === 'input' ? 'input_required' : 'approval' })
    if (kind === 'approval') {
      s.db.prepare("INSERT INTO actions(id,task_id,run_id,kind,state,source_json,request_json,commit_valid,created_at) VALUES ('approval-action',?,?,'mutation','waiting',?,'{}',1,?)").run(s.task, s.run, JSON.stringify({ owner: s.owner }), new Date().toISOString())
      s.db.prepare("INSERT INTO approvals VALUES ('approval','approval-action','pending','valid','manual','awaiting_human',?,NULL,?)").run(new Date(Date.now() + 60000).toISOString(), JSON.stringify({ owner: s.owner, runtime_epoch: s.epoch }))
    }
  } else if (kind === 'background') {
    s.record('worker.tool.started', { owner: s.owner, plan_revision: 1, request_type: 'call', capability: 'plugin:worker', operation_id: 'background' })
    s.db.prepare("INSERT INTO calls(id,task_id,run_id,capability_id,state,dispatch,delivery,input_json,limits_json,commit_valid,created_at) VALUES ('background-call',?,?,'plugin:worker','executing','sent','pending','{}',?,1,?)").run(s.task, s.run, JSON.stringify({ owner: s.owner }), new Date().toISOString())
  } else if (kind === 'unpublished') {
    const artifacts = new RunnerArtifactState(s.db, s.state), provenance = s.record('worker.content.produced', { owner: s.owner, value: secret })
    artifacts.installOutline({ task_id: s.task, outline_revision: 1, base_outline_revision: 0, sections: [{ section_id: 'section', request_id: 'goal', intent_revision: 1, position_revision: 1, order_key: 'a' }] })
    artifacts.assign([{ task_id: s.task, artifact_id: 'artifact', work_id: s.owner.work_id, plan_revision: 1, section_id: 'section', base_artifact_revision: 0 }])
    s.db.prepare("INSERT INTO resources(id,storage_key,sha256,byte_length,media_type,display_name,created_at) VALUES ('body','body.json','fixture',2,'application/json','Content',?)").run(new Date().toISOString())
    s.db.prepare('INSERT INTO task_resources VALUES (?,?)').run(s.task, 'body')
    artifacts.decide({ candidate_id: 'candidate', task_id: s.task, request_id: 'goal', intent_revision: 1, run_id: s.run, work_id: s.owner.work_id, attempt_id: s.owner.attempt_id, artifact_id: 'artifact', plan_revision: 1, base_artifact_revision: 0, bundle_resource_id: 'body', section_id: 'section', section_position_revision: 1, order_key: 'a', presentation_kind: 'managed-v1', width_constraint: 'full', interaction_kind: 'none', provenance_ref: { task_id: s.task, kind: 'record', id: provenance }, dependencies: s.state.work(s.owner.work_id).dependencies, requirement_ids: ['answer'], unresolved: [] }, { state: 'accepted' })
  } else s.calls('unknown', 1)
  s.observe(); await Promise.resolve()
  expect(s.records('runner.progress.checkpoint')).toHaveLength(1)
  expect(s.records('runner.progress.diagnosis')).toEqual([])
  expect(s.records('runner.progress.diagnostic.queued')).toEqual([])
  expect(s.complete).not.toHaveBeenCalled()
  expect(s.ledger.snapshot('budget').total.model_requests).toBe(0)
})

it('cannot turn an attempted diagnostic tool call into a second model request or recovery permission', async () => {
  const s = setup()
  s.complete.mockResolvedValue({ text: '', calls: [{ id: 'denied-call', type: 'function', function: { name: 'call', arguments: JSON.stringify({ capability: 'plugin:worker', arguments: { secret } }) } }], finish: 'tool_calls', usage: { prompt_tokens: 25, completion_tokens: 5 } })
  s.calls(); s.observe()
  await vi.waitFor(() => { expect(s.records('runner.progress.diagnostic.ended')).toHaveLength(1) })
  expect(s.complete).toHaveBeenCalledTimes(1)
  expect(s.records('runner.progress.diagnostic.result')).toEqual([])
  expect(s.records('runner.progress.diagnostic.ended')[0]!.payload).toMatchObject({ code: 'RUNNER_DIAGNOSTIC_LIMIT', automatic_replay: false, execution_permission: false, recovery_permission: false })
  expect(s.db.prepare('SELECT COUNT(*) n FROM calls').get()).toEqual({ n: 0 })
  expect(s.records('worker.tool.started')).toEqual([])
  expect(s.ledger.snapshot('budget').settled.model_requests).toBe(1)
})

it('queues diagnosis under the Task work limit and cancels it when required work completes', async () => {
  const s = setup({ works: 6 }); s.calls(); s.observe()
  const queued = s.records('runner.progress.diagnostic.queued')[0]!.payload
  expect(s.state.attempt(queued.attempt_id)).toMatchObject({ state: 'queued', dispatch_state: 'not_dispatched' })
  expect(s.complete).not.toHaveBeenCalled()
  for (const work of s.state.taskWorks(s.task).filter(work => work.required)) {
    const result = s.record('worker.result', { value: 'done' })
    s.state.updateAttempt({ ...s.state.attempt(work.current_attempt_id!), state: 'succeeded', result_ref: { task_id: s.task, kind: 'record', id: result } })
  }
  s.internal.aggregateWorkerRun(s.task, s.run)
  await vi.waitFor(() => { expect(s.records('runner.progress.diagnostic.ended')).toHaveLength(1) })
  expect(s.state.attempt(queued.attempt_id).state).toBe('revoked')
  expect(s.state.run(s.run)).toMatchObject({ state: 'completed', commit_valid: false })
  expect(s.complete).not.toHaveBeenCalled()
  expect(s.ledger.snapshot('budget').total.model_requests).toBe(0)
})

it('rechecks the diagnostic capability when a queued opportunity is admitted', async () => {
  const s = setup({ works: 6 }); s.calls(); s.observe()
  const queued = s.records('runner.progress.diagnostic.queued')[0]!.payload
  s.features.runner.diagnostics = false
  const work = s.state.taskWorks(s.task).find(work => work.work_id === 'producer-1')!, result = s.record('worker.result', { value: 'done' })
  s.state.updateAttempt({ ...s.state.attempt(work.current_attempt_id!), state: 'succeeded', result_ref: { task_id: s.task, kind: 'record', id: result } })
  s.internal.pumpRunnerWorkers(s.task)
  await vi.waitFor(() => { expect(s.records('runner.progress.diagnostic.ended')).toHaveLength(1) })
  expect(s.records('runner.progress.diagnostic.ended')[0]!.payload.code).toBe('INVALID_DIAGNOSTIC_CONTEXT')
  expect(s.state.attempt(queued.attempt_id)).toMatchObject({ state: 'revoked', dispatch_state: 'not_dispatched' })
  expect(s.complete).not.toHaveBeenCalled()
  expect(s.ledger.snapshot('budget').total.model_requests).toBe(0)
})

it('revokes active diagnosis on required completion and settles a late provider usage observation', async () => {
  const s = setup(), entered = deferred<void>(), finish = deferred<Completion>()
  let signal!: AbortSignal, response!: Completion
  s.complete.mockImplementation(async (_config, _key, messages, _tools, currentSignal) => {
    signal = currentSignal; response = suggestion(JSON.parse(messages[1]!.content!)); entered.resolve(); return finish.promise
  })
  s.calls(); s.observe(); await entered.promise
  const queued = s.records('runner.progress.diagnostic.queued')[0]!.payload
  const result = s.record('worker.result', { value: 'required output' })
  s.state.updateAttempt({ ...s.state.attempt(s.owner.attempt_id), state: 'succeeded', result_ref: { task_id: s.task, kind: 'record', id: result } })
  s.internal.aggregateWorkerRun(s.task, s.run)
  expect(signal.aborted).toBe(true)
  expect(s.state.work(s.owner.work_id).state).toBe('succeeded')
  expect(s.state.work(queued.work_id).state).toBe('cancelled')
  expect(s.state.attempt(queued.attempt_id).state).toBe('running')
  expect(s.records('runner.progress.diagnostic.result')).toEqual([])
  finish.resolve(response)
  await vi.waitFor(() => { expect(s.records('runner.progress.diagnostic.ended')).toHaveLength(1) })
  expect(s.state.attempt(queued.attempt_id).state).toBe('cancelled')
  expect(s.state.run(s.run)).toMatchObject({ state: 'completed', commit_valid: false })
  expect(s.ledger.snapshot('budget')).toMatchObject({ settled: { model_requests: 1, tokens: 30 }, reserved: { model_requests: 0 }, unknown: { model_requests: 0 } })
  expect(s.records('runner.progress.diagnostic.result')).toEqual([])
  expect(s.records('message.assistant')).toEqual([])
  expect(s.complete).toHaveBeenCalledTimes(1)
})

it('triggers from real tool-result advancement without a timer or a status query', async () => {
  const s = setup({ dispatched: false }), diagnosticFinished = deferred<void>(), finishProducer = deferred<Completion>()
  let producerRequests = 0
  s.complete.mockImplementation(async (_config, _key, messages) => {
    if (messages[0]!.content!.startsWith('You diagnose')) {
      const response = suggestion(JSON.parse(messages[1]!.content!)); diagnosticFinished.resolve(); return response
    }
    if (++producerRequests === 1) return { text: '', finish: 'tool_calls', usage: { prompt_tokens: 25, completion_tokens: 5 }, calls: Array.from({ length: 8 }, (_, index) => ({ id: `read-${index}`, type: 'function' as const, function: { name: 'read', arguments: JSON.stringify({ kind: 'task', id: s.task }) } })) }
    return finishProducer.promise
  })
  const profile = createWorkerProfile({ id: 'producer-test', role: 'producer', system: 'Produce the requested answer', grants: [{ type: 'read', kind: 'task', ids: [s.task] }], parseResult: response => ({ answer: response.text }) })
  const producer = s.store.executeWorker(s.owner.attempt_id, profile, { text: secret })
  await diagnosticFinished.promise; await s.waitForResult()
  expect(s.records('runner.progress.diagnosis')[0]!.payload.reason).toBe('suspected_stall')
  expect(s.records('runner.progress.diagnostic.queued')).toHaveLength(1)
  expect(s.ledger.snapshot('budget').settled.model_requests).toBeGreaterThanOrEqual(2)
  finishProducer.resolve(completion('done')); await expect(producer).resolves.toEqual({ answer: 'done' })
  expect(s.state.run(s.run).state).toBe('completed')
  const diagnosticRequest = s.complete.mock.calls.find(call => call[2][0]!.content!.startsWith('You diagnose'))!
  expect(JSON.stringify(diagnosticRequest[2])).not.toContain(secret)
  expect(s.records('runner.progress.diagnostic.result')[0]!.payload.owner.role).toBe('diagnostic')
})

it('does not recursively include diagnostic history in further observation', async () => {
  const s = setup(); s.calls(); s.observe(); await s.waitForResult()
  const observed = new RunnerHostProgress(s.db, s.epoch).observe(s.task, 'goal', { capability_allowed: true })
  expect(observed.works.map(work => work.work_id)).toEqual([s.owner.work_id])
  expect(observed.diagnoses[0]!.model_diagnosis).toBe('same_evidence')
})

function persistedDiagnosis(mode: 'queued' | 'succeeded' | 'unknown' | 'cancelled_unknown') {
  const s = openRuntime(), task = s.store.create('Diagnostic restart').task.id
  vi.spyOn(s.store, 'executeRunnerProduction').mockResolvedValue({ version: 1, complete: true, answer: 'not executed', artifacts: [], requirement_ids: ['answer'], unresolved: [] })
  const run = s.store.start(task, secret, s.config.id, []), producer = s.state.taskWorks(task)[0]!, budget = s.state.run(run).budget_id
  if (producer.purpose !== 'production') throw new Error('Expected production work')
  const record = (kind: string, payload: Record<string, unknown>) => s.internal.record(task, kind, payload)
  const work: LogicalWork = { work_id: 'diagnostic', task_id: task, run_id: run, plan_revision: 1, role: 'diagnostic', required: false, requirement_ids: [], dependencies: producer.dependencies, state: 'planned', max_attempts: 1, purpose: 'production', request_id: producer.request_id, intent_revision: 1 }
  s.state.installPlan([work])
  s.state.createAttempt({ attempt_id: 'diagnostic-attempt', work_id: work.work_id, task_id: task, run_id: run, runtime_epoch: s.epoch, attempt_number: 1, profile_id: 'runner-diagnostic-v1', model_config_id: s.config.id, model_config_revision: 1, input_versions: work.dependencies, state: 'registered', dispatch_state: 'not_dispatched', usage_refs: [], purpose: 'production', request_id: producer.request_id, intent_revision: 1 })
  const evidence = record('runner.progress.diagnostic.queued', { run_id: run, work_id: work.work_id, attempt_id: 'diagnostic-attempt', automatic_replay: false, execution_permission: false, recovery_permission: false })
  const checkpoint = new RunnerHostProgress(s.db, s.epoch).observe(task, producer.request_id, { capability_allowed: true }).checkpoint
  s.ledger.reserve('prior-planning', budget, 'planning-operation', { model_requests: 1, tokens: 10 })
  s.ledger.markDispatched('prior-planning'); s.ledger.settle('prior-planning', { tokens: 10 })
  s.ledger.reserve('diagnostic-reservation', budget, 'diagnostic-model-operation', { model_requests: 1, tokens: 1024 }, 'diagnostic-attempt')
  if (mode === 'queued') s.state.updateAttempt({ ...s.state.attempt('diagnostic-attempt'), state: 'queued' })
  else {
    s.ledger.markDispatched('diagnostic-reservation')
    // The unknown case loses the enclosing attempt update after its durable
    // model-dispatch barrier. Recovery must infer dispatch from that evidence.
    if (mode !== 'unknown') {
      s.state.updateAttempt({ ...s.state.attempt('diagnostic-attempt'), state: 'dispatched', dispatch_state: 'dispatched', operation_id: 'diagnostic-operation' })
      if (mode === 'succeeded') {
        s.ledger.settle('diagnostic-reservation', { tokens: 30 })
        const result = record('worker.result', { value: 'bounded diagnostic suggestion' })
        s.state.updateAttempt({ ...s.state.attempt('diagnostic-attempt'), state: 'succeeded', result_ref: { task_id: task, kind: 'record', id: result } })
      } else s.state.updateAttempt({ ...s.state.attempt('diagnostic-attempt'), state: 'cancelled' })
    }
  }
  return { ...s, task, run, producer, budget, evidence, checkpoint }
}

it.each(['queued', 'succeeded'] as const)('resumes production after a real restart without replaying a %s diagnostic', async mode => {
  const first = persistedDiagnosis(mode), before = first.ledger.snapshot(first.budget)
  first.store.close()
  const next = openRuntime(first.directory); next.complete.mockResolvedValue(completion('Recovered answer'))
  await next.store.recoverRunnerWork()
  await vi.waitFor(() => expect(next.records(first.task, 'runner.answer')).toHaveLength(1))
  const resumed = next.state.work(first.producer.work_id), run = next.state.run(resumed.run_id)
  expect(run).toMatchObject({ previous_run_id: first.run, budget_id: first.budget, runtime_epoch: next.epoch })
  expect(next.state.attempt(resumed.current_attempt_id!)).toMatchObject({ previous_attempt_id: first.producer.current_attempt_id, attempt_number: 2, profile_id: 'producer-output-v1' })
  expect(next.state.work('diagnostic')).toMatchObject({ run_id: first.run, role: 'diagnostic', plan_revision: 1 })
  expect(next.state.attempts('diagnostic')).toMatchObject([{ attempt_id: 'diagnostic-attempt', profile_id: 'runner-diagnostic-v1', state: mode === 'queued' ? 'revoked' : 'succeeded', attempt_number: 1 }])
  expect(next.records(first.task, 'runner.progress.diagnostic.queued').map(record => record.id)).toEqual([first.evidence])
  expect(next.records(first.task, 'runner.progress.checkpoint')[0]!.payload).toEqual(first.checkpoint)
  expect(next.ledger.query('diagnostic-reservation').state).toBe(mode === 'queued' ? 'released' : 'settled')
  expect(next.ledger.snapshot(first.budget).settled.model_requests).toBe(before.settled.model_requests + 1)
  expect(next.db.prepare('SELECT COUNT(*) n FROM runner_budgets WHERE task_id=?').get(first.task)).toEqual({ n: 1 })
  await next.store.recoverRunnerWork()
  expect(next.complete).toHaveBeenCalledTimes(1)
  expect(next.records(first.task, 'runner.goal.waiting')).toEqual([])
})

it.each(['unknown', 'cancelled_unknown'] as const)('keeps %s diagnostic dispatch as an explicit production recovery blocker', async mode => {
  const first = persistedDiagnosis(mode), before = first.ledger.snapshot(first.budget)
  first.store.close()
  const next = openRuntime(first.directory); next.complete.mockResolvedValue(completion('Must not replay'))
  await next.store.recoverRunnerWork(); await next.store.recoverRunnerWork()
  expect(next.complete).not.toHaveBeenCalled()
  expect(next.state.run(first.run)).toMatchObject({ state: 'interrupted', commit_valid: false })
  expect(next.state.attempt('diagnostic-attempt')).toMatchObject({ state: mode === 'unknown' ? 'unknown' : 'cancelled', attempt_number: 1, profile_id: 'runner-diagnostic-v1' })
  expect(next.ledger.query('diagnostic-reservation').state).toBe('unknown')
  expect(next.ledger.snapshot(first.budget)).toMatchObject({ total: before.total, settled: before.settled, unknown: { model_requests: 1, tokens: 1024 } })
  expect(next.records(first.task, 'runner.goal.waiting').map(record => record.payload)).toMatchObject([{ previous_run_id: first.run, reason: 'RUNNER_OPERATION_UNKNOWN' }])
  expect(next.records(first.task, 'runner.progress.diagnostic.queued').map(record => record.id)).toEqual([first.evidence])
  expect(next.records(first.task, 'runner.progress.checkpoint')[0]!.payload).toEqual(first.checkpoint)
  expect(next.db.prepare('SELECT COUNT(*) n FROM runner_runs WHERE task_id=?').get(first.task)).toEqual({ n: 1 })
  expect(next.state.attempts(first.producer.work_id)).toHaveLength(1)
  expect(next.state.attempts('diagnostic')).toHaveLength(1)
})
