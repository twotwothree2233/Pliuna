import { useCallback, useEffect, useRef, useState } from 'react'
import type { RunnerGoalProjection, RunnerProjection, Snapshot } from '../../shared/types'
import { hostRequest } from './ModelSettings'
import { clearRunnerInput, goalCanStop, goalDeliveryLabel, goalExecutionLabel, goalFailureMessage, goalUsagePending, loadRunnerInput, runnerInputNotReceived, runnerInputProblem, runnerWaitLabel, saveRunnerInput, type RunnerInput } from './runner-projection'

export function useRunnerPage(snapshot: Snapshot) {
  const [cursor, setCursor] = useState<string | null>(null), [page, setPage] = useState<RunnerProjection | null>(null)
  const [error, setError] = useState(''), [loading, setLoading] = useState(false), [retry, setRetry] = useState(0)
  useEffect(() => { setCursor(null); setPage(null); setError('') }, [snapshot.task.id, snapshot.runtime_epoch])
  useEffect(() => {
    if (!cursor) { setPage(null); setError(''); setLoading(false); return }
    let cancelled = false
    setLoading(true)
    void hostRequest<RunnerProjection>({ type: 'host.runner.status', task_id: snapshot.task.id, cursor, limit: 16 }).then(value => {
      if (!cancelled) { setPage(value); setError('') }
    }).catch(() => { if (!cancelled) setError('目标状态暂未读取。请重新查询。') }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [cursor, snapshot.task.id, snapshot.runtime_epoch, snapshot.task.revision, retry])
  return { projection: cursor ? page : snapshot.runner ?? null, cursor, loading, error, first: () => setCursor(null), next: (value: string) => { setPage(null); setCursor(value) }, retry: () => setRetry(value => value + 1) }
}

export function RunnerGoals({ snapshot, busy, refresh, onApproval, onDirty }: { snapshot: Snapshot; busy: boolean; refresh(): Promise<void>; onApproval(id: string): void; onDirty(id: string, dirty: boolean): void }) {
  const page = useRunnerPage(snapshot), projection = page.projection
  const dirtyGoals = useRef(new Set<string>()), dirtyCallback = useRef(onDirty), [hasEdits, setHasEdits] = useState(false)
  dirtyCallback.current = onDirty
  const markDirty = useCallback((id: string, dirty: boolean) => {
    dirtyCallback.current(id, dirty)
    if (dirty) dirtyGoals.current.add(id); else dirtyGoals.current.delete(id)
    setHasEdits(dirtyGoals.current.size > 0)
  }, [])
  if (!snapshot.runner?.goals.length && !snapshot.runner?.next_cursor) return null
  return <section className="runner-goals" aria-label="各目标状态">
    <header><h2>目标进展</h2><button className="agent-text-link" disabled={page.loading} onClick={() => { page.retry(); void refresh() }}>刷新状态</button></header>
    {page.error && <p role="alert">{page.error}<button onClick={page.retry}>重新查询</button></p>}
    {page.loading && !projection && <p role="status">正在读取目标状态…</p>}
    <ul>{projection?.goals.map(goal => {
      const failure = goalFailureMessage(goal)
      return <li key={goal.request_id}>
      <header><h3 title={goal.title}>{goal.title || '未命名目标'}</h3><span>{goalExecutionLabel(goal)}</span></header>
      <p>{goalDeliveryLabel(goal)}{goal.unresolved_count > 0 && ` · 尚缺 ${goal.unresolved_count} 项`}</p>
      {failure && <p>{failure}</p>}
      {goalUsagePending(goal) && <p role="status">生成已停止。原调用用量待核对。可查看执行记录。</p>}
      {!!goal.waits.length && <ul className="runner-waits">{goal.waits.map((wait, index) => <li key={`${wait.reason}:${wait.operation_id ?? wait.work_id ?? wait.run_id ?? index}`}><span>{runnerWaitLabel(wait.reason)}</span>{wait.approval_id && <button disabled={busy} onClick={() => onApproval(wait.approval_id!)}>查看并处理</button>}</li>)}</ul>}
      <GoalActions taskId={snapshot.task.id} goal={goal} busy={busy || snapshot.task.state !== 'active'} refresh={refresh} onDirty={markDirty} />
    </li>})}</ul>
    {(page.cursor || projection?.next_cursor) && <>{hasEdits && <p>请先保存目标修改或核对原操作。</p>}<nav className="runner-page" aria-label="目标分页">{page.cursor && <button disabled={page.loading || hasEdits} onClick={page.first}>返回首批目标</button>}{projection?.next_cursor && <button disabled={page.loading || hasEdits} onClick={() => page.next(projection.next_cursor!)}>更多目标</button>}</nav></>}
  </section>
}

function GoalActions({ taskId, goal, busy, refresh, onDirty }: { taskId: string; goal: RunnerGoalProjection; busy: boolean; refresh(): Promise<void>; onDirty(id: string, dirty: boolean): void }) {
  const [mode, setMode] = useState<'correction' | 'cancel_run' | 'withdraw_goal' | null>(null), [text, setText] = useState('')
  const [pending, setPending] = useState<RunnerInput | null>(() => { try { return loadRunnerInput(localStorage, taskId, goal.request_id) } catch { return null } })
  const [working, setWorking] = useState(false), [notice, setNotice] = useState(''), composing = useRef(false)
  useEffect(() => {
    const key = `goal-correction:${taskId}:${goal.request_id}`
    onDirty(key, !!text || !!pending || working)
    return () => onDirty(key, false)
  }, [taskId, goal.request_id, text, pending, working, onDirty])
  async function query() {
    setWorking(true)
    try {
      const page = await hostRequest<RunnerProjection>({ type: 'host.runner.status', task_id: taskId, request_id: goal.request_id, limit: 1 }), current = page.goals[0]
      setNotice(current ? `${goalExecutionLabel(current)}。${goalDeliveryLabel(current)}。${goalFailureMessage(current) ?? ''}` : '此目标暂未读取，请刷新状态。')
    } catch { setNotice('此目标状态暂未读取，请重试。') } finally { setWorking(false) }
  }
  function editRejected(input: RunnerInput, message: string) {
    try { clearRunnerInput(localStorage, taskId, goal.request_id) }
    catch { setNotice('操作尚未接收。请检查本地存储后重新核对。'); return }
    setPending(null); setMode(input.kind === 'correction' ? 'correction' : null); setText(input.text ?? ''); setNotice(message)
  }
  async function submit() {
    if (working || composing.current || !pending && (busy || !mode || mode === 'correction' && !text.trim())) return
    const input: RunnerInput = pending ?? { type: 'host.runner.input', task_id: taskId, request_id: goal.request_id, input_event_id: crypto.randomUUID(), kind: mode!, ...(mode === 'correction' ? { text: text.trim() } : mode === 'cancel_run' ? { run_id: goal.run!.id } : {}) }
    const problem = runnerInputProblem(input)
    if (problem) { if (pending) editRejected(input, problem); else setNotice(problem); return }
    try { saveRunnerInput(localStorage, input) } catch { setNotice('操作尚未发送。请检查本地存储后重试。'); return }
    setPending(input); setWorking(true); setNotice('')
    try { await hostRequest(input) } catch (error) {
      if (runnerInputNotReceived(error)) editRejected(input, '操作尚未接收。请修改后重新提交。')
      else setNotice('原操作结果尚未确认。请核对原操作。')
      setWorking(false); return
    }
    try { clearRunnerInput(localStorage, taskId, goal.request_id) } catch { setNotice('操作已保存。请稍后核对原操作。'); setWorking(false); return }
    setPending(null); setMode(null); setText(''); setNotice('操作已保存。')
    try { await refresh() } catch { setNotice('操作已保存。请刷新目标状态。') } finally { setWorking(false) }
  }
  return <div className="runner-goal-actions">
    {!mode && !pending && <div className="runner-action-row"><button disabled={working} onClick={() => void query()}>查看状态</button>{goal.state === 'active' && <><button disabled={busy || working} onClick={() => { setMode('correction'); setNotice('') }}>纠正目标</button>{goalCanStop(goal) && <button disabled={busy || working} onClick={() => { setMode('cancel_run'); setNotice('') }}>停止此目标</button>}<button className="agent-text-link" disabled={busy || working} onClick={() => { setMode('withdraw_goal'); setNotice('') }}>撤回目标</button></>}</div>}
    {(mode || pending) && <form onSubmit={event => { event.preventDefault(); void submit() }}>
      {(pending?.kind ?? mode) === 'correction' ? <><label htmlFor={`goal-correction-${goal.request_id}`}>修改此目标的要求</label><textarea id={`goal-correction-${goal.request_id}`} value={pending?.text ?? text} disabled={working || !!pending} onChange={event => setText(event.target.value)} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} autoFocus /></> : <p>{(pending?.kind ?? mode) === 'cancel_run' ? '停止此目标的当前执行。已保存内容继续保留。' : '将此目标移出当前成稿范围。已发布内容继续保留。'}</p>}
      <div className="runner-action-row">{!pending && <button type="button" disabled={working} onClick={() => { setMode(null); setText(''); setNotice('') }}>返回</button>}<button className="primary" disabled={working || !pending && (busy || mode === 'correction' && !text.trim())}>{working ? '正在核对…' : pending ? '核对原操作' : mode === 'correction' ? '保存目标修改' : mode === 'cancel_run' ? '确认停止此目标' : '确认撤回目标'}</button></div>
    </form>}
    {(pending || notice) && <p role={pending && !working ? 'alert' : 'status'}>{notice || '原操作仍待确认。请核对后继续。'}</p>}
  </div>
}
