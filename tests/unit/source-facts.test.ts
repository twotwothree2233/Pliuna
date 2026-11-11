import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { extractionCoverage, sourceFacts, sourceFieldLocations, type Provenance } from '../../src/renderer/src/source-facts'
import { RunOutcome } from '../../src/renderer/src/RunOutcome'

const provenance: Provenance = {
  input: { id: 'source-only', sha256: 'a'.repeat(64), byte_length: 978 },
  output: { id: 'output-only', sha256: 'b'.repeat(64), byte_length: 182 },
  call_id: 'original-call', capability_id: 'bound-capability', package_digest: 'c'.repeat(64),
  plugin_version: '1.0.0', pages: [{ page: 2, start: 0, end: 182 }], partial: false,
  notice: '', location_verification: 'tool_reported'
}

it('maps each saved source fact without deriving parameters, status or semantic confidence', () => {
  const before = structuredClone(provenance), facts = sourceFacts(provenance)
  expect(facts).toHaveLength(10)
  expect(facts.map(row => row.value)).toEqual(['source-only', 'a'.repeat(64), '978', 'output-only', 'b'.repeat(64), '182', 'original-call', 'bound-capability', 'c'.repeat(64), '1.0.0'])
  expect(facts.some(row => /parameters|success|delivered/.test(row.value))).toBe(false)
  expect(provenance).toEqual(before)
})

it('keeps partial status distinct from semantic completeness and describes field absence', () => {
  expect(extractionCoverage(false)).toContain('不代表语义完整')
  expect(extractionCoverage(true)).toContain('不能当作完整材料')
  expect(sourceFieldLocations.find(row => row.label === '精确提取参数')?.location).toContain('不表示参数为空')
  expect(sourceFieldLocations.find(row => row.label === '页索引')?.location).toContain('不是原 Call')
})

it('labels Run token totals as cumulative and unavailable usage as nonzero-unknown rather than a bill', () => {
  for (const [accounting, label] of [['provider-usage', '服务 usage'], ['mixed', '混合估算与 usage'], ['estimated', '估算']]) {
    const html = renderToStaticMarkup(createElement(RunOutcome, { run: { id: 'run', state: 'completed', primary_reason: 'model_stop', budget_json: JSON.stringify({ model_requests: 3, tool_requests: 2, tokens: 49303, accounting }) } }))
    expect(html).toContain('累计 token 49303')
    expect(html).toContain(label)
    expect(html).toContain('不是单次上下文长度或服务账单')
    expect(html).toContain('未完成请求不视为零消耗')
  }
})

it('keeps source guidance out of the main role while the summary retains evidence distinctions', () => {
  const agent = readFileSync('src/runtime/model/prompts/agent-v0.1.txt', 'utf8')
  expect(agent.trim()).toBe('你是 Pliuna 的通用学习与任务助手。\n\n你可以与用户对话，使用当前提供的工具处理任务，并生成学习内容和交互界面。')
  const summary = readFileSync('src/runtime/model/prompts/summary-v0.1.txt', 'utf8')
  expect(summary).toContain('区分用户请求、模型陈述和工具结果')
  expect(summary).toContain('不把模型自述当作执行证据')
  expect(summary).toContain('以本次实际可见内容为依据')
  expect(summary).toContain('不虚构界面过程或来源可见性')
})
