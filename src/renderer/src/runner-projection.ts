import type { HostRequest, RunnerFinalAnswer, RunnerGoalProjection, RunnerProjection, RunnerScopeProjection } from '../../shared/types'
import defaults from '../../shared/contracts/development-defaults.json'
import { modelErrorMessage } from './model-errors'

export type RunnerInput = Extract<HostRequest, { type: 'host.runner.input' }>
const activeRunStates = new Set(['queued', 'running', 'waiting', 'closing'])
const waitLabels: Record<string, string> = {
  approval: '等待你批准', surface_host: '等待确认替换', input: '等待你的输入', input_required: '等待你的输入', user_input: '等待你的输入',
  context_compacting: '正在整理上下文', model_queue: '等待服务名额', model_generating: '正在生成', ending_cleanup: '正在结束执行',
  dependency: '等待前序结果', work_waiting: '等待处理', budget: '额度不足', capability: '所需能力未开启', unknown: '原操作结果待核对', usage_unknown: '模型用量待核对',
  CAPABILITY_DISABLED: '所需能力未开启', WORKER_CAPABILITY_DENIED: '所需能力未授权', RUNNER_LIMIT_EXCEEDED: '呈现内容超出限制',
  BUNDLE_SIZE_LIMIT: '呈现内容超出限制', INVALID_LAYOUT: '呈现布局需要调整', INVALID_PRESENTATION_PLAN: '呈现布局需要调整', INVALID_BUNDLE_SOURCE: '呈现内容需要调整',
  COMPOSITION_INPUT_CONFIRMATION_REQUIRED: '汇总输入需要确认', composition_blocked: '内容发布受阻', composition_preparing: '正在准备内容发布'
}

export function runnerWaitLabel(reason: string): string { return waitLabels[reason] ?? (/^[A-Z][A-Z0-9_]*$/.test(reason) ? '内容发布受阻' : '等待处理') }
export function goalCanStop(goal: RunnerGoalProjection): boolean { return goal.state === 'active' && !!goal.run && activeRunStates.has(goal.run.state) }
export function goalUsagePending(goal: RunnerGoalProjection): boolean { return goal.run?.state === 'closing' && goal.waits.some(wait => wait.reason === 'usage_unknown' && wait.run_id === goal.run!.id && !!wait.operation_id) }
export function goalExecutionLabel(goal: RunnerGoalProjection): string {
  if (goal.state === 'withdrawn') return '已撤回'
  const run = goal.run
  if (!run) return '待执行'
  if (goalUsagePending(goal)) return runnerWaitLabel('usage_unknown')
  if (run.state === 'closing') return '正在结束执行'
  if (run.state === 'waiting') return runnerWaitLabel(goal.waits[0]?.reason ?? run.wait_reason ?? 'work_waiting')
  if (run.state === 'running') return run.wait_reason ? runnerWaitLabel(run.wait_reason) : '正在执行'
  if (run.state === 'completed' && (goal.delivery === 'incomplete' || goal.unresolved_count > 0)) return '本轮已结束'
  return ({ queued: '等待执行', completed: '执行已完成', failed: '执行失败', cancelled: '执行已停止', interrupted: '执行中断' } as Record<string, string>)[run.state] ?? '等待处理'
}
export function goalDeliveryLabel(goal: RunnerGoalProjection): string {
  if (goal.state === 'withdrawn') return '已退出当前成稿范围'
  return ({ pending: '等待内容生成', accepted: '内容已生成，等待发布', published: '内容已发布', pending_update: '已发布内容待更新', incomplete: '内容尚未完成' })[goal.delivery]
}
export function goalFailureMessage(goal: RunnerGoalProjection): string | null {
  const run = goal.run
  if (!run || !['failed', 'interrupted'].includes(run.state)) return null
  const reason = run.primary_reason?.trim()
  if (!reason) return '未提供结束原因。请查看执行记录。'
  const message = modelErrorMessage(reason)
  return message === reason ? `${reason} · 暂无此错误的说明。请查看执行记录。` : message
}
export function runnerSummary(projection: RunnerProjection): string {
  const goals = projection.goals.filter(goal => goal.state === 'active'), running = goals.filter(goal => goal.run?.state === 'running').length
  const waiting = goals.filter(goal => goal.run?.state === 'waiting').length
  if (running && waiting) return `${running} 个目标进行中 · ${waiting} 个等待`
  if (running) return `${running} 个目标进行中`
  if (waiting) return `${waiting} 个目标等待处理`
  const closing = goals.filter(goal => goal.run?.state === 'closing')
  if (closing.length && closing.every(goalUsagePending)) return runnerWaitLabel('usage_unknown')
  if (goals.some(goal => goal.run?.state === 'closing')) return '正在结束执行'
  return projection.scope?.state === 'complete' ? '当前成稿已完整' : goals.length ? '目标状态已保存' : '就绪'
}
export function scopeLabel(scope: RunnerScopeProjection): string {
  return scope.state === 'complete' && !scope.unresolved_count && !scope.pending_update_count ? '当前成稿已完整' : '渐进工作版'
}
export function selectRunnerAnswer(goal: RunnerGoalProjection): RunnerFinalAnswer | null {
  const reply = goal.reply
  return reply?.kind === 'runner.answer' && reply.purpose === 'final_answer' && reply.request_id === goal.request_id && reply.intent_revision === goal.intent_revision && reply.input_event_id === goal.input_event_id && goal.state === 'active' ? reply : null
}
export function runnerReplyNotice(goal: RunnerGoalProjection): string | null {
  if (goal.state === 'withdrawn') return '此目标已撤回。'
  if (goal.run && ['failed', 'cancelled', 'interrupted', 'closing'].includes(goal.run.state)) return `${goalExecutionLabel(goal)}。${goalDeliveryLabel(goal)}。`
  const wait = goal.waits[0]
  if (goal.delivery === 'incomplete' || goal.unresolved_count > 0) {
    const notice = goal.run?.state === 'completed' ? '本轮已结束，目标尚未完成。' : '目标尚未完成。'
    return wait ? `${notice}${runnerWaitLabel(wait.reason)}。` : notice
  }
  if (wait) return `${goalDeliveryLabel(goal)}。${runnerWaitLabel(wait.reason)}。`
  const hasArtifacts = (goal.artifact_count ?? (['accepted', 'pending_update'].includes(goal.delivery) ? 1 : 0)) > 0
  if (!hasArtifacts) return null
  if (goal.delivery === 'published') return goal.run?.state === 'completed' ? '任务已完成，内容已发布。' : '内容已发布。'
  return `${goalDeliveryLabel(goal)}。`
}

