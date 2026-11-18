import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Bundle } from '../../src/shared/contracts.generated'
import type { ArtifactCandidate, ArtifactIndex, CompositionBatch, ExecutionScope, GoalRevision, HostRequest, Outline, OutlineSection, Snapshot, WorkDependency } from '../../src/shared/types'
import { chooseModel, configureModel } from '../helpers/settings-ui'
import { frame, modelServer, synthetic } from '../helpers/model-server'

const executablePath: string = createRequire(import.meta.url)('electron')
interface ProducerBinding { owner: ExecutionScope; plan_revision: number; dependencies: WorkDependency[]; goal: GoalRevision; requirement_ids: string[]; sections: OutlineSection[] }
interface CollatorBinding { batch: CompositionBatch; outline: Outline; indexes: ArtifactIndex[] }
interface ProviderMessage { role: string; content: string | null; tool_calls?: unknown[] }

function complete(response: ServerResponse, delta: object, finish: 'stop' | 'tool_calls' = 'stop') {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(frame({ role: 'assistant', ...delta }) + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: 50 } })}\n\n` + 'data: [DONE]\n\n')
}
async function unusedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

for (const mode of ['wrapped valid', 'malformed', 'repeated invalid tool', 'unresolved'] as const) test(`Web routes ${mode} production output through acceptance`, async () => {
  test.setTimeout(90000)
  const malformed = mode === 'malformed', repeatedInvalidTool = mode === 'repeated invalid tool', unresolvedWork = mode === 'unresolved'
  const reply = '已生成多臂老虎机讲义，可在内容区阅读。'
  const prefix = '我已将讲义制作成一个独立的 managed-v1 视图。'
  const unresolvedReply = '内容未发布。' + '资源校验失败，所需内容尚未完成。'.repeat(20)
  const initial = '生成多臂老虎机的讲义。', followup = '继续解释探索和利用。', secondReply = '探索收集信息，利用选择当前最优臂。'
  const bundle: Bundle = {
    profile: 'managed-v1', html: String.raw`<section id="lecture"><h2>BANDIT_PUBLISHED_LECTURE</h2><p data-label="quoted">探索与利用之间存在权衡。路径 C:\notes\bandit。</p></section>`, css: String.raw`#lecture p::after{content:" \\path";}`,
    state: { schema: { type: 'object', properties: {}, additionalProperties: false }, initial: {}, compatibility_version: 'static-v1' },
    forms: [], behaviors: [], references: [], export: [{ id: 'lecture', category: 'learning', source: { type: 'element', element_id: 'lecture' } }]
  }
  const errors: string[] = [], pageErrors: string[] = [], histories: ProviderMessage[][] = []
  let createdResource: string | undefined
  let bundleWrites = 0, producedResults = 0
  let rejectedRequests = 0, rejectionFeedbackReceived = false
  const server = await modelServer(({ body }, response) => {
    if (synthetic(body, response)) return
    try {
      const messages: ProviderMessage[] = body.messages, system = messages[0]!.content ?? ''
      if (system.startsWith('You are the Collator.')) {
        const { batch, outline, indexes } = JSON.parse(messages.find(message => message.role === 'user')!.content!) as CollatorBinding
        complete(response, { content: JSON.stringify({ task_id: batch.task_id, run_id: batch.run_id, batch_id: batch.batch_id, composition_version: batch.composition_version, intents: indexes.map(index => {
          const section = outline.sections.find(section => section.section_id === index.section_id)!
          return { artifact: { task_id: index.task_id, artifact_id: index.artifact_id, artifact_revision: index.artifact_revision }, section_id: section.section_id, section_position_revision: section.position_revision, order_key: section.order_key, slot_id: 'main', layout_mode: 'column', width_constraint: index.width_constraint }
        }) }) }); return
      }
      const current = [...messages].reverse().find(message => message.role === 'user')
      const request = JSON.parse(current?.content ?? '').request
      if (request === followup) { histories.push(structuredClone(messages)); complete(response, { content: secondReply }); return }
      if (request !== initial) throw Error('Unexpected isolated output-routing input')
      const boundData = system.split('\n').find(line => line.startsWith('Bound data: '))
      if (!boundData) throw Error('Production bound data not found')
      const binding = JSON.parse(boundData.slice('Bound data: '.length)) as ProducerBinding
      const { owner, plan_revision, dependencies, requirement_ids, sections } = binding, section = sections[0]!
      if (owner.purpose !== 'production') throw Error('Production source required')
      if (repeatedInvalidTool) {
        rejectedRequests++
        if (rejectedRequests > 2) throw Error('Unchanged invalid input triggered a third model request')
        if (rejectedRequests === 2) rejectionFeedbackReceived = messages.some(message => message.role === 'tool' && JSON.parse(message.content ?? '{}').error?.code === 'INVALID_REQUEST')
        complete(response, { tool_calls: [{ index: 0, id: `rejected-${rejectedRequests}`, type: 'function', function: { name: 'write', arguments: JSON.stringify({ operation: 'resource.create', input_json: '{"display_name":"lecture","content":}' }) } }] }, 'tool_calls'); return
      }
      if (unresolvedWork) {
        const last = messages.at(-1)!
        if (last.role !== 'tool') {
          bundleWrites++
          complete(response, { tool_calls: [{ index: 0, id: 'create-invalid-bundle', type: 'function', function: { name: 'write', arguments: JSON.stringify({ operation: 'resource.create', input: { display_name: 'invalid-bundle.json', content: { type: 'json', value: { ...bundle, references: [{ kind: 'resource', id: 'unpublished-source', name: 'source' }] } } } }) } }] }, 'tool_calls'); return
        }
        const tool = JSON.parse(last.content!)
        if (tool.error?.code !== 'INVALID_REQUEST' || !tool.error.message.includes('data/references/0')) throw Error('Invalid bundle reference diagnostics were not returned to the worker')
        rejectionFeedbackReceived = true
        const unresolved = requirement_ids.map(requirement_id => ({ task_id: owner.task_id, request_id: owner.request_id, intent_revision: owner.intent_revision, requirement_id }))
        producedResults++
        complete(response, { content: JSON.stringify({ version: 1, complete: true, answer: unresolvedReply, artifacts: [], requirement_ids: [], unresolved }) }); return
      }
      if (!createdResource) {
        const last = messages.at(-1)!
        if (last.role !== 'tool') {
          bundleWrites++
          complete(response, { tool_calls: [{ index: 0, id: 'create-lecture-bundle', type: 'function', function: { name: 'write', arguments: JSON.stringify({ operation: 'resource.create', input: { display_name: 'bandit-lecture.json', content: { type: 'json', value: bundle } } }) } }] }, 'tool_calls'); return
        }
        const tool = JSON.parse(last.content!)
        if (tool.execution !== 'success' || typeof tool.data?.id !== 'string') throw Error('Synthetic bundle was not created')
        createdResource = tool.data.id
      }
      const resourceId = createdResource
      if (!resourceId) throw Error('Synthetic bundle resource is missing')
      const candidate: ArtifactCandidate = {
        task_id: owner.task_id, request_id: owner.request_id, run_id: owner.run_id, work_id: owner.work_id, attempt_id: owner.attempt_id, intent_revision: owner.intent_revision,
        artifact_id: 'bandit-lecture', candidate_id: 'bandit-lecture-candidate', base_artifact_revision: 0, plan_revision,
        section_id: section.section_id, section_position_revision: section.position_revision, order_key: section.order_key,
        bundle_resource_id: resourceId, presentation_kind: 'managed-v1', width_constraint: 'full', interaction_kind: 'none',
        provenance_ref: { task_id: owner.task_id, kind: 'resource', id: resourceId }, dependencies, requirement_ids, unresolved: [], title: '多臂老虎机讲义'
      }
      const encoded = JSON.stringify({ version: 1, complete: true, answer: reply, artifacts: [candidate], requirement_ids, unresolved: [] })
      const protocol = malformed ? encoded.replace(/"([a-z_]+)":/g, '$1:') : encoded
      producedResults++
      complete(response, { content: `${prefix}\n\n\`\`\`json\n${protocol}\n\`\`\`\n这是内部交付结果。` })
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error)); response.writeHead(500); response.end('Output-routing fixture failed')
    }
  })
  const directory = await mkdtemp(join(tmpdir(), 'pliuna-output-routing-')), port = await unusedPort(), url = `http://127.0.0.1:${port}/`
  let app: ElectronApplication | undefined, page!: Page
  const call = async <T = unknown,>(request: HostRequest): Promise<T> => page.evaluate(async request => {
    const response = await window.pliuna.request(request)
    if (!response.ok) throw Error(`${response.error.code}: ${response.error.message}`)
    return response.data as T
  }, request)
  try {
    app = await electron.launch({ executablePath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', PLIUNA_TEST_DATA: directory, PLIUNA_TEST_RUNNER: 'dual', PLIUNA_TEST_RUNNER_COLLATOR: 'model', PLIUNA_WEB: '1', PLIUNA_WEB_PORT: String(port) } })
    await expect.poll(() => fetch(url).then(response => response.status).catch(() => 0), { timeout: 15000 }).toBe(200)
    const browserWindow = app.waitForEvent('window')
    await app.evaluate(({ BrowserWindow }, url) => { const window = new BrowserWindow({ show: false, width: 1440, height: 960, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } }); void window.loadURL(url) }, url)
    page = await browserWindow
    page.on('pageerror', error => pageErrors.push(error.message))
    const center = page.getByRole('main'), agent = page.locator('#pane-right'), replies = agent.getByRole('region', { name: '任务回复', exact: true })
    await expect(page.getByRole('button', { name: '创建第一个任务', exact: true })).toBeVisible()
    await configureModel(page, { id: 'routing-main', url: server.url, key: 'isolated-routing-key', model: 'routing-wire', context: 100000, output: 4096 })
    await call({ type: 'model.test', model_id: 'routing-main', role: 'main', confirm_cost: true })
    await chooseModel(page, 'routing-main')
    await page.getByRole('button', { name: '创建第一个任务', exact: true }).click()
    await page.getByLabel('任务名称').fill('Output routing')
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    const task = (await call<{ id: string }[]>({ type: 'host.tasks' }))[0]!.id
    const snapshot = () => call<Snapshot>({ type: 'task.snapshot', task_id: task })
    await page.getByLabel('想从哪里开始？').fill(initial)
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    if (unresolvedWork) {
      await expect.poll(async () => (await snapshot()).runs.some(run => run.state === 'completed'), { timeout: 15000 }).toBe(true)
      const unfinished = await snapshot()
      expect(unfinished.views).toHaveLength(0)
      expect(unfinished.runs[0]?.primary_reason).toBe('required_work_settled')
      expect(unfinished.runner?.goals[0]).toMatchObject({ delivery: 'incomplete', artifact_count: 0, unresolved_count: 1 })
      expect(unfinished.runner?.goals[0]?.reply).not.toBeNull()
      expect(unfinished.runner?.scope?.state).not.toBe('complete')
      expect(bundleWrites).toBe(1); expect(producedResults).toBe(1); expect(rejectionFeedbackReceived).toBe(true)
      await expect(replies.locator('.task-reply-text[role="status"]')).toHaveText('本轮已结束，目标尚未完成。')
      await expect(replies).not.toContainText(unresolvedReply)
      await expect(replies).not.toContainText('任务已完成')
      await expect(center.getByRole('heading', { name: '尚无已发布内容', exact: true })).toBeVisible()
    } else if (malformed || repeatedInvalidTool) {
      await expect.poll(async () => (await snapshot()).runs.some(run => run.state === 'failed'), { timeout: 15000 }).toBe(true)
      const failed = await snapshot()
      expect(failed.views).toHaveLength(0)
      expect(failed.runner?.goals[0]?.delivery).toBe('incomplete')
      expect(failed.runner?.goals[0]?.reply).toBeNull()
      expect(failed.runner?.scope?.state).not.toBe('complete')
      expect(failed.task.state).toBe('active')
      if (malformed) {
        expect(failed.runs[0]?.primary_reason).toBe('INVALID_WORKER_RESULT')
        expect(producedResults).toBe(2)
        expect(bundleWrites).toBe(1)
      }
      if (repeatedInvalidTool) {
        expect(failed.runs[0]?.primary_reason).toBe('MODEL_TOOL_NO_PROGRESS')
        expect(rejectedRequests).toBe(2)
        expect(rejectionFeedbackReceived).toBe(true)
        await expect(page.getByLabel('想从哪里开始？')).toBeEnabled()
      }
      await expect(center.getByRole('heading', { name: '尚无已发布内容', exact: true })).toBeVisible()
      await expect(replies).not.toContainText(prefix)
      await expect(replies).not.toContainText('bundle_resource_id')
      await expect(replies).not.toContainText(reply)
    } else {
      await expect.poll(async () => {
        for (const approval of (await snapshot()).approvals.filter(approval => approval.decision === 'pending' && approval.validity === 'valid')) await call({ type: 'approval.decide', task_id: task, approval_id: approval.id, decision: 'approve' })
        for (const update of (await snapshot()).surface_updates) await call({ type: 'surface.respond', task_id: task, action_id: update.action_id, proceed: true, confirm_discard: false })
        return (await snapshot()).views.length
      }, { timeout: 30000, intervals: [100, 200, 500] }).toBe(1)
      await expect(center.getByRole('heading', { name: 'BANDIT_PUBLISHED_LECTURE', exact: true })).toBeVisible()
      await expect(replies).toContainText('任务已完成，内容已发布。')
      await expect(replies).not.toContainText(reply)
      await expect(replies).not.toContainText(prefix)
      await expect(replies).not.toContainText('bundle_resource_id')
      await expect(replies).not.toContainText(createdResource!)
      await expect(center).not.toContainText(reply)
      const published = await snapshot()
      expect(published.runner?.goals[0]?.delivery).toBe('published')
      expect(published.runner?.goals[0]?.artifact_count).toBe(1)
      expect(published.views[0]?.bundle).toMatchObject({ html: bundle.html, css: bundle.css })
      await page.getByLabel('想从哪里开始？').fill(followup)
      await page.getByRole('button', { name: '发送消息', exact: true }).click()
      await expect(replies).toContainText(secondReply)
      expect((await snapshot()).runner?.goals.at(-1)?.artifact_count).toBe(0)
      expect(histories).toHaveLength(1)
      const history = histories[0]!.filter(message => message.role !== 'system')
      expect(history.map(message => message.role)).toEqual(['user', 'assistant', 'user'])
      expect(history[1]!.content).toBe(reply)
      expect(history.every(message => message.tool_calls === undefined)).toBe(true)
    }
    if (repeatedInvalidTool || unresolvedWork) expect(createdResource).toBeUndefined()
    else expect(createdResource).toEqual(expect.any(String))
    expect(errors).toEqual([]); expect(pageErrors).toEqual([])
  } finally {
    if (app) {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy())).catch(() => {})
      await app.close().catch(() => {})
    }
    await server.close(); await rm(directory, { recursive: true, force: true })
  }
})
