import { useEffect, useState } from 'react'
import type { Run, RunActivity, Snapshot } from '../../shared/types'
import { hostRequest } from './ModelSettings'

const kinds: Record<string, string> = { task: '任务', surface: '任务界面', view: '内容单元', view_history: '内容历史', task_data: '任务数据', message: '消息', event: '执行记录', answer: '作答记录', run: '运行记录', action: '动作记录', approval: '审批记录', resource: '材料', call: '调用记录', object_type: '操作契约', plugin: '插件', capability: '工具能力', summary: '工作摘要' }
const operations: Record<string, string> = { 'task_data.create': '创建任务数据', 'task_data.replace': '更新任务数据', 'task_data.remove': '移除任务数据', 'surface.update': '更新任务内容', 'resource.create': '保存资源', 'plugin.invoke': '调用插件', 'export.prepare': '准备导出', 'export.check': '检查导出内容' }

function describe(item: RunActivity['items'][number]) {
  const title = item.type === 'reply' ? item.execution === 'partial' ? '已保留部分回复' : '回复已保存'
    : item.name === 'read' ? `读取${kinds[item.target_kind ?? ''] ?? '对象'}`
    : item.name === 'list' ? `查询${kinds[item.target_kind ?? ''] ?? '对象列表'}`
    : item.name === 'write' ? operations[item.operation ?? ''] ?? '写入任务内容'
    : item.name === 'call' ? '调用工具' : '工具请求'
  const state = item.type === 'reply' ? item.execution === 'partial' ? '回复未完整' : ''
    : !item.execution ? '已请求，待返回结果'
    : item.execution === 'success' ? item.delivery === 'failed' ? '已执行，结果交付失败' : item.delivery && item.delivery !== 'delivered' ? '已执行，结果待交付' : '已完成'
    : ({ not_executed: '未执行', failure: '执行失败', cancelled: '已取消', partial: '部分执行', unknown: '结果待核对' } as Record<string, string>)[item.execution] ?? '结果待核对'
  const detail = [state, item.label || item.target_id, item.error].filter(Boolean).join(' · ')
  const phase = item.execution === 'success' && (!item.delivery || item.delivery === 'delivered') ? 'done' : item.execution ? 'attention' : 'next'
  return { title, detail, phase }
}

export function AgentActivity({ snapshot, run }: { snapshot: Snapshot; run: Run }) {
  const [saved, setSaved] = useState<{ key: string; value: RunActivity } | null>(null), [error, setError] = useState(''), [retry, setRetry] = useState(0)
  const key = `${snapshot.runtime_epoch}:${snapshot.task.id}:${run.id}`
  useEffect(() => {
    let cancelled = false
    void hostRequest<RunActivity>({ type: 'host.run.activity', task_id: snapshot.task.id, run_id: run.id }).then(value => {
      if (!cancelled) { setSaved({ key, value }); setError('') }
    }).catch(() => { if (!cancelled) { setSaved(null); setError(key) } })
    return () => { cancelled = true }
  }, [key, snapshot.record_total, snapshot.records.at(-1)?.id, run.state, run.wait_reason, retry])
  const activity = saved?.key === key ? saved.value : null
  return <section className="agent-activity" aria-label="本次执行动态">
    {activity?.request && <div className="agent-request"><span>本次指令</span><p>{activity.request}</p></div>}
    {activity && activity.items.length > 0 && <ol className="agent-state-steps" aria-label="最近执行动态">{activity.items.map(item => {
      const row = describe(item)
      const detail = !item.execution && !['running', 'waiting'].includes(run.state) ? '未取得执行结果' : row.detail
      return <li key={item.id} className={row.phase}><span className="state-point" /><div><b>{row.title}</b>{detail && <small>{detail}</small>}</div></li>
    })}</ol>}
    {error === key && <p className="agent-activity-error">执行动态暂未读取。<button className="agent-text-link" onClick={() => setRetry(value => value + 1)}>重新读取</button></p>}
  </section>
}
