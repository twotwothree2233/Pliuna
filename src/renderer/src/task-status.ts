import type { Snapshot, Task } from '../../shared/types'

export interface RequestQueueState {
  taskId: string
  loaded: boolean
  pending: number
  confirmation: number
  unknown: boolean
}

const executingStates: Record<string, string> = {
  running: '执行中', waiting: '等待处理', queued: '待执行', closing: '正在结束执行'
}

export function taskStatus(task: Pick<Task, 'id' | 'state'>, snapshot?: Pick<Snapshot, 'task' | 'runs'> | null, queue?: RequestQueueState | null): string {
  if (task.state !== 'active') return { stopping: '停止中', stopped: '已停止', deleting: '删除中' }[task.state]
  if (snapshot?.task.id !== task.id) return '已开启'
  const run = snapshot.runs.find(run => executingStates[run.state])
  const executing = run && executingStates[run.state]
  if (executing) return executing
  if (!queue || queue.taskId !== task.id || !queue.loaded) return '查询状态'
  if (queue.unknown) return '发送结果待核对'
  if (queue.confirmation > 0) return '等待确认'
  return queue.pending > 0 ? '待执行' : '就绪'
}
