import { artifactDraft } from '../helpers/producer-draft'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Bundle } from '../../src/shared/contracts.generated'
import type { ArtifactCandidate, ArtifactIndex, CompositionBatch, ExecutionScope, HostRequest, Outline, OutlineSection, Snapshot, WorkDependency } from '../../src/shared/types'
import { chooseModel, configureModel } from '../helpers/settings-ui'
import { frame, modelServer, synthetic } from '../helpers/model-server'

const executablePath: string = createRequire(import.meta.url)('electron')
interface ProviderMessage { role: string; content: string | null; tool_calls?: unknown[] }

async function unusedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

test('Web mode serves a browser bridge and continues a real Task conversation', async () => {
  test.setTimeout(90000)
  const firstInput = '给这个 Web 对话取一个代号。', firstReply = '这个对话的代号是 WEB_ORCHID42。'
  const followup = '重复刚才的代号。', secondReply = 'WEB_ORCHID42。'
  const firstTitle = 'Web 连续对话验收', idleTitle = 'Web 空闲状态验收'
  const replies = new Map([[firstInput, firstReply], [followup, secondReply]])
  const captured: ProviderMessage[][] = [], serverErrors: string[] = [], pageErrors: string[] = []
  let releaseFirst!: () => void
  const firstCompletion = new Promise<void>(resolve => { releaseFirst = resolve })
  const server = await modelServer(async ({ body }, response) => {
    if (synthetic(body, response)) return
    try {
      const messages: ProviderMessage[] = body.messages
      const current = [...messages].reverse().find(message => message.role === 'user')
      const request = JSON.parse(current?.content ?? '').request
      const reply = replies.get(request)
      if (!reply) throw Error('Unexpected Web conversation input')
      captured.push(structuredClone(messages))
      if (request === firstInput) await firstCompletion
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(frame({ role: 'assistant', content: reply }) + `data: ${JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 80, completion_tokens: 20 }
      })}\n\n` + 'data: [DONE]\n\n')
    } catch (error) {
      serverErrors.push(error instanceof Error ? error.message : String(error))
      response.writeHead(500); response.end('Web conversation fixture failed')
    }
  })
  const directory = await mkdtemp(join(tmpdir(), 'pliuna-web-runtime-')), port = await unusedPort()
  const webUrl = `http://127.0.0.1:${port}/`, env = { ...process.env }
  delete env.PLIUNA_TEST_RUNNER; delete env.TRELLIS_TEST_RUNNER
  delete env.PLIUNA_TEST_RUNNER_COLLATOR; delete env.TRELLIS_TEST_RUNNER_COLLATOR
  let app: ElectronApplication | undefined, page!: Page
  const call = async <T = unknown,>(request: HostRequest): Promise<T> => page.evaluate(async request => {
    const response = await window.pliuna.request(request)
    if (!response.ok) throw Error(`${response.error.code}: ${response.error.message}`)
    return response.data as T
  }, request)
  try {
    app = await electron.launch({ executablePath, args: ['.'], env: { ...env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', PLIUNA_TEST_DATA: directory, PLIUNA_WEB: '1', PLIUNA_WEB_PORT: String(port) } })
    await expect.poll(async () => fetch(webUrl).then(response => response.status).catch(() => 0), { timeout: 15000 }).toBe(200)
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible()))).toBe(false)

    // No preload: all workspace operations below must use the injected HTTP bridge.
    const browserWindow = app.waitForEvent('window')
    await app.evaluate(({ BrowserWindow }, url) => {
      const window = new BrowserWindow({ show: false, width: 1440, height: 960, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } })
      void window.loadURL(url)
    }, webUrl)
    page = await browserWindow
    page.on('pageerror', error => pageErrors.push(error.message))
    const bridgeRequests: { type?: string }[] = []
    page.on('request', request => {
      if (request.url() === `${webUrl}_pliuna/request` && request.method() === 'POST') bridgeRequests.push(request.postDataJSON())
    })
    await expect(page.getByRole('button', { name: '创建第一个任务', exact: true })).toBeVisible()
    await expect(page.getByText(/桌面桥接不可用/)).toHaveCount(0)
    expect(await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require)).toBe('undefined')
    expect(await call({ type: 'host.tasks' })).toEqual([])
    await configureModel(page, { id: 'web-main', url: server.url, key: 'isolated-web-key', model: 'web-wire', context: 100000, output: 2048 })
    await call({ type: 'model.test', model_id: 'web-main', role: 'main', confirm_cost: true })
    await chooseModel(page, 'web-main')
    await page.getByRole('button', { name: '创建第一个任务', exact: true }).click()
    await page.getByLabel('任务名称').fill(firstTitle)
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    const task = (await call<{ id: string }[]>({ type: 'host.tasks' }))[0]!.id
    const snapshot = () => call<Snapshot>({ type: 'task.snapshot', task_id: task })
    const badge = page.getByRole('navigation', { name: '当前任务工具栏' }).locator('.badge')
    const taskRow = (title: string) => page.locator('.task-row').filter({ has: page.getByText(title, { exact: true }) })
    await expect(badge).toHaveText('就绪')
    await expect(taskRow(firstTitle).getByLabel('就绪', { exact: true })).toBeVisible()
    const empty = await snapshot()
    expect(empty.runs).toHaveLength(0)
    expect(empty.runner?.goals ?? []).toHaveLength(0)
    const send = async (text: string, reply: string, count: number) => {
      await page.getByLabel('想从哪里开始？').fill(text)
      await page.getByRole('button', { name: '发送消息', exact: true }).click()
      await expect(page.locator('#pane-right').getByRole('region', { name: '任务回复', exact: true })).toContainText(reply)
      await expect.poll(async () => (await snapshot()).runs.filter(run => run.state === 'completed').length).toBe(count)
      await expect(badge).toHaveText('就绪')
      await expect(page.getByRole('main')).not.toContainText(reply)
      await expect(page.getByRole('main').getByRole('heading', { name: '尚无已发布内容', exact: true })).toBeVisible()
      expect((await snapshot()).views).toHaveLength(0)
    }
    await page.getByLabel('想从哪里开始？').fill(firstInput)
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect.poll(() => captured.length).toBe(1)
    await expect(badge).toHaveText('执行中')
    await expect(taskRow(firstTitle).getByLabel('执行中', { exact: true })).toBeVisible()
    expect((await snapshot()).runs.some(run => run.state === 'running')).toBe(true)

    await page.getByRole('button', { name: '＋ 新建', exact: true }).click()
    await page.getByLabel('任务名称').fill(idleTitle)
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    await expect(badge).toHaveText('就绪')
    await expect(taskRow(firstTitle).getByLabel('已开启', { exact: true })).toBeVisible()
    await expect(taskRow(idleTitle).getByLabel('就绪', { exact: true })).toBeVisible()
    await taskRow(firstTitle).click()
    await expect(badge).toHaveText('执行中')
    await expect(taskRow(idleTitle).getByLabel('已开启', { exact: true })).toBeVisible()
    await taskRow(idleTitle).click()
    await expect(badge).toHaveText('就绪')

    releaseFirst()
    await expect.poll(async () => (await snapshot()).runs.filter(run => run.state === 'completed').length).toBe(1)
    await expect(badge).toHaveText('就绪')
    await expect(taskRow(firstTitle).getByLabel('已开启', { exact: true })).toBeVisible()
    await taskRow(firstTitle).click()
    await expect(page.locator('#pane-right').getByRole('region', { name: '任务回复', exact: true })).toContainText(firstReply)
    await expect(badge).toHaveText('就绪')
    await expect(taskRow(firstTitle).getByLabel('就绪', { exact: true })).toBeVisible()
    await send(followup, secondReply, 2)
    expect(captured).toHaveLength(2)
    const history = captured[1]!.filter(message => message.role !== 'system')
    expect(history.map(message => message.role)).toEqual(['user', 'assistant', 'user'])
    expect(history[0]!.content).toContain(firstInput)
    expect(history[1]!.content).toBe(firstReply)
    expect(history[2]!.content).toContain(followup)
    expect(history.every(message => message.tool_calls === undefined)).toBe(true)
    expect(bridgeRequests.some(request => request.type === 'host.tasks')).toBe(true)
    expect(bridgeRequests.filter(request => request.type === 'request.submit')).toHaveLength(2)
    expect(serverErrors).toEqual([]); expect(pageErrors).toEqual([])
  } finally {
    releaseFirst()
    if (app) {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy())).catch(() => {})
      await app.close().catch(() => {})
    }
    await server.close(); await rm(directory, { recursive: true, force: true })
  }
})

