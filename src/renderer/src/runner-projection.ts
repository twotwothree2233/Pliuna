import type { RunnerScopeProjection } from '../../shared/types'

const waitLabels: Record<string, string> = {
  approval: '等待你批准', surface_host: '正在检查内容更新', input: '等待你的输入', input_required: '等待你的输入', user_input: '等待你的输入',
  context_compacting: '正在整理上下文', model_queue: '等待服务名额', model_generating: '正在生成', ending_cleanup: '正在结束执行',
  dependency: '等待前序结果', work_waiting: '等待处理', budget: '额度不足', capability: '所需能力未开启', unknown: '原操作结果待核对', usage_unknown: '模型用量待核对',
  CAPABILITY_DISABLED: '所需能力未开启', WORKER_CAPABILITY_DENIED: '所需能力未授权', RUNNER_LIMIT_EXCEEDED: '呈现内容超出限制',
  BUNDLE_SIZE_LIMIT: '呈现内容超出限制', INVALID_LAYOUT: '呈现布局需要调整', INVALID_PRESENTATION_PLAN: '呈现布局需要调整', INVALID_BUNDLE_SOURCE: '呈现内容需要调整',
  COMPOSITION_INPUT_CONFIRMATION_REQUIRED: '汇总输入需要确认', composition_blocked: '内容发布受阻', composition_preparing: '正在准备内容发布'
}

export function runnerWaitLabel(reason: string): string { return waitLabels[reason] ?? (/^[A-Z][A-Z0-9_]*$/.test(reason) ? '内容发布受阻' : '等待处理') }
export function scopeLabel(scope: RunnerScopeProjection): string {
  return scope.state === 'complete' && !scope.unresolved_count && !scope.pending_update_count ? '当前成稿已完整' : '渐进工作版'
}
