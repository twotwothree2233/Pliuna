import type Database from 'better-sqlite3'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ExecutionAttempt, ExecutionScope, LogicalWork, ModelConfiguration } from '../../src/shared/contracts.generated'
import { ContractError } from '../../src/shared/validation'
import { ChatAdapter, ModelError, type ChatMessage, type Completion, type ToolCall } from '../../src/runtime/model/adapter'
import { messageEvidence } from '../../src/runtime/model/request-evidence'
import { ModelScheduler, ModelService, type ModelLease } from '../../src/runtime/model/service'
import { modelToolRequest } from '../../src/runtime/model/tool-input'
import { RunnerBudgetLedger } from '../../src/runtime/runner/budget'
import { createWorkerProfile, type WorkerGrant, type WorkerProfile } from '../../src/runtime/runner/worker-profile'
import { RunnerWorkState } from '../../src/runtime/runner/work-state'
import { RuntimeStore } from '../../src/runtime/store'

const stores: RuntimeStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  vi.restoreAllMocks()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const answer = (text = 'done'): Completion => ({ text, calls: [], finish: 'stop', usage: { prompt_tokens: 20, completion_tokens: 2 } })
const call = (resource: string, extra: Record<string, unknown> = {}): ToolCall => ({ id: 'same-call-id', type: 'function', function: { name: 'read', arguments: JSON.stringify({ kind: 'resource', id: resource, ...extra }) } })
const toolResponse = (...calls: ToolCall[]): Completion => ({ text: '', calls, finish: 'tool_calls', usage: { prompt_tokens: 20, completion_tokens: 2 } })

function profile(name: string, grants: readonly WorkerGrant[] = []): WorkerProfile<{ answer: string }> {
  return createWorkerProfile({ id: `profile-${name}`, role: 'producer', system: `Worker rules: ${name}`, grants, parseResult: response => ({ answer: response.text }) })
}

function setup(names = ['alpha', 'beta'], configuration: Partial<ModelConfiguration> = {}, optional: readonly string[] = [], budgetLimits: Partial<{ model_requests: number; tool_requests: number; tokens: number; wall_ms: number }> = {}) {
  const adapter = new ChatAdapter(), scheduler = new ModelScheduler(), service = new ModelService(adapter, scheduler)
  const config: ModelConfiguration = { id: 'isolated', base_url: 'https://example.invalid/v1', wire_model_id: 'synthetic', context_tokens: 1000000, max_output_tokens: 1024, compatibility_profile: 'chat-max-tokens', ...configuration }
  service.configure({ type: 'model.configure', configuration: config, api_key: 'synthetic', confirm_memory_only: true })
  const release = vi.fn(), lease: ModelLease = { id: config.id, revision: 1, config, release }
  const acquire = vi.spyOn(service, 'acquire').mockReturnValue(lease)
  vi.spyOn(service, 'acquireCompaction').mockReturnValue(undefined)
  const request = vi.spyOn(service, 'request')
  const complete = vi.spyOn(adapter, 'complete')
  const store = new RuntimeStore(mkdtempSync(join(tmpdir(), 'pliuna-worker-runtime-')), service)
  stores.push(store)
  const internal = store as unknown as {
    db: Database.Database
    epoch: string
    record(task: string, kind: string, payload: Record<string, unknown>): string
    query(task: string, request: unknown, source?: string): unknown
    finish(task: string, run: string, state: string, reason: string): void
  }
  const { db, epoch } = internal, task = store.create('Worker isolation').task.id
  const goal = 'goal', run = 'run', state = new RunnerWorkState(db, epoch)
  db.prepare("INSERT INTO requests(id,task_id,state,config_selection_json,input_json,created_at) VALUES (?,?,'started','{}',?,'time')").run(goal, task, JSON.stringify({ text: 'Outer goal' }))
  const input = internal.record(task, 'message.user', { text: 'Outer goal' })
  state.receive({ input_event_id: 'input', task_id: task, kind: 'request', record_id: input, request_id: goal, stage: 'received' })
  state.installGoal({ task_id: task, request_id: goal, intent_revision: 1, input_event_id: 'input', state: 'active', requirements: [{ requirement_id: 'answer', kind: 'answer', required: true, provenance_required: false }] })
  new RunnerBudgetLedger(db).create({ budget_id: 'budget', task_id: task, purpose: 'production', request_id: goal })
  db.prepare("UPDATE runner_budgets SET limits_json=? WHERE budget_id='budget'").run(JSON.stringify({ model_requests: 50, tool_requests: 50, tokens: 1000000, wall_ms: 60000, ...budgetLimits }))
  db.prepare("INSERT INTO runs(id,task_id,request_id,state,runtime_epoch,limits_json,budget_json,created_at) VALUES (?,?,?,'running',?,'{}','{}','time')").run(run, task, goal, epoch)
  state.registerRun({ run_id: run, task_id: task, runtime_epoch: epoch, state: 'running', commit_valid: true, budget_id: 'budget', purpose: 'production', request_id: goal, intent_revision: 1 })
  const works: LogicalWork[] = names.map(name => ({ work_id: name, task_id: task, run_id: run, plan_revision: 1, role: 'producer', required: !optional.includes(name), requirement_ids: ['answer'], dependencies: [{ kind: 'goal', task_id: task, request_id: goal, intent_revision: 1 }], state: 'planned', max_attempts: 1, purpose: 'production', request_id: goal, intent_revision: 1 }))
  state.installPlan(works)
  for (const work of works) {
    const attempt: ExecutionAttempt = { attempt_id: `attempt-${work.work_id}`, work_id: work.work_id, task_id: task, run_id: run, runtime_epoch: epoch, attempt_number: 1, profile_id: `profile-${work.work_id}`, model_config_id: config.id, model_config_revision: 1, input_versions: work.dependencies, state: 'registered', dispatch_state: 'not_dispatched', usage_refs: [], purpose: 'production', request_id: goal, intent_revision: 1 }
    state.createAttempt(attempt)
  }
  const owner = (name: string): ExecutionScope => ({ task_id: task, run_id: run, work_id: name, attempt_id: `attempt-${name}`, role: 'producer', purpose: 'production', request_id: goal, intent_revision: 1 })
  const records = (kind: string) => (db.prepare('SELECT id,sequence,payload_json FROM records WHERE task_id=? AND kind=? ORDER BY sequence').all(task, kind) as { id: string; sequence: number; payload_json: string }[]).map(row => ({ ...row, payload: JSON.parse(row.payload_json) }))
  const resource = (text: string) => (store.modelTool(task, run, { type: 'write', input: { type: 'resource.create', display_name: 'Worker material', content: { type: 'text', text } } }) as { data: { id: string } }).data.id
  return { store, service, scheduler, complete, request, acquire, release, internal, db, task, run, state, owner, records, resource }
}

