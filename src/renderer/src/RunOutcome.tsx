import type { Run } from '../../shared/types'
import { modelErrorMessage } from './model-errors'
import { useEffect, useState } from 'react'
import { hostRequest } from './ModelSettings'
import { RecordBrowser } from './TaskInspector'
import { RequestUsage } from './RequestUsage'

export function RunOutcome({ run, taskId, showUsage = true }: { run: Run; taskId?: string; showUsage?: boolean }) {
  const [page, setPage] = useState<{ items: { id: string; kind: 'action' | 'call'; state: string; result: string | null }[]; total: number; offset: number } | null>(null)
  const [selected, setSelected] = useState<{ id: string; kind: 'action' | 'call' } | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  async function load(offset = 0) {
    if (!taskId) return
    setBusy(true); setError(''); setSelected(null)
    try { setPage(await hostRequest({ type: 'host.run.results', task_id: taskId, run_id: run.id, offset })) }
    catch (e) { setError(String(e)) } finally { setBusy(false) }
  }
  useEffect(() => { void load() }, [run.id, run.state, taskId])
  let budget: Record<string, unknown> = {}
  try { budget = JSON.parse(run.budget_json ?? '{}') } catch {}
  return <section className="notice run-outcome" aria-label="最近 Run 结果">
    <strong>最近 Run · {run.state}</strong>
    <p>{run.primary_reason === 'model_stop' ? '模型已交还控制权；模型声称完成不代表所有业务已执行。' : run.primary_reason === 'fixture_complete' ? '开发夹具完成，不是来自真实模型。' : modelErrorMessage(run.primary_reason ?? '无结束原因')}</p>
    {budget.model_requests != null && <><small>模型请求 {String(budget.model_requests)} · 工具请求 {String(budget.tool_requests)} · 累计 token {String(budget.tokens ?? '未知')}（{budget.accounting === 'provider-usage' ? '服务 usage' : budget.accounting === 'mixed' ? '混合估算与 usage' : '估算'}）· 费用未知{budget.unbounded_output_requests && budget.accounting !== 'provider-usage' ? ' · 含服务决定的输出，累计估算不含未知输出，不是完整消耗' : ''}</small><small>这是本 Run 多次请求的累计预算记账，不是单次上下文长度或服务账单；每次重发的历史会重复计入。估算使用字节加余量，不是精确 tokenizer，usage 缺失或未完成请求不视为零消耗。</small></>}
    <small>已提交结果保留；不会重放失败或中断请求。继续需明确发送新 Run。</small>
    {page && <p>宿主原结果核对（不是模型答复）：共 {page.total} 项，本页已结束且 success 的动作 {page.items.filter(item => item.kind === 'action' && item.state === 'ended' && item.result === 'success').length} 项。Run 失败不撤销这些成功动作；是否交付、对象及版本请查询原结果，不代表整个任务完成。</p>}
    {taskId && showUsage && <RequestUsage key={run.id} taskId={taskId} runId={run.id} />}
    {taskId && <><button disabled={busy} onClick={() => void load()}>查看本 Run 原操作结果</button>{error && <p role="alert">{error}</p>}{page && <><p>原操作 {page.total} 项；每页最多 50 项。success 仅表示该项成功，不等于整个目标完成。</p>{page.items.map(item => <button key={item.kind + item.id} disabled={busy} onClick={() => setSelected(item)}>{item.kind} · {item.state} · {item.result ?? '结果待核对'} · {item.id.slice(0, 8)}</button>)}{page.offset > 0 && <button disabled={busy} onClick={() => void load(Math.max(0, page.offset - 50))}>上一页原结果</button>}{page.offset + page.items.length < page.total && <button disabled={busy} onClick={() => void load(page.offset + 50)}>下一页原结果</button>}</>}{selected && <RecordBrowser key={selected.kind + selected.id} taskId={taskId} kind={selected.kind} label="本 Run 原操作" initialId={selected.id} />}</>}
  </section>
}
