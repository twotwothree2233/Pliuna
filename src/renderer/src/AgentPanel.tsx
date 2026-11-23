import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { HostRequest, Run, Snapshot, TaskMessage } from '../../shared/types'
import type { FlowApproval } from './RunnerFlow'
import type { ModelState } from './ModelSettings'
import { AgentDialog } from './Dialog'
import { WorkspaceIcon } from './WorkspaceIcon'
import { ContextPanel } from './ContextPanel'
import { ApprovalCard, approvalLabel } from './ApprovalCard'
import { RunOutcome } from './RunOutcome'
import { RequestUsage, TaskUsageAction } from './RequestUsage'
import { RecordBrowser, viewTitle } from './TaskInspector'
import { RequestComposer } from './RequestComposer'
import type { RequestQueueState } from './task-status'
import { AgentActivity } from './AgentActivity'
import { RunnerWorkingCopy } from './RunnerWorkingCopy'
import { TaskReply } from './TaskReply'
import { runnerWaitLabel } from './runner-projection'
import { modelErrorMessage } from './model-errors'
import type { ChapterSourceRequest } from './ChapterEditor'

type Tool = 'details' | 'context' | 'stop' | null
export function runStatus(run?: Run) {
  if (!run) return '就绪'
  if (run.state === 'running' || run.state === 'waiting') return ({ approval: '等待你批准', surface_host: '正在检查内容更新', context_compacting: '正在整理上下文', model_queue: '等待服务名额', model_generating: '正在生成', ending_cleanup: '正在结束执行' } as Record<string, string>)[run.wait_reason ?? ''] ?? '正在执行'
  if (run.state === 'completed') return run.primary_reason === 'context_organized' ? '上下文已整理' : run.primary_reason === 'fixture_complete' ? '示例执行已完成' : '本次执行已完成'
  return ({ failed: '本次执行失败', cancelled: '本次执行已停止', interrupted: '本次执行中断' } as Record<string, string>)[run.state] ?? '本次执行已结束'
}
type SurfaceUpdate = Snapshot['surface_updates'][number]
function discardLabel(update: SurfaceUpdate, views: Snapshot['views']) {
  const { input } = update.request as { input: { operations: { type: string; view_id?: string }[] } }
  const removing = input.operations.some(op => op.type === 'view.remove')
  const operation = removing ? '移除内容并清空草稿' : '替换内容并清空草稿'
  const targets = input.operations.filter(op => op.type === 'view.remove' || op.type === 'view.replace')
  const index = targets.length === 1 ? views.findIndex(view => view.id === targets[0]?.view_id) : -1
  return index >= 0 ? `${operation}：《${viewTitle(views[index]!, index)}》` : operation
}

