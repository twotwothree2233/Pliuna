import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HostRequest, Snapshot } from '../../src/shared/types'
import { chooseModel, configureModel } from '../helpers/settings-ui'
import { frame, modelServer, synthetic } from '../helpers/model-server'

const executablePath: string = createRequire(import.meta.url)('electron')
interface ProviderMessage { role: string; content: string | null; tool_calls?: unknown[] }

test('default Runner continues the user conversation across messages and app restart', async () => {
  test.setTimeout(90000)
  const firstInput = '解释原子性与一致性的区别。'
  const firstReply = '原子性强调一起完成。示例代号 BLUEBIRD42。'
  const followup = '把刚才的例子改成一句话。'
  const secondReply = 'BLUEBIRD42：原子性让两个写入一起完成。'
  const restoredInput = '继续刚才的话题，重复那个示例代号。'
  const finalReply = '示例代号是 BLUEBIRD42。'
  const replies = new Map([[firstInput, firstReply], [followup, secondReply], [restoredInput, finalReply]])
  const captured: ProviderMessage[][] = [], serverErrors: string[] = [], pageErrors: string[] = []
  const server = await modelServer(({ body }, response) => {
    if (synthetic(body, response)) return
    try {
      const messages: ProviderMessage[] = body.messages
      const user = [...messages].reverse().find(message => message.role === 'user')
      const request = JSON.parse(user?.content ?? '').request
      const reply = replies.get(request)
      if (!reply) throw Error('Unexpected conversation input')
      captured.push(structuredClone(messages))
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(frame({ role: 'assistant', content: JSON.stringify({ kind: 'reply', text: reply }) }) + `data: ${JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 80, completion_tokens: 20 }
      })}\n\n` + 'data: [DONE]\n\n')
    } catch (error) {
      serverErrors.push(error instanceof Error ? error.message : String(error))
      response.writeHead(500); response.end('Conversation fixture failed')
    }
  })
  const directory = await mkdtemp(join(tmpdir(), 'pliuna-runner-conversation-'))
  const env = { ...process.env }
  delete env.PLIUNA_TEST_RUNNER
  delete env.TRELLIS_TEST_RUNNER
  delete env.PLIUNA_TEST_RUNNER_COLLATOR
  delete env.TRELLIS_TEST_RUNNER_COLLATOR
  const launch = () => electron.launch({ executablePath, args: ['.'], env: { ...env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', PLIUNA_TEST_DATA: directory } })
  let app: ElectronApplication | undefined, page!: Page, task = ''
  const call = async <T = unknown,>(request: HostRequest): Promise<T> => page.evaluate(async request => {
    const response = await window.pliuna.request(request)
    if (!response.ok) throw Error(`${response.error.code}: ${response.error.message}`)
    return response.data as T
  }, request)
  const enableModel = async () => {
    await configureModel(page, { id: 'conversation-main', url: server.url, key: 'isolated-conversation-key', model: 'conversation-wire', context: 100000, output: 2048 })
    await call({ type: 'model.test', model_id: 'conversation-main', role: 'main', confirm_cost: true })
    await chooseModel(page, 'conversation-main')
  }
  const observePage = async () => {
    page = await app!.firstWindow()
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.setViewportSize({ width: 1440, height: 960 })
  }
  const assertConversation = (messages: ProviderMessage[], expected: { role: string; text: string }[]) => {
    const actual = messages.filter(message => message.role !== 'system')
    expect(actual).toHaveLength(expected.length)
    expected.forEach((message, index) => {
      expect(actual[index]!.role).toBe(message.role)
      expect(actual[index]!.content).toContain(message.text)
      expect(actual[index]!.tool_calls).toBeUndefined()
    })
  }
  try {
    app = await launch(); await observePage(); await enableModel()
    await page.getByRole('button', { name: '创建第一个任务', exact: true }).click()
    await page.getByLabel('任务名称').fill('连续对话验收')
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    task = (await call<{ id: string }[]>({ type: 'host.tasks' }))[0]!.id
    const snapshot = () => call<Snapshot>({ type: 'task.snapshot', task_id: task })
    const send = async (text: string, reply: string, count: number) => {
      await page.getByLabel('想从哪里开始？').fill(text)
      await page.getByRole('button', { name: '发送消息', exact: true }).click()
      await expect(page.locator('#pane-right').getByRole('region', { name: '任务对话', exact: true })).toContainText(reply)
      await expect.poll(async () => (await snapshot()).runs.filter(run => run.state === 'completed').length).toBe(count)
      await expect(page.getByRole('main')).not.toContainText(reply)
      await expect(page.getByRole('main').getByRole('heading', { name: '尚无已发布内容', exact: true })).toBeVisible()
      await expect(page.getByRole('main').locator('.managed, .task-reply, .runner-working-copy, .runner-goals')).toHaveCount(0)
      expect((await snapshot()).views).toHaveLength(0)
    }
    await send(firstInput, firstReply, 1)
    await send(followup, secondReply, 2)
    expect(captured).toHaveLength(2)
    assertConversation(captured[1]!, [
      { role: 'user', text: firstInput },
      { role: 'assistant', text: firstReply },
      { role: 'user', text: followup }
    ])
    expect((await snapshot()).runner?.goals).toHaveLength(0)
    await app.close(); app = await launch(); await observePage()
    await page.getByRole('button', { name: /连续对话验收/ }).click()
    await expect(page.locator('#pane-right').getByRole('region', { name: '任务对话', exact: true })).toContainText(secondReply)
    expect(captured).toHaveLength(2)
    await enableModel()
    await send(restoredInput, finalReply, 3)
    expect(captured).toHaveLength(3)
    assertConversation(captured[2]!, [
      { role: 'user', text: firstInput },
      { role: 'assistant', text: firstReply },
      { role: 'user', text: followup },
      { role: 'assistant', text: secondReply },
      { role: 'user', text: restoredInput }
    ])
    expect(serverErrors).toEqual([])
    expect(pageErrors).toEqual([])
  } catch (error) {
    const snapshot = task ? await call<Snapshot>({ type: 'task.snapshot', task_id: task }).catch(() => null) : null
    await test.info().attach('conversation-failure', { body: JSON.stringify({ captured, serverErrors, snapshot }, null, 2), contentType: 'application/json' })
    throw error
  } finally {
    if (app) {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy())).catch(() => {})
      await app.close().catch(() => {})
    }
    await server.close(); await rm(directory, { recursive: true, force: true })
  }
})
