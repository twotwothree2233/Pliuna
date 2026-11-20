import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { RunnerGoalProjection, RunnerProjection, Snapshot } from '../../src/shared/types'
import { RunnerGoals } from '../../src/renderer/src/RunnerGoals'
import { RunnerWorkingCopy } from '../../src/renderer/src/RunnerWorkingCopy'
import { TaskReply } from '../../src/renderer/src/TaskReply'
import { clearRunnerInput, goalCanStop, goalDeliveryLabel, goalExecutionLabel, goalFailureMessage, goalUsagePending, loadRunnerInput, runnerInputNotReceived, runnerInputProblem, runnerReplyNotice, runnerSummary, runnerWaitLabel, saveRunnerInput, scopeLabel, selectRunnerAnswer, type RunnerInput } from '../../src/renderer/src/runner-projection'
import defaults from '../../src/shared/contracts/development-defaults.json'

function goal(request = 'alpha'): RunnerGoalProjection {
  return { request_id: request, intent_revision: 1, input_event_id: `input-${request}`, title: `${request} 的结果要求`, state: 'active', run: { id: `run-${request}`, state: 'running', primary_reason: null }, waits: [], delivery: 'accepted', unresolved_count: 0, request: null, reply: { id: `reply-${request}`, kind: 'runner.answer', purpose: 'final_answer', created_at: '2026-11-16T00:00:00.000Z', request_id: request, intent_revision: 1, input_event_id: `input-${request}`, run_id: `run-${request}` } }
}
function projection(): RunnerProjection {
  const alpha = goal(), beta = goal('beta')
  alpha.run = { ...alpha.run!, state: 'waiting', wait_reason: 'approval' }; alpha.waits = [{ reason: 'approval', run_id: alpha.run.id, approval_id: 'approval-alpha' }]
  return { goals: [alpha, beta], next_cursor: null, scope: { composition_version: 2, state: 'working', required_goal_count: 2, unresolved_count: 1, pending_update_count: 1, published_count: 1 } }
}
function snapshot(runner = projection()): Snapshot {
  return { task: { id: 'task', title: '并行任务', state: 'active', revision: 2 }, runtime_epoch: 'epoch', surface: { id: 'surface', revision: 1 }, views: [], task_data: { total: 0, items: [] }, answer_total: 0, runs: runner.goals.flatMap(item => item.run ? [item.run] : []), records: [], approvals: [], answers: [], surface_updates: [], runner }
}
function storage() {
  const values = new Map<string, string>()
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
}

it('shows approval waiting and another running goal independently with exact controls', () => {
  const s = snapshot(), html = renderToStaticMarkup(createElement(RunnerGoals, { snapshot: s, busy: false, refresh: async () => {}, onApproval: () => {}, onDirty: () => {} }))
  expect(html).toContain('alpha 的结果要求'); expect(html).toContain('beta 的结果要求')
  expect(html).toContain('等待你批准'); expect(html).toContain('正在执行')
  expect(html.match(/停止此目标/g)).toHaveLength(2)
  expect(html).toContain('查看并处理'); expect(html).not.toContain('run-alpha')
  expect(runnerSummary(s.runner!)).toBe('1 个目标进行中 · 1 个等待')
})

it('shows ended generation awaiting original model usage instead of generic closing', () => {
  const value = goal()
  value.run = { ...value.run!, state: 'closing', wait_reason: 'ending_cleanup' }
  value.waits = [{ reason: 'usage_unknown', run_id: value.run.id, work_id: 'work-alpha', operation_id: 'model-request' }]
  const runner: RunnerProjection = { goals: [value], next_cursor: null, scope: null }
  const html = renderToStaticMarkup(createElement(RunnerGoals, { snapshot: snapshot(runner), busy: false, refresh: async () => {}, onApproval: () => {}, onDirty: () => {} }))
  expect(goalExecutionLabel(value)).toBe('模型用量待核对')
  expect(runnerSummary(runner)).toBe('模型用量待核对')
  expect(html).toContain('生成已停止。原调用用量待核对。可查看执行记录。')
  expect(html).not.toContain('正在结束执行')
  expect(html).not.toContain('重新生成')
  expect(goalCanStop(value)).toBe(true)
  value.waits = [{ ...value.waits[0]!, run_id: 'other-run' }]
  expect(goalUsagePending(value)).toBe(false)
  expect(goalExecutionLabel(value)).toBe('正在结束执行')
  expect(runnerSummary(runner)).toBe('正在结束执行')
})