it('isolates interleaved same-Run work and equal call IDs in real requests and persisted evidence', async () => {
  const s = setup(), alphaText = 'ALPHA PRIVATE MATERIAL', betaText = 'BETA PRIVATE MATERIAL'
  const resources = { alpha: s.resource(alphaText), beta: s.resource(betaText) }
  const entered = { alpha: deferred<void>(), beta: deferred<void>() }, finish = { alpha: deferred<Completion>(), beta: deferred<Completion>() }
  const sent: { name: 'alpha' | 'beta'; messages: ChatMessage[] }[] = []
  s.complete.mockImplementation(async (_config, _key, messages) => {
    const name = messages[0]!.content!.endsWith('alpha') ? 'alpha' : 'beta'
    sent.push({ name, messages: JSON.parse(JSON.stringify(messages)) })
    if (!messages.some(message => message.role === 'tool')) return toolResponse(call(resources[name]))
    entered[name].resolve(); return finish[name].promise
  })
  const run = (name: 'alpha' | 'beta') => s.store.executeWorker(`attempt-${name}`, profile(name, [{ type: 'read', kind: 'resource', ids: [resources[name]] }]), { text: `${name} input` })
  const alpha = run('alpha')
  await entered.alpha.promise
  const beta = run('beta')
  await entered.beta.promise
  finish.beta.resolve(answer('beta done'))
  await expect(beta).resolves.toEqual({ answer: 'beta done' })
  expect(s.state.attempt('attempt-alpha').state).toBe('running')
  expect(s.state.run(s.run)).toMatchObject({ commit_valid: true })
  expect(['running', 'waiting']).toContain(s.state.run(s.run).state)
  expect(s.release).not.toHaveBeenCalled()
  finish.alpha.resolve(answer('alpha done'))
  await expect(alpha).resolves.toEqual({ answer: 'alpha done' })

  for (const entry of sent) {
    const body = JSON.stringify(entry.messages)
    expect(body).toContain(`${entry.name} input`)
    expect(body).not.toContain(`${entry.name === 'alpha' ? 'beta' : 'alpha'} input`)
    expect(body).not.toContain(entry.name === 'alpha' ? betaText : alphaText)
    const results = entry.messages.filter(message => message.role === 'tool')
    if (results.length) {
      expect(results.map(message => message.tool_call_id)).toEqual(['same-call-id'])
      expect(results[0]!.content).toContain(entry.name === 'alpha' ? alphaText : betaText)
    }
  }
  const sourceOwners = new Map(['worker.input', 'model.response', 'model.tool_result'].flatMap(kind => s.records(kind)).map(record => [record.id, record.payload.owner]))
  const evidence = s.records('model.request.evidence')
  expect(evidence).toHaveLength(4)
  for (const { payload } of evidence) {
    expect(payload.owner).toEqual(s.owner(payload.owner.work_id))
    for (const entry of payload.entries) if (entry.source) {
      expect(entry.owner).toEqual(payload.owner)
      expect(sourceOwners.get(entry.source.id)).toEqual(payload.owner)
    }
  }
  expect(s.records('worker.result').map(record => record.payload.owner.work_id).sort()).toEqual(['alpha', 'beta'])
  expect(s.state.run(s.run)).toMatchObject({ state: 'completed', commit_valid: false })
  expect(s.acquire).toHaveBeenCalledTimes(1)
  expect(s.release).toHaveBeenCalledTimes(1)
})

