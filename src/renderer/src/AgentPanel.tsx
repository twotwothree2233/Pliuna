import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { HostRequest, Run, Snapshot } from '../../shared/types'
import type { ModelState } from './ModelSettings'
import { AgentDialog } from './Dialog'
import { PaneClose } from './WorkspaceLayout'
import { ContextPanel } from './ContextPanel'
import { ApprovalCard } from './ApprovalCard'
import { RunOutcome } from './RunOutcome'
import { RequestUsage } from './RequestUsage'
import { RecordBrowser } from './TaskInspector'
import { RequestComposer, type RequestQueueState } from './RequestComposer'
import { AgentActivity } from './AgentActivity'

type Tool = 'details' | 'context' | 'pending' | 'stop' | null
export function runStatus(run?: Run) {
  if (!run) return '就绪'
  if (run.state === 'running' || run.state === 'waiting') return ({ approval: '等待你批准', surface_host: '等待确认替换', context_compacting: '正在整理上下文', model_queue: '等待服务名额', model_generating: '正在生成', ending_cleanup: '正在结束执行' } as Record<string, string>)[run.wait_reason ?? ''] ?? '正在执行'
  if (run.state === 'completed') return run.primary_reason === 'context_organized' ? '上下文已整理' : run.primary_reason === 'fixture_complete' ? '示例执行已完成' : '本次执行已完成'
  return ({ failed: '本次执行失败', cancelled: '本次执行已停止', interrupted: '本次执行中断' } as Record<string, string>)[run.state] ?? '本次执行已结束'
}
const approvalTitle = (approval: Snapshot['approvals'][number]) => ({ 'task_data.replace': '更新任务数据', 'task_data.remove': '移除任务数据', 'surface.update': '更新任务内容', 'plugin.invoke': '调用插件' } as Record<string, string>)[(approval.request as { type?: string }).type ?? ''] ?? '确认本次修改'