type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const inputBytes = (text: string): number => new TextEncoder().encode(text).byteLength
// A valid text can expand sixfold when JSON escapes control characters.
const storedInputBytes = defaults.data.object_bytes * 6 + 4096
function inputKey(taskId: string, requestId: string): string { return `pliuna.runner-input:${taskId}:${requestId}` }
export function runnerInputProblem(input: RunnerInput): string | null {
  if (input.kind !== 'correction') return null
  if (!input.text?.trim()) return '目标修改不能为空。'
  return inputBytes(input.text) > defaults.data.object_bytes ? '目标修改过长，请缩短后再提交。' : null
}
export function runnerInputNotReceived(error: unknown): boolean {
  // runnerHostInput rejects INVALID_INPUT before persisting its input receipt.
  return error instanceof Error && error.message.startsWith('INVALID_INPUT:')
}
export function loadRunnerInput(storage: DraftStorage, taskId: string, requestId: string): RunnerInput | null {
  const raw = storage.getItem(inputKey(taskId, requestId))
  if (!raw || inputBytes(raw) > storedInputBytes) return null
  try {
    const value = JSON.parse(raw) as RunnerInput
    if (value.type !== 'host.runner.input' || value.task_id !== taskId || value.request_id !== requestId || typeof value.input_event_id !== 'string' || !value.input_event_id || !['correction', 'cancel_run', 'withdraw_goal'].includes(value.kind)) return null
    if (value.kind === 'correction' && (typeof value.text !== 'string' || !value.text.trim()) || value.kind === 'cancel_run' && typeof value.run_id !== 'string') return null
    if (Object.keys(value).some(key => !['type', 'task_id', 'request_id', 'input_event_id', 'kind', 'text', 'run_id'].includes(key))) return null
    return value
  } catch { return null }
}
export function saveRunnerInput(storage: DraftStorage, input: RunnerInput): void {
  if (!input.request_id) throw Error('目标操作缺少归属')
  const problem = runnerInputProblem(input)
  if (problem) throw Error(problem)
  const text = JSON.stringify(input)
  if (inputBytes(text) > storedInputBytes) throw Error('目标操作过长，请缩短后再提交。')
  storage.setItem(inputKey(input.task_id, input.request_id), text)
}
export function clearRunnerInput(storage: DraftStorage, taskId: string, requestId: string): void { storage.removeItem(inputKey(taskId, requestId)) }