it('checks the profile again at host dispatch and returns no denied resource body', async () => {
  const s = setup(['alpha']), secret = 'SECRET BODY MUST STAY AT HOST', resource = s.resource(secret)
  const base = profile('alpha', [{ type: 'read', kind: 'resource', ids: [resource] }])
  const authorize = vi.fn((request: unknown) => {
    if (authorize.mock.calls.length > 1) throw new ContractError('WORKER_CAPABILITY_DENIED', 'Worker profile does not grant this object or operation')
    base.authorize(request)
  })
  const query = vi.spyOn(s.internal, 'query'), selected = { ...base, authorize }
  s.complete.mockResolvedValueOnce(toolResponse(call(resource))).mockResolvedValueOnce(answer())
  await expect(s.store.executeWorker('attempt-alpha', selected, { text: 'Read only while authorized' })).resolves.toEqual({ answer: 'done' })
  expect(authorize).toHaveBeenCalledTimes(2)
  expect(query).not.toHaveBeenCalled()
  const delivered = s.complete.mock.calls[1]![2].find(message => message.role === 'tool')!
  expect(JSON.parse(delivered.content!)).toMatchObject({ execution: 'not_executed', error: { code: 'WORKER_CAPABILITY_DENIED' } })
  expect(delivered.content).not.toContain(secret)
})

it('rejects ungranted and malformed direct host reads before a query can expose a body', async () => {
  const s = setup(['alpha']), secret = 'DENIED PRIVATE CONTENT', resource = s.resource(secret)
  const entered = deferred<void>(), finish = deferred<Completion>()
  s.complete.mockImplementation(async () => { entered.resolve(); return finish.promise })
  const pending = s.store.executeWorker('attempt-alpha', profile('alpha', [{ type: 'read', kind: 'resource', ids: ['other-resource'] }]), { text: 'No access to this resource' })
  await entered.promise
  const query = vi.spyOn(s.internal, 'query')
  const read = modelToolRequest('read', { kind: 'resource', id: resource })
  for (const raw of [read, { ...read, secret }]) {
    await expect(s.store.workerTool('attempt-alpha', raw, new AbortController().signal)).rejects.toMatchObject({ code: 'WORKER_CAPABILITY_DENIED', message: 'Worker profile does not grant this object or operation' })
  }
  expect(query).not.toHaveBeenCalled()
  finish.resolve(answer())
  await pending
  expect(JSON.stringify(s.records('model.tool_result'))).not.toContain(secret)
})

it('does not install a typed result or final assistant message after Run cancellation', async () => {
  const s = setup(['alpha']), entered = deferred<void>(), finish = deferred<Completion>(), install = vi.fn()
  s.complete.mockImplementation(async () => { entered.resolve(); return finish.promise })
  const pending = s.store.executeWorker('attempt-alpha', profile('alpha'), { text: 'Cancel while provider is running' }, install)
  await entered.promise
  s.store.handle({ type: 'run.cancel', task_id: s.task, run_id: s.run })
  const rejected = expect(pending).rejects.toMatchObject({ code: 'RUNNER_OWNERSHIP_INVALID' })
  finish.resolve(answer('late answer'))
  await rejected
  expect(install).not.toHaveBeenCalled()
  expect(s.records('worker.result')).toEqual([])
  expect(s.records('message.assistant')).toEqual([])
  expect(s.state.attempt('attempt-alpha').state).toBe('cancelled')
  expect(s.records('model.request.accounting').some(record => record.payload.phase === 'completed')).toBe(true)
})

it('completes a Run without fabricating usage when the provider omits usage', async () => {
  const s = setup(['alpha'])
  s.complete.mockResolvedValue({ text: 'Finished answer', calls: [], finish: 'stop' })
  await expect(s.store.executeWorker('attempt-alpha', profile('alpha'), { text: 'Produce an answer' })).resolves.toEqual({ answer: 'Finished answer' })
  expect(s.state.run(s.run)).toMatchObject({ state: 'completed', commit_valid: false })
  expect(new RunnerBudgetLedger(s.db).snapshot('budget').unknown.model_requests).toBe(1)
  expect(s.db.prepare('SELECT state,usage_json FROM runner_budget_reservations').all()).toEqual([{ state: 'unknown', usage_json: null }])
  expect(s.release).toHaveBeenCalledOnce()
})

it('finishes Task cancellation after the request aborts while retaining unknown usage', async () => {
  const s = setup(['alpha']), entered = deferred<void>()
  s.complete.mockImplementation((_config, _key, _messages, _tools, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new ModelError('MODEL_CANCELLED')), { once: true })
    entered.resolve()
  }))
  const pending = s.store.executeWorker('attempt-alpha', profile('alpha'), { text: 'Cancel while generating' })
  const rejected = expect(pending).rejects.toMatchObject({ code: 'MODEL_CANCELLED' })
  await entered.promise
  expect(s.store.handle({ type: 'task.stop', task_id: s.task })).toMatchObject({ task: { state: 'stopping' } })
  await rejected
  expect(s.store.snapshot(s.task)).toMatchObject({ task: { state: 'stopped' }, runs: [expect.objectContaining({ state: 'cancelled', wait_reason: null })] })
  expect(new RunnerBudgetLedger(s.db).snapshot('budget').unknown.model_requests).toBe(1)
  expect(s.records('worker.result')).toEqual([])
  expect(s.release).toHaveBeenCalledOnce()
})

