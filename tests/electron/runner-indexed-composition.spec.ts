import { _electron as electron, expect, test } from '@playwright/test'
import type { ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { configureModel, chooseTheme } from '../helpers/settings-ui'
import { frame, modelInputFromHost, modelServer, synthetic } from '../helpers/model-server'
import type { Bundle } from '../../src/shared/contracts.generated'
import type { ArtifactCandidate, ArtifactIndex, CompositionBatch, ExecutionScope, GoalRevision, HostRequest, Outline, OutlineSection, RunnerProjection, Snapshot, WorkDependency } from '../../src/shared/types'

const require = createRequire(import.meta.url), executablePath: string = require('electron')
type RunnerLimits = typeof import('../../src/runtime/runner/limits').RUNNER_LIMITS

function complete(response: ServerResponse, delta: object, finish: 'stop' | 'tool_calls') {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(frame({ role: 'assistant', ...delta }) + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 400, completion_tokens: 80 } })}\n\n` + 'data: [DONE]\n\n')
}
function textStream(response: ServerResponse, text: string) { complete(response, { content: text }, 'stop') }
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

test('controlled dual goals keep approval, final answers and immutable input reconciliation separate', async () => {
  test.setTimeout(90000)
  let alphaData = ''
  const toolResults: unknown[] = []
  const held: { beta: ServerResponse | null; corrected: ServerResponse | null } = { beta: null, corrected: null }
  const server = await modelServer(({ body }, response) => {
    if (synthetic(body, response)) return
    const messages = JSON.stringify(body.messages)
    if (messages.includes('BETA_CORRECTED')) { held.corrected = response; return }
    if (messages.includes('GOAL_BETA')) { held.beta = response; return }
    if (messages.includes('GOAL_ALPHA')) {
      const last = body.messages.at(-1)
      if (last.role === 'tool') toolResults.push({ id: last.tool_call_id, result: JSON.parse(last.content) })
      if (last.role !== 'tool') {
        hostToolStream(response, 'write', { type: 'task_data.create', data: { schema: { type: 'string' }, value: 'ALPHA_SAVED_ORIGINAL', references: [] } }, '', 'alpha-create')
      } else if (last.tool_call_id === 'alpha-create') {
        const result = JSON.parse(last.content)
        expect(result).toMatchObject({ execution: 'success', data: { id: expect.any(String) } })
        alphaData = result.data.id
        hostToolStream(response, 'write', { type: 'task_data.remove', id: alphaData, expected_revision: 1 }, '', 'alpha-remove')
      } else textStream(response, 'ALPHA_FINAL_AFTER_APPROVAL')
      return
    }
    response.writeHead(400); response.end('Unexpected isolated runner input')
  })
  const directory = await mkdtemp(join(tmpdir(), 'pliuna-runner-desktop-'))
  const app = await electron.launch({ executablePath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', PLIUNA_TEST_DATA: directory, PLIUNA_TEST_RUNNER: 'dual' } })
  try {
    const page = await app.firstWindow(), errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewportSize({ width: 1440, height: 960 })
    const agent = page.locator('#pane-right'), center = page.getByRole('main')
    const call = async <T,>(request: HostRequest): Promise<T> => page.evaluate(async request => {
      const response = await window.pliuna.request(request)
      if (!response.ok) throw Error(response.error.code)
      return response.data as T
    }, request)
    await configureModel(page, { id: 'runner-main', url: server.url, key: 'isolated-runner-key', model: 'runner-wire', context: 100000, output: 4096 })
    await call({ type: 'model.test', model_id: 'runner-main', role: 'main', confirm_cost: true })
    await page.getByRole('button', { name: '创建第一个任务' }).click()
    await page.getByLabel('任务名称').fill('并行目标实际归属验收')
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    const task = (await call<{ id: string }[]>({ type: 'host.tasks' }))[0]!.id
    const input = page.getByLabel('想从哪里开始？'), send = page.getByRole('button', { name: '发送消息', exact: true })
    await input.fill('GOAL_ALPHA：申请删除刚创建的研究记录，保留审批。'); await send.click()
    const goals = agent.getByRole('region', { name: '各目标状态' })
    await expect(goals).toContainText('等待你批准').catch(async error => {
      await test.info().attach('runner-initial-state', { body: JSON.stringify({ snapshot: await call<Snapshot>({ type: 'task.snapshot', task_id: task }), toolResults }, null, 2), contentType: 'application/json' })
      throw error
    })
    await input.fill('GOAL_BETA：整理独立结论。'); await send.click()
    await expect.poll(() => Boolean(held.beta)).toBe(true)
    let status = await call<RunnerProjection>({ type: 'host.runner.status', task_id: task, limit: 16 })
    expect(status.goals).toHaveLength(2)
    const alpha = status.goals.find(goal => goal.title.includes('GOAL_ALPHA'))!, beta = status.goals.find(goal => goal.title.includes('GOAL_BETA'))!
    expect(alpha.waits).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'approval', approval_id: expect.any(String) })]))
    expect(['running', 'waiting']).toContain(beta.run?.state)
    expect(beta.waits.every(wait => wait.reason !== 'approval')).toBe(true)
    const alphaRow = goals.locator(':scope > ul > li').filter({ hasText: 'GOAL_ALPHA' }), betaRow = goals.locator(':scope > ul > li').filter({ hasText: 'GOAL_BETA' })
    await expect(betaRow).toContainText('正在执行')
    await alphaRow.getByRole('button', { name: '查看并处理', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '待处理事项' })).toContainText('移除任务数据')
    await page.getByRole('button', { name: '关闭弹窗', exact: true }).click()
    textStream(held.beta!, 'BETA_FINAL_FIRST：A 等待批准时，B 的结论可提前阅读。'); held.beta = null
    const reply = agent.getByRole('region', { name: '任务回复' })
    await expect(reply).toContainText('BETA_FINAL_FIRST')
    await expect(center).not.toContainText('BETA_FINAL_FIRST')
    await expect(center.locator('.task-reply, .runner-working-copy, .runner-goals')).toHaveCount(0)
    await expect(center.getByRole('heading', { name: '尚无已发布内容', exact: true })).toBeVisible()
    await expect(center.locator('.managed')).toHaveCount(0)
    expect((await call<RunnerProjection>({ type: 'host.runner.status', task_id: task })).goals.find(goal => goal.request_id === alpha.request_id)?.run?.state).toBe('waiting')
    const beforeQuery = server.exchanges.length
    await betaRow.getByRole('button', { name: '查看状态', exact: true }).click()
    status = await call<RunnerProjection>({ type: 'host.runner.status', task_id: task, request_id: beta.request_id, limit: 1 })
    expect(status.goals[0]!.intent_revision).toBe(1)
    expect(server.exchanges).toHaveLength(beforeQuery)
    await app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as any)._invokeHandlers, original = handlers.get('pliuna:request')
      const state = { inputs: [] as unknown[], rejected: false }; (globalThis as any).__runnerCorrectionRejection = state
      handlers.set('pliuna:request', async (event: unknown, request: HostRequest) => {
        if (request.type === 'host.runner.input' && request.kind === 'correction') {
          state.inputs.push(structuredClone(request))
          if (!state.rejected) {
            state.rejected = true
            return { ok: false, error: { code: 'INVALID_INPUT', message: 'Correction input requires nonempty bounded text' } }
          }
        }
        return original(event, request)
      })
    })
    await betaRow.getByRole('button', { name: '纠正目标', exact: true }).click()
    const correction = betaRow.getByLabel('修改此目标的要求')
    await correction.fill('汉'.repeat(90000))
    await betaRow.getByRole('button', { name: '保存目标修改', exact: true }).click()
    await expect(betaRow).toContainText('目标修改过长，请缩短后再提交')
    await expect(correction).toBeEnabled()
    await expect(betaRow.getByRole('button', { name: '返回', exact: true })).toBeVisible()
    expect(await page.evaluate(({ task, request }) => localStorage.getItem(`pliuna.runner-input:${task}:${request}`), { task, request: beta.request_id })).toBeNull()
    expect(await app.evaluate(() => (globalThis as any).__runnerCorrectionRejection.inputs.length)).toBe(0)
    expect((await call<RunnerProjection>({ type: 'host.runner.status', task_id: task, request_id: beta.request_id, limit: 1 })).goals[0]!.intent_revision).toBe(1)
    await correction.fill('BETA_CORRECTED：增加事实年份。')
    await betaRow.getByRole('button', { name: '保存目标修改', exact: true }).click()
    await expect(betaRow).toContainText('操作尚未接收。请修改后重新提交。')
    await expect(correction).toBeEnabled()
    await expect(correction).toHaveValue('BETA_CORRECTED：增加事实年份。')
    await expect(betaRow.getByRole('button', { name: '返回', exact: true })).toBeVisible()
    expect(await page.evaluate(({ task, request }) => localStorage.getItem(`pliuna.runner-input:${task}:${request}`), { task, request: beta.request_id })).toBeNull()
    expect((await call<RunnerProjection>({ type: 'host.runner.status', task_id: task, request_id: beta.request_id, limit: 1 })).goals[0]!.intent_revision).toBe(1)
    await correction.fill('BETA_CORRECTED：增加事实年份与来源。')
    await betaRow.getByRole('button', { name: '保存目标修改', exact: true }).click()
    await expect.poll(() => Boolean(held.corrected)).toBe(true)
    const corrections = await app.evaluate(() => (globalThis as any).__runnerCorrectionRejection.inputs) as Extract<HostRequest, { type: 'host.runner.input' }>[]
    expect(corrections).toHaveLength(2)
    expect(corrections[0]!.input_event_id).not.toBe(corrections[1]!.input_event_id)
    await expect(reply).not.toContainText('BETA_FINAL_FIRST')
    status = await call<RunnerProjection>({ type: 'host.runner.status', task_id: task })
    expect(status.goals.find(goal => goal.request_id === alpha.request_id)).toMatchObject({ intent_revision: 1, run: { id: alpha.run!.id, state: 'waiting' } })
    expect(status.goals.find(goal => goal.request_id === beta.request_id)).toMatchObject({ intent_revision: 2 })
    textStream(held.corrected!, 'BETA_FINAL_CORRECTED：当前修订的最终结论。'); held.corrected = null
    await expect(reply).toContainText('BETA_FINAL_CORRECTED')
    await expect(center).not.toContainText('BETA_FINAL_CORRECTED')
    const currentBeta = (await call<RunnerProjection>({ type: 'host.runner.status', task_id: task })).goals.find(goal => goal.request_id === beta.request_id)!
    const saved = await call<{ data: { payload: { purpose: string; text: string; request_id: string; intent_revision: number } } }>({ type: 'task.query', task_id: task, query: { type: 'read', input: { target: { kind: 'event', id: currentBeta.reply!.id } } } })
    expect(saved.data.payload).toMatchObject({ purpose: 'final_answer', request_id: beta.request_id, intent_revision: 2, text: 'BETA_FINAL_CORRECTED：当前修订的最终结论。' })
    // Lose the first accepted cancellation receipt at the real Electron IPC boundary.
    await app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as any)._invokeHandlers, original = handlers.get('pliuna:request')
      const state = { inputs: [] as unknown[], lost: false }; (globalThis as any).__runnerInputReconciliation = state
      handlers.set('pliuna:request', async (event: unknown, request: HostRequest) => {
        if (request.type === 'host.runner.input') state.inputs.push(structuredClone(request))
        const result = await original(event, request)
        if (request.type === 'host.runner.input' && request.kind === 'cancel_run' && result.ok && !state.lost) {
          state.lost = true
          return { ok: false, error: { code: 'CONNECTION_LOST', message: 'Isolated accepted input receipt was lost' } }
        }
        return result
      })
    })
    await alphaRow.getByRole('button', { name: '停止此目标', exact: true }).click()
    await alphaRow.getByRole('button', { name: '确认停止此目标', exact: true }).click()
    await expect(alphaRow.getByRole('button', { name: '核对原操作', exact: true })).toBeVisible()
    await alphaRow.getByRole('button', { name: '核对原操作', exact: true }).click()
    await expect(alphaRow).toContainText('执行已停止')
    const cancellations = await app.evaluate(() => (globalThis as any).__runnerInputReconciliation.inputs) as Extract<HostRequest, { type: 'host.runner.input' }>[]
    expect(cancellations).toHaveLength(2)
    expect(cancellations[0]).toEqual(cancellations[1])
    expect(cancellations[0]).toMatchObject({ kind: 'cancel_run', task_id: task, request_id: alpha.request_id, run_id: alpha.run!.id })
    expect((await call<RunnerProjection>({ type: 'host.runner.status', task_id: task })).goals.find(goal => goal.request_id === beta.request_id)?.reply?.id).toBe(currentBeta.reply!.id)
    await alphaRow.getByRole('button', { name: '撤回目标', exact: true }).click()
    await expect(alphaRow).toContainText('已发布内容继续保留')
    expect((await call<RunnerProjection>({ type: 'host.runner.status', task_id: task })).goals.find(goal => goal.request_id === alpha.request_id)?.state).toBe('active')
    await alphaRow.getByRole('button', { name: '确认撤回目标', exact: true }).click()
    await expect(alphaRow).toContainText('已退出当前成稿范围')
    const snapshot = await call<Snapshot>({ type: 'task.snapshot', task_id: task })
    expect(snapshot.runner?.scope?.required_goal_count).toBe(1)
    expect(snapshot.task_data.total).toBe(1)
    await expect(reply).toContainText('BETA_FINAL_CORRECTED')
    for (const theme of ['graphite', 'midnight']) {
      await chooseTheme(page, theme)
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 960 })
        // ResizeObserver must install the new docking state before we decide
        // whether the Agent drawer needs to be opened.
        const rightDock = page.locator('[role="separator"][aria-controls="pane-right"]')
        if (width === 1440) await expect(rightDock).toBeVisible()
        else await expect(rightDock).toBeHidden()
        if (await page.locator('#pane-right').isHidden()) await page.locator('#toggle-right').click()
        await expect(goals).toBeVisible()
        await expect(reply).toContainText('BETA_FINAL_CORRECTED')
        await expect(center.locator('.task-reply, .runner-working-copy, .runner-goals')).toHaveCount(0)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        expect(await page.locator('.agent').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
      }
      await page.setViewportSize({ width: 1440, height: 960 })
    }
    await page.screenshot({ path: test.info().outputPath('runner-goals-actual-store.png') })
    expect(errors).toEqual([])
  } finally {
    held.beta?.destroy(); held.corrected?.destroy()
    await app.close(); await server.close(); await rm(directory, { recursive: true, force: true })
  }
})

interface ProducerBinding {
  owner: ExecutionScope
  plan_revision: number
  dependencies: WorkDependency[]
  goal: GoalRevision
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
      textStream(response, JSON.stringify(plan)); return
    }
    const current = [...body.messages].reverse().find((message: any) => message.role === 'user')
    const request = JSON.parse(current.content).request as string
    const name = request.includes('RESOURCE_ALPHA') ? 'ALPHA' : request.includes('RESOURCE_BETA') ? 'BETA' : null
    if (!name) { response.writeHead(400); response.end('Unexpected isolated composition input'); return }
    const last = body.messages.at(-1)
    if (last.role !== 'tool') { held[name === 'ALPHA' ? 'alpha' : 'beta'] = response; return }
    const result = JSON.parse(last.content)
    expect(result).toMatchObject({ execution: 'success', data: { id: expect.any(String) } })
    const resource = result.data.id as string
    sourceResources.set(name, resource)
    const system = body.messages.find((message: any) => message.role === 'system' && message.content.includes('Bound data: ')).content as string
    const binding = JSON.parse(system.slice(system.indexOf('Bound data: ') + 'Bound data: '.length)) as ProducerBinding
    const { owner, dependencies, plan_revision, sections, requirement_ids } = binding, section = sections[0]!
    if (owner.purpose !== 'production') throw Error('Expected real production source')
    const candidate: ArtifactCandidate = {
      candidate_id: `candidate-${name.toLowerCase()}`, task_id: owner.task_id, request_id: owner.request_id, intent_revision: owner.intent_revision,
      run_id: owner.run_id, work_id: owner.work_id, attempt_id: owner.attempt_id, artifact_id: `artifact-${name.toLowerCase()}`, base_artifact_revision: 0,
      plan_revision, bundle_resource_id: resource, section_id: section.section_id, section_position_revision: section.position_revision, order_key: section.order_key,
      presentation_kind: 'managed-v1', width_constraint: 'full', interaction_kind: 'none', provenance_ref: { task_id: owner.task_id, kind: 'resource', id: resource },
      requirement_ids, unresolved: [], dependencies
    }
    textStream(response, JSON.stringify({ version: 1, complete: true, answer: `${name}_FINAL_ANSWER`, artifacts: [candidate], requirement_ids, unresolved: [] }))
  })
  const directory = await mkdtemp(join(tmpdir(), 'pliuna-indexed-resource-desktop-'))
  const app = await electron.launch({ executablePath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', PLIUNA_TEST_DATA: directory, PLIUNA_TEST_RUNNER: 'dual', PLIUNA_TEST_RUNNER_COLLATOR: 'model' } })
  try {
    const page = await app.firstWindow(), errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewportSize({ width: 1440, height: 960 })
    const agent = page.locator('#pane-right'), center = page.getByRole('main')
    const workingCopy = agent.getByRole('region', { name: '当前成稿状态' })
    const reply = agent.getByRole('region', { name: '任务回复' })
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
    createResource(held.alpha!, 'ALPHA'); held.alpha = null
    const snapshot = () => call<Snapshot>({ type: 'task.snapshot', task_id: task })
    const publishThroughHost = async (count: number) => {
      await expect.poll(async () => {
        const current = await snapshot()
        for (const approval of current.approvals.filter(approval => approval.decision === 'pending' && approval.validity === 'valid')) {
          await call({ type: 'approval.decide', task_id: task, approval_id: approval.id, decision: 'approve' })
        }
        for (const update of (await snapshot()).surface_updates) {
          await call({ type: 'surface.respond', task_id: task, action_id: update.action_id, proceed: true, confirm_discard: false })
        }
        return (await snapshot()).views.length
      }, { timeout: 30000, intervals: [100, 200, 500] }).toBe(count)
      return snapshot()
    }
    const first = await publishThroughHost(1), alpha = first.views[0]!
    await expect(center.getByRole('heading', { name: 'ALPHA_PUBLISHED', exact: true })).toBeVisible()
    await expect(center.getByRole('heading', { name: 'BETA_PUBLISHED', exact: true })).toHaveCount(0)
    await expect(center.getByRole('heading', { name: '尚无已发布内容', exact: true })).toHaveCount(0)
    await expect(workingCopy).toContainText('渐进工作版')
    await expect(reply).toContainText('ALPHA_FINAL_ANSWER')
    await expect(center).not.toContainText('ALPHA_FINAL_ANSWER')
    await expect(center.locator('.task-reply, .runner-working-copy, .runner-goals')).toHaveCount(0)
    expect(first.runner?.scope).toMatchObject({ required_goal_count: 2, published_count: 1 })
    expect(first.runner!.scope!.unresolved_count).toBeGreaterThan(0)
    expect(first.runner!.scope!.state).not.toBe('complete')
    expect(held.beta).not.toBeNull()
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
    createResource(held.beta!, 'BETA'); held.beta = null
    const complete = await publishThroughHost(2)
    await expect(center.getByRole('heading', { name: 'BETA_PUBLISHED', exact: true })).toBeVisible()
    await expect(center.getByRole('heading', { name: 'ALPHA_PUBLISHED', exact: true })).toBeVisible()
    await expect(workingCopy).toContainText('当前成稿已完整')
    const beta = complete.runner!.goals.find(goal => goal.title.startsWith('RESOURCE_BETA'))!
    await reply.getByRole('combobox', { name: '选择目标' }).selectOption(beta.request_id)
    await expect(reply).toContainText('BETA_FINAL_ANSWER')
    await expect(center).not.toContainText('BETA_FINAL_ANSWER')
    await expect(center.locator('.task-reply, .runner-working-copy, .runner-goals')).toHaveCount(0)
    expect(complete.surface.id).toBe(first.surface.id)
    expect(complete.surface.revision).toBeGreaterThan(first.surface.revision)
    expect(complete.views.find(view => view.id === alpha.id)).toMatchObject({ id: alpha.id, revision: alpha.revision, state_revision: alpha.state_revision, bundle: alpha.bundle })
    expect(complete.runner?.scope).toMatchObject({ state: 'complete', required_goal_count: 2, unresolved_count: 0, pending_update_count: 0, published_count: 2 })
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
      for (const index of snapshot.indexes) expect(index.bundle_resource_id).toBe(sourceResources.get(index.artifact_id === 'artifact-alpha' ? 'ALPHA' : 'BETA'))
    }
    await page.screenshot({ path: test.info().outputPath('runner-resource-composition-actual-store.png') })
    expect(errors).toEqual([])
  } finally {
    held.alpha?.destroy(); held.beta?.destroy()
    await app.close(); await server.close(); await rm(directory, { recursive: true, force: true })
  }
})
