import { artifactDraft } from '../helpers/producer-draft'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ServerResponse } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Bundle } from '../../src/shared/contracts.generated'
import type { ArtifactCandidate, ArtifactIndex, CompositionBatch, ExecutionScope, GoalRevision, HostRequest, Outline, OutlineSection, RunnerGoalProjection, Snapshot, WorkDependency } from '../../src/shared/types'
import type { RequestAccounting } from '../../src/runtime/model/accounting'
import { frame, modelInputFromHost, modelServer, synthetic } from '../helpers/model-server'

const executablePath: string = createRequire(import.meta.url)('electron')
const materialText = '{"version":1,"warehouses":{"ALPHA":{"boxes":12,"books_per_box":8},"BETA":{"boxes":9,"books_per_box":7}}}\n'
const taskTitle = '固定材料的两个仓库报告'
const requests = {
  ALPHA: 'COMPARE_ALPHA：读取所选材料，计算 ALPHA 仓库的图书数。保存独立章节和最终答案。',
  BETA: 'COMPARE_BETA：读取相同材料，计算 BETA 仓库的图书数。保存独立章节和最终答案。'
}
type GoalName = keyof typeof requests
interface ProducerBinding { owner: ExecutionScope; plan_revision: number; dependencies: WorkDependency[]; goal: GoalRevision; requirement_ids: string[]; sections: OutlineSection[] }
interface CollatorInput { batch: CompositionBatch; outline: Outline; indexes: ArtifactIndex[] }
interface Milestones { submitted: number; received: number; effective: number | null; first_readable: number | null; complete: number | null }
interface EventMetadata { id: string; kind: string }
interface Directory<T> { items: T[]; next_cursor: string | null }
interface Evidence { request_id: string; purpose: string; owner?: ExecutionScope }
type RequestFact = RequestAccounting & { event_id: string; dispatched: boolean }
type MeasuredRequest = RequestFact & { run_id: string; owner: ExecutionScope; evidence_event_id: string }
interface ServiceObservation { role: 'producer' | 'collator'; stage: string; planned_delay_ms: number; observed_service_ms: number; usage: { prompt_tokens: number; completion_tokens: number } }
const roles: ExecutionScope['role'][] = ['router', 'producer', 'lightweight', 'integrator', 'collator', 'diagnostic']
const fixturePrice = { currency: 'USD', input_per_million_tokens: 1, output_per_million_tokens: 2 }

// Responses deliberately contain fixed answers. The quality oracle below computes
// the expected values separately from the actual imported material.
function chapter(name: GoalName): Bundle {
  const text = name === 'ALPHA' ? 'ALPHA：12 箱，每箱 8 本，共 96 本。' : 'BETA：9 箱，每箱 7 本，共 63 本。'
  return { profile: 'managed-v1', html: `<section id="report"><h2>${name}_BOOK_REPORT</h2><p>${text}</p></section>`, css: '', state: { schema: { type: 'object', properties: {}, additionalProperties: false }, initial: {}, compatibility_version: 'static-v1' }, forms: [], behaviors: [], references: [], export: [{ id: 'report', category: 'learning', source: { type: 'element', element_id: 'report' } }] }
}