it('admits queued work after completed requests with unknown usage free execution slots', async () => {
  const s = setup(['alpha', 'beta', 'gamma']), entered = { alpha: deferred<void>(), beta: deferred<void>(), gamma: deferred<void>() }, finish = { alpha: deferred<Completion>(), beta: deferred<Completion>() }
  s.complete.mockImplementation(async (_config, _key, messages) => {
    const name = messages[0]!.content!.split(': ')[1]!
    if (name !== 'alpha' && name !== 'beta' && name !== 'gamma') throw Error('Unexpected worker')
    entered[name].resolve()
    return name === 'gamma' ? { text: 'gamma finished', calls: [], finish: 'stop' } : finish[name].promise
  })
  const run = (name: 'alpha' | 'beta' | 'gamma') => s.store.executeWorker(`attempt-${name}`, profile(name), { text: name })
  const alpha = run('alpha'), beta = run('beta')
  await Promise.all([entered.alpha.promise, entered.beta.promise])
  const gamma = run('gamma')
  expect(s.state.attempt('attempt-gamma').state).toBe('queued')
  finish.alpha.resolve({ text: 'alpha finished', calls: [], finish: 'stop' })
  finish.beta.resolve({ text: 'beta finished', calls: [], finish: 'stop' })
  await Promise.all([alpha, beta, entered.gamma.promise, gamma])
  expect(s.state.run(s.run).state).toBe('completed')
  expect(new RunnerBudgetLedger(s.db).snapshot('budget').unknown.model_requests).toBe(3)
})

it('continues long reads with the original selection and rejects a sibling attempt cursor', async () => {
  const s = setup(), body = '0123456789abcdefghijklmnopqrstuvwxyz'.repeat(1000), resource = s.resource(body)
  const entered = [deferred<void>(), deferred<void>()], finish = deferred<Completion>()
  let dispatched = 0
  s.complete.mockImplementation(async () => { entered[dispatched++]!.resolve(); return finish.promise })
  const selected = (name: string) => profile(name, [{ type: 'read', kind: 'resource', ids: [resource] }])
  const alpha = s.store.executeWorker('attempt-alpha', selected('alpha'), { text: 'Read first selection' })
  await entered[0]!.promise
  const beta = s.store.executeWorker('attempt-beta', selected('beta'), { text: 'Read independent selection' })
  await entered[1]!.promise
  const read = (name: string, raw: Record<string, unknown>) => s.store.workerTool(`attempt-${name}`, modelToolRequest('read', { kind: 'resource', id: resource, ...raw }), new AbortController().signal) as Promise<{ data: { data: { text: string }; next_cursor: string | null; content_version: string; actual_range: { start_bytes: number; end_bytes: number } } }>
  const first = (await read('alpha', { max_chars: 37, selection: { view: 'text' } })).data
  expect(first.data.text).toBe(body.slice(0, 37))
  expect(first.next_cursor).toMatch(/^r\./)
  await expect(read('beta', { cursor: first.next_cursor })).rejects.toMatchObject({ code: 'INVALID_CURSOR' })
  const second = (await read('alpha', { cursor: first.next_cursor })).data
  expect(second.data.text).toBe(body.slice(37, 74))
  expect(second.content_version).toBe(first.content_version)
  expect(second.actual_range.start_bytes).toBe(first.actual_range.end_bytes)
  const sibling = (await read('beta', { max_chars: 37, selection: { view: 'text' } })).data
  expect(sibling.data.text).toEqual(first.data.text)
  expect(sibling.next_cursor).not.toBe(first.next_cursor)
  finish.resolve(answer())
  await Promise.all([alpha, beta])
})

it('installs an owned summary through real provider recovery while a sibling completes', async () => {
  const s = setup(), owner = s.owner('alpha'), siblingOwner = s.owner('beta')
  for (let index = 0; index < 4; index++) {
    s.internal.record(s.task, 'model.response', { owner, run_id: s.run, message: { role: 'assistant', content: `alpha history ${index}: ` + 'old detail '.repeat(2000), tool_calls: [call('historical-resource')] } })
    s.internal.record(s.task, 'model.response', { owner: siblingOwner, run_id: s.run, message: { role: 'assistant', content: `BETA PRIVATE HISTORY ${index}` } })
    s.internal.record(s.task, 'model.tool_result', { owner, run_id: s.run, message: { role: 'tool', tool_call_id: 'same-call-id', content: `alpha original result ${index}` } })
  }
  const compacting = deferred<void>(), summary = deferred<Completion>()
  const sent: { messages: ChatMessage[]; metadata: ReturnType<typeof messageEvidence>[]; summary: boolean }[] = []
  let mainRequests = 0
  s.complete.mockImplementation(async (_config, _key, messages, tools) => {
    const isSummary = tools === undefined
    sent.push({ messages: JSON.parse(JSON.stringify(messages)), metadata: messages.map(message => messageEvidence(message)), summary: isSummary })
    if (messages[0]!.content!.endsWith('beta')) return answer('beta done')
    if (isSummary) { compacting.resolve(); return summary.promise }
    if (++mainRequests === 1) throw new ModelError('MODEL_CONTEXT_LENGTH_EXCEEDED')
    return answer('alpha done')
  })
  const alpha = s.store.executeWorker('attempt-alpha', profile('alpha'), { text: 'Current alpha goal' })
  await compacting.promise
  const through = s.records('worker.input').find(record => record.payload.owner.work_id === 'alpha')!.sequence
  await s.store.executeWorker('attempt-beta', profile('beta'), { text: 'Current beta goal' })
  summary.resolve(answer('Alpha owned working summary'))
  await expect(alpha).resolves.toEqual({ answer: 'alpha done' })

  const installed = s.records('context.summary.installed')
  expect(installed).toHaveLength(1)
  expect(installed[0]!.payload).toMatchObject({ owner, through_sequence: through, text: expect.stringContaining('Alpha owned working summary') })
  const manifest = s.records('model.request.evidence').map(record => record.payload)
  const summaryRequest = manifest.find(value => value.purpose === 'summary')!
  expect(summaryRequest.owner).toEqual(owner)
  expect(installed[0]!.payload.request_link).toEqual({ request_id: summaryRequest.request_id, evidence_event_id: s.records('model.request.evidence').find(record => record.payload.request_id === summaryRequest.request_id)!.id })
  const resumed = manifest.find(value => value.purpose === 'main' && value.entries.some((entry: { kind: string }) => entry.kind === 'summary'))!
  expect(resumed.owner).toEqual(owner)
  expect(resumed.entries.find((entry: { kind: string }) => entry.kind === 'summary')).toMatchObject({ owner, representation: 'summary-only' })
  for (const entry of sent.filter(value => value.messages[0]!.content!.endsWith('alpha'))) {
    expect(JSON.stringify(entry.messages)).not.toContain('BETA PRIVATE HISTORY')
    expect(JSON.stringify(entry.messages)).not.toContain('Current beta goal')
    for (const metadata of entry.metadata) if (metadata?.owner) expect(metadata.owner).toEqual(owner)
    for (const message of entry.messages) expect(Object.keys(message).every(key => ['role', 'content', 'tool_calls', 'tool_call_id'].includes(key))).toBe(true)
  }
  const resumedMessages = sent.find(entry => entry.messages.some(message => message.content?.startsWith('工作摘要：')))!.messages
  expect(resumedMessages.some(message => message.content?.includes('alpha history 0:'))).toBe(false)
  expect(resumedMessages.some(message => message.content?.includes('alpha history 2:'))).toBe(true)
  expect(resumedMessages.some(message => message.content?.includes('alpha original result 3'))).toBe(true)
  expect(s.request.mock.calls.map(args => args[8])).toContain('summary')
})

