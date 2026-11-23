import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { RunnerProjection } from '../../src/shared/types'
import { RunnerWorkingCopy } from '../../src/renderer/src/RunnerWorkingCopy'
import { scopeLabel } from '../../src/renderer/src/runner-projection'

it('keeps the same working copy while showing missing and pending content', () => {
  const runner: RunnerProjection = { goals: [], next_cursor: null, scope: { composition_version: 2, state: 'working', required_content_count: 2, unresolved_count: 1, pending_update_count: 1, published_count: 1 } }
  const html = renderToStaticMarkup(createElement(RunnerWorkingCopy, { runner }))
  expect(html).toContain('渐进工作版'); expect(html).toContain('已发布内容可在中央内容区阅读')
  expect(html).toContain('1 项内容待更新'); expect(html).toContain('1 项待完成')
  expect(html).not.toContain('创建'); expect(html).not.toContain('删除')
  expect(scopeLabel({ ...runner.scope!, state: 'complete' })).toBe('渐进工作版')
  expect(scopeLabel({ ...runner.scope!, state: 'complete', unresolved_count: 0, pending_update_count: 0 })).toBe('当前成稿已完整')
})