export function AgentPanel({ snapshot, run, modelId, models, busy, text, setText, composer, onDirty, refresh, act, settings, onRecords, surfaceChecks }: {
  snapshot: Snapshot | null; run?: Run; modelId: string; models: ModelState; busy: boolean
  text: string; setText(value: string): void; composer: RefObject<HTMLTextAreaElement | null>
  onDirty(id: string, dirty: boolean): void; refresh(): Promise<void>; act(request: HostRequest): Promise<void>; settings(): void; onRecords(): void
  surfaceChecks: { id: string; content: ReactNode }[]
}) {
  const [tool, setTool] = useState<Tool>(null), [menu, setMenu] = useState(false), [detailTab, setDetailTab] = useState<'process' | 'usage' | 'raw'>('process')
  const [queueOpen, setQueueOpen] = useState(false), [queue, setQueue] = useState<RequestQueueState>({ pending: 0, confirmation: 0, unknown: false }), [selected, setSelected] = useState('')
  const menuRoot = useRef<HTMLDivElement>(null)
  const current = run ?? snapshot?.runs[0]
  const pending = snapshot?.approvals.filter(p => p.decision === 'pending' && p.validity === 'valid') ?? []
  const items = [...pending.map(p => ({ id: p.id, title: approvalTitle(p), content: <ApprovalCard key={`${p.id}:${p.handling}`} taskId={snapshot!.task.id} approval={p} busy={busy} decide={decision => { setTool(null); void act({ type: 'approval.decide', task_id: snapshot!.task.id, approval_id: p.id, decision }) }} /> })), ...surfaceChecks.map(check => ({ ...check, title: '确认替换任务内容' }))]
  const active = items.find(item => item.id === selected) ?? items[0]
  const status = !snapshot ? '未选择任务' : queue.unknown ? '发送结果待核对' : queue.confirmation ? '材料需要确认' : pending.length ? '等待你批准' : surfaceChecks.length ? '等待确认替换' : !run && queue.pending ? '等待材料与排队' : runStatus(current)
  const phase = queue.unknown || queue.confirmation || items.length || current?.state === 'failed' || current?.state === 'interrupted' ? 'attention' : run ? 'running' : current?.state === 'completed' ? 'done' : 'idle'
  useEffect(() => { if (tool === 'pending' && !active) setTool(null) }, [tool, active?.id])
  useEffect(() => {
    if (!menu) return
    menuRoot.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    const dismiss = (event: PointerEvent) => { if (!menuRoot.current?.contains(event.target as Node)) setMenu(false) }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [menu])
  const open = (value: Tool) => { setMenu(false); setTool(value) }
  const titles = { details: '本次请求详情', context: '工作摘要与上下文', pending: '待处理事项', stop: '停止当前执行？' }
  return <>
    <header className="agent-heading" data-phase={phase}><b>Agent</b><span className="agent-status" role={snapshot ? 'status' : undefined} title={status}>{status}</span><div className="agent-actions">
      {snapshot && <div className="agent-menu-root" ref={menuRoot}><button className="agent-icon" aria-label="更多 Agent 操作" aria-expanded={menu} aria-haspopup="menu" onClick={() => setMenu(value => !value)}>···</button>{menu && <div className="agent-menu" role="menu" onKeyDown={event => { if (event.key === 'Escape') { setMenu(false); menuRoot.current?.querySelector<HTMLButtonElement>('.agent-icon')?.focus() }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault()
          const choices = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')], index = choices.indexOf(document.activeElement as HTMLButtonElement)
          choices[event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length]?.focus()
        } }}>
        {current && <button role="menuitem" onClick={() => { setDetailTab('process'); open('details') }}>本次请求详情</button>}<button role="menuitem" onClick={() => open('context')}>工作摘要与上下文</button><button role="menuitem" onClick={() => { setMenu(false); setQueueOpen(true) }}>请求队列</button>
      </div>}</div>}<PaneClose side="right" />
    </div></header>
    <div className="agent-state-scroll">
      {snapshot ? <>
        <section className="agent-task"><span>当前任务</span><b>{snapshot.task.title}</b></section>
        {current ? <AgentActivity snapshot={snapshot} run={current} /> : <section className="agent-ready"><h2>准备就绪</h2><p>在下方输入指令，结果保存在任务区。</p></section>}
        {active && <section className="agent-pending-summary" aria-label="当前待处理"><header><span>需要你处理</span><small>{items.length} 项</small></header><b>{active.title}</b><button disabled={busy} onClick={() => { setSelected(active.id); open('pending') }}>查看并处理 →</button></section>}
        {(queue.pending > 0 || queue.unknown) && <button className="agent-queue-row" aria-label="请求队列" onClick={() => setQueueOpen(true)}><span>{queue.unknown ? '核对原请求' : queue.confirmation ? '材料需要确认' : '待执行请求'}</span><span>{queue.unknown ? '发送已暂停' : `${queue.pending} 项`} ›</span></button>}
        <dl className="agent-state-facts"><div><dt>内容单元</dt><dd>{snapshot.view_page?.total ?? snapshot.views.length}</dd></div><div><dt>任务数据</dt><dd>{snapshot.task_data.total} 项</dd></div></dl>
        {modelId === 'fixture' && <p className="agent-note">开发夹具 · 本机固定示例，不联网。</p>}{!modelId && <p className="agent-note">选择主模型后即可发送。<button onClick={settings}>配置主模型 →</button></p>}
      </> : <section className="agent-ready"><h2>先选择任务</h2><p>选择或新建任务后查看执行状态。</p></section>}
    </div>
    {snapshot && <><footer className="agent-state-footer"><button className="agent-text-link" onClick={onRecords}>查看执行记录 →</button></footer><RequestComposer taskId={snapshot.task.id} active={snapshot.task.state === 'active'} text={text} setText={setText} modelId={modelId} models={models} busy={busy} run={Boolean(run)} composer={composer} onDirty={onDirty} refresh={refresh} queueOpen={queueOpen} setQueueOpen={setQueueOpen} onQueueChange={setQueue} stop={run ? () => open('stop') : undefined} /></>}
    {tool && snapshot && <AgentDialog key={tool} title={titles[tool]} close={() => setTool(null)}>
      {tool === 'pending' && active && <>{items.length > 1 && <nav className="agent-pending-tabs" aria-label="选择待处理事项">{items.map((item, index) => <button key={item.id} aria-pressed={item.id === active.id} onClick={() => setSelected(item.id)}>{index + 1} · {item.title}</button>)}</nav>}<div key={active.id}>{active.content}</div></>}
      {tool === 'context' && <ContextPanel taskId={snapshot.task.id} modelId={modelId} latest={snapshot.records.at(-1)?.id} refresh={refresh} />}
      {tool === 'details' && current && <><nav className="agent-detail-tabs" aria-label="请求详情"><button aria-pressed={detailTab === 'process'} onClick={() => setDetailTab('process')}>过程与结果</button><button aria-pressed={detailTab === 'usage'} onClick={() => setDetailTab('usage')}>用量</button><button aria-pressed={detailTab === 'raw'} onClick={() => setDetailTab('raw')}>原记录</button></nav>{detailTab === 'process' && <RunOutcome run={current} taskId={snapshot.task.id} showUsage={false} />}{detailTab === 'usage' && <RequestUsage taskId={snapshot.task.id} runId={current.id} />}{detailTab === 'raw' && <RecordBrowser taskId={snapshot.task.id} kind="run" label="本次运行" initialId={current.id} />}</>}
      {tool === 'stop' && <><p>已经保存的回复和数据保留。停止后不自动重试。</p><div className="agent-dialog-actions"><button onClick={() => setTool(null)}>继续执行</button><button disabled={busy || !run} onClick={() => { if (run) void act({ type: 'run.cancel', task_id: snapshot.task.id, run_id: run.id }); setTool(null) }}>停止本次执行</button></div></>}
    </AgentDialog>}
  </>
}