it('installs a result after successful execution and before closing revokes its source', async () => {
  const s = setup(['alpha'])
  s.complete.mockResolvedValue(answer())
  const install = vi.fn((_result: { answer: string }, owner: ExecutionScope) => {
    expect(s.state.qualify(owner.attempt_id).attempt.state).toBe('succeeded')
    expect(s.state.work(owner.work_id).state).toBe('succeeded')
    expect(s.state.run(owner.run_id).commit_valid).toBe(true)
  })
  await s.store.executeWorker('attempt-alpha', profile('alpha'), undefined, install)
  expect(install).toHaveBeenCalledOnce()
  expect(s.state.run(s.run)).toMatchObject({ state: 'completed', commit_valid: false })
  expect(s.release).toHaveBeenCalledOnce()
  s.store.handle({ type: 'run.cancel', task_id: s.task, run_id: s.run })
  expect(s.state.run(s.run).state).toBe('completed')
  expect(s.release).toHaveBeenCalledOnce()
})

it('rolls back successful work when the synchronous result installation fails', async () => {
  const s = setup(['alpha'])
  s.complete.mockResolvedValue(answer())
  await expect(s.store.executeWorker('attempt-alpha', profile('alpha'), undefined, () => {
    s.internal.record(s.task, 'installation.partial', {})
    throw new ContractError('INSTALL_FAILED', 'Installation failed')
  })).rejects.toMatchObject({ code: 'INSTALL_FAILED' })
  expect(s.state.attempt('attempt-alpha').state).toBe('failed')
  expect(s.records('installation.partial')).toEqual([])
  expect(s.state.run(s.run).state).toBe('failed')
})

it('closes and revokes optional work but holds the lease until its real model request settles', async () => {
  const s = setup(['alpha', 'beta'], {}, ['beta']), entered = deferred<void>(), optional = deferred<Completion>()
  s.complete.mockImplementation(async (_config, _key, messages) => {
    if (messages[0]!.content!.endsWith('beta')) { entered.resolve(); return optional.promise }
    return answer('required complete')
  })
  const beta = s.store.executeWorker('attempt-beta', profile('beta'))
  const rejected = expect(beta).rejects.toMatchObject({ code: 'RUNNER_OWNERSHIP_INVALID' })
  await entered.promise
  await s.store.executeWorker('attempt-alpha', profile('alpha'))
  expect(s.state.work('beta').state).toBe('cancelled')
  expect(s.state.run(s.run)).toMatchObject({ state: 'closing', commit_valid: false })
  expect(s.release).not.toHaveBeenCalled()
  optional.resolve(answer('late optional'))
  await rejected
  expect(s.state.run(s.run).state).toBe('completed')
  expect(s.release).toHaveBeenCalledOnce()
})

it('keeps an independent necessary worker active after failure and preserves failure over local cancellation', async () => {
  const s = setup(), entered = deferred<void>(), finish = deferred<Completion>()
  s.complete.mockImplementation(async (_config, _key, messages) => {
    if (messages[0]!.content!.endsWith('beta')) { entered.resolve(); return finish.promise }
    return answer('invalid typed result')
  })
  const beta = s.store.executeWorker('attempt-beta', profile('beta'))
  await entered.promise
  await expect(s.store.executeWorker('attempt-alpha', { ...profile('alpha'), parseResult: () => { throw new Error('Invalid result') } })).rejects.toMatchObject({ code: 'INVALID_WORKER_RESULT' })
  expect(s.state.run(s.run).commit_valid).toBe(true)
  expect(s.release).not.toHaveBeenCalled()
  s.state.revokeWork('beta')
  finish.resolve(answer('cancelled work'))
  await expect(beta).rejects.toMatchObject({ code: 'RUNNER_OWNERSHIP_INVALID' })
  expect(s.state.work('alpha').root_cause?.kind).toBe('failure')
  expect(s.state.work('beta').root_cause?.kind).toBe('cancellation')
  expect(s.state.run(s.run).state).toBe('failed')
  expect(s.db.prepare('SELECT primary_reason FROM runs WHERE id=?').get(s.run)).toEqual({ primary_reason: 'INVALID_WORKER_RESULT' })
})

