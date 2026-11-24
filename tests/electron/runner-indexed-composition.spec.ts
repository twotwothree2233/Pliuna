import { artifactDraft } from '../helpers/producer-draft'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { frame, modelInputFromHost, modelServer, synthetic } from '../helpers/model-server'
import type { Bundle } from '../../src/shared/contracts.generated'
import type { ArtifactCandidate, ArtifactIndex, CompositionBatch, ExecutionScope, ContentPlan, HostRequest, Outline, OutlineSection, LiveFlowSnapshot, RunnerProjection, Snapshot, WorkDependency } from '../../src/shared/types'

const require = createRequire(import.meta.url), executablePath: string = require('electron')
type RunnerLimits = typeof import('../../src/runtime/runner/limits').RUNNER_LIMITS

function complete(response: ServerResponse, delta: object, finish: 'stop' | 'tool_calls', cached?: number) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(frame({ role: 'assistant', ...delta }) + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 400, completion_tokens: 80, ...(cached === undefined ? {} : { prompt_tokens_details: { cached_tokens: cached } }) } })}\n\n` + 'data: [DONE]\n\n')
}
function textStream(response: ServerResponse, text: string, cached?: number) { complete(response, { content: text }, 'stop', cached) }
function hostToolStream(response: ServerResponse, name: 'write', input: unknown, text = '', id = 'wire-call-1') {
  complete(response, { content: text, tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(modelInputFromHost(name, input)) } }] }, 'tool_calls')
}

async function runnerLimits(): Promise<RunnerLimits> {
  // Bundle the production constants and their JSON dependencies before loading
  // them, matching the Electron build rather than Playwright's ESM JSON loader.
  const esbuild = createRequire(require.resolve('vite'))('esbuild')
  const built = await esbuild.build({ entryPoints: [resolve('src/runtime/runner/limits.ts')], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent' })
  const loaded = { exports: {} as { RUNNER_LIMITS: RunnerLimits } }
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, loaded, loaded.exports)
  return loaded.exports.RUNNER_LIMITS
}

interface ProducerBinding {
  owner: ExecutionScope
  plan_revision: number
  dependencies: WorkDependency[]
  goal: ContentPlan
  requirement_ids: string[]
  sections: OutlineSection[]
}
interface CollatorSnapshot {
  batch: CompositionBatch
  outline: Outline
  indexes: ArtifactIndex[]
}
interface ExportPreview {
  id: string
  phase: string
  issues: string[]
  html: string
  selection: { composition_version: number; surface_revision: number; state: string; target_count: number; published_count: number; unresolved_count: number }
}

test('real resources reach the working copy through bounded model Collators while exports retain their selected version', async () => {
  test.setTimeout(90000)
  const RUNNER_LIMITS = await runnerLimits()
  const bundle = (name: 'ALPHA' | 'BETA'): Bundle => ({
    profile: 'managed-v1', html: `<section id="piece"><h2>${name}_PUBLISHED</h2><p>${`BODY_SENTINEL_${name}_`.repeat(7000)}</p></section>`, css: '',
    state: { schema: { type: 'object', properties: {}, additionalProperties: false }, initial: {}, compatibility_version: 'static-v1' },
    forms: [], behaviors: [], references: [], export: [{ id: 'piece', category: 'learning', source: { type: 'element', element_id: 'piece' } }]
  })
  const bundles = { ALPHA: bundle('ALPHA'), BETA: bundle('BETA') }
  for (const value of Object.values(bundles)) {
    const bytes = Buffer.byteLength(JSON.stringify(value))
    expect(bytes).toBeGreaterThan(100 * 1024)
    expect(bytes).toBeLessThan(256 * 1024)
  }
  const held: { alpha: ServerResponse | null; beta: ServerResponse | null } = { alpha: null, beta: null }
  let alphaLayout: { response: ServerResponse; complete: () => void } | undefined
  const collators: { request: string; snapshot: CollatorSnapshot }[] = []
  const sourceResources = new Map<string, string>()
  const createResource = (response: ServerResponse, name: 'ALPHA' | 'BETA') => hostToolStream(response, 'write', {
    type: 'resource.create', display_name: `${name.toLowerCase()}.json`, content: { type: 'json', value: bundles[name] }
  }, '', `resource-${name.toLowerCase()}`)
  const server = await modelServer(({ body }, response) => {
    if (synthetic(body, response)) return
    if (body.messages[0]?.content.startsWith('You are the Collator.')) {
      const request = JSON.stringify(body), snapshot = JSON.parse(body.messages.find((message: any) => message.role === 'user').content) as CollatorSnapshot
      collators.push({ request, snapshot })
      const { batch, outline, indexes } = snapshot
      const plan = {
        task_id: batch.task_id, run_id: batch.run_id, batch_id: batch.batch_id, composition_version: batch.composition_version,
        intents: indexes.map(index => {
          const section = outline.sections.find(section => section.section_id === index.section_id)!
          return { artifact: { task_id: index.task_id, artifact_id: index.artifact_id, artifact_revision: index.artifact_revision }, section_id: section.section_id, section_position_revision: section.position_revision, order_key: section.order_key, slot_id: 'main', layout_mode: 'column', width_constraint: index.width_constraint }
        })
      }
      if (collators.length === 1) {
        alphaLayout = { response, complete: () => textStream(response, JSON.stringify(plan)) }
      } else textStream(response, JSON.stringify(plan))
      return
    }
    const current = [...body.messages].reverse().find((message: any) => message.role === 'user')
    const request = JSON.parse(current.content).request as string
    const name = request.includes('RESOURCE_ALPHA') ? 'ALPHA' : request.includes('RESOURCE_BETA') ? 'BETA' : null
    if (!name) { response.writeHead(400); response.end('Unexpected isolated composition input'); return }
    const last = body.messages.at(-1)
    if (last.role !== 'tool') { held[name === 'ALPHA' ? 'alpha' : 'beta'] = response; return }
    const result = JSON.parse(last.content)
    if (last.tool_call_id === 'beta-create') {
      hostToolStream(response, 'write', { type: 'task_data.remove', id: result.data.id, expected_revision: 1 }, '', 'beta-remove'); return
    }
    if (last.tool_call_id === 'beta-remove') { createResource(response, 'BETA'); return }
    expect(result).toMatchObject({ execution: 'success', data: { id: expect.any(String) } })
    const resource = result.data.id as string
    const system = body.messages.find((message: any) => message.role === 'system' && message.content.includes('Bound data: ')).content as string
    const binding = JSON.parse(system.slice(system.indexOf('Bound data: ') + 'Bound data: '.length)) as ProducerBinding
    const { owner, dependencies, plan_revision, sections, requirement_ids } = binding, section = sections[0]!
    if (owner.purpose !== 'production') throw Error('Expected real production source')
    sourceResources.set(owner.work_id, resource)
    const candidate: ArtifactCandidate = {
      candidate_id: `candidate-${name.toLowerCase()}`, task_id: owner.task_id, request_id: owner.request_id, intent_revision: owner.intent_revision,
      run_id: owner.run_id, work_id: owner.work_id, attempt_id: owner.attempt_id, artifact_id: `artifact-${name.toLowerCase()}`, base_artifact_revision: 0,
      plan_revision, bundle_resource_id: resource, section_id: section.section_id, section_position_revision: section.position_revision, order_key: section.order_key,
      presentation_kind: 'managed-v1', width_constraint: 'full', interaction_kind: 'none', provenance_ref: { task_id: owner.task_id, kind: 'resource', id: resource },
      requirement_ids, unresolved: [], dependencies
    }
    textStream(response, JSON.stringify({ version: 1, complete: true, answer: `${name}_FINAL_ANSWER`, artifacts: [artifactDraft(candidate)], requirement_ids, unresolved: [] }))
  })
  const directory = await mkdtemp(join(tmpdir(), 'pliuna-indexed-resource-desktop-'))
  const app = await electron.launch({ executablePath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', PLIUNA_TEST_DATA: directory, PLIUNA_TEST_RUNNER: 'dual', PLIUNA_TEST_RUNNER_COLLATOR: 'model' } })
  try {
    const page = await app.firstWindow(), errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewportSize({ width: 1440, height: 960 })
    const agent = page.locator('#pane-right'), center = page.getByRole('main')
    const workingCopy = agent.getByRole('region', { name: '当前成稿状态' })
    const reply = agent.getByRole('region', { name: '任务对话' })
    const call = async <T,>(request: HostRequest): Promise<T> => page.evaluate(async request => {
      const response = await window.pliuna.request(request)
      if (!response.ok) throw Error(response.error.code)
      return response.data as T
    }, request)
    await call({ type: 'model.configure', configuration: { id: 'indexed-main', base_url: server.url, wire_model_id: 'indexed-wire', context_tokens: 1000000, max_output_tokens: 50000, compatibility_profile: 'chat-max-tokens' }, api_key: 'isolated-indexed-key', confirm_memory_only: true })
    await call({ type: 'model.test', model_id: 'indexed-main', role: 'main', confirm_cost: true })
    await page.getByRole('button', { name: '创建第一个任务', exact: true }).click()
    await page.getByLabel('任务名称').fill('大资源渐进发布与固定导出')
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    const task = (await call<{ id: string }[]>({ type: 'host.tasks' }))[0]!.id
    const input = page.getByLabel('想从哪里开始？'), send = page.getByRole('button', { name: '发送消息', exact: true })
    await input.fill('RESOURCE_ALPHA：完成第一章并保留其完整资源。'); await send.click()
    await expect.poll(() => Boolean(held.alpha)).toBe(true)
    await input.fill('RESOURCE_BETA：独立完成第二章，稍后发布。'); await send.click()
    await expect.poll(() => Boolean(held.beta)).toBe(true)
    expect((await call<RunnerProjection>({ type: 'host.runner.status', task_id: task })).goals).toHaveLength(2)
    const flowTab = page.getByRole('tab', { name: '执行流程', exact: true }), contentTab = page.getByRole('tab', { name: /^内容/ })
    const graph = page.getByRole('region', { name: '实时执行流程', exact: true })
    const workerLane = graph.getByRole('region', { name: 'Worker', exact: true })
    const collatorLane = graph.getByRole('region', { name: 'Collator', exact: true })
    const message = (name: string) => reply.getByRole('article', { name: '你的消息' }).filter({ hasText: name })
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const agentTabs = agent.getByRole('navigation', { name: 'Agent 视图' })
    const agentRecords = () => agentTabs.getByRole('button', { name: '执行记录', exact: true }).click()
    const agentChat = () => agentTabs.getByRole('button', { name: '对话', exact: true }).click()
    await message('RESOURCE_ALPHA').getByRole('button', { name: '执行详情' }).press('Enter')
    await page.getByRole('dialog', { name: '本次请求详情' }).getByRole('button', { name: '查看此执行流程' }).press('Enter')
    await expect(flowTab).toHaveAttribute('aria-selected', 'true')
    await expect(workerLane.locator('.flow-card')).toHaveCount(2)
    await expect(workerLane.locator('.flow-card[aria-pressed=true]')).toBeFocused()
    await expect(graph.locator('.flow-packet')).toHaveCount(0)
    await graph.evaluate(element => {
      document.body.dataset.flowEmissions = '[]'
      new MutationObserver(changes => {
        const ids = JSON.parse(document.body.dataset.flowEmissions ?? '[]') as string[]
        for (const change of changes) for (const added of change.addedNodes) if (added instanceof Element) {
          const packets = added.matches('.flow-packet') ? [added] : [...added.querySelectorAll('.flow-packet')]
          for (const packet of packets) ids.push(packet.closest<HTMLElement>('[data-kind]')?.dataset.kind ?? '')
        }
        document.body.dataset.flowEmissions = JSON.stringify(ids)
      }).observe(element, { childList: true, subtree: true })
    })
    await page.setViewportSize({ width: 575, height: 760 })
    await expect(graph).toBeVisible()
    await expect(page.getByRole('navigation', { name: '工作区视图' })).toBeVisible()
    expect(await graph.evaluate(el => [...el.querySelectorAll('.flow-lane')].every(node => node.getBoundingClientRect().left === el.querySelector('.flow-lane')!.getBoundingClientRect().left))).toBe(true)
    createResource(held.alpha!, 'ALPHA'); held.alpha = null
    await expect.poll(() => Boolean(alphaLayout)).toBe(true)
    const alphaBatch = collators[0]!.snapshot.batch
    const alphaCard = graph.locator(`[data-flow-id="batch:${alphaBatch.batch_id}"].flow-card`)
    await expect(collatorLane.locator('.flow-card')).toHaveCount(1)
    await expect(alphaCard).toContainText('排版中')
    await expect(alphaCard).toContainText('Worker → Collator')
    await expect(graph.getByRole('heading', { name: '实时执行流程' })).toBeFocused()
    hostToolStream(held.beta!, 'write', { type: 'task_data.create', data: { schema: { type: 'string' }, value: 'BETA_PENDING_APPROVAL', references: [] } }, '', 'beta-create')
    held.beta = null
    const betaCard = workerLane.locator('.flow-card[data-state="approval"]')
    await expect(betaCard).toBeVisible()
    const betaKey = await betaCard.getAttribute('data-flow-id')
    const beta = workerLane.locator(`[data-flow-id="${betaKey}"]`)
    await beta.focus()
    await expect(alphaCard).toContainText('排版中')
    await expect(beta).toBeFocused()
    await page.screenshot({ path: test.info().outputPath('runner-flow-concurrent.png') })
    alphaLayout!.complete()
    await expect(graph.getByRole('region', { name: 'Host', exact: true }).locator('.flow-card')).toContainText('Collator → Host')
    await expect(beta).toBeFocused()
    const snapshot = () => call<Snapshot>({ type: 'task.snapshot', task_id: task })
    const publishThroughHost = async (count: number, actionId?: string) => {
      await expect.poll(async () => {
        const current = await snapshot()
        for (const approval of current.approvals.filter(approval => approval.decision === 'pending' && approval.validity === 'valid' && (!actionId || approval.action_id === actionId))) {
          await call({ type: 'approval.decide', task_id: task, approval_id: approval.id, decision: 'approve' })
        }
        for (const update of (await snapshot()).surface_updates.filter(update => !actionId || update.action_id === actionId)) {
          await call({ type: 'surface.respond', task_id: task, action_id: update.action_id, proceed: true, confirm_discard: false })
        }
        return (await snapshot()).views.length
      }, { timeout: 30000, intervals: [100, 200, 500] }).toBe(count)
      return snapshot()
    }
    const first = await publishThroughHost(1, alphaBatch.action_id), alpha = first.views[0]!
    await expect(alphaCard).toHaveCount(0)
    await expect(beta).toContainText('待审批')
    await expect(beta).toBeFocused()
    await expect(graph.locator('.flow-packet')).toHaveCount(0)
    const emissions = await page.evaluate(() => JSON.parse(document.body.dataset.flowEmissions ?? '[]'))
    expect(emissions.filter((kind: string) => kind === 'indexes')).toHaveLength(1)
    expect(emissions.filter((kind: string) => kind === 'plan')).toHaveLength(1)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await contentTab.click(); await flowTab.click()
    await expect(beta).toContainText('Router → Worker')
    await expect(graph.locator('.flow-packet')).toHaveCount(0)
    await page.setViewportSize({ width: 1440, height: 960 })
    await contentTab.click()
    await expect(center.getByRole('heading', { name: 'ALPHA_PUBLISHED', exact: true })).toBeVisible()
    await expect(center.getByRole('heading', { name: 'BETA_PUBLISHED', exact: true })).toHaveCount(0)
    await expect(center.getByRole('heading', { name: '尚无已发布内容', exact: true })).toHaveCount(0)
    await agentRecords()
    await expect(workingCopy).toContainText('渐进工作版')
    await agentChat()
    await expect(reply).toContainText('内容已发布。')
    await expect(reply).toContainText('ALPHA_FINAL_ANSWER')
    await expect(center).not.toContainText('ALPHA_FINAL_ANSWER')
    await expect(center.locator('.task-reply, .runner-working-copy, .runner-goals')).toHaveCount(0)
    expect(first.runner?.scope).toMatchObject({ required_content_count: 2, published_count: 1 })
    expect(first.runner!.scope!.unresolved_count).toBeGreaterThan(0)
    expect(first.runner!.scope!.state).not.toBe('complete')
    await expect(message('RESOURCE_BETA').locator('.approval-card')).toContainText('移除任务数据')
    const beforeExport = server.exchanges.length
    const operation = await call<{ id: string }>({ type: 'export.prepare', task_id: task, answer_ids: [], view_ids: [alpha.id], expected_revision: first.surface.revision })
    await expect.poll(async () => (await call<{ phase: string }>({ type: 'export.status', task_id: task, operation_id: operation.id })).phase).toBe('preview')
    const frozen = await call<ExportPreview>({ type: 'export.preview', task_id: task, operation_id: operation.id })
    expect(frozen.html).toContain('ALPHA_PUBLISHED')
    expect(frozen.html).toContain('BODY_SENTINEL_ALPHA_')
    expect(frozen.html).not.toContain('BODY_SENTINEL_BETA_')
    expect(frozen.issues).toContain('RUNNER_COMPOSITION_PARTIAL')
    expect(frozen.selection).toMatchObject({ state: 'partial', target_count: 2, published_count: 1, surface_revision: first.surface.revision })
    expect(frozen.selection.unresolved_count).toBeGreaterThan(0)
    expect(server.exchanges).toHaveLength(beforeExport)
    await message('RESOURCE_BETA').getByRole('button', { name: '批准', exact: true }).click()
    const complete = await publishThroughHost(2)
    await expect(center.getByRole('heading', { name: 'BETA_PUBLISHED', exact: true })).toBeVisible()
    await expect(center.getByRole('heading', { name: 'ALPHA_PUBLISHED', exact: true })).toBeVisible()
    await agentRecords()
    await expect(workingCopy).toContainText('当前成稿已完整')
    await agentChat()
    await expect(reply).toContainText('内容已发布。')
    await expect(reply).toContainText('BETA_FINAL_ANSWER')
    await expect(center).not.toContainText('BETA_FINAL_ANSWER')
    await expect(center.locator('.task-reply, .runner-working-copy, .runner-goals')).toHaveCount(0)
    expect(complete.surface.id).toBe(first.surface.id)
    expect(complete.surface.revision).toBeGreaterThan(first.surface.revision)
    expect(complete.views.find(view => view.id === alpha.id)).toMatchObject({ id: alpha.id, revision: alpha.revision, state_revision: alpha.state_revision, bundle: alpha.bundle })
    expect(complete.runner?.scope).toMatchObject({ state: 'complete', required_content_count: 2, unresolved_count: 0, pending_update_count: 0, published_count: 2 })
    expect(complete.runner!.scope!.composition_version).toBeGreaterThan(first.runner!.scope!.composition_version)
    const afterProduction = server.exchanges.length
    const retained = await call<ExportPreview>({ type: 'export.preview', task_id: task, operation_id: operation.id })
    expect(retained.html).toBe(frozen.html)
    expect(retained.selection).toEqual(frozen.selection)
    expect(retained.issues).toEqual(frozen.issues)
    await call({ type: 'export.cancel', task_id: task, operation_id: operation.id })
    expect(server.exchanges).toHaveLength(afterProduction)
    expect(collators.length).toBeGreaterThanOrEqual(2)
    expect(new Set(collators.map(({ snapshot }) => snapshot.batch.run_id)).size).toBeGreaterThanOrEqual(2)
    for (const { request, snapshot } of collators) {
      expect(Buffer.byteLength(request)).toBeLessThanOrEqual(RUNNER_LIMITS.index.page_bytes)
      expect(request).not.toMatch(/BODY_SENTINEL_|ALPHA_FINAL_ANSWER|BETA_FINAL_ANSWER|resource-alpha|resource-beta/)
      expect(snapshot.indexes.length).toBeLessThanOrEqual(RUNNER_LIMITS.composition.batch_fragments)
      for (const index of snapshot.indexes) expect(index.bundle_resource_id).toBe(sourceResources.get(index.work_id))
    }
    await page.screenshot({ path: test.info().outputPath('runner-resource-composition-actual-store.png') })
    const live = await call<LiveFlowSnapshot>({ type: 'host.runner.flow', task_id: task })
    expect(Object.values(live.lanes).every(lane => lane.total === 0)).toBe(true)
    await flowTab.click()
    await expect(graph.getByText('当前没有正在执行的工作')).toBeVisible()
    await expect(graph.locator('.flow-card')).toHaveCount(0)
    expect(errors).toEqual([])
  } finally {
    held.alpha?.destroy(); held.beta?.destroy(); alphaLayout?.response.destroy()
    await app.close(); await server.close(); await rm(directory, { recursive: true, force: true })
  }
})