export function AgentPanel({ snapshot, run, approvalTarget, modelId, models, busy, text, setText, composer, onDirty, onQueueChange, refresh, act, settings, onRecords, onShowFlow, onFlow, onChapterScope, onConfirmSurface }: {
  snapshot: Snapshot | null; run?: Run; approvalTarget?: FlowApproval; modelId: string; models: ModelState; busy: boolean
  text: string; setText(value: string): void; composer: RefObject<HTMLTextAreaElement | null>
  onDirty(id: string, dirty: boolean): void; onQueueChange(state: RequestQueueState): void; refresh(): Promise<void>; act(request: HostRequest): Promise<void>; settings(): void; onRecords(): void; onShowFlow(): void
  onConfirmSurface(update: SurfaceUpdate): void
  onChapterScope(request: ChapterSourceRequest): boolean
  onFlow(runId: string): void
}) {
  const [view, setView] = useState<'chat' | 'records'>('chat')
  const [recordsOpened, setRecordsOpened] = useState(false)
  const [tool, setTool] = useState<Tool>(null), [menu, setMenu] = useState(false), [detailTab, setDetailTab] = useState<'process' | 'usage' | 'raw'>('process')
  const [selectedRun, setSelectedRun] = useState<Run | null>(null)
  const [queueOpen, setQueueOpen] = useState(false), [queue, setQueue] = useState<RequestQueueState>({ taskId: snapshot?.task.id ?? '', loaded: false, pending: 0, confirmation: 0, unknown: false })
  const updateQueue = useCallback((state: RequestQueueState) => {
    if (state.taskId !== snapshot?.task.id) return
    setQueue(state); onQueueChange(state)
  }, [snapshot?.task.id, onQueueChange])
  const menuRoot = useRef<HTMLDivElement>(null), chatScroll = useRef<HTMLDivElement>(null)
  const current = run ?? snapshot?.runs[0]
  const pending = snapshot?.approvals.filter(p => p.decision === 'pending' && p.validity === 'valid') ?? []
  const approvals = pending.filter(p => p.handling === 'awaiting_human')
  const surfaceChecks = snapshot?.surface_updates.filter(update => update.reset_requires_confirmation) ?? []
  const needsDecision = approvals.length > 0 || surfaceChecks.length > 0
  const status = !snapshot ? '未选择任务' : needsDecision ? '等待你确认' : queue.unknown ? '发送结果待核对' : queue.confirmation ? '需要你确认' : pending.length ? '正在评估权限' : snapshot.surface_updates.length ? '正在检查内容更新' : !run && queue.pending ? '等待材料与排队' : runStatus(current)
  const phase = queue.unknown || queue.confirmation || needsDecision || current?.state === 'failed' || current?.state === 'interrupted' ? 'attention' : run ? 'running' : current?.state === 'completed' ? 'done' : 'idle'
  const decide = (approvalId: string, decision: 'approve' | 'deny') => {
    if (snapshot && !busy) void act({ type: 'approval.decide', task_id: snapshot.task.id, approval_id: approvalId, decision })
  }
  useEffect(() => { if (approvalTarget) { setView('chat'); setTool(null); setMenu(false) } }, [approvalTarget])
  useEffect(() => {
    if (!menu) return
    menuRoot.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    const dismiss = (event: PointerEvent) => { if (!menuRoot.current?.contains(event.target as Node)) setMenu(false) }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [menu])
  const runs = new Map(snapshot?.runs.map(item => [item.id, item]))
  const byMessage = new Map([...snapshot?.runs ?? []].reverse().filter(item => item.message_id).map(item => [item.message_id!, item]))
  const byRequest = new Map(snapshot?.message_requests?.map(item => [item.id, item]))
  const detailRun = selectedRun ? runs.get(selectedRun.id) ?? selectedRun : current
  const open = (value: Tool, execution?: Run) => { setSelectedRun(execution ?? null); setMenu(false); setTool(value) }
  const showDetails = (execution: Run) => { setDetailTab('process'); open('details', execution) }
  const approvalCard = (p: Snapshot['approvals'][number]) => <ApprovalCard key={p.id} id={p.id} label={approvalLabel(p)} busy={busy} proceed="批准" reject="拒绝" onProceed={() => decide(p.id, 'approve')} onReject={() => decide(p.id, 'deny')} />
  const approvalMessage = (p: Snapshot['approvals'][number], visible: ReadonlyMap<string, TaskMessage>) => {
    const target = approvalTarget?.approvalId === p.id ? approvalTarget.messageId : undefined
    if (target && visible.has(target) && p.message_ids?.includes(target)) return target
    return (p.message_ids ?? []).filter(id => visible.has(id)).sort((left, right) => visible.get(right)!.sequence - visible.get(left)!.sequence)[0]
  }
  const underMessage = (message: TaskMessage, visible: ReadonlyMap<string, TaskMessage>) => {
    if (message.role !== 'user') return null
    const execution = byMessage.get(message.id) ?? (message.execution && (runs.get(message.execution.id) ?? message.execution))
    const request = (message.request_id ? byRequest.get(message.request_id) : null) ?? message.request_state
    const live = execution && ['running', 'waiting'].includes(execution.state) && execution.wait_reason !== 'ending_cleanup'
    const notice = request?.code === 'CONVERSATION_WAITING_FOR_RESULT' ? '等待前一轮回复' : request?.state === 'rejected' ? modelErrorMessage(request.code ?? 'REQUEST_START_FAILED')
      : request?.state === 'confirmation_required' ? request.code === 'CHAPTER_SCOPE_REQUIRED' ? null : '请求需要确认'
      : execution && execution.state !== 'completed' ? (execution.state === 'failed' && execution.primary_reason ? modelErrorMessage(execution.primary_reason) : execution.wait_reason && live ? runnerWaitLabel(execution.wait_reason) : runStatus(execution))
      : request?.state === 'queued' ? '等待执行' : request?.state === 'cancelled' ? '已取消' : null
    return <>
      {(notice || execution) && <div className="conversation-actions">
        {notice && <small>{notice}</small>}
        {execution && <button type="button" onClick={() => showDetails(execution)}>执行详情</button>}
        {live && <button type="button" disabled={busy} onClick={() => open('stop', execution)}>停止本次执行</button>}
      </div>}
      {approvals.filter(p => p.message_ids?.includes(message.id)).map(p => approvalMessage(p, visible) === message.id ? approvalCard(p) :
        <button key={p.id} type="button" className="conversation-reference" onClick={() => document.getElementById(`approval-${p.id}`)?.focus()}>查看待审批操作</button>)}
    </>
  }

  const titles = { details: '本次请求详情', context: '工作摘要与上下文', stop: '停止当前执行？' }
  return <>
    <header className="agent-heading"><b>Agent</b><div className="agent-actions"><nav className="agent-tabs" aria-label="Agent 视图"><button aria-pressed={view === 'chat'} onClick={() => setView('chat')}>对话</button><button disabled={!snapshot} aria-pressed={view === 'records'} onClick={() => { setRecordsOpened(true); setView('records') }}>执行记录</button></nav>
      {snapshot && <div className="agent-menu-root" ref={menuRoot}><button className="agent-icon" aria-label="更多 Agent 操作" aria-expanded={menu} aria-haspopup="menu" onClick={() => setMenu(value => !value)}><WorkspaceIcon name="more" /></button>{menu && <div className="agent-menu" role="menu" onKeyDown={event => { if (event.key === 'Escape') { setMenu(false); menuRoot.current?.querySelector<HTMLButtonElement>('.agent-icon')?.focus() }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault()
          const choices = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')], index = choices.indexOf(document.activeElement as HTMLButtonElement)
          choices[event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length]?.focus()
        } }}>
        {current && <button role="menuitem" onClick={() => { setDetailTab('process'); open('details') }}>本次请求详情</button>}<button role="menuitem" onClick={() => open('context')}>工作摘要与上下文</button><button role="menuitem" onClick={() => { setMenu(false); setQueueOpen(true) }}>请求队列</button>
      </div>}</div>}
    </div></header>
    <div className="agent-activity-strip" data-phase={phase}><WorkspaceIcon name={phase === 'done' ? 'check' : 'clock'} /><span className="agent-status" role={snapshot ? 'status' : undefined} title={status}>{status}</span></div>
    {snapshot && surfaceChecks.length > 0 && <section className="agent-approvals" aria-label="待确认草稿">
      {surfaceChecks.map(update => <ApprovalCard key={update.action_id} id={update.action_id} label={discardLabel(update, snapshot.views)} busy={busy} proceed="确认清空" reject="取消" onProceed={() => onConfirmSurface(update)} onReject={() => void act({ type: 'surface.respond', task_id: snapshot.task.id, action_id: update.action_id, proceed: false, confirm_discard: false })} />)}
    </section>}
    <div ref={chatScroll} className="agent-state-scroll" data-agent-view="chat" hidden={view !== 'chat'}>
      {snapshot ? <>
        {(queue.pending > 0 || queue.unknown) && <button className="agent-queue-row" aria-label="请求队列" onClick={() => setQueueOpen(true)}><span>{queue.unknown ? '核对原请求' : queue.confirmation ? '请求需要确认' : '待执行请求'}</span><span>{queue.unknown ? '发送已暂停' : `${queue.pending} 项`} ›</span></button>}
        <TaskReply key={`${snapshot.task.id}:${snapshot.runtime_epoch}`} snapshot={snapshot} scroll={chatScroll} locateApproval={view === 'chat' ? approvalTarget : undefined} underMessage={underMessage} unplaced={visible => {
          const remaining = approvals.filter(p => !approvalMessage(p, visible))
          return remaining.length ? <section className="conversation-approvals" aria-label="待审批操作">{remaining.map(approvalCard)}</section> : null
        }} />{!modelId && <p className="agent-note">选择主模型后即可发送。<button onClick={settings}>配置主模型 →</button></p>}
      </> : <p className="agent-ready">先选择或新建任务。</p>}
    </div>
    {snapshot && recordsOpened && <div className="agent-state-scroll" data-agent-view="records" hidden={view !== 'records'}>
          <button className="agent-flow-link" onClick={onShowFlow}><WorkspaceIcon name="flow" />查看执行流程 <span aria-hidden="true">›</span></button>
          {current && <AgentActivity snapshot={snapshot} run={current} />}
          <RunnerWorkingCopy runner={snapshot.runner} />
          <button className="agent-text-link" onClick={onRecords}>查看完整执行记录 →</button>
    </div>}
    {snapshot && <RequestComposer usage={<TaskUsageAction taskId={snapshot.task.id} epoch={snapshot.runtime_epoch} />} taskId={snapshot.task.id} active={snapshot.task.state === 'active'} text={text} setText={setText} modelId={modelId} models={models} busy={busy} run={Boolean(run)} composer={composer} onDirty={onDirty} refresh={refresh} queueOpen={queueOpen} setQueueOpen={setQueueOpen} onQueueChange={updateQueue} onChapterScope={onChapterScope} />}
    {tool && snapshot && <AgentDialog key={tool} title={titles[tool]} close={() => setTool(null)}>
      {tool === 'context' && <ContextPanel taskId={snapshot.task.id} modelId={modelId} latest={snapshot.records.at(-1)?.id} refresh={refresh} />}
      {tool === 'details' && detailRun && <><nav className="agent-detail-tabs" aria-label="请求详情"><button aria-pressed={detailTab === 'process'} onClick={() => setDetailTab('process')}>过程与结果</button><button aria-pressed={detailTab === 'usage'} onClick={() => setDetailTab('usage')}>用量</button><button aria-pressed={detailTab === 'raw'} onClick={() => setDetailTab('raw')}>原记录</button></nav>{detailTab === 'process' && <><button type="button" onClick={() => { setTool(null); onFlow(detailRun.id) }}>查看此执行流程</button><RunOutcome run={detailRun} taskId={snapshot.task.id} showUsage={false} /></>}{detailTab === 'usage' && <RequestUsage key={`${snapshot.runtime_epoch}:${detailRun.id}`} taskId={snapshot.task.id} runId={detailRun.id} />}{detailTab === 'raw' && <RecordBrowser taskId={snapshot.task.id} kind="run" label="本次运行" initialId={detailRun.id} />}</>}
      {tool === 'stop' && <><p>已经保存的回复和数据保留。停止后不自动重试。</p><div className="agent-dialog-actions"><button onClick={() => setTool(null)}>继续执行</button><button disabled={busy || !detailRun || !['running', 'waiting'].includes(detailRun.state)} onClick={() => { if (detailRun) void act({ type: 'run.cancel', task_id: snapshot.task.id, run_id: detailRun.id }); setTool(null) }}>停止本次执行</button></div></>}
    </AgentDialog>}
  </>
}
