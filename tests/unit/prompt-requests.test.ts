import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeStore } from '../../src/runtime/store'
import { ModelService } from '../../src/runtime/model/service'
import { modelTools } from '../../src/runtime/model/tools'
import agent from '../../src/runtime/model/prompts/agent-v0.1.txt?raw'
import summary from '../../src/runtime/model/prompts/summary-v0.1.txt?raw'
import approval from '../../src/runtime/model/prompts/approval-v0.1.txt?raw'
import { modelServer, synthetic, textStream, hostToolStream } from '../helpers/model-server'
import { createHash } from 'node:crypto'
import Ajv2020 from 'ajv/dist/2020.js'

const closes: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })
const schema = { type: 'object', properties: { stage: { type: 'string' } }, required: ['stage'], additionalProperties: false }

it('uses exactly the approved role bodies and tool examples, with the approved minimal parameter contracts', () => {
  const hashes = [
    [agent.trim(), '54633633bd755c5bcbe513a213b1b2ad469f970a4dc6f2eafd557df9d28350da'],
    [summary.trim(), '5f71227ee4c3455653788c9480ae9fa522af9ad34b576291abeb9bafb2020416'],
    [approval.trim(), 'b768ec5d4fbcff344611cb9b35072a25236552b3a0b6afa8148566a31b1ca88c'],

  ]
  for (const [text, hash] of hashes) expect(createHash('sha256').update(text!).digest('hex')).toBe(hash)
  expect(modelTools.map(tool => tool.function.name)).toEqual(['list', 'read', 'write', 'call'])
  for (const tool of modelTools) {
    const example = JSON.parse(tool.function.description.split('示例：')[1]!)
    expect(new Ajv2020({ strict: false }).compile(tool.function.parameters as any)(example)).toBe(true)
  }
})

it('captures actual role requests, correction and exact action results without external credentials', async () => {
  const captured: { label: string; body: any }[] = []
  const server = await modelServer(({ body }, res) => {
    if (synthetic(body, res)) return
    const first = body.messages[0].content
    if (first === approval) {
      captured.push({ label: 'approval', body })
      textStream(res, '{"decision":"approve","reason":"This exact replacement matches the request."}'); return
    }
    if (body.messages.at(-1).content === summary) {
      captured.push({ label: 'summary', body })
      textStream(res, 'Keep the updated stage.'); return
    }
    expect(first).toBe(agent)
    const input = JSON.parse(body.messages.findLast((m: any) => m.role === 'user').content)
    captured.push({ label: input.request.startsWith('replace') ? 'replacement' : 'initial', body })
    if (body.messages.at(-1).role === 'tool') { textStream(res, 'The result is recorded.'); return }
    if (input.request.startsWith('replace ')) hostToolStream(res, 'write', { type: 'task_data.replace', id: input.request.slice(8), expected_revision: 1, value: { stage: 'updated' }, references: [] })
    else hostToolStream(res, 'write', { type: 'task_data.create', data: { schema, value: { stage: 'initial' }, references: [] } })
  }); closes.push(server.close)
  const models = new ModelService(); closes.push(() => models.close())
  for (const id of ['main', 'approval']) models.configure({ type: 'model.configure', configuration: { id, base_url: server.url, wire_model_id: 'synthetic-only', context_tokens: 240000, ...(id === 'main' ? { max_output_tokens: 7777 } : {}), compatibility_profile: 'chat-max-tokens' }, api_key: 'synthetic-only', confirm_memory_only: true })
  await models.test('main', 'main'); await models.test('approval', 'approval')
  const store = new RuntimeStore(mkdtempSync(join(tmpdir(), 'trellis-prompt-capture-')), models); closes.push(() => store.close())
  const task = store.create('Prompt regression').task.id
  store.handle({ type: 'approval.configure', mode: 'assisted', model_id: 'approval', confirm_external_processing: true })
  const wait = async (run: string) => {
    const end = Date.now() + 10000
    while (true) {
      const state = store.snapshot(task).runs.find(r => r.id === run)!
      if (!['running', 'waiting'].includes(state.state)) { expect(state.state, state.primary_reason ?? '').toBe('completed'); return }
      if (Date.now() > end) throw Error('Run did not finish')
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }
  await wait(store.start(task, 'create stage', 'main', []))
  const id = store.snapshot(task).task_data.items[0]!.id
  await wait(store.start(task, 'replace ' + id, 'main', []))
  expect(store.handle({ type: 'task.data.read', task_id: task, id, expected_revision: 2 })).toMatchObject({ value: { stage: 'updated' } })
  const compact = store.handle({ type: 'context.compact', task_id: task, model_config_id: 'main', confirm_cost: true }) as any
  await wait(compact.run_id)
  expect(captured.map(e => e.label)).toEqual(['initial', 'initial', 'replacement', 'approval', 'replacement', 'summary'])
  for (const { label, body } of captured) {
    expect(body.model).toBe('synthetic-only')
    if (label === 'approval') expect(body).not.toHaveProperty('max_tokens')
    else expect(body.max_tokens).toBe(7777)
    if (['summary', 'summary-correction', 'approval'].includes(label)) expect(body.tools).toBeUndefined()
    else expect(body.tools).toEqual(modelTools)
    if (label !== 'approval') {
      const context = label.startsWith('summary') ? body.messages[1] : body.messages.find((message: any) => message.role === 'user' && message.content.includes('\"request\"'))
      const input = JSON.parse(context.content)
      const data = input
      for (const field of ['authorization_guidance', 'field_semantics', 'host_facts_source_policy', 'source_lineage_policy', 'previous_summary_notice', 'previous_sources_notice', 'source_format', 'review_notice']) expect(data).not.toHaveProperty(field)
      for (const field of ['host_context','read_permission','host_facts','request_evidence','request_relations','historical_action_facts','execution_identity']) expect(data).not.toHaveProperty(field)
      expect(Object.keys(data)).toEqual(['request'])
    }
  }
  const summaryRequest = captured.at(-1)!.body.messages
  const lastMain = captured.filter(entry => entry.label === 'replacement').at(-1)!.body.messages
  expect(summaryRequest.slice(0, lastMain.length)).toEqual(lastMain)
  expect(summaryRequest.at(-1)).toEqual({ role: 'system', content: summary })
  if (process.env.TRELLIS_PROMPT_CAPTURE) writeFileSync(process.env.TRELLIS_PROMPT_CAPTURE, JSON.stringify(captured, null, 2))
})