it('keeps accepted unpublished work distinct from delivered content', () => {
  const value = goal()
  expect(goalDeliveryLabel(value)).toBe('内容已生成，等待发布')
  value.delivery = 'pending_update'
  expect(goalDeliveryLabel(value)).toBe('已发布内容待更新')
  value.state = 'withdrawn'
  expect(goalCanStop(value)).toBe(false)
  expect(goalDeliveryLabel(value)).toBe('已退出当前成稿范围')
})

it('shows delivery obstructions even after production finishes and maps exact host codes', () => {
  const runner = projection(), alpha = runner.goals[0]!
  alpha.run = { id: 'run-alpha', state: 'completed', primary_reason: null }
  alpha.waits = [{ reason: 'CAPABILITY_DISABLED', run_id: 'composition-alpha', batch_id: 'batch-alpha', operation_id: 'operation-alpha' }]
  const html = renderToStaticMarkup(createElement(RunnerGoals, { snapshot: snapshot(runner), busy: false, refresh: async () => {}, onApproval: () => {}, onDirty: () => {} }))
  expect(html).toContain('执行已完成'); expect(html).toContain('所需能力未开启')
  expect(html).toContain('内容已生成，等待发布'); expect(html).not.toContain('CAPABILITY_DISABLED')
  expect(runnerWaitLabel('BUNDLE_SIZE_LIMIT')).toBe('呈现内容超出限制')
  expect(runnerWaitLabel('INVALID_LAYOUT')).toBe('呈现布局需要调整')
})

it('shows the unsupported bundle reason alongside failed execution and incomplete delivery', () => {
  const value = goal()
  value.run = { id: 'run-alpha', state: 'failed', primary_reason: 'UNSUPPORTED_BUNDLE' }
  value.delivery = 'incomplete'; value.reply = null; value.unresolved_count = 1
  const runner: RunnerProjection = { goals: [value], next_cursor: null, scope: null }
  const html = renderToStaticMarkup(createElement(RunnerGoals, { snapshot: snapshot(runner), busy: false, refresh: async () => {}, onApproval: () => {}, onDirty: () => {} }))
  expect(html).toContain('执行失败')
  expect(html).toContain('内容尚未完成')
  expect(html).toContain('UNSUPPORTED_BUNDLE')
  expect(html).toContain('生成的内容含有不支持的结构或行为。请查看执行记录中的具体校验原因。')
})

it.each([null, '', ' \t\n', 'UNRECOGNIZED_FAILURE'])('shows a failure reason fallback for %j without changing terminal labels', reason => {
  const value = goal()
  value.run = { id: 'run-alpha', state: 'failed', primary_reason: reason }
  value.delivery = 'incomplete'; value.reply = null
  const runner: RunnerProjection = { goals: [value], next_cursor: null, scope: null }
  const html = renderToStaticMarkup(createElement(RunnerGoals, { snapshot: snapshot(runner), busy: false, refresh: async () => {}, onApproval: () => {}, onDirty: () => {} }))
  expect(html).toContain('执行失败')
  expect(html).toContain('内容尚未完成')
  expect(html).toContain(reason?.trim() ? 'UNRECOGNIZED_FAILURE · 暂无此错误的说明。请查看执行记录。' : '未提供结束原因。请查看执行记录。')
})

