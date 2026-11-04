import { useState } from 'react'
import type { Snapshot } from '../../shared/types'
import { RecordBrowser } from './TaskInspector'

export function ApprovalCard({ taskId, approval: p, busy, decide }: { taskId: string; approval: Snapshot['approvals'][number]; busy: boolean; decide(decision: 'approve' | 'deny'): void }) {
  const [readId, setReadId] = useState('')
  return <section className={'approval-card ' + (p.decision === 'approve' ? 'approved' : p.decision === 'deny' ? 'denied' : 'pending')}>
    <b>单次权限审批 · {p.mode}</b><small>{p.decision} / {p.validity} / {p.handling}</small>
    <p>{(p.request as { type?: string }).type === 'plugin.invoke' ? '仅允许派发这一次插件调用，不证明工具执行成功；后续数据或 View 修改另行审批，外部副作用不保证回滚。' : (p.request as { type?: string }).type === 'task_data.remove' ? '移除当前数据对象，不能撤销；仅本人批准此动作，不级联删除、不删除资源文件，不授予长期许可。' : '仅批准列出的具体修改；丢弃输入仍需本人确认，无长期许可。'}</p>
    {p.request_truncated ? <><p className="notice">参数较长，请完整读取原动作后再批准；摘要不代表完整修改。</p><RecordBrowser taskId={taskId} kind="action" label="本次审批原动作" initialId={p.action_id} onComplete={setReadId} /></> : <details><summary>具体参数与版本</summary><pre>{JSON.stringify(p.request, null, 2)}</pre></details>}
    <small>原期限：{new Date(p.expires_at).toLocaleString()}</small>{p.evaluation != null && <pre>{JSON.stringify(p.evaluation, null, 2)}</pre>}
    {p.decision === 'pending' && p.validity === 'valid' && p.handling === 'awaiting_human' && <div><button disabled={busy} onClick={() => decide('deny')}>拒绝本次动作</button><button disabled={busy || Boolean(p.request_truncated && readId !== p.action_id)} onClick={() => decide('approve')}>批准本次动作</button></div>}
  </section>
}