it.each([null, 'required_work_settled'])('persists a required worker failure over %s and exposes it in both Run projections', async primaryReason => {
  const s = setup(['alpha'])
  s.db.prepare('UPDATE runs SET primary_reason=? WHERE id=?').run(primaryReason, s.run)
  s.complete.mockResolvedValue(answer('invalid typed result'))
  await expect(s.store.executeWorker('attempt-alpha', { ...profile('alpha'), parseResult: () => { throw new Error('Invalid result') } })).rejects.toMatchObject({ code: 'INVALID_WORKER_RESULT' })
  expect(s.db.prepare('SELECT state,primary_reason FROM runs WHERE id=?').get(s.run)).toEqual({ state: 'failed', primary_reason: 'INVALID_WORKER_RESULT' })
  const snapshot = s.store.snapshot(s.task)
  expect(snapshot.runs[0]).toMatchObject({ state: 'failed', primary_reason: 'INVALID_WORKER_RESULT' })
  expect(snapshot.runner?.goals[0]).toMatchObject({ run: { state: 'failed', primary_reason: 'INVALID_WORKER_RESULT' }, delivery: 'incomplete' })
})

it('keeps an existing specific primary reason when a required worker fails', async () => {
  const s = setup(['alpha'])
  s.db.prepare("UPDATE runs SET primary_reason='MODEL_TIMEOUT' WHERE id=?").run(s.run)
  s.complete.mockResolvedValue(answer('invalid typed result'))
  await expect(s.store.executeWorker('attempt-alpha', { ...profile('alpha'), parseResult: () => { throw new Error('Invalid result') } })).rejects.toMatchObject({ code: 'INVALID_WORKER_RESULT' })
  expect(s.db.prepare('SELECT state,primary_reason FROM runs WHERE id=?').get(s.run)).toEqual({ state: 'failed', primary_reason: 'MODEL_TIMEOUT' })
  expect(s.internal.query(s.task, { type: 'read', input: { target: { kind: 'run', id: s.run } } })).toMatchObject({ data: { state: 'failed', primary_reason: 'MODEL_TIMEOUT' } })
})

it.each([null, 'required_work_settled'])('projects historical failed Run reasons without changing persisted %s', async primaryReason => {
  const s = setup(['alpha'])
  s.complete.mockResolvedValue(answer('invalid typed result'))
  await expect(s.store.executeWorker('attempt-alpha', { ...profile('alpha'), parseResult: () => { throw new Error('Invalid result') } })).rejects.toMatchObject({ code: 'INVALID_WORKER_RESULT' })
  s.db.prepare('UPDATE runs SET primary_reason=? WHERE id=?').run(primaryReason, s.run)
  const before = s.db.prepare('SELECT state,primary_reason,wait_reason,intended_terminal FROM runs WHERE id=?').get(s.run)
  const snapshot = s.store.snapshot(s.task)
  expect(snapshot.runs[0]).toMatchObject({ state: 'failed', primary_reason: 'INVALID_WORKER_RESULT' })
  expect(snapshot.runner?.goals[0]).toMatchObject({ run: { state: 'failed', primary_reason: 'INVALID_WORKER_RESULT' }, delivery: 'incomplete' })
  expect(s.internal.query(s.task, { type: 'read', input: { target: { kind: 'run', id: s.run } } })).toMatchObject({ data: { state: 'failed', primary_reason: 'INVALID_WORKER_RESULT' } })
  expect(s.db.prepare('SELECT state,primary_reason,wait_reason,intended_terminal FROM runs WHERE id=?').get(s.run)).toEqual(before)
})

it.each(['cancelled', 'interrupted'] as const)('preserves %s priority after a required worker failure', async terminalState => {
  const s = setup(), entered = deferred<void>(), finish = deferred<Completion>()
  s.complete.mockImplementation(async (_config, _key, messages) => {
    if (messages[0]!.content!.endsWith('beta')) { entered.resolve(); return finish.promise }
    return answer('invalid typed result')
  })
  const pending = s.store.executeWorker('attempt-beta', profile('beta'))
  const rejected = expect(pending).rejects.toMatchObject({ code: 'RUNNER_OWNERSHIP_INVALID' })
  await entered.promise
  await expect(s.store.executeWorker('attempt-alpha', { ...profile('alpha'), parseResult: () => { throw new Error('Invalid result') } })).rejects.toMatchObject({ code: 'INVALID_WORKER_RESULT' })
  const primaryReason = terminalState === 'interrupted' ? 'host_shutdown' : 'user_cancelled'
  s.internal.finish(s.task, s.run, terminalState, primaryReason)
  finish.resolve(answer('late answer'))
  await rejected
  expect(s.db.prepare('SELECT state,primary_reason FROM runs WHERE id=?').get(s.run)).toEqual({ state: terminalState, primary_reason: primaryReason })
  expect(s.store.snapshot(s.task).runs[0]).toMatchObject({ state: terminalState, primary_reason: primaryReason })
  expect(s.internal.query(s.task, { type: 'read', input: { target: { kind: 'run', id: s.run } } })).toMatchObject({ data: { state: terminalState, primary_reason: primaryReason } })
})

