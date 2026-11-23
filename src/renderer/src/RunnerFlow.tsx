import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { liveFlowPageSize, type LiveFlowItem, type LiveFlowSnapshot, type LiveFlowState, type RunnerFlowRole } from '../../shared/types'
import { hostRequest } from './ModelSettings'
import { WorkspaceIcon, type WorkspaceGlyph } from './WorkspaceIcon'
import { useWorkspaceContentVisible } from './WorkspaceLayout'

const lanes = [
  ['Router', '路由', 'flow'], ['Worker', '生产', 'agent'], ['Collator', '排版', 'doc'], ['Host', '发布与核对', 'check']
] as const satisfies readonly [RunnerFlowRole, string, WorkspaceGlyph][]
const stateLabels: Record<LiveFlowState, string> = {
  queued: '排队中', running: '进行中', waiting: '等待中', approval: '待审批', input: '待确认', unknown: '结果待核对', closing: '收尾中', publishing: '发布中'
}
const workLabels: Record<string, string> = { producer: '内容生产', lightweight: '轻量工作', integrator: '整合', diagnostic: '诊断', collator: '排版' }
const reasons: Record<string, string> = {
  material_pending: '等待材料导入', material_preflight: '正在检查材料', CONVERSATION_WAITING_FOR_RESULT: '等待前一轮回复',
  CHAPTER_SCOPE_REQUIRED: '等待确认章节范围', approval_evaluating: '正在评估权限', model_queue: '等待模型名额',
  model_generating: '正在生成', composition_queue: '等待编排批次', context_compacting: '正在整理上下文',
  ending_cleanup: '正在结束执行', surface_host: '正在检查内容更新'
}
const handoffLabels = { work: '任务指令', indexes: '成果索引', plan: '发布方案' }
const short = (id: string) => id.slice(0, 8)
const itemName = (item: LiveFlowItem) => item.kind === 'batch' ? item.role === 'Collator' ? '排版批次' : '批次发布'
  : item.kind === 'chapter' ? '章节更新' : item.kind === 'work' ? workLabels[item.work_role ?? ''] ?? '工作' : item.kind === 'request' ? '请求' : '执行'
const stateName = (item: LiveFlowItem) => item.state === 'running' && item.role === 'Collator' ? '排版中'
  : item.state === 'queued' && item.role === 'Collator' ? '待排版'
  : item.state === 'queued' && item.role === 'Host' ? '待发布'
  : item.state === 'running' && item.role === 'Router' ? '路由中' : stateLabels[item.state]
const sourceName = (item: LiveFlowItem) => {
  const count = item.source_count ?? item.sources.length
  if (count > 1) return `${count} 个来源`
  const first = item.sources[0], id = first?.message_id ?? first?.request_id ?? first?.run_id
  return id ? `来源 ${short(id)}` : ''
}
const handoffKey = (item: LiveFlowItem) => `${item.id}:${item.handoff?.sequence}`
const requests = new Map<string, Promise<LiveFlowSnapshot>>()
type Pages = Partial<Record<RunnerFlowRole, number>>
type Read = { status: 'loading' | 'unavailable' } | { status: 'ready'; snapshot: LiveFlowSnapshot }
export type FlowFocus = { runId: string }
export type FlowApproval = { approvalId: string; messageId?: string }

