import { expect, it } from 'vitest'
import type { Run, Snapshot, Task } from '../../src/shared/types'
import { taskStatus, type RequestQueueState } from '../../src/renderer/src/task-status'

const task: Task = { id: 'task', title: 'Task status', state: 'active', revision: 1 }
function snapshot(runs: Run[] = [], id = task.id): Pick<Snapshot, 'task' | 'runs'> {
  return { task: { ...task, id }, runs }
}
function run(state: string): Run { return { id: `run-${state}`, state, primary_reason: null } }
function queue(patch: Partial<RequestQueueState> = {}): RequestQueueState {
  return { taskId: task.id, loaded: true, pending: 0, confirmation: 0, unknown: false, ...patch }
}

it('gives task lifecycle priority over execution, queue and snapshot availability', () => {
  const cases: { state: Task['state']; label: string }[] = [
    { state: 'stopping', label: '停止中' },
    { state: 'stopped', label: '已停止' },
    { state: 'deleting', label: '删除中' }
  ]
  for (const { state, label } of cases) {
    expect(taskStatus({ ...task, state }, snapshot([run('running')]), queue({ unknown: true, pending: 2 }))).toBe(label)
    expect(taskStatus({ ...task, state }, null)).toBe(label)
    expect(taskStatus({ ...task, state }, snapshot([], 'other'))).toBe(label)
  }
})

it('shows an opened task until a snapshot for that exact task is available', () => {
  expect(taskStatus(task)).toBe('已开启')
  expect(taskStatus(task, null, queue({ unknown: true }))).toBe('已开启')
  expect(taskStatus(task, snapshot([run('running')], 'other'), queue({ pending: 3 }))).toBe('已开启')
})

it('uses active execution before queue uncertainty and skips terminal history', () => {
  for (const { state, label } of [
    { state: 'running', label: '执行中' },
    { state: 'waiting', label: '等待处理' },
    { state: 'queued', label: '待执行' },
    { state: 'closing', label: '正在结束执行' }
  ]) {
    const current = snapshot([run('completed'), run(state)])
    expect(taskStatus(task, current)).toBe(label)
    expect(taskStatus(task, current, queue({ taskId: 'other', loaded: false, unknown: true }))).toBe(label)
    expect(taskStatus(task, current, queue({ unknown: true, confirmation: 1, pending: 1 }))).toBe(label)
  }
})

it('requires a loaded queue belonging to the current task before showing readiness', () => {
  const current = snapshot()
  expect(taskStatus(task, current)).toBe('查询状态')
  expect(taskStatus(task, current, null)).toBe('查询状态')
  expect(taskStatus(task, current, queue({ taskId: 'other', unknown: true }))).toBe('查询状态')
  expect(taskStatus(task, current, queue({ loaded: false, unknown: true, confirmation: 1, pending: 1 }))).toBe('查询状态')
})

it('prioritizes unknown sends, confirmations and queued requests before readiness', () => {
  const current = snapshot()
  expect(taskStatus(task, current, queue({ unknown: true, confirmation: 2, pending: 3 }))).toBe('发送结果待核对')
  expect(taskStatus(task, current, queue({ confirmation: 2, pending: 3 }))).toBe('等待确认')
  expect(taskStatus(task, current, queue({ pending: 3 }))).toBe('待执行')
  expect(taskStatus(task, current, queue())).toBe('就绪')
})

it('keeps completed, failed and stopped execution history separate from current readiness', () => {
  const current = snapshot(['completed', 'failed', 'cancelled', 'interrupted'].map(run))
  expect(taskStatus(task, current, queue())).toBe('就绪')
  expect(taskStatus(task, current, queue({ pending: 1 }))).toBe('待执行')
  expect(taskStatus(task, current, queue({ unknown: true }))).toBe('发送结果待核对')
})
