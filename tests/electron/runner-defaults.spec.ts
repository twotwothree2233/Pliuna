import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import type { ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HostRequest, Snapshot } from '../../src/shared/types'
import { frame, modelServer, synthetic } from '../helpers/model-server'

const executablePath: string = createRequire(import.meta.url)('electron')
const goalNames = ['ALPHA', 'BETA', 'GAMMA'] as const
type GoalName = typeof goalNames[number]
interface RequestStatus { request_id: string; state: string; run_id: string | null; run_state: string | null }

for (const mode of ['default', 'single', 'legacy'] as const) test(`production entry preserves admission and ownership: ${mode}`, async () => {
  test.setTimeout(60000)
  const directory = await mkdtemp(join(tmpdir(), `pliuna-runner-defaults-${mode}-`))
  const held = new Map<GoalName, ServerResponse>(), arrivals: GoalName[] = [], serverErrors: string[] = []
  let maximumProducerRequests = 0, app: ElectronApplication | undefined
  const server = await modelServer(({ body }, response) => {
    try {
      if (synthetic(body, response)) return
      // The legacy path includes earlier user messages in the same Task.
      const user = [...body.messages].reverse().find(message => message.role === 'user')?.content
      const name = goalNames.find(name => typeof user === 'string' && user.includes(`DEFAULT_GOAL_${name}`))
      if (!name || arrivals.includes(name)) throw Error('Unexpected production request')
      expect(body.model).toBe('fixed-defaults-v1')
      expect(body.max_tokens).toBe(4096)
      arrivals.push(name)
      held.set(name, response)
      maximumProducerRequests = Math.max(maximumProducerRequests, held.size)
    } catch (error) {
      serverErrors.push(error instanceof Error ? error.message : String(error))
      response.writeHead(500)
      response.end('Defaults fixture failed')
    }
  })
  const release = (name: GoalName) => {
    const response = held.get(name)
    expect(response, `The ${name} model request must already be dispatched`).toBeDefined()
    held.delete(name)
    response!.writeHead(200, { 'content-type': 'text/event-stream' })
    response!.end(frame({ role: 'assistant', content: `${name}_FINAL` }) + `data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 30, completion_tokens: 8 }
    })}\n\n` + 'data: [DONE]\n\n')
  }
  const env = { ...process.env }
  delete env.PLIUNA_TEST_RUNNER
  delete env.TRELLIS_TEST_RUNNER
  delete env.PLIUNA_TEST_RUNNER_COLLATOR
  delete env.TRELLIS_TEST_RUNNER_COLLATOR
  if (mode !== 'default') env.PLIUNA_TEST_RUNNER = mode
  try {
    app = await electron.launch({ executablePath, args: ['.'], env: { ...env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', PLIUNA_TEST_DATA: directory } })
    const page = await app.firstWindow(), pageErrors: string[] = []
    page.on('pageerror', error => pageErrors.push(error.message))
    const call = async <T = unknown,>(request: HostRequest): Promise<T> => page.evaluate(async request => {
      const response = await window.pliuna.request(request)
      if (!response.ok) throw Error(response.error.code)
      return response.data as T
    }, request)
    await call({ type: 'model.configure', configuration: { id: 'defaults-main', base_url: server.url, wire_model_id: 'fixed-defaults-v1', context_tokens: 100000, max_output_tokens: 4096, compatibility_profile: 'chat-max-tokens' }, api_key: 'fixed-local-fixture', confirm_memory_only: true })
    await call({ type: 'model.test', model_id: 'defaults-main', role: 'main', confirm_cost: true })
    await page.getByRole('button', { name: '创建第一个任务', exact: true }).click()
    await page.getByLabel('任务名称').fill('默认生产准入验收')
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    const task = (await call<{ id: string }[]>({ type: 'host.tasks' }))[0]!.id
    const requests = new Map<GoalName, string>()
    for (const name of goalNames) {
      const received = await call<RequestStatus>({ type: 'request.submit', task_id: task, text: `DEFAULT_GOAL_${name}：返回独立最终答案。`, model_config_id: 'defaults-main', resource_ids: [], import_ids: [] })
      requests.set(name, received.request_id)
    }
    const status = (name: GoalName) => call<RequestStatus>({ type: 'request.status', task_id: task, request_id: requests.get(name)! })
    const snapshot = () => call<Snapshot>({ type: 'task.snapshot', task_id: task })
    const completed = (name: GoalName) => expect.poll(async () => (await status(name)).run_state, { timeout: 10000 }).toBe('completed')
    const admission = async (active: GoalName[], queued: GoalName[]) => {
      await expect.poll(() => [...held.keys()].sort(), { timeout: 10000 }).toEqual([...active].sort())
      const current = await snapshot()
      expect(current.runs.filter(run => ['running', 'waiting'].includes(run.state))).toHaveLength(active.length)
      for (const name of active) {
        const request = await status(name)
        expect(request).toMatchObject({ state: 'started', run_state: 'running', run_id: expect.any(String) })
        expect(current.runs.find(run => run.id === request.run_id)).toBeDefined()
        if (mode !== 'legacy') expect(current.runner?.goals.find(goal => goal.request_id === request.request_id)?.run).toMatchObject({
          id: request.run_id,
          source: { purpose: 'production', task_id: task, request_id: request.request_id, run_id: request.run_id, intent_revision: 1 }
        })
      }
      for (const name of queued) {
        expect(await status(name)).toMatchObject({ state: 'queued', run_id: null })
        expect(arrivals).not.toContain(name)
      }
      if (mode === 'legacy') expect(current.runner).toBeUndefined()
    }
    if (mode === 'default') {
      await admission(['ALPHA', 'BETA'], ['GAMMA'])
      release('ALPHA')
      await completed('ALPHA')
      // BETA is still held when GAMMA takes the released production slot.
      await admission(['BETA', 'GAMMA'], [])
      release('BETA')
      release('GAMMA')
    } else {
      await admission(['ALPHA'], ['BETA', 'GAMMA'])
      release('ALPHA')
      await completed('ALPHA')
      await admission(['BETA'], ['GAMMA'])
      release('BETA')
      await completed('BETA')
      await admission(['GAMMA'], [])
      release('GAMMA')
    }
    await Promise.all(goalNames.map(completed))
    const final = await snapshot()
    expect(final.runs).toHaveLength(3)
    expect(final.runs.every(run => run.state === 'completed')).toBe(true)
    expect(arrivals.slice().sort()).toEqual([...goalNames].sort())
    expect(maximumProducerRequests).toBe(mode === 'default' ? 2 : 1)
    const plans = final.records.filter(record => record.kind === 'runner.plan.installed')
    const answers = final.records.filter(record => record.kind === (mode === 'legacy' ? 'message.assistant' : 'runner.answer'))
    expect(answers).toHaveLength(3)
    for (const name of goalNames) {
      const request = await status(name)
      expect(answers.find(record => record.payload.run_id === request.run_id)?.payload).toMatchObject({ text: `${name}_FINAL` })
      if (mode !== 'legacy') {
        expect(plans.find(record => record.payload.run_id === request.run_id)?.payload).toMatchObject({ request_id: request.request_id, intent_revision: 1 })
        expect(final.runner?.goals.find(goal => goal.request_id === request.request_id)?.reply).toMatchObject({ purpose: 'final_answer', run_id: request.run_id, request_id: request.request_id })
      }
    }
    if (mode === 'legacy') {
      expect(final.runner).toBeUndefined()
      expect(plans).toHaveLength(0)
      expect(final.records.filter(record => record.kind.startsWith('runner.'))).toHaveLength(0)
    } else {
      expect(final.runner?.goals).toHaveLength(3)
      expect(plans).toHaveLength(3)
    }
    expect(serverErrors).toEqual([])
    expect(pageErrors).toEqual([])
  } finally {
    if (app) {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy())).catch(() => {})
      await app.close().catch(() => {})
    }
    for (const response of held.values()) response.destroy()
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
})