export function RunnerFlow({ taskId, epoch, focus, paused, onApproval }: {
  taskId: string; epoch: string; focus?: FlowFocus; paused: boolean; onApproval(target: FlowApproval): void
}) {
  const active = useWorkspaceContentVisible() && !paused
  const [read, setRead] = useState<Read>({ status: 'loading' })
  const [selected, setSelected] = useState<string | null>(null)
  const [pulses, setPulses] = useState<ReadonlySet<string>>(new Set())
  const root = useRef<HTMLElement>(null), heading = useRef<HTMLHeadingElement>(null)
  const previousFocus = useRef<{ node: HTMLElement; id?: string } | null>(null)
  const focusCard = useRef<string | undefined>(undefined)
  const wantedFocus = useRef(focus), handledFocus = useRef<FlowFocus | undefined>(undefined)
  const pages = useRef<Pages>({}), navigation = useRef(0), wake = useRef<() => void>(() => {})

  useEffect(() => {
    if (!active) return
    const key = JSON.stringify([taskId, epoch])
    let disposed = false, generation = 0, baseline: number | undefined
    let timer: ReturnType<typeof setTimeout> | undefined, pulseTimer: ReturnType<typeof setTimeout> | undefined
    let awaiting = false
    const rememberFocus = () => {
      const node = document.activeElement
      if (node instanceof HTMLElement && root.current?.contains(node)) previousFocus.current = { node, id: node.closest<HTMLElement>('[data-flow-id]')?.dataset.flowId }
    }
    function schedule(delay: number) {
      clearTimeout(timer)
      if (!disposed && !document.hidden && navigator.onLine) timer = setTimeout(tick, delay)
    }
    async function tick() {
      if (disposed || awaiting || document.hidden || !navigator.onLine) return
      const currentGeneration = generation, nav = navigation.current
      const requested = wantedFocus.current === handledFocus.current ? undefined : wantedFocus.current
      awaiting = true
      const pending = requests.get(key)
      if (pending) {
        await pending.catch(() => {})
        awaiting = false
        schedule(0)
        return
      }
      const request = hostRequest<LiveFlowSnapshot>({ type: 'host.runner.flow', task_id: taskId,
        pages: pages.current, ...(requested ? { focus_run_id: requested.runId } : {}) })
      requests.set(key, request)
      const isCurrent = () => !disposed && currentGeneration === generation && !document.hidden && navigator.onLine
      try {
        const snapshot = await request
        if (!isCurrent() || nav !== navigation.current) return
        if (snapshot.task_id !== taskId || snapshot.runtime_epoch !== epoch) throw Error('Stale flow')
        const items = lanes.flatMap(([role]) => snapshot.lanes[role].items)
        const recent = baseline === undefined ? [] : items.filter(item => item.handoff && item.handoff.sequence > baseline! && item.handoff.sequence <= snapshot.through_sequence)
        baseline = Math.max(baseline ?? 0, snapshot.through_sequence)
        rememberFocus()
        pages.current = Object.fromEntries(lanes.map(([role]) => [role, snapshot.lanes[role].page]))
        if (requested) {
          handledFocus.current = requested
          focusCard.current = snapshot.focus?.id
          setSelected(snapshot.focus?.id ?? null)
        } else setSelected(value => items.some(item => item.id === value) ? value : null)
        setRead({ status: 'ready', snapshot })
        if (recent.length) {
          setPulses(new Set(recent.map(handoffKey)))
          clearTimeout(pulseTimer)
          pulseTimer = setTimeout(() => setPulses(new Set()), 1000)
        }
      } catch {
        if (isCurrent()) {
          baseline = undefined
          rememberFocus()
          setPulses(new Set()); setRead({ status: 'unavailable' })
        }
      } finally {
        if (requests.get(key) === request) requests.delete(key)
        awaiting = false
        schedule(currentGeneration === generation && nav === navigation.current ? 900 : 0)
      }
    }
    function visibilityChanged() {
      generation++; baseline = undefined
      clearTimeout(timer); clearTimeout(pulseTimer)
      setPulses(new Set())
      if (!navigator.onLine) { rememberFocus(); setRead({ status: 'unavailable' }) }
      else if (!document.hidden) { rememberFocus(); setRead({ status: 'loading' }); schedule(0) }
    }
    wake.current = () => schedule(0)
    document.addEventListener('visibilitychange', visibilityChanged)
    window.addEventListener('online', visibilityChanged); window.addEventListener('offline', visibilityChanged)
    visibilityChanged()
    return () => {
      disposed = true; clearTimeout(timer); clearTimeout(pulseTimer); wake.current = () => {}
      document.removeEventListener('visibilitychange', visibilityChanged)
      window.removeEventListener('online', visibilityChanged); window.removeEventListener('offline', visibilityChanged)
    }
  }, [active, taskId, epoch])
  useEffect(() => { wantedFocus.current = focus; navigation.current++; wake.current() }, [focus])

  useLayoutEffect(() => {
    const previous = previousFocus.current, target = focusCard.current
    previousFocus.current = null; focusCard.current = undefined
    const find = (id: string) => [...root.current?.querySelectorAll<HTMLButtonElement>('.flow-card') ?? []].find(node => node.dataset.flowId === id)
    if (target) find(target)?.focus()
    else if (previous && !previous.node.isConnected && document.activeElement === document.body) (previous.id && find(previous.id) || heading.current)?.focus({ preventScroll: true })
  }, [read])

  const snapshot = read.status === 'ready' ? read.snapshot : null
  const selectedItem = snapshot && lanes.flatMap(([role]) => snapshot.lanes[role].items).find(item => item.id === selected)
  const total = snapshot ? lanes.reduce((sum, [role]) => sum + snapshot.lanes[role].total, 0) : 0
  function page(role: RunnerFlowRole, index: number) { pages.current = { ...pages.current, [role]: index }; navigation.current++; wake.current() }
  return <section ref={root} className="runner-flow" aria-labelledby="runner-flow-heading">
    <header className="flow-heading"><h2 id="runner-flow-heading" ref={heading} tabIndex={-1}>实时执行流程</h2>{snapshot && total > 0 && <span>{total} 项在途</span>}</header>
    {read.status === 'loading' && <p className="flow-feedback" role="status">正在读取执行状态…</p>}
    {read.status === 'unavailable' && <div className="flow-feedback" role="status">状态暂不可用 <button type="button" onClick={() => wake.current()}>重试</button></div>}
    {snapshot && total === 0 && <p className="flow-feedback" role="status">当前没有正在执行的工作</p>}
    <div className="flow-board" aria-label="任务实时状态">
      {lanes.map(([role, label, icon]) => {
        const lane = snapshot?.lanes[role]
        const remaining = lane ? Math.max(0, lane.total - lane.page * liveFlowPageSize - lane.items.length) : 0
        return <section className="flow-lane" key={role} aria-label={role}>
          <header><WorkspaceIcon name={icon} /><h3>{role}</h3>{Boolean(lane?.total) && <span>{lane?.total}</span>}<small>{label}</small></header>
          {lane && <>{lane.items.length ? <ul>{lane.items.map(item => <li key={item.id}>
            <button className="flow-card" type="button" data-flow-id={item.id} data-state={item.state} aria-pressed={selected === item.id} onClick={() => setSelected(value => value === item.id ? null : item.id)}>
              <strong>{itemName(item)}</strong>{sourceName(item) && <small>{sourceName(item)}</small>}
              <span className="flow-card-state"><i aria-hidden="true" />{stateName(item)}</span>
              {item.reason && reasons[item.reason] && <small>{reasons[item.reason]}</small>}
              {item.handoff && <span className="flow-handoff" data-kind={item.handoff.kind}>
                <span>{item.handoff.from} → {role}</span><small>{handoffLabels[item.handoff.kind]}</small>
                <span className="flow-track" aria-hidden="true">{pulses.has(handoffKey(item)) && <i className="flow-packet" key={handoffKey(item)} />}</span>
              </span>}
            </button>
          </li>)}</ul> : <p className="flow-lane-empty">—</p>}
          {(remaining > 0 || lane.page > 0) && <nav className="flow-pages" aria-label={`${role} 当前工作分页`}>
            {lane.page > 0 && <button type="button" onClick={() => page(role, lane.page - 1)}>上一页</button>}
            {remaining > 0 && <button type="button" onClick={() => page(role, lane.page + 1)}>还有 {remaining} 项</button>}
          </nav>}</>}
        </section>
      })}
    </div>
    {selectedItem && <section className="flow-detail" aria-labelledby="flow-detail-heading" data-flow-id={selectedItem.id}>
      <header><h3 id="flow-detail-heading">{itemName(selectedItem)}</h3><span>{stateName(selectedItem)}</span></header>
      {selectedItem.sources.length > 0 && <dl><dt>来源</dt><dd>{selectedItem.sources.map((ref, index) => {
        const id = ref.message_id ?? ref.request_id ?? ref.run_id
        return id ? <code key={`${id}:${index}`} title={id}>{short(id)}</code> : null
      })}{(selectedItem.source_count ?? 0) > selectedItem.sources.length && <span>另有 {selectedItem.source_count! - selectedItem.sources.length} 个来源</span>}</dd></dl>}
      {selectedItem.approval_id && <button type="button" onClick={() => onApproval({ approvalId: selectedItem.approval_id!, messageId: selectedItem.sources.find(ref => ref.message_id)?.message_id })}>前往 Agent 审批</button>}
    </section>}
  </section>
}
