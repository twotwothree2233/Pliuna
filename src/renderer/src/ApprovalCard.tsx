import type { Snapshot } from '../../shared/types'

const actionLabels: Record<string, string> = {
  'task_data.replace': '更新任务数据', 'task_data.remove': '移除任务数据', 'plugin.invoke': '调用插件',
  'content.delete': '删除章节内容', 'content.move': '移动章节内容', 'view.create': '新增内容', 'view.replace': '替换内容', 'view.remove': '移除内容', 'layout.set': '调整内容布局'
}

export function approvalLabel(approval: Snapshot['approvals'][number]) {
  const { type, target, operations } = approval.summary ?? { type: '' }
  if (type === 'surface.update') return operations?.map(op => actionLabels[op]).filter(Boolean).join('、') || '更新任务内容'
  const label = actionLabels[type] ?? '执行本次操作'
  return target ? `${label}：${type === 'plugin.invoke' ? target.replace(/^plugin:/, '') : target}` : label
}

export function ApprovalCard({ id, label, busy, proceed, reject, onProceed, onReject }: {
  id: string; label: string; busy: boolean; proceed: string; reject: string; onProceed(): void; onReject(): void
}) {
  return <article className="approval-card" id={`approval-${id}`} aria-labelledby={`approval-label-${id}`} tabIndex={-1}>
    <b id={`approval-label-${id}`}>{label}</b>
    <div className="approval-actions">
      <button type="button" disabled={busy} onClick={onReject}>{reject}</button>
      <button type="button" className="primary" disabled={busy} onClick={onProceed}>{proceed}</button>
    </div>
  </article>
}
