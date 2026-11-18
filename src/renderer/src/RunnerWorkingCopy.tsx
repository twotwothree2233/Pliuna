import type { RunnerProjection } from '../../shared/types'
import { scopeLabel } from './runner-projection'

export function RunnerWorkingCopy({ runner }: { runner?: RunnerProjection }) {
  const scope = runner?.scope
  if (!scope) return null
  return <section className="runner-working-copy" aria-label="当前成稿状态">
    <header><h2>{scopeLabel(scope)}</h2><span>{scope.required_goal_count} 个目标</span></header>
    <p>{scope.published_count ? '已发布内容可在中央内容区阅读。' : '通过验收的内容将在中央内容区逐步呈现。'}{scope.pending_update_count > 0 && ` ${scope.pending_update_count} 项内容待更新。`}{scope.unresolved_count > 0 && ` 尚有 ${scope.unresolved_count} 项待完成。`}</p>
  </section>
}