it('revokes worker actions and approvals before the Task stop reaches cancellation listeners', async () => {
  const s = setup(['alpha']), entered = deferred<void>(), finish = deferred<Completion>()
  s.complete.mockImplementation(async (_config, _key, _messages, _tools, signal) => {
    signal.addEventListener('abort', () => {
      expect(s.state.run(s.run).commit_valid).toBe(false)
      expect(s.db.prepare("SELECT commit_valid FROM actions WHERE id='waiting-action'").get()).toEqual({ commit_valid: 0 })
      expect(s.db.prepare("SELECT validity FROM approvals WHERE id='waiting-approval'").get()).toEqual({ validity: 'revoked' })
    }, { once: true })
    entered.resolve(); return finish.promise
  })
  const pending = s.store.executeWorker('attempt-alpha', profile('alpha'))
  const rejected = expect(pending).rejects.toMatchObject({ code: 'RUNNER_OWNERSHIP_INVALID' })
  await entered.promise
  s.db.prepare("INSERT INTO actions(id,task_id,run_id,kind,state,source_json,request_json,commit_valid,created_at) VALUES ('waiting-action',?,?,'mutation','waiting',?,'{}',1,'time')").run(s.task, s.run, JSON.stringify({ owner: s.owner('alpha') }))
  s.db.prepare("INSERT INTO approvals VALUES ('waiting-approval','waiting-action','pending','valid','manual','awaiting_human','2999-01-01',NULL,'{}')").run()
  s.store.handle({ type: 'task.stop', task_id: s.task })
  finish.resolve(answer('late answer'))
  await rejected
  expect(s.state.run(s.run).state).toBe('cancelled')
})

it('queues a third worker until a real active work slot is released', async () => {
  const s = setup(['alpha', 'beta', 'gamma'])
  const entered = { alpha: deferred<void>(), beta: deferred<void>(), gamma: deferred<void>() }
  const finish = { alpha: deferred<Completion>(), beta: deferred<Completion>(), gamma: deferred<Completion>() }
  s.complete.mockImplementation(async (_config, _key, messages) => {
    const name = (['alpha', 'beta', 'gamma'] as const).find(name => messages[0]!.content!.endsWith(name))!
    entered[name].resolve(); return finish[name].promise
  })
  const alpha = s.store.executeWorker('attempt-alpha', profile('alpha'))
  const beta = s.store.executeWorker('attempt-beta', profile('beta'))
  await Promise.all([entered.alpha.promise, entered.beta.promise])
  const gamma = s.store.executeWorker('attempt-gamma', profile('gamma'))
  expect(s.state.attempt('attempt-gamma')).toMatchObject({ state: 'queued', dispatch_state: 'not_dispatched' })
  expect(s.complete).toHaveBeenCalledTimes(2)
  finish.alpha.resolve(answer('alpha complete'))
  await alpha; await entered.gamma.promise
  expect(s.complete).toHaveBeenCalledTimes(3)
  expect(s.state.attempt('attempt-gamma').dispatch_state).toBe('dispatched')
  finish.beta.resolve(answer()); finish.gamma.resolve(answer())
  await Promise.all([beta, gamma])
  expect(s.state.run(s.run).state).toBe('completed')
})