it('shows interrupted execution reasons and suppresses them for other execution states', () => {
  const value = goal()
  value.run = { id: 'run-alpha', state: 'interrupted', primary_reason: 'UNRECOGNIZED_FAILURE' }
  value.delivery = 'incomplete'; value.reply = null
  const runner: RunnerProjection = { goals: [value], next_cursor: null, scope: null }
  const html = renderToStaticMarkup(createElement(RunnerGoals, { snapshot: snapshot(runner), busy: false, refresh: async () => {}, onApproval: () => {}, onDirty: () => {} }))
  expect(html).toContain('执行中断')
  expect(html).toContain('UNRECOGNIZED_FAILURE · 暂无此错误的说明。请查看执行记录。')
  for (const state of ['queued', 'running', 'waiting', 'closing', 'completed', 'cancelled']) {
    value.run = { id: 'run-alpha', state, primary_reason: 'UNSUPPORTED_BUNDLE' }
    expect(goalFailureMessage(value)).toBeNull()
    const normal = renderToStaticMarkup(createElement(RunnerGoals, { snapshot: snapshot(runner), busy: false, refresh: async () => {}, onApproval: () => {}, onDirty: () => {} }))
    expect(normal).not.toContain('UNSUPPORTED_BUNDLE')
    expect(normal).not.toContain('未提供结束原因')
  }
  value.run = null
  expect(goalFailureMessage(value)).toBeNull()
})

it('keeps the same working copy while showing missing and pending content', () => {
  const runner = projection(), html = renderToStaticMarkup(createElement(RunnerWorkingCopy, { runner }))
  expect(html).toContain('渐进工作版'); expect(html).toContain('已发布内容可在中央内容区阅读')
  expect(html).toContain('1 项内容待更新'); expect(html).toContain('1 项待完成')
  expect(html).not.toContain('创建'); expect(html).not.toContain('删除')
  expect(scopeLabel({ ...runner.scope!, state: 'complete' })).toBe('渐进工作版')
  expect(scopeLabel({ ...runner.scope!, state: 'complete', unresolved_count: 0, pending_update_count: 0 })).toBe('当前成稿已完整')
})

it('selects only a final answer for the current exact input and goal revision', () => {
  const value = goal()
  expect(selectRunnerAnswer(value)?.id).toBe('reply-alpha')
  for (const patch of [{ request_id: 'beta' }, { intent_revision: 2 }, { input_event_id: 'other-input' }, { purpose: 'query_reply' }, { kind: 'message.assistant' }]) {
    const changed = { ...value, reply: { ...value.reply!, ...patch } } as RunnerGoalProjection
    expect(selectRunnerAnswer(changed)).toBeNull()
  }
  expect(selectRunnerAnswer({ ...value, state: 'withdrawn' })).toBeNull()
})

it('does not use legacy recent messages as the managed reply entry', () => {
  const html = renderToStaticMarkup(createElement(TaskReply, { snapshot: snapshot(), onRecords: () => {} }))
  expect(html).toContain('目标回复'); expect(html).toContain('选择目标')
  expect(html).not.toContain('最近保存的回复')
})

it('replaces artifact replies with a publication notice without loading their saved bodies', () => {
  const value = goal()
  value.artifact_count = 1; value.delivery = 'published'; value.run!.state = 'completed'
  const html = renderToStaticMarkup(createElement(TaskReply, { snapshot: snapshot({ goals: [value], next_cursor: null, scope: null }), onRecords: () => {} }))
  expect(html).toContain('任务已完成，内容已发布。')
  expect(html).not.toContain('saved-message')
  expect(html).not.toContain('正在读取已保存内容')
  expect(selectRunnerAnswer(value)?.id).toBe('reply-alpha')
})

it('selects the latest artifact-only result when an older goal already has a reply', () => {
  const older = goal('older'), latest = goal('latest')
  latest.artifact_count = 1; latest.delivery = 'published'; latest.run!.state = 'completed'; latest.reply = null
  const html = renderToStaticMarkup(createElement(TaskReply, { snapshot: snapshot({ goals: [older, latest], next_cursor: null, scope: null }), onRecords: () => {} }))
  expect(html).toContain('任务已完成，内容已发布。')
  expect(html).toContain('<option value="latest" selected="">')
  expect(html).not.toContain('saved-message')
})

