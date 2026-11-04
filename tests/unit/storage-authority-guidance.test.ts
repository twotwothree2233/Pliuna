import { expect, it } from 'vitest'
import agentTemplate from '../../src/runtime/model/prompts/agent-v0.1.txt?raw'
import { persistenceFacts } from '../../src/runtime/model/host-facts'
import { setup, context, answer } from '../helpers/compaction'
import { assertContract } from '../../src/shared/validation'
it('keeps structural persistence facts separate from the minimal main role', () => {
  expect(persistenceFacts).toEqual({storage:'local-task-store',saved_records:['accepted-messages','submitted-answers','tool-records','installed-summaries'],compaction_deletes_originals:false,restart_resumes_execution:false})
  expect(agentTemplate.trim()).toBe('你是 Trellis 的通用学习与任务助手。\n\n你可以与用户对话，使用当前提供的工具处理任务，并生成学习内容和交互界面。')
})
it('does not manufacture authority facts or authenticate a model claim through summary storage', async () => {
  const s = setup([...context().slice(0, 2), answer('claim', 2, 'Earlier layout was allowed.')])
  await s.run()
  const messages = s.request.mock.calls[0]![2]
  expect(messages.slice(0, -1)).toEqual(s.messages)
  expect(JSON.stringify(messages)).not.toMatch(/host_facts|field_semantics|authorization_guidance/)
  expect(s.install.mock.calls[0]![0].text).toBe('Current goal; result read; continue.')
})
it('keeps execution and delivery independent under the tool result contract', () => {
  const value = { request_type: 'read', execution: 'success', delivery: 'delivered', truncated: false }
  expect(() => assertContract('tool_result', value)).not.toThrow()
  expect(() => assertContract('tool_result', { ...value, delivery: 'failed' })).not.toThrow()
  expect(() => assertContract('tool_result', { ...value, delivery: 'success' })).toThrow()
})
