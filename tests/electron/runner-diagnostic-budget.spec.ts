import { _electron as electron, expect, test } from '@playwright/test'
import type { ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { frame, modelServer, synthetic } from '../helpers/model-server'
import type { HostRequest, RunnerProjection, Snapshot } from '../../src/shared/types'

const executablePath: string = createRequire(import.meta.url)('electron')
function complete(response: ServerResponse, delta: object, finish: 'stop' | 'tool_calls') {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(frame({ role: 'assistant', ...delta }) + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 5500, completion_tokens: 500 } })}\n\n` + 'data: [DONE]\n\n')
}

test('production exceeds the former request and token limits alongside a bounded diagnostic on desktop', async () => {
  test.setTimeout(60000)
  let producerRequests = 0, diagnosticOutput: number | undefined, producerOutput: number | undefined
  let diagnostic: { response: ServerResponse; metadata: { reason: string; calls: { record_id: string }[] } } | undefined
  let producer: ServerResponse | undefined
  const server = await modelServer(({ body }, response) => {
    if (synthetic(body, response)) return
    if (body.messages[0]?.content.startsWith('You diagnose')) {
      diagnosticOutput = body.max_tokens
      diagnostic = { response, metadata: JSON.parse(body.messages[1].content) }
      return
    }
    producerRequests++
    producerOutput = body.max_tokens
    if (producerRequests <= 40) {
      complete(response, { tool_calls: [{ index: 0, id: `inspect-${producerRequests}`, type: 'function', function: { name: 'list', arguments: JSON.stringify({ kind: 'task_data' }) } }] }, 'tool_calls')
    } else producer = response
  })
  const directory = await mkdtemp(join(tmpdir(), 'pliuna-diagnostic-budget-desktop-'))
  const app = await electron.launch({ executablePath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', PLIUNA_TEST_DATA: directory, PLIUNA_TEST_RUNNER: 'dual' } })
  try {
    const page = await app.firstWindow(), errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const agent = page.locator('#pane-right'), center = page.getByRole('main')
    const call = async <T,>(request: HostRequest): Promise<T> => page.evaluate(async request => {
      const response = await window.pliuna.request(request)
      if (!response.ok) throw Error(`${response.error.code}: ${response.error.message}`)
      return response.data as T
    }, request)
    await call({ type: 'model.configure', configuration: { id: 'large-output', base_url: server.url, wire_model_id: 'synthetic', context_tokens: 1000000, max_output_tokens: 131072, compatibility_profile: 'chat-max-tokens' }, api_key: 'isolated-diagnostic-key', confirm_memory_only: true })
    await call({ type: 'model.test', model_id: 'large-output', role: 'main', confirm_cost: true })
    await page.getByRole('button', { name: '创建第一个任务', exact: true }).click()
    await page.getByLabel('任务名称').fill('累计限制移除回归')
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    const task = (await call<{ id: string }[]>({ type: 'host.tasks' }))[0]!.id
    await page.getByLabel('想从哪里开始？').fill('BUDGET_REGRESSION：持续调用后完成正文，记录所有用量。')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect.poll(() => Boolean(diagnostic && producer), { timeout: 20000 }).toBe(true)
    expect(diagnosticOutput).toBe(4096)
    expect(producerOutput).toBe(131072)
    expect(producerRequests).toBe(41)
    const pending = (await call<RunnerProjection>({ type: 'host.runner.status', task_id: task })).goals[0]!
    expect(['running', 'waiting']).toContain(pending.run?.state)
    const held = diagnostic!
    complete(held.response, { content: JSON.stringify({ version: 1, assessment: held.metadata.reason, evidence_record_ids: [held.metadata.calls.at(-1)!.record_id], recommendation: 'review_goal', automatic_replay: false, execution_permission: false, recovery_permission: false }) }, 'stop')
    diagnostic = undefined
    await expect.poll(async () => (await call<Snapshot>({ type: 'task.snapshot', task_id: task })).records.some(record => record.kind === 'runner.progress.diagnostic.result')).toBe(true)
    complete(producer!, { content: 'BUDGET_REGRESSION_FINAL：正文在诊断并发时正常完成。' }, 'stop')
    producer = undefined
    await expect.poll(async () => (await call<RunnerProjection>({ type: 'host.runner.status', task_id: task })).goals[0]?.run?.state).toBe('completed')
    await expect(agent.getByRole('region', { name: '任务回复' })).toContainText('BUDGET_REGRESSION_FINAL')
    await expect(agent.getByRole('region', { name: '各目标状态' })).not.toContainText('正在结束执行')
    await expect(center).not.toContainText('BUDGET_REGRESSION_FINAL')
    await expect(center.locator('.task-reply, .runner-working-copy, .runner-goals')).toHaveCount(0)
    await expect(center.getByRole('heading', { name: '尚无已发布内容', exact: true })).toBeVisible()
    await expect(center.locator('.managed')).toHaveCount(0)
    expect(errors).toEqual([])
  } finally {
    diagnostic?.response.destroy(); producer?.destroy()
    await app.close(); await server.close(); await rm(directory, { recursive: true, force: true })
  }
})