it('keeps direct answers and unknown historical published projections readable', () => {
  const value = goal()
  value.delivery = 'published'; value.run!.state = 'completed'
  for (const count of [0, undefined]) {
    value.artifact_count = count
    expect(runnerReplyNotice(value)).toBeNull()
    const html = renderToStaticMarkup(createElement(TaskReply, { snapshot: snapshot({ goals: [value], next_cursor: null, scope: null }), onRecords: () => {} }))
    expect(html).toContain('saved-message')
  }
})

it('keeps a successful direct answer readable beside an older artifact result', () => {
  const older = goal('older'), latest = goal('latest')
  older.artifact_count = 1; older.delivery = 'published'; older.run!.state = 'completed'
  latest.artifact_count = 0; latest.delivery = 'published'; latest.run!.state = 'completed'
  const html = renderToStaticMarkup(createElement(TaskReply, { snapshot: snapshot({ goals: [older, latest], next_cursor: null, scope: null }), onRecords: () => {} }))
  expect(html).toContain('<option value="latest" selected="">')
  expect(html).toContain('saved-message')
  expect(html).not.toContain('任务已完成，内容已发布。')
})

it.each(['running', 'completed'])('summarizes unresolved zero-artifact work while execution is %s', state => {
  const value = goal()
  value.artifact_count = 0; value.delivery = 'incomplete'; value.unresolved_count = 1; value.run!.state = state
  const notice = state === 'completed' ? '本轮已结束，目标尚未完成。' : '目标尚未完成。'
  const html = renderToStaticMarkup(createElement(TaskReply, { snapshot: snapshot({ goals: [value], next_cursor: null, scope: null }), onRecords: () => {} }))
  expect(runnerReplyNotice(value)).toBe(notice)
  expect(html).toContain(notice)
  expect(html).not.toContain('saved-message')
  expect(html).not.toContain('正在读取已保存内容')
  if (state === 'completed') {
    expect(goalExecutionLabel(value)).toBe('本轮已结束')
    value.waits = [{ reason: 'surface_host' }]
    expect(runnerReplyNotice(value)).toBe('本轮已结束，目标尚未完成。等待确认替换。')
  }
})

it.each(['accepted', 'pending_update'] as const)('keeps an explicit answer-only projection for %s readable', delivery => {
  const value = goal()
  value.artifact_count = 0; value.delivery = delivery
  expect(runnerReplyNotice(value)).toBeNull()
})

it('distinguishes accepted content and approval waits from successful publication', () => {
  const value = goal()
  value.artifact_count = 1; value.run!.state = 'completed'
  expect(runnerReplyNotice(value)).toBe('内容已生成，等待发布。')
  value.waits = [{ reason: 'surface_host' }]
  expect(runnerReplyNotice(value)).toBe('内容已生成，等待发布。等待确认替换。')
  value.waits = [{ reason: 'CAPABILITY_DISABLED' }]
  expect(runnerReplyNotice(value)).toContain('所需能力未开启')
  expect(runnerReplyNotice(value)).not.toContain('任务已完成')
  value.artifact_count = undefined
  expect(runnerReplyNotice(value)).toContain('等待发布')
})

it.each(['failed', 'cancelled', 'interrupted', 'closing'])('does not turn %s content generation into a completion notice', state => {
  const value = goal()
  value.delivery = 'pending_update'; value.run!.state = state
  for (const count of [0, 1]) {
    value.artifact_count = count
    expect(runnerReplyNotice(value)).toContain(goalExecutionLabel(value))
    expect(runnerReplyNotice(value)).toContain('已发布内容待更新')
    expect(runnerReplyNotice(value)).not.toContain('任务已完成')
    const html = renderToStaticMarkup(createElement(TaskReply, { snapshot: snapshot({ goals: [value], next_cursor: null, scope: null }), onRecords: () => {} }))
    expect(html).not.toContain('saved-message')
  }
})