test('Web mode corrects an invalid managed resource in the same Worker before publishing', async () => {
  test.setTimeout(90000)
  const initial = '生成一份带学习次数输入框的讲义。', reply = '讲义已生成，可在内容区阅读。'
  const title = 'Web 呈现内容纠正验收', invalidName = 'raw-number-invalid.json', validName = 'raw-number-valid.json'
  const bundle = (count: number | string): Bundle => ({
    profile: 'managed-v1', html: '<section id="lesson"><h2>RAW_DRAFT_RECOVERED</h2><label for="count">学习次数</label><input id="count" type="text"></section>', css: '',
    state: { schema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false }, initial: { count }, compatibility_version: 'raw-number-v1' },
    forms: [], behaviors: [{ type: 'input', element_id: 'count', field: '/count', control: 'number' }], references: [],
    export: [{ id: 'lesson', category: 'learning', source: { type: 'element', element_id: 'lesson' } }]
  })
  interface ProducerBinding { owner: ExecutionScope; plan_revision: number; dependencies: WorkDependency[]; requirement_ids: string[]; sections: OutlineSection[] }
  const bindings: ProducerBinding[] = [], serverErrors: string[] = [], pageErrors: string[] = []
  let rejection: { code: string; message: string } | undefined, resourceId: string | undefined
  let releaseCorrection!: () => void
  const correction = new Promise<void>(resolve => { releaseCorrection = resolve })
  const complete = (response: ServerResponse, delta: object, finish: 'stop' | 'tool_calls' = 'stop') => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(frame({ role: 'assistant', ...delta }) + `data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 200, completion_tokens: 100 }
    })}\n\n` + 'data: [DONE]\n\n')
  }
  const createResource = (response: ServerResponse, count: number | string) => complete(response, {
    tool_calls: [{ index: 0, id: typeof count === 'number' ? 'invalid-raw-number' : 'corrected-raw-number', type: 'function', function: {
      name: 'write', arguments: JSON.stringify({ operation: 'resource.create', input: { display_name: typeof count === 'number' ? invalidName : validName, content: { type: 'json', value: bundle(count) } } })
    } }]
  }, 'tool_calls')
  const server = await modelServer(async ({ body }, response) => {
    if (synthetic(body, response)) return
    try {
      const messages: ProviderMessage[] = body.messages, system = messages[0]!.content ?? ''
      if (system.startsWith('You are the Collator.')) {
        const { batch, outline, indexes } = JSON.parse(messages.find(message => message.role === 'user')!.content!) as { batch: CompositionBatch; outline: Outline; indexes: ArtifactIndex[] }
        complete(response, { content: JSON.stringify({ task_id: batch.task_id, run_id: batch.run_id, batch_id: batch.batch_id, composition_version: batch.composition_version, intents: indexes.map(index => {
          const section = outline.sections.find(section => section.section_id === index.section_id)!
          return { artifact: { task_id: index.task_id, artifact_id: index.artifact_id, artifact_revision: index.artifact_revision }, section_id: section.section_id, section_position_revision: section.position_revision, order_key: section.order_key, slot_id: 'main', layout_mode: 'column', width_constraint: index.width_constraint }
        }) }) }); return
      }
      const current = [...messages].reverse().find(message => message.role === 'user')
      if (JSON.parse(current?.content ?? '').request !== initial || !system.includes('Bound data: ')) throw Error('Unexpected managed resource recovery input')
      const binding = JSON.parse(system.slice(system.indexOf('Bound data: ') + 'Bound data: '.length)) as ProducerBinding
      if (binding.owner.purpose !== 'production') throw Error('Expected production Worker')
      bindings.push(binding)
      if (bindings.length === 1) { createResource(response, 0); return }
      const last = messages.at(-1)!
      if (last.role !== 'tool') throw Error('Expected original Worker tool feedback')
      const result = JSON.parse(last.content!)
      if (bindings.length === 2) {
        expect(result.error).toMatchObject({ code: 'UNSUPPORTED_BUNDLE', message: expect.stringContaining('Invalid raw draft types') })
        rejection = result.error
        await correction
        createResource(response, '0'); return
      }
      if (bindings.length !== 3 || result.execution !== 'success' || typeof result.data?.id !== 'string') throw Error('Corrected managed resource was not created')
      resourceId = result.data.id
      const { owner, plan_revision, dependencies, requirement_ids, sections } = binding, section = sections[0]!
      const candidate: ArtifactCandidate = {
        task_id: owner.task_id, request_id: owner.request_id, run_id: owner.run_id, work_id: owner.work_id, attempt_id: owner.attempt_id, intent_revision: owner.intent_revision,
        artifact_id: 'raw-number-lesson', candidate_id: 'raw-number-candidate', base_artifact_revision: 0, plan_revision,
        section_id: section.section_id, section_position_revision: section.position_revision, order_key: section.order_key,
        bundle_resource_id: resourceId!, presentation_kind: 'managed-v1', width_constraint: 'full', interaction_kind: 'input',
        provenance_ref: { task_id: owner.task_id, kind: 'resource', id: resourceId! }, dependencies, requirement_ids, unresolved: [], title: '学习次数讲义'
      }
      complete(response, { content: JSON.stringify({ version: 1, complete: true, answer: reply, artifacts: [artifactDraft(candidate)], requirement_ids, unresolved: [] }) })
    } catch (error) {
      serverErrors.push(error instanceof Error ? error.message : String(error)); response.writeHead(500); response.end('Managed resource recovery fixture failed')
    }
  })
  const directory = await mkdtemp(join(tmpdir(), 'pliuna-web-managed-recovery-')), port = await unusedPort()
  const webUrl = `http://127.0.0.1:${port}/`, env = { ...process.env }
  delete env.PLIUNA_TEST_RUNNER; delete env.TRELLIS_TEST_RUNNER
  delete env.PLIUNA_TEST_RUNNER_COLLATOR; delete env.TRELLIS_TEST_RUNNER_COLLATOR
  let app: ElectronApplication | undefined, page!: Page
  const call = async <T = unknown,>(request: HostRequest): Promise<T> => page.evaluate(async request => {
    const response = await window.pliuna.request(request)
    if (!response.ok) throw Error(`${response.error.code}: ${response.error.message}`)
    return response.data as T
  }, request)
  try {
    app = await electron.launch({ executablePath, args: ['.'], env: { ...env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', PLIUNA_TEST_DATA: directory, PLIUNA_WEB: '1', PLIUNA_WEB_PORT: String(port) } })
    await expect.poll(() => fetch(webUrl).then(response => response.status).catch(() => 0), { timeout: 15000 }).toBe(200)
    const browserWindow = app.waitForEvent('window')
    await app.evaluate(({ BrowserWindow }, url) => {
      const window = new BrowserWindow({ show: false, width: 1440, height: 960, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } })
      void window.loadURL(url)
    }, webUrl)
    page = await browserWindow
    page.on('pageerror', error => pageErrors.push(error.message))
    await expect(page.getByRole('button', { name: '创建第一个任务', exact: true })).toBeVisible()
    await configureModel(page, { id: 'recovery-main', url: server.url, key: 'isolated-recovery-key', model: 'recovery-wire', context: 100000, output: 4096 })
    await call({ type: 'model.test', model_id: 'recovery-main', role: 'main', confirm_cost: true })
    await chooseModel(page, 'recovery-main')
    await page.getByRole('button', { name: '创建第一个任务', exact: true }).click()
    await page.getByLabel('任务名称').fill(title)
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    const task = (await call<{ id: string }[]>({ type: 'host.tasks' }))[0]!.id
    const snapshot = () => call<Snapshot>({ type: 'task.snapshot', task_id: task })
    const resources = () => call<{ items: { id: string; display_name: string }[] }>({ type: 'task.query', task_id: task, query: { type: 'list', input: { kind: 'resource', limit: 20 } } })
    await page.getByLabel('想从哪里开始？').fill(initial)
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect.poll(() => Boolean(rejection), { timeout: 15000 }).toBe(true)
    const rejected = await snapshot()
    expect(rejected.runs).toHaveLength(1)
    expect(['running', 'waiting']).toContain(rejected.runs[0]!.state)
    expect(rejected.views).toHaveLength(0)
    expect((await resources()).items.some(resource => resource.display_name === invalidName)).toBe(false)
    releaseCorrection()
    await expect.poll(async () => {
      for (const approval of (await snapshot()).approvals.filter(approval => approval.decision === 'pending' && approval.validity === 'valid')) await call({ type: 'approval.decide', task_id: task, approval_id: approval.id, decision: 'approve' })
      for (const update of (await snapshot()).surface_updates) await call({ type: 'surface.respond', task_id: task, action_id: update.action_id, proceed: true, confirm_discard: false })
      return (await snapshot()).views.length
    }, { timeout: 30000, intervals: [100, 200, 500] }).toBe(1)
    const center = page.getByRole('main')
    await expect(center.getByRole('heading', { name: 'RAW_DRAFT_RECOVERED', exact: true })).toBeVisible()
    await expect(center.getByRole('textbox', { name: '学习次数', exact: true })).toHaveValue('0')
    await expect(page.locator('#pane-right').getByRole('region', { name: '任务回复', exact: true })).toContainText('任务已完成，内容已发布。')
    await expect(page.locator('#pane-right').getByRole('region', { name: '任务回复', exact: true })).not.toContainText(reply)
    await expect.poll(async () => (await snapshot()).runner?.goals[0]?.run?.state).toBe('completed')
    const published = await snapshot()
    expect(published.runner?.goals[0]?.delivery).toBe('published')
    expect(published.views[0]!.bundle.state.initial).toEqual({ count: '0' })
    expect(published.views[0]!.draft).toEqual({ count: '0' })
    expect(bindings).toHaveLength(3)
    expect(bindings.every(binding => JSON.stringify(binding.owner) === JSON.stringify(bindings[0]!.owner))).toBe(true)
    expect(published.runs.find(run => run.id === bindings[0]!.owner.run_id)?.state).toBe('completed')
    const created = (await resources()).items
    expect(created.some(resource => resource.display_name === invalidName)).toBe(false)
    expect(created).toContainEqual(expect.objectContaining({ id: resourceId, display_name: validName }))
    expect(serverErrors).toEqual([]); expect(pageErrors).toEqual([])
  } finally {
    releaseCorrection()
    if (app) {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy())).catch(() => {})
      await app.close().catch(() => {})
    }
    await server.close(); await rm(directory, { recursive: true, force: true })
  }
})

