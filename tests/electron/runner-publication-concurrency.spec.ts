import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { frame, modelInputFromHost, modelServer, synthetic } from '../helpers/model-server'
import type { Bundle } from '../../src/shared/contracts.generated'
import type { ArtifactCandidate, ArtifactIndex, CompositionBatch, ExecutionScope, GoalRevision, HostRequest, Outline, OutlineSection, Snapshot, WorkDependency } from '../../src/shared/types'
import type { PublicationOperation } from '../../src/runtime/runner/publication-state'

const require = createRequire(import.meta.url), executablePath: string = require('electron')
const poll = { timeout: 30000, intervals: [100, 200, 500] }

interface WireBody { messages: { role: string; content: string; tool_call_id?: string }[] }
interface ProducerBinding { owner: ExecutionScope; plan_revision: number; dependencies: WorkDependency[]; goal: GoalRevision; requirement_ids: string[]; sections: OutlineSection[] }
interface CollatorInput { batch: CompositionBatch; outline: Outline; indexes: ArtifactIndex[] }
interface PublicationInspection {
  operation: PublicationOperation | null
  view_ids: string[]
  view_history_count: number
  mapping_count: number
  surface_history_count: number
  publication_ids: string[]
  budget_id: string | null
}
interface CancellationEvidence { pid: number; process_type: string; run_id: string; attempt_id: string; requested: number; performed: number }
type CancellationCommand = { type: 'arm'; owner: ExecutionScope } | { type: 'inspect' | 'replay' | 'cleanup' }

function complete(response: ServerResponse, delta: object, finish: 'stop' | 'tool_calls' = 'stop'): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(frame({ role: 'assistant', ...delta }) + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 400, completion_tokens: 80 } })}\n\n` + 'data: [DONE]\n\n')
}
function bundle(name: string): Bundle {
  return {
    profile: 'managed-v1', html: `<section><h2>${name}_PUBLISHED</h2><label for="answer">${name}_NOTE</label><textarea id="answer"></textarea></section>`, css: '',
    state: { schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false }, initial: { answer: '' }, compatibility_version: 'concurrent-input-v1' },
    forms: [], behaviors: [{ type: 'input', element_id: 'answer', field: '/answer', control: 'textarea' }], references: [], export: []
  }
}
function createResource(response: ServerResponse, name: string): void {
  complete(response, { tool_calls: [{ index: 0, id: `resource-${name}`, type: 'function', function: { name: 'write', arguments: JSON.stringify(modelInputFromHost('write', { type: 'resource.create', display_name: `${name}.json`, content: { type: 'json', value: bundle(name) } })) } }] }, 'tool_calls')
}
function producerBinding(body: WireBody): ProducerBinding {
  const prompt = body.messages.find(message => message.role === 'system' && message.content.includes('Bound data: '))?.content
  if (!prompt) throw Error('Missing real production binding')
  return JSON.parse(prompt.slice(prompt.indexOf('Bound data: ') + 'Bound data: '.length)) as ProducerBinding
}
function producerResult(binding: ProducerBinding, resource: string, name: string) {
  const { owner, sections, plan_revision, dependencies, requirement_ids } = binding, section = sections[0]
  if (owner.purpose !== 'production' || !section) throw Error('Expected a bound production section')
  const candidate: ArtifactCandidate = {
    candidate_id: `candidate-${owner.attempt_id}`, task_id: owner.task_id, request_id: owner.request_id, intent_revision: owner.intent_revision,
    run_id: owner.run_id, work_id: owner.work_id, attempt_id: owner.attempt_id, artifact_id: `artifact-${owner.request_id}`, base_artifact_revision: 0,
    plan_revision, bundle_resource_id: resource, section_id: section.section_id, section_position_revision: section.position_revision, order_key: section.order_key,
    presentation_kind: 'managed-v1', width_constraint: 'full', interaction_kind: 'input', provenance_ref: { task_id: owner.task_id, kind: 'resource', id: resource },
    requirement_ids, unresolved: [], dependencies
  }
  return { version: 1, complete: true, answer: `${name}_FINAL`, artifacts: [candidate], requirement_ids, unresolved: [] }
}
function collate(body: WireBody, response: ServerResponse, observations: CollatorInput[]): boolean {
  if (!body.messages[0]?.content.startsWith('You are the Collator.')) return false
  const input = JSON.parse(body.messages.find(message => message.role === 'user')!.content) as CollatorInput
  observations.push(input)
  const { batch, outline, indexes } = input
  complete(response, { content: JSON.stringify({ task_id: batch.task_id, run_id: batch.run_id, batch_id: batch.batch_id, composition_version: batch.composition_version, intents: indexes.map(index => {
    const section = outline.sections.find(section => section.section_id === index.section_id)!
    return { artifact: { task_id: index.task_id, artifact_id: index.artifact_id, artifact_revision: index.artifact_revision }, section_id: section.section_id, section_position_revision: section.position_revision, order_key: section.order_key, slot_id: 'main', layout_mode: 'column', width_constraint: index.width_constraint }
  }) }) })
  return true
}
function publicationIds(input: CollatorInput) {
  const { action_id, operation_id } = input.batch
  if (!action_id || !operation_id) throw Error('The real batch must retain its publication identities')
  return { action_id, operation_id }
}
function bridge(page: Page) {
  return async <T,>(request: HostRequest): Promise<T> => page.evaluate(async request => {
    const response = await window.pliuna.request(request)
    if (!response.ok) throw Error(response.error.code)
    return response.data as T
  }, request)
}
function launch(directory: string, bootstrap?: string) {
  return electron.launch({ executablePath, args: [...(bootstrap ? ['--require', bootstrap] : []), '.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', PLIUNA_TEST_DATA: directory, PLIUNA_ENABLE_VIEW_REPLACEMENT: '1', PLIUNA_TEST_RUNNER: 'dual', PLIUNA_TEST_RUNNER_COLLATOR: 'model' } })
}
async function lateResultBootstrap(directory: string): Promise<string> {
  const file = join(directory, 'capture-production-controller.cjs')
  await writeFile(file, `