it('persists one immutable input identity for confirmation loss and target-specific reconciliation', () => {
  const saved = storage(), input: RunnerInput = { type: 'host.runner.input', task_id: 'task', request_id: 'alpha', input_event_id: 'stable-input', kind: 'cancel_run', run_id: 'run-alpha' }
  saveRunnerInput(saved, input)
  const restored = loadRunnerInput(saved, 'task', 'alpha')!
  expect(restored).toEqual(input)
  expect(loadRunnerInput(saved, 'task', 'beta')).toBeNull()
  saveRunnerInput(saved, restored)
  expect(loadRunnerInput(saved, 'task', 'alpha')?.input_event_id).toBe('stable-input')
  clearRunnerInput(saved, 'task', 'alpha')
  expect(loadRunnerInput(saved, 'task', 'alpha')).toBeNull()
})

it('refuses stored input that attempts to change its target or operation kind', () => {
  const saved = storage(), base = { type: 'host.runner.input', task_id: 'task', request_id: 'alpha', input_event_id: 'stable-input', kind: 'correction', text: '目标更正' }
  for (const patch of [{ request_id: 'beta' }, { kind: 'stop_task' }, { text: '' }, { work_id: 'unrelated-work' }]) {
    saved.setItem('pliuna.runner-input:task:alpha', JSON.stringify({ ...base, ...patch }))
    expect(loadRunnerInput(saved, 'task', 'alpha')).toBeNull()
  }
})

it('checks correction UTF-8 bytes before saving pending and permits the exact host boundary', () => {
  const saved = storage(), input: RunnerInput = { type: 'host.runner.input', task_id: 'task', request_id: 'alpha', input_event_id: 'stable-input', kind: 'correction', text: '汉'.repeat(Math.floor(defaults.data.object_bytes / 3)) + 'a' }
  expect(new TextEncoder().encode(input.text).byteLength).toBe(defaults.data.object_bytes)
  expect(runnerInputProblem(input)).toBeNull()
  saveRunnerInput(saved, input)
  expect(loadRunnerInput(saved, 'task', 'alpha')).toEqual(input)
  clearRunnerInput(saved, 'task', 'alpha')
  const oversized = { ...input, text: '汉'.repeat(90000) }
  expect(JSON.stringify(oversized).length).toBeLessThan(defaults.data.object_bytes)
  expect(() => saveRunnerInput(saved, oversized)).toThrow('目标修改过长')
  expect(loadRunnerInput(saved, 'task', 'alpha')).toBeNull()
  expect(saved.values.size).toBe(0)
})

it('round-trips valid text even when JSON escaping exceeds the text byte limit', () => {
  const saved = storage(), input: RunnerInput = { type: 'host.runner.input', task_id: 'task', request_id: 'alpha', input_event_id: 'stable-input', kind: 'correction', text: 'x' + '\u0000'.repeat(defaults.data.object_bytes - 1) }
  expect(new TextEncoder().encode(input.text).byteLength).toBe(defaults.data.object_bytes)
  expect(new TextEncoder().encode(JSON.stringify(input)).byteLength).toBeGreaterThan(defaults.data.object_bytes)
  saveRunnerInput(saved, input)
  expect(loadRunnerInput(saved, 'task', 'alpha')).toEqual(input)
})

it('returns only explicit pre-receipt input rejection to editing and keeps uncertainty pending', () => {
  expect(runnerInputNotReceived(Error('INVALID_INPUT: Correction input requires nonempty bounded text'))).toBe(true)
  for (const message of ['CONNECTION_LOST: receipt missing', 'UNKNOWN_RESULT: not confirmed', 'OFFLINE: transport unavailable', 'RUNNER_INPUT_CONFLICT: original payload retained', 'RUNNER_NOT_FOUND: target unavailable', 'CONNECTION_LOST: INVALID_INPUT: response was lost']) expect(runnerInputNotReceived(Error(message))).toBe(false)
  expect(runnerInputNotReceived(undefined)).toBe(false)
})