test('Web mode exits with a startup error when its loopback port is occupied', async () => {
  test.setTimeout(30000)
  const directory = await mkdtemp(join(tmpdir(), 'pliuna-web-port-occupied-'))
  const occupied = createServer((_request, response) => response.end('Occupied by Web startup fixture'))
  try {
    await new Promise<void>((resolve, reject) => { occupied.once('error', reject); occupied.listen(0, '127.0.0.1', resolve) })
    const port = (occupied.address() as { port: number }).port, env = { ...process.env }
    delete env.PLIUNA_TEST_RUNNER; delete env.TRELLIS_TEST_RUNNER
    delete env.PLIUNA_TEST_RUNNER_COLLATOR; delete env.TRELLIS_TEST_RUNNER_COLLATOR
    const child = spawn(executablePath, ['.'], {
      cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', PLIUNA_TEST_DATA: directory, PLIUNA_WEB: '1', PLIUNA_WEB_PORT: String(port) }
    })
    let output = '', timedOut = false
    child.stdout.on('data', chunk => { output += chunk.toString() })
    child.stderr.on('data', chunk => { output += chunk.toString() })
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    const deadline = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 15000)
    try {
      const result = await closed
      expect(timedOut, `Web startup hung instead of exiting:\n${output}`).toBe(false)
      expect(output).toContain('WEB_START_FAILED')
      expect(result.signal, output).toBe(null)
      expect(result.code, output).toBe(1)
    } finally {
      clearTimeout(deadline)
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed.catch(() => {}) }
    }
  } finally {
    if (occupied.listening) await new Promise<void>((resolve, reject) => occupied.close(error => error ? reject(error) : resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})