if (process.type === 'browser') {
  const { utilityProcess } = require('electron'), fork = utilityProcess.fork
  utilityProcess.fork = function(modulePath, args, options) {
    if (options?.serviceName !== 'Pliuna Runtime') return fork.call(this, modulePath, args, options)
    const child = fork.call(this, __filename, [modulePath, ...(args ?? [])], options)
    utilityProcess.fork = fork
    let sequence = 0
    const pending = new Map()
    child.on('message', message => {
      const reply = message?.__lateProductionReply, waiter = reply && pending.get(reply.id)
      if (!waiter) return
      pending.delete(reply.id); clearTimeout(waiter.timer)
      reply.error ? waiter.reject(Error(reply.error)) : waiter.resolve(reply.data)
    })
    child.on('exit', () => {
      for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(Error('Runtime exited during private cancellation control')) }
      pending.clear()
    })
    globalThis.__lateProductionControl = command => new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('Private cancellation control timed out')) }, 10000)
      pending.set(id, { resolve, reject, timer })
      child.postMessage({ vault_response: 'late-production-test-' + id, __lateProductionCommand: { id, command } })
    })
    return child
  }
} else if (process.parentPort) {
  const descriptor = Object.getOwnPropertyDescriptor(AbortController.prototype, 'signal')
  const controllers = new WeakMap(), attempts = new Map(), nativeFetch = globalThis.fetch
  let gate
  const restoreCapture = () => { Object.defineProperty(AbortController.prototype, 'signal', descriptor); globalThis.fetch = nativeFetch }
  const restoreAbort = () => {
    if (!gate) return
    if (gate.ownAbort) Object.defineProperty(gate.controller, 'abort', gate.ownAbort)
    else delete gate.controller.abort
  }
  const evidence = () => gate ? { pid: process.pid, process_type: process.type, run_id: gate.run_id, attempt_id: gate.attempt_id, requested: gate.requested, performed: gate.performed } : null
  const replay = () => { if (gate?.requested && gate.performed === 0) { gate.abort.call(gate.controller, gate.reason); gate.performed++ } }
  Object.defineProperty(AbortController.prototype, 'signal', { ...descriptor, get() {
    const signal = descriptor.get.call(this)
    controllers.set(signal, this)
    return signal
  } })
  globalThis.fetch = function(input, init) {
    try {
      const body = JSON.parse(init?.body ?? '{}')
      const prompt = body.messages?.find(message => message.role === 'system' && message.content?.includes('Bound data: '))?.content
      if (prompt) {
        const { owner } = JSON.parse(prompt.slice(prompt.indexOf('Bound data: ') + 'Bound data: '.length))
        const controller = controllers.get(init.signal)
        if (owner.purpose === 'production' && controller) attempts.set(owner.attempt_id, { controller, run_id: owner.run_id })
      }
    } catch {}
    return nativeFetch.call(this, input, init)
  }
  const control = ({ data }) => {
    const envelope = data.__lateProductionCommand
    if (!envelope) return
    try {
      const { command } = envelope
      if (command.type === 'arm') {
        const selected = attempts.get(command.owner.attempt_id)
        if (gate || !selected || selected.run_id !== command.owner.run_id) throw Error('Missing the exact old production HTTP controller')
        restoreCapture()
        const controller = selected.controller
        gate = { controller, ownAbort: Object.getOwnPropertyDescriptor(controller, 'abort'), abort: controller.abort, run_id: command.owner.run_id, attempt_id: command.owner.attempt_id, requested: 0, performed: 0 }
        // Defer only this request's first cancellation. Restore its method
        // immediately so deadlines and every other request retain native abort.
        controller.abort = reason => { gate.requested++; gate.reason = reason; restoreAbort() }
      } else if (command.type === 'replay') replay()
      else if (command.type === 'cleanup') { restoreCapture(); restoreAbort(); replay() }
      process.parentPort.postMessage({ __lateProductionReply: { id: envelope.id, data: evidence() } })
      if (command.type === 'cleanup') process.parentPort.off('message', control)
    } catch (error) {
      process.parentPort.postMessage({ __lateProductionReply: { id: envelope.id, error: error.message } })
    }
  }
  process.parentPort.on('message', control)
  const modulePath = process.argv[2]
  process.argv.splice(1, 2, modulePath)
  require(modulePath)
}
`)
  return file
}
async function cancellationControl(app: ElectronApplication, command: CancellationCommand): Promise<CancellationEvidence | null> {
  return app.evaluate((_electron, command) => (globalThis as any).__lateProductionControl(command), command)
}
async function configure(page: Page, url: string, title: string): Promise<string> {
  const call = bridge(page)
  await call({ type: 'model.configure', configuration: { id: 'publication-main', base_url: url, wire_model_id: 'local-publication-v1', context_tokens: 1000000, max_output_tokens: 4096, compatibility_profile: 'chat-max-tokens' }, api_key: 'isolated-local-fixture', confirm_memory_only: true })
  await call({ type: 'model.test', model_id: 'publication-main', role: 'main', confirm_cost: true })
  await page.getByRole('button', { name: '创建第一个任务', exact: true }).click()
  await page.getByLabel('任务名称').fill(title)
  await page.getByRole('button', { name: '创建任务', exact: true }).click()
  return (await call<{ id: string }[]>({ type: 'host.tasks' }))[0]!.id
}
async function pendingApproval(page: Page, task: string, action: string) {
  const snapshot = () => bridge(page)<Snapshot>({ type: 'task.snapshot', task_id: task })
  await expect.poll(async () => (await snapshot()).approvals.some(item => item.action_id === action && item.decision === 'pending' && item.validity === 'valid'), poll).toBe(true)
  return (await snapshot()).approvals.find(item => item.action_id === action && item.decision === 'pending' && item.validity === 'valid')!
}
async function approve(page: Page, task: string, action: string): Promise<void> {
  const approval = await pendingApproval(page, task, action)
  await bridge(page)({ type: 'approval.decide', task_id: task, approval_id: approval.id, decision: 'approve' })
}
async function hostReady(page: Page, task: string, action: string): Promise<void> {
  await expect.poll(async () => (await bridge(page)<Snapshot>({ type: 'task.snapshot', task_id: task })).surface_updates.some(update => update.action_id === action), poll).toBe(true)
}
async function publicationReader(app: ElectronApplication, directory: string, task: string) {
  // Read the original persisted operation without loading unrelated runtime
  // initializers or introducing a new host request for this acceptance test.
  return (operation: string): Promise<PublicationInspection> => app.evaluate((_electron, input) => {
    const req = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json'), Database = req('better-sqlite3')
    const database = new Database(input.directory + '/pliuna.sqlite', { readonly: true, fileMustExist: true })
    try {
      return database.transaction(() => {
        const row = database.prepare('SELECT payload_json,state,result_json FROM runner_publications WHERE task_id=? AND operation_id=?').get(input.task, input.operation) as { payload_json: string; state: PublicationOperation['state']; result_json: string | null } | undefined
        const payload = row ? JSON.parse(row.payload_json) as Pick<PublicationOperation, 'registration' | 'preparation'> : null
        const original: PublicationOperation | null = row && payload ? { registration: payload.registration, preparation: payload.preparation ?? null, state: row.state, result: row.result_json ? JSON.parse(row.result_json) as PublicationOperation['result'] : null } : null
        const count = (sql: string): number => database.prepare(sql).get(input.task).n
        return {
          operation: original,
          view_ids: database.prepare('SELECT v.id FROM views v JOIN surfaces s ON s.id=v.surface_id WHERE s.task_id=? ORDER BY v.id').all(input.task).map((row: { id: string }) => row.id),
          view_history_count: count('SELECT count(*) n FROM view_history WHERE task_id=?'),
          mapping_count: count('SELECT count(*) n FROM runner_view_mappings WHERE task_id=?'),
          surface_history_count: count('SELECT count(*) n FROM runner_surface_history WHERE task_id=?'),
          publication_ids: database.prepare('SELECT operation_id FROM runner_publications WHERE task_id=? ORDER BY operation_id').all(input.task).map((row: { operation_id: string }) => row.operation_id),
          budget_id: original ? database.prepare('SELECT budget_id FROM runner_runs WHERE task_id=? AND run_id=?').get(input.task, original.registration.plan.run_id).budget_id as string : null
        }
      })()
    } finally { database.close() }
  }, { directory, task, operation })
}
async function attachRuntimeFailure(app: ElectronApplication, directory: string): Promise<void> {
  try {
    const facts = await app.evaluate((_electron, directory) => {
      const req = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json'), Database = req('better-sqlite3')
      const database = new Database(directory + '/pliuna.sqlite', { readonly: true, fileMustExist: true })
      try {
        return {
          runs: database.prepare('SELECT r.id,r.state,r.commit_valid,r.intended_terminal,r.primary_reason,n.payload_json FROM runs r LEFT JOIN runner_runs n ON n.run_id=r.id').all(),
          batches: database.prepare('SELECT * FROM runner_batches').all(),
          budgets: database.prepare('SELECT * FROM runner_budgets').all(),
          reservations: database.prepare('SELECT * FROM runner_budget_reservations').all(),
          attempts: database.prepare('SELECT * FROM runner_attempts').all(),
          publications: database.prepare('SELECT * FROM runner_publications').all(),
          events: database.prepare("SELECT kind,payload_json FROM records WHERE kind LIKE 'runner.%' OR kind='worker.ended' ORDER BY sequence DESC LIMIT 30").all()
        }
      } finally { database.close() }
    }, directory)
    const path = test.info().outputPath('runtime-failure.json')
    await writeFile(path, JSON.stringify(facts, null, 2))
    await test.info().attach('runtime-failure', { path, contentType: 'application/json' })
  } catch (error) {
    const path = test.info().outputPath('runtime-diagnostic-error.txt')
    await writeFile(path, String(error))
    await test.info().attach('runtime-diagnostic-error', { path, contentType: 'text/plain' })
  }
}

test('a waiting Composition rebuilds after an independent publication and reconciles its lost success receipt by the original operation', async () => {
  test.setTimeout(90000)
  const held = new Map<string, ServerResponse>(), collators: CollatorInput[] = [], serverErrors: string[] = []
  const server = await modelServer(({ body }, response) => {
    try {
      if (synthetic(body, response) || collate(body, response, collators)) return
      const binding = producerBinding(body), name = JSON.stringify(body.messages).includes('CONCURRENT_ALPHA') ? 'ALPHA' : 'BETA'
      const last = (body as WireBody).messages.at(-1)!
      if (last.role !== 'tool') { held.set(name, response); return }
      expect(last.tool_call_id).toBe(`resource-${name}`)
      const result = JSON.parse(last.content)
      expect(result).toMatchObject({ execution: 'success', data: { id: expect.any(String) } })
      complete(response, { content: JSON.stringify(producerResult(binding, result.data.id, name)) })
    } catch (error) {
      serverErrors.push(error instanceof Error ? error.message : String(error))
      if (!response.headersSent) response.writeHead(500)
      response.end()
    }
  })
  const directory = await mkdtemp(join(tmpdir(), 'pliuna-publication-concurrency-')), app = await launch(directory)
  try {
    const page = await app.firstWindow(), errors: string[] = [], call = bridge(page)
    page.on('pageerror', error => errors.push(error.message))
    const task = await configure(page, server.url, '并发汇总与原发布结果验收'), snapshot = () => call<Snapshot>({ type: 'task.snapshot', task_id: task })
    const readPublication = await publicationReader(app, directory, task)
    const alpha = await call<{ request_id: string }>({ type: 'request.submit', task_id: task, text: 'CONCURRENT_ALPHA：保存独立章节。', model_config_id: 'publication-main', resource_ids: [], import_ids: [] })
    const beta = await call<{ request_id: string }>({ type: 'request.submit', task_id: task, text: 'CONCURRENT_BETA：保存另一独立章节。', model_config_id: 'publication-main', resource_ids: [], import_ids: [] })
    await expect.poll(() => [...held.keys()].sort(), poll).toEqual(['ALPHA', 'BETA'])
    createResource(held.get('ALPHA')!, 'ALPHA'); held.delete('ALPHA')
    await expect.poll(() => collators.some(input => input.batch.trigger_request_id === alpha.request_id), poll).toBe(true)
    const a = collators.find(input => input.batch.trigger_request_id === alpha.request_id)!, aIds = publicationIds(a)
    const originalApproval = await pendingApproval(page, task, aIds.action_id), initial = await snapshot()
    expect(originalApproval.request).toMatchObject({ effective_request: { expected_revision: initial.surface.revision } })
    expect(initial.views).toEqual([])
    expect(a.indexes.map(index => index.request_id)).toEqual([alpha.request_id])

    createResource(held.get('BETA')!, 'BETA'); held.delete('BETA')
    await expect.poll(() => collators.some(input => input.batch.trigger_request_id === beta.request_id), poll).toBe(true)
    const b = collators.find(input => input.batch.trigger_request_id === beta.request_id)!, bIds = publicationIds(b)
    expect(b.indexes.map(index => index.request_id)).toEqual([beta.request_id])
    await approve(page, task, bIds.action_id)
    await hostReady(page, task, bIds.action_id)
    await app.evaluate(({ ipcMain }, action) => {
      const handlers = (ipcMain as any)._invokeHandlers, original = handlers.get('pliuna:request')
      const evidence = { lost: false, confirmations: 0 }; (globalThis as any).__publicationReceipt = evidence
      handlers.set('pliuna:request', async (event: unknown, request: HostRequest) => {
        if (request.type === 'surface.respond' && request.action_id === action) evidence.confirmations++
        const response = await original(event, request)
        if (request.type === 'surface.respond' && request.action_id === action && response.ok && response.data.result === 'success' && !evidence.lost) {
          evidence.lost = true
          return { ok: false, error: { code: 'UNKNOWN_RESULT', message: 'Isolated publication success receipt was lost after commit' } }
        }
        return response
      })
    }, bIds.action_id)
    const lost = await page.evaluate(request => window.pliuna.request(request), { type: 'surface.respond', task_id: task, action_id: bIds.action_id, proceed: true, confirm_discard: false } satisfies HostRequest)
    expect(lost).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } })
    await expect(page.getByRole('heading', { name: 'BETA_PUBLISHED', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'ALPHA_PUBLISHED', exact: true })).toHaveCount(0)
    const publishedB = await snapshot(), betaView = publishedB.views[0]!, committedB = await readPublication(bIds.operation_id)
    expect(publishedB.views).toHaveLength(1)
    expect(publishedB.surface.revision).toBe(initial.surface.revision + 1)
    expect(publishedB.approvals.find(item => item.id === originalApproval.id)).toMatchObject({ decision: 'pending', validity: 'valid' })
    expect(committedB.operation).toMatchObject({ state: 'published', registration: { operation_id: bIds.operation_id, action_id: bIds.action_id, batch_id: b.batch.batch_id }, result: { state: 'published', operation_id: bIds.operation_id, surface_revision: publishedB.surface.revision } })
    const requestsBeforeQueries = server.exchanges.length
    for (let query = 0; query < 2; query++) {
      expect(await readPublication(bIds.operation_id)).toEqual(committedB)
      expect(await call({ type: 'task.query', task_id: task, query: { type: 'read', input: { target: { kind: 'action', id: bIds.action_id } } } })).toMatchObject({ data: { state: 'ended', result: 'success', result_data: { action_id: bIds.action_id, revision: publishedB.surface.revision } } })
    }
    expect(server.exchanges).toHaveLength(requestsBeforeQueries)
    expect(await app.evaluate(() => (globalThis as any).__publicationReceipt)).toEqual({ lost: true, confirmations: 1 })

    await page.getByLabel('BETA_NOTE', { exact: true }).fill('BETA_INPUT_WHILE_ALPHA_WAITS')
    await expect.poll(async () => (await snapshot()).views[0]?.draft.answer, poll).toBe('BETA_INPUT_WHILE_ALPHA_WAITS')
    const savedB = (await snapshot()).views[0]!
    await call({ type: 'approval.decide', task_id: task, approval_id: originalApproval.id, decision: 'approve' })
    await expect.poll(async () => (await readPublication(aIds.operation_id)).operation?.result, poll).toMatchObject({ state: 'failure', code: 'VERSION_CONFLICT' })
    await expect.poll(() => collators.some(input => input.batch.previous_batch_id === a.batch.batch_id), poll).toBe(true)
    const rebuilt = collators.find(input => input.batch.previous_batch_id === a.batch.batch_id)!, rebuiltIds = publicationIds(rebuilt)
    expect(rebuilt.batch.run_id).not.toBe(a.batch.run_id)
    expect(rebuiltIds.operation_id).not.toBe(aIds.operation_id)
    const newApproval = await pendingApproval(page, task, rebuiltIds.action_id)
    expect(newApproval.id).not.toBe(originalApproval.id)
    expect(newApproval.request).toMatchObject({ effective_request: { surface_id: publishedB.surface.id, expected_revision: publishedB.surface.revision } })
    expect(JSON.stringify(newApproval.request)).toContain(betaView.id)
    expect((await readPublication(rebuiltIds.operation_id)).budget_id).toBe((await readPublication(aIds.operation_id)).budget_id)
    await approve(page, task, rebuiltIds.action_id)
    await hostReady(page, task, rebuiltIds.action_id)
    await call({ type: 'surface.respond', task_id: task, action_id: rebuiltIds.action_id, proceed: true, confirm_discard: false })
    await expect.poll(async () => (await snapshot()).runner?.scope?.state, poll).toBe('complete')
    await expect(page.getByRole('heading', { name: 'ALPHA_PUBLISHED', exact: true })).toBeVisible()
    const final = await snapshot()
    expect(final.views).toHaveLength(2)
    expect(final.surface).toMatchObject({ id: initial.surface.id, revision: publishedB.surface.revision + 1 })
    expect(final.views.find(view => view.id === betaView.id)).toEqual(savedB)
    expect(final.surface.layout?.slots.flatMap(slot => slot.groups.flatMap(group => group.views)).sort()).toEqual(final.views.map(view => view.id).sort())
    expect(final.runner?.scope).toMatchObject({ state: 'complete', required_goal_count: 2, published_count: 2, unresolved_count: 0 })
    expect((await readPublication(bIds.operation_id)).operation).toEqual(committedB.operation)
    const reconciled = await readPublication(rebuiltIds.operation_id)
    expect(reconciled).toMatchObject({ mapping_count: 2, surface_history_count: 2, view_history_count: 2 })
    expect(reconciled.view_ids).toHaveLength(2)
    expect(reconciled.publication_ids).toHaveLength(3)
    expect(collators).toHaveLength(3)
    expect(errors).toEqual([])
    expect(serverErrors).toEqual([])
    await page.screenshot({ path: test.info().outputPath('composition-concurrent-publication.png') })
  } catch (error) {
    await attachRuntimeFailure(app, directory)
    throw error
  } finally {
    for (const response of held.values()) response.destroy()
    await app.close(); await server.close(); await rm(directory, { recursive: true, force: true })
  }
})

test('a correction fences an explicitly released old HTTP production result while the current goal and its sibling publish', async () => {
  test.setTimeout(90000)
  const held = new Map<string, ServerResponse>(), collators: CollatorInput[] = [], serverErrors: string[] = []
  let old: { response: ServerResponse; binding: ProducerBinding; result: ReturnType<typeof producerResult> } | undefined
  const server = await modelServer(({ body }, response) => {
    try {
      if (synthetic(body, response) || collate(body, response, collators)) return
      const binding = producerBinding(body)
      if (binding.owner.purpose !== 'production') throw Error('Expected a production source')
      const name = JSON.stringify(body.messages).includes('LATE_ALPHA') ? binding.owner.intent_revision === 1 ? 'STALE_ALPHA' : 'CURRENT_ALPHA' : 'INDEPENDENT_BETA'
      const last = (body as WireBody).messages.at(-1)!
      if (last.role !== 'tool') {
        if (name === 'STALE_ALPHA') createResource(response, name)
        else held.set(name, response)
        return
      }
      expect(last.tool_call_id).toBe(`resource-${name}`)
      const resource = JSON.parse(last.content)
      expect(resource).toMatchObject({ execution: 'success', data: { id: expect.any(String) } })
      const result = producerResult(binding, resource.data.id, name)
      if (name === 'STALE_ALPHA') { old = { response, binding, result }; return }
      complete(response, { content: JSON.stringify(result) })
    } catch (error) {
      serverErrors.push(error instanceof Error ? error.message : String(error))
      if (!response.headersSent) response.writeHead(500)
      response.end()
    }
  })
  const directory = await mkdtemp(join(tmpdir(), 'pliuna-production-late-result-')), app = await launch(directory, await lateResultBootstrap(directory))
  try {
    const page = await app.firstWindow(), errors: string[] = [], call = bridge(page)
    page.on('pageerror', error => errors.push(error.message))
    const task = await configure(page, server.url, '纠正前迟到结果隔离验收'), snapshot = () => call<Snapshot>({ type: 'task.snapshot', task_id: task })
    const readPublication = await publicationReader(app, directory, task)
    const alpha = await call<{ request_id: string }>({ type: 'request.submit', task_id: task, text: 'LATE_ALPHA：保存原始章节。', model_config_id: 'publication-main', resource_ids: [], import_ids: [] })
    const beta = await call<{ request_id: string }>({ type: 'request.submit', task_id: task, text: 'INDEPENDENT_BETA：保存独立章节。', model_config_id: 'publication-main', resource_ids: [], import_ids: [] })
    await expect.poll(() => !!old && held.has('INDEPENDENT_BETA'), poll).toBe(true)
    const original = old!, originalBeta = (await snapshot()).runner!.goals.find(goal => goal.request_id === beta.request_id)!
    // Model the upstream race in which an already dispatched request delivers
    // its response despite cancellation. Persistent ownership stays unchanged.
    const cancellation = await cancellationControl(app, { type: 'arm', owner: original.binding.owner })
    expect(cancellation).toMatchObject({ process_type: 'utility', run_id: original.binding.owner.run_id, attempt_id: original.binding.owner.attempt_id, requested: 0, performed: 0 })
    expect(cancellation!.pid).not.toBe(await app.evaluate(() => process.pid))
    const correction: HostRequest = { type: 'host.runner.input', task_id: task, input_event_id: 'late-alpha-correction', kind: 'correction', request_id: alpha.request_id, text: 'LATE_ALPHA：改用当前修订，旧章节和旧答案作废。' }
    const receipt = await call(correction)
    expect(await call(correction)).toEqual(receipt)
    expect(await cancellationControl(app, { type: 'inspect' })).toEqual({ ...cancellation, requested: 1 })
    await expect.poll(async () => (await snapshot()).runner?.goals.find(goal => goal.request_id === alpha.request_id)?.intent_revision, poll).toBe(2)
    const retired = await app.evaluate((_electron, input) => {
      const req = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json'), Database = req('better-sqlite3')
      const database = new Database(input.directory + '/pliuna.sqlite', { readonly: true, fileMustExist: true })
      try {
        return database.prepare("SELECT r.commit_valid,json_extract(n.payload_json,'$.state') state FROM runs r JOIN runner_runs n ON n.run_id=r.id WHERE r.task_id=? AND r.id=?").get(input.task, input.run)
      } finally { database.close() }
    }, { directory, task, run: original.binding.owner.run_id })
    expect(retired).toEqual({ commit_valid: 0, state: 'closing' })
    // Closing keeps the old Run's admission slot until its dispatched HTTP
    // response settles. Release the real old result only after revocation.
    expect(original.result.artifacts[0]).toMatchObject({ request_id: alpha.request_id, intent_revision: 1, attempt_id: original.binding.owner.attempt_id })
    expect(original.response.destroyed).toBe(false)
    expect(original.response.writableEnded).toBe(false)
    complete(original.response, { content: JSON.stringify(original.result) })
    expect(original.response.writableEnded).toBe(true)
    old = undefined
    await expect.poll(() => held.has('CURRENT_ALPHA'), poll).toBe(true)
    expect(await cancellationControl(app, { type: 'replay' })).toEqual({ ...cancellation, requested: 1, performed: 1 })
    createResource(held.get('CURRENT_ALPHA')!, 'CURRENT_ALPHA'); held.delete('CURRENT_ALPHA')
    createResource(held.get('INDEPENDENT_BETA')!, 'INDEPENDENT_BETA'); held.delete('INDEPENDENT_BETA')
    await expect.poll(async () => {
      const current = await snapshot()
      for (const approval of current.approvals.filter(item => item.decision === 'pending' && item.validity === 'valid')) await call({ type: 'approval.decide', task_id: task, approval_id: approval.id, decision: 'approve' })
      for (const update of (await snapshot()).surface_updates) {
        const response = await page.evaluate(request => window.pliuna.request(request), { type: 'surface.respond', task_id: task, action_id: update.action_id, proceed: true, confirm_discard: false } satisfies HostRequest)
        if (!response.ok) {
          expect(response.error.code).toBe('VERSION_CONFLICT')
          const original = collators.find(input => input.batch.action_id === update.action_id)!
          await expect.poll(async () => (await readPublication(publicationIds(original).operation_id)).operation?.result, poll).toMatchObject({ state: 'failure', code: 'VERSION_CONFLICT' })
        }
      }
      return (await snapshot()).runner?.scope?.state
    }, poll).toBe('complete')
    const final = await snapshot(), currentAlpha = final.runner!.goals.find(goal => goal.request_id === alpha.request_id)!, currentBeta = final.runner!.goals.find(goal => goal.request_id === beta.request_id)!
    expect(currentAlpha).toMatchObject({ intent_revision: 2, run: { state: 'completed' }, reply: { request_id: alpha.request_id, intent_revision: 2 } })
    expect(currentBeta).toMatchObject({ intent_revision: 1, run: { id: originalBeta.run!.id, state: 'completed' }, reply: { request_id: beta.request_id, intent_revision: 1 } })
    expect(final.runner?.scope).toMatchObject({ state: 'complete', required_goal_count: 2, published_count: 2, unresolved_count: 0 })
    await expect(page.getByRole('heading', { name: 'CURRENT_ALPHA_PUBLISHED', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'INDEPENDENT_BETA_PUBLISHED', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'STALE_ALPHA_PUBLISHED', exact: true })).toHaveCount(0)
    const facts: { answers: { request_id: string; intent_revision: number; text: string }[]; artifacts: ArtifactIndex[] } = await app.evaluate((_electron, input) => {
      const req = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json'), Database = req('better-sqlite3')
      const database = new Database(input.directory + '/pliuna.sqlite', { readonly: true, fileMustExist: true })
      try {
        return {
          answers: database.prepare("SELECT payload_json FROM records WHERE task_id=? AND kind='runner.answer' ORDER BY sequence").all(input.task).map((row: { payload_json: string }) => JSON.parse(row.payload_json) as { request_id: string; intent_revision: number; text: string }),
          artifacts: database.prepare('SELECT payload_json FROM runner_artifacts WHERE task_id=? ORDER BY artifact_id').all(input.task).map((row: { payload_json: string }) => JSON.parse(row.payload_json) as ArtifactIndex)
        }
      } finally { database.close() }
    }, { directory, task })
    expect(facts.answers.map(answer => answer.text).sort()).toEqual(['CURRENT_ALPHA_FINAL', 'INDEPENDENT_BETA_FINAL'])
    expect(facts.artifacts).toHaveLength(2)
    expect(facts.artifacts.find(index => index.request_id === alpha.request_id)).toMatchObject({ intent_revision: 2, artifact_revision: 1 })
    expect(facts.artifacts.every(index => index.attempt_id !== original.binding.owner.attempt_id)).toBe(true)
    expect(final.views.map(view => view.bundle.html).join('\n')).not.toContain('STALE_ALPHA')
    expect(errors).toEqual([])
    expect(serverErrors).toEqual([])
    await page.screenshot({ path: test.info().outputPath('corrected-production-late-result.png') })
  } catch (error) {
    await attachRuntimeFailure(app, directory)
    throw error
  } finally {
    old?.response.destroy()
    for (const response of held.values()) response.destroy()
    await cancellationControl(app, { type: 'cleanup' }).catch(() => {})
    await app.close(); await server.close(); await rm(directory, { recursive: true, force: true })
  }
})