async function compareMode(mode: 'single' | 'dual') {
  const directory = await mkdtemp(join(tmpdir(), `pliuna-runner-compare-${mode}-`)), path = join(directory, 'warehouse-material.txt')
  await writeFile(path, materialText)
  let material = '', inFlight = 0, maximumProducerRequests = 0
  const service: ServiceObservation[] = [], serverErrors: string[] = []
  const delayed = async (response: ServerResponse, role: ServiceObservation['role'], stage: string, delay: number, delta: unknown, finish: 'stop' | 'tool_calls') => {
    const start = performance.now()
    if (role === 'producer') { inFlight++; maximumProducerRequests = Math.max(maximumProducerRequests, inFlight) }
    try {
      await new Promise<void>(resolve => setTimeout(resolve, delay))
      const usage = { prompt_tokens: role === 'collator' ? 250 : stage === 'read' ? 400 : stage === 'resource' ? 600 : 800, completion_tokens: role === 'collator' ? 60 : stage === 'answer' ? 120 : 30 }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(frame({ role: 'assistant', ...delta as object }) + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage })}\n\n` + 'data: [DONE]\n\n')
      service.push({ role, stage, planned_delay_ms: delay, observed_service_ms: Math.round(performance.now() - start), usage })
    } finally { if (role === 'producer') inFlight-- }
  }
  const tool = (name: 'read' | 'write', input: unknown, id: string) => ({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(modelInputFromHost(name, input)) } }] })
  const server = await modelServer(async ({ body }, response) => {
    try {
      if (synthetic(body, response)) return
      if (body.messages[0]?.content.startsWith('You are the Collator.')) {
        const { batch, outline, indexes } = JSON.parse(body.messages.find((message: any) => message.role === 'user').content) as CollatorInput
        const plan = { task_id: batch.task_id, run_id: batch.run_id, batch_id: batch.batch_id, composition_version: batch.composition_version, intents: indexes.map(index => {
          const section = outline.sections.find(section => section.section_id === index.section_id)!
          return { artifact: { task_id: index.task_id, artifact_id: index.artifact_id, artifact_revision: index.artifact_revision }, section_id: section.section_id, section_position_revision: section.position_revision, order_key: section.order_key, slot_id: 'main', layout_mode: 'column', width_constraint: index.width_constraint }
        }) }
        await delayed(response, 'collator', 'plan', 40, { content: JSON.stringify(plan) }, 'stop'); return
      }
      const prompt = body.messages.find((message: any) => message.role === 'system' && message.content.includes('Bound data: '))?.content as string | undefined
      if (!prompt) throw Error('Comparison request has no production binding')
      const binding = JSON.parse(prompt.slice(prompt.indexOf('Bound data: ') + 'Bound data: '.length)) as ProducerBinding
      const user = [...body.messages].reverse().find((message: any) => message.role === 'user').content as string
      const name: GoalName = user.includes('COMPARE_ALPHA') ? 'ALPHA' : user.includes('COMPARE_BETA') ? 'BETA' : (() => { throw Error('Unknown comparison goal') })()
      const last = body.messages.at(-1)
      if (last.role !== 'tool') {
        await delayed(response, 'producer', 'read', name === 'ALPHA' ? 800 : 1400, tool('read', { target: { kind: 'resource', id: material }, content: { max_chars: 4000 } }, `material-${name}`), 'tool_calls'); return
      }
      const result = JSON.parse(last.content)
      if (last.tool_call_id === `material-${name}`) {
        expect(result).toMatchObject({ execution: 'success', data: { data: { text: materialText } } })
        await delayed(response, 'producer', 'resource', 40, tool('write', { type: 'resource.create', display_name: `${name}-report.json`, content: { type: 'json', value: chapter(name) } }, `resource-${name}`), 'tool_calls'); return
      }
      expect(last.tool_call_id).toBe(`resource-${name}`)
      expect(result).toMatchObject({ execution: 'success', data: { id: expect.any(String) } })
      const { owner, plan_revision, dependencies, requirement_ids, sections } = binding
      if (owner.purpose !== 'production') throw Error('Expected a production owner')
      const section = sections[0]!, resource = result.data.id as string
      const candidate: ArtifactCandidate = { candidate_id: `candidate-${name}`, task_id: owner.task_id, request_id: owner.request_id, intent_revision: owner.intent_revision, run_id: owner.run_id, work_id: owner.work_id, attempt_id: owner.attempt_id, artifact_id: `artifact-${name}`, base_artifact_revision: 0, plan_revision, bundle_resource_id: resource, section_id: section.section_id, section_position_revision: section.position_revision, order_key: section.order_key, presentation_kind: 'managed-v1', width_constraint: 'full', interaction_kind: 'none', provenance_ref: { task_id: owner.task_id, kind: 'resource', id: material }, requirement_ids, unresolved: [], dependencies }
      const answer = name === 'ALPHA' ? 'ALPHA_FINAL：12 × 8 = 96 本。' : 'BETA_FINAL：9 × 7 = 63 本。'
      await delayed(response, 'producer', 'answer', 40, { content: JSON.stringify({ version: 1, complete: true, answer, artifacts: [artifactDraft(candidate)], requirement_ids, unresolved: [] }) }, 'stop')
    } catch (error) {
      serverErrors.push(error instanceof Error ? error.message : String(error))
      if (!response.headersSent) response.writeHead(500)
      response.end('Comparison fixture failed')
    }
  })
  const app = await electron.launch({ executablePath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', PLIUNA_TEST_DATA: directory, PLIUNA_TEST_RUNNER: mode, PLIUNA_TEST_RUNNER_COLLATOR: 'model' } })
  try {
    const page = await app.firstWindow(), pageErrors: string[] = []
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.setViewportSize({ width: 1440, height: 960 })
    const call = async <T,>(request: HostRequest): Promise<T> => page.evaluate(async request => {
      const response = await window.pliuna.request(request)
      if (!response.ok) throw Error(response.error.code)
      return response.data as T
    }, request)
    const all = async <T,>(kind: 'event' | 'run'): Promise<T[]> => {
      const items: T[] = []; let cursor: string | null = null
      do { const result: Directory<T> = await call({ type: 'task.query', task_id: task, query: { type: 'list', input: { kind, limit: 200, ...(cursor ? { cursor } : {}) } } }); items.push(...result.items); cursor = result.next_cursor } while (cursor)
      return items
    }
    await call({ type: 'model.configure', configuration: { id: 'comparison-main', base_url: server.url, wire_model_id: 'fixed-comparison-v1', context_tokens: 1000000, max_output_tokens: 4096, compatibility_profile: 'chat-max-tokens' }, api_key: 'fixed-local-fixture', confirm_memory_only: true })
    await call({ type: 'model.test', model_id: 'comparison-main', role: 'main', confirm_cost: true })
    await page.getByRole('button', { name: '创建第一个任务', exact: true }).click()
    await page.getByLabel('任务名称').fill(taskTitle)
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    const task = (await call<{ id: string }[]>({ type: 'host.tasks' }))[0]!.id
    await app.evaluate(({ dialog }, path) => { (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, path)
    const imported = await call<{ items: { operation_id: string }[] }>({ type: 'material.pick', task_id: task })
    const importId = imported.items[0]!.operation_id
    await expect.poll(async () => (await call<{ state: string }>({ type: 'material.status', task_id: task, operation_id: importId })).state).toBe('success')
    material = (await call<{ resource: { id: string } }>({ type: 'material.status', task_id: task, operation_id: importId })).resource.id
    const readMaterial = await call<{ data: { text: string } }>({ type: 'task.query', task_id: task, query: { type: 'read', input: { target: { kind: 'resource', id: material }, content: { max_chars: 4000 } } } })
    expect(readMaterial.data.text).toBe(materialText)
    const start = performance.now(), now = () => Math.round(performance.now() - start)
    const goals = new Map<GoalName, { request_id: string; milestones_ms: Milestones }>()
    for (const name of ['ALPHA', 'BETA'] as const) {
      const submitted = now()
      const received = await call<{ request_id: string }>({ type: 'request.submit', task_id: task, text: requests[name], model_config_id: 'comparison-main', resource_ids: [material], import_ids: [] })
      goals.set(name, { request_id: received.request_id, milestones_ms: { submitted, received: now(), effective: null, first_readable: null, complete: null } })
    }
    let complete = 0, maximumActiveProduction = 0
    while (!complete && now() < 40000) {
      const snapshot = await call<Snapshot>({ type: 'task.snapshot', task_id: task }), projection = snapshot.runner!
      maximumActiveProduction = Math.max(maximumActiveProduction, projection.goals.filter(goal => goal.run && ['running', 'waiting', 'closing'].includes(goal.run.state)).length)
      for (const [name, value] of goals) {
        const goal = projection.goals.find(goal => goal.request_id === value.request_id)
        if (goal?.run && value.milestones_ms.effective === null) value.milestones_ms.effective = now()
        if (value.milestones_ms.first_readable === null && await page.getByRole('heading', { name: `${name}_BOOK_REPORT`, exact: true }).isVisible()) value.milestones_ms.first_readable = now()
        if (goal?.delivery === 'published' && goal.run?.state === 'completed' && value.milestones_ms.complete === null) value.milestones_ms.complete = now()
      }
      for (const approval of snapshot.approvals.filter(approval => approval.decision === 'pending' && approval.validity === 'valid')) await call({ type: 'approval.decide', task_id: task, approval_id: approval.id, decision: 'approve' })
      for (const update of snapshot.surface_updates) await call({ type: 'surface.respond', task_id: task, action_id: update.action_id, proceed: true, confirm_discard: false })
      if (projection.scope?.state === 'complete' && [...goals.values()].every(value => value.milestones_ms.complete !== null && value.milestones_ms.first_readable !== null)) complete = now()
      else await new Promise<void>(resolve => setTimeout(resolve, 50))
    }
    expect(complete, `Comparison stalled: ${JSON.stringify(await call({ type: 'host.runner.status', task_id: task }))}; fixture=${JSON.stringify(serverErrors)}`).toBeGreaterThan(0)
    expect(maximumProducerRequests).toBe(mode === 'dual' ? 2 : 1)
    expect(maximumActiveProduction).toBe(mode === 'dual' ? 2 : 1)
    const final = await call<Snapshot>({ type: 'task.snapshot', task_id: task })
    expect(final.runner?.scope).toMatchObject({ state: 'complete', required_goal_count: 2, unresolved_count: 0, pending_update_count: 0, published_count: 2 })
    const facts = JSON.parse(readMaterial.data.text) as { warehouses: Record<GoalName, { boxes: number; books_per_box: number }> }
    const quality: { goal: GoalName; expected_books: number; answer: string; rendered_text: string }[] = []
    for (const [name, value] of goals) {
      const goal: RunnerGoalProjection = final.runner!.goals.find(goal => goal.request_id === value.request_id)!, entry = await call<{ data: { payload: { text: string; request_id: string; intent_revision: number } } }>({ type: 'task.query', task_id: task, query: { type: 'read', input: { target: { kind: 'event', id: goal.reply!.id } } } })
      const expected = facts.warehouses[name].boxes * facts.warehouses[name].books_per_box
      const answer = entry.data.payload.text, view = final.views.find(view => view.bundle.html.includes(`${name}_BOOK_REPORT`))!
      const rendered = await page.getByRole('heading', { name: `${name}_BOOK_REPORT`, exact: true }).locator('..').innerText()
      expect(entry.data.payload).toMatchObject({ request_id: value.request_id, intent_revision: 1 })
      expect(answer).toMatch(new RegExp(`= ${expected} 本`)); expect(view.bundle.html).toContain(`共 ${expected} 本`); expect(rendered).toContain(`共 ${expected} 本`)
      expect(answer).not.toContain(name === 'ALPHA' ? 'BETA_FINAL' : 'ALPHA_FINAL')
      const times = value.milestones_ms
      expect(times.received).toBeGreaterThanOrEqual(times.submitted)
      expect(times.effective!).toBeGreaterThanOrEqual(times.received)
      expect(times.first_readable!).toBeGreaterThanOrEqual(times.effective!)
      quality.push({ goal: name, expected_books: expected, answer, rendered_text: rendered })
    }
    const evidence = new Map<string, { id: string; payload: Evidence }>()
    for (const event of (await all<EventMetadata>('event')).filter(event => event.kind === 'model.request.evidence')) {
      const result = await call<{ data: { payload: Evidence } }>({ type: 'task.query', task_id: task, query: { type: 'read', input: { target: { kind: 'event', id: event.id } } } })
      evidence.set(result.data.payload.request_id, { id: event.id, payload: result.data.payload })
    }
    const ledger: MeasuredRequest[] = []
    for (const run of await all<{ id: string }>('run')) {
      let cursor: string | null = null
      do {
        const page: { consistency: string; requests: RequestFact[]; next_cursor: string | null; complete: boolean } = await call({ type: 'host.run.accounting', task_id: task, run_id: run.id, ...(cursor ? { cursor } : {}) })
        expect(page.consistency).toBe('snapshot')
        for (const item of page.requests) {
          const source = evidence.get(item.request_id)
          expect(source?.payload.owner?.task_id).toBe(task)
          expect(source?.payload.owner?.run_id).toBe(run.id)
          expect(source?.payload.purpose).toBe(item.purpose)
          expect(item).toMatchObject({ model_id: 'comparison-main', model_revision: 1, phase: 'completed', dispatched: true, usage: { prompt_tokens: expect.any(Number), completion_tokens: expect.any(Number) } })
          ledger.push({ ...item, run_id: run.id, owner: source!.payload.owner!, evidence_event_id: source!.id })
        }
        cursor = page.next_cursor
        if (!cursor) expect(page.complete).toBe(true)
      } while (cursor)
    }
    expect(ledger).toHaveLength(service.length)
    expect(new Set(ledger.map(item => item.request_id)).size).toBe(ledger.length)
    const costs = roles.map(role => {
      const actual = ledger.filter(item => item.owner.role === role)
      const known = actual.every(item => typeof item.usage?.prompt_tokens === 'number' && typeof item.usage.completion_tokens === 'number')
      const input = actual.length && known ? actual.reduce((sum, item) => sum + item.usage!.prompt_tokens!, 0) : null
      const output = actual.length && known ? actual.reduce((sum, item) => sum + item.usage!.completion_tokens!, 0) : null
      return { role, state: actual.length ? known ? 'fixture_usage_known' : 'usage_unknown' : 'not_dispatched', request_ids: actual.map(item => item.request_id), input_tokens: input, output_tokens: output, fixture_cost_usd: input === null || output === null ? null : (input * fixturePrice.input_per_million_tokens + output * fixturePrice.output_per_million_tokens) / 1000000 }
    })
    expect(costs.find(role => role.role === 'producer')!.request_ids).toHaveLength(6)
    expect(costs.find(role => role.role === 'collator')!.request_ids.length).toBeGreaterThanOrEqual(1)
    expect(serverErrors).toEqual([]); expect(pageErrors).toEqual([])
    return { mode, model: { id: 'comparison-main', wire_model_id: 'fixed-comparison-v1', context_tokens: 1000000, max_output_tokens: 4096 }, task: taskTitle, material: materialText, requests, timing: { clock: 'test-process performance.now; milliseconds from the first submission', observation: 'Host/Renderer polling upper bounds; 50ms minimum polling interval plus IPC and approval handling', automated_approvals: true, task_milestones_ms: { received: Math.max(...[...goals.values()].map(value => value.milestones_ms.received)), effective: Math.min(...[...goals.values()].map(value => value.milestones_ms.effective!)), first_readable: Math.min(...[...goals.values()].map(value => value.milestones_ms.first_readable!)), complete }, goals: Object.fromEntries(goals) }, maximum_active_production_runs: maximumActiveProduction, maximum_producer_requests_in_flight: maximumProducerRequests, service, pricing: fixturePrice, roles: costs, model_requests: ledger, quality }
  } finally {
    await app.close(); await server.close(); await rm(directory, { recursive: true, force: true })
  }
}

test('fixed model responses, material and tasks compare single and dual production with complete role costs and independent quality checks', async () => {
  test.setTimeout(120000)
  const single = await compareMode('single'), dual = await compareMode('dual')
  expect(dual.model).toEqual(single.model); expect(dual.material).toBe(single.material); expect(dual.requests).toEqual(single.requests)
  expect(dual.quality.map(({ goal, expected_books, answer, rendered_text }) => ({ goal, expected_books, answer, rendered_text }))).toEqual(single.quality)
  const report = { version: 1, evidence_boundary: 'Real Electron, Store, IPC, resource reads, publication and Renderer; fixed local HTTP model responses and declared fixture usage. No live model quality or provider billing evidence. Elapsed times include controlled service delays and automated approval polling; no real-provider speedup claim.', fixture_price_is_not_provider_billing: true, single, dual }
  const path = test.info().outputPath('runner-single-vs-dual.json')
  await writeFile(path, JSON.stringify(report, null, 2))
  await test.info().attach('runner-single-vs-dual', { path, contentType: 'application/json' })
})