it('releases inference slots during a real worker approval and keeps other requests on their actual tasks', async () => {
  const s = setup(['alpha']), schedule = vi.spyOn(s.scheduler, 'schedule')
  const schema = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false }
  const otherTasks = ['beta', 'gamma'].map(name => ({ name, task: s.store.create(`Other ${name}`).task.id, finish: deferred<Completion>() }))
  const started: string[] = []
  let active = 0, maximumActive = 0
  s.complete.mockImplementation(async (_config, _key, messages) => {
    active++; maximumActive = Math.max(maximumActive, active)
    try {
      if (messages[0]!.content === 'Worker rules: alpha') {
        if (messages.some(message => message.role === 'tool' && message.tool_call_id === 'remove-data')) return answer('removal complete')
        if (!messages.some(message => message.role === 'tool')) return toolResponse({ id: 'create-data', type: 'function', function: { name: 'write', arguments: JSON.stringify({ operation: 'task_data.create', input_json: JSON.stringify({ data: { schema, value: { value: 'original' }, references: [] } }) }) } })
        const data = s.store.snapshot(s.task).task_data.items[0]!
        return toolResponse({ id: 'remove-data', type: 'function', function: { name: 'write', arguments: JSON.stringify({ operation: 'task_data.remove', input_json: JSON.stringify({ id: data.id, expected_revision: 1 }) }) } })
      }
      const other = otherTasks.find(value => messages.some(message => message.role === 'user' && message.content?.includes(`Other task ${value.name}`)))!
      started.push(other.task)
      return await other.finish.promise
    } finally { active-- }
  })
  const worker = s.store.executeWorker('attempt-alpha', profile('alpha', [{ type: 'write', operation: 'task_data.create' }, { type: 'write', operation: 'task_data.remove' }]))
  await vi.waitFor(() => expect(s.store.snapshot(s.task).approvals).toHaveLength(1))
  const approval = s.store.snapshot(s.task).approvals[0]!
  const data = s.store.snapshot(s.task).task_data.items[0]!
  expect(s.state.attempt('attempt-alpha').state).toBe('waiting')
  expect(s.records('worker.state').at(-1)!.payload).toMatchObject({ owner: s.owner('alpha'), state: 'waiting', reason: 'approval' })
  expect(s.records('worker.tool.started')).toHaveLength(2)
  expect(s.records('worker.tool.ended')).toHaveLength(1)
  expect(s.release).not.toHaveBeenCalled()

  const otherRuns = otherTasks.map(other => s.store.start(other.task, `Other task ${other.name}`, 'isolated', []))
  await vi.waitFor(() => expect(started).toEqual(otherTasks.map(other => other.task)))
  expect(active).toBe(2)
  expect(maximumActive).toBe(2)
  expect(s.store.snapshot(s.task).approvals[0]!.id).toBe(approval.id)
  expect(s.state.attempt('attempt-alpha').state).toBe('waiting')
  expect(schedule.mock.calls.map(args => args[0])).toEqual([s.task, s.task, ...otherTasks.map(other => other.task)])
  expect(new Set(schedule.mock.calls.map(args => args[1])).size).toBe(1)

  for (const other of otherTasks) other.finish.resolve(answer(`Finished ${other.name}`))
  await vi.waitFor(() => otherTasks.forEach((other, index) => expect(s.store.snapshot(other.task).runs.find(run => run.id === otherRuns[index])!.state).toBe('completed')))
  s.store.handle({ type: 'approval.decide', task_id: s.task, approval_id: approval.id, decision: 'approve' })
  await expect(worker).resolves.toEqual({ answer: 'removal complete' })
  expect(schedule.mock.calls.map(args => args[0])).toEqual([s.task, s.task, ...otherTasks.map(other => other.task), s.task])
  expect(s.records('worker.tool.ended')).toHaveLength(2)
  expect(s.store.snapshot(s.task).task_data.items).toEqual([])
  expect(s.records('task_data.removed')[0]!.payload).toMatchObject({ id: data.id, removed: true })
})

it('removes a queued optional worker when required work starts closing', async () => {
  const s = setup(['alpha', 'beta', 'gamma'], {}, ['gamma'])
  const entered = deferred<void>(), finish = deferred<Completion>()
  s.complete.mockImplementation(async () => { entered.resolve(); return finish.promise })
  const alpha = s.store.executeWorker('attempt-alpha', profile('alpha'))
  const beta = s.store.executeWorker('attempt-beta', profile('beta'))
  await entered.promise
  const gamma = s.store.executeWorker('attempt-gamma', profile('gamma'))
  const rejected = expect(gamma).rejects.toMatchObject({ code: 'RUNNER_OWNERSHIP_INVALID' })
  finish.resolve(answer())
  await Promise.all([alpha, beta, rejected])
  expect(s.complete).toHaveBeenCalledTimes(2)
  expect(s.state.attempt('attempt-gamma')).toMatchObject({ state: 'revoked', dispatch_state: 'not_dispatched' })
  expect(s.state.run(s.run).state).toBe('completed')
})

it('dispatches sibling model requests beyond the legacy shared request cap', async () => {
  const s = setup(['alpha', 'beta'], {}, [], { model_requests: 1 })
  const entered = deferred<void>(), finish = deferred<Completion>()
  s.complete.mockImplementation(async () => { entered.resolve(); return finish.promise })
  const alpha = s.store.executeWorker('attempt-alpha', profile('alpha'))
  await entered.promise
  const beta = s.store.executeWorker('attempt-beta', profile('beta'))
  await vi.waitFor(() => expect(s.complete).toHaveBeenCalledTimes(2))
  finish.resolve(answer())
  await Promise.all([alpha, beta])
  const reservations = s.db.prepare('SELECT attempt_id,state FROM runner_budget_reservations ORDER BY attempt_id').all()
  expect(reservations).toEqual([{ attempt_id: 'attempt-alpha', state: 'settled' }, { attempt_id: 'attempt-beta', state: 'settled' }])
  expect(new RunnerBudgetLedger(s.db).snapshot('budget').settled).toEqual({ model_requests: 2, tool_requests: 0, tokens: 44 })
  expect(s.state.run(s.run).state).toBe('completed')
})

it('records usage above the legacy token cap and completes a fully reconciled run', async () => {
  const s = setup(['alpha'], {}, [], { tokens: 2000 })
  s.complete.mockResolvedValue({ ...answer(), usage: { prompt_tokens: 2000, completion_tokens: 2000 } })
  await expect(s.store.executeWorker('attempt-alpha', profile('alpha'))).resolves.toEqual({ answer: 'done' })
  expect(s.db.prepare('SELECT state FROM runner_budget_reservations').get()).toEqual({ state: 'settled' })
  expect(s.records('model.request.accounting').some(record => record.payload.usage?.prompt_tokens === 2000 && record.payload.usage?.completion_tokens === 2000)).toBe(true)
  expect(new RunnerBudgetLedger(s.db).snapshot('budget').settled.tokens).toBe(4000)
  expect(s.state.run(s.run).state).toBe('completed')
  expect(s.release).toHaveBeenCalledOnce()
})
