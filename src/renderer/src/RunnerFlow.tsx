import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { RunnerFlowEvidence, RunnerFlowOption, RunnerFlowOptions, RunnerFlowPage, RunnerFlowScope } from '../../shared/types'
import { hostRequest } from './ModelSettings'
import { AgentDialog } from './Dialog'
import { RecordBrowser } from './TaskInspector'
import { WorkspaceIcon, type WorkspaceGlyph } from './WorkspaceIcon'

export const flowScopeKey = (scope: RunnerFlowScope | null) => scope?.run_id ?? ''
const scopeFor = (item: RunnerFlowScope): RunnerFlowScope => ({ run_id: item.run_id })

export function useFlowOptions(taskId?: string, epoch?: string) {
  const key = JSON.stringify([taskId, epoch])
  const [result, setResult] = useState<{ key: string; page: RunnerFlowOptions | null; error: boolean } | null>(null)
  useEffect(() => {
    if (!taskId) return
    let stale = false, pending = false
    async function refresh() {
      if (pending || document.hidden) return
      pending = true
      try {
        const page = await hostRequest<RunnerFlowOptions>({ type: 'host.runner.flow', task_id: taskId! })
        if (!stale && page.task_id === taskId) setResult({ key, page, error: false })
      } catch { if (!stale) setResult(old => ({ key, page: old?.key === key ? old.page : null, error: true })) }
      finally { pending = false }
    }
    void refresh()
    const timer = setInterval(refresh, 1500)
    return () => { stale = true; clearInterval(timer) }
  }, [key, taskId])
  const current = result?.key === key ? result : null
  return { page: current?.page ?? null, error: current?.error ?? false, latest: current?.page?.options[0] ? scopeFor(current.page.options[0]) : null }
}

const stateLabels: Record<string, string> = {
  planned: '已规划', queued: '排队中', running: '运行中', waiting: '等待中', succeeded: '工作完成', failed: '失败', cancelled: '已取消',
  unknown: '结果待核对', invalidated: '已失效', dependency_failed: '依赖失败', dependency_cancelled: '依赖取消',
  accepted: '已验收', indexes_received: '索引已交接', pending_layout: '待排版', pending_publication: '待发布', published: '已发布'
}
const kindLabels = { work: '任务指令', accepted: '成果验收', indexes: '成果索引', plan: '排版方案' }
const roleLabels: Record<string, string> = { router: '路由', producer: '产出', lightweight: '轻量工作', integrator: '整合', collator: '排版', diagnostic: '诊断' }
const shortId = (id: string) => id.slice(0, 8)
const label = (item: RunnerFlowScope & Partial<RunnerFlowOption>) => item.input ? `${item.input} · ${shortId(item.run_id)}` : `执行 ${shortId(item.run_id)}`
const edgeKey = (item: RunnerFlowEvidence) => `${item.id}:${item.from}:${item.to}`
const stateLabel = (item?: RunnerFlowEvidence, fallback = '等待交接') => item ? stateLabels[item.state] ?? item.state : fallback

type OpenRecord = (ref: RunnerFlowEvidence['ref']) => void
function FlowNode({ role, title, icon, state, evidence, onRecord }: { role: string; title: string; icon: WorkspaceGlyph; state: string; evidence?: RunnerFlowEvidence; onRecord: OpenRecord }) {
  const ref = evidence?.ref
  const contents = <><span className="flow-node-role"><WorkspaceIcon name={icon} />{role}</span><strong>{title}</strong><span className="flow-node-state"><i />{state}</span></>
  const tone = evidence?.state === 'accepted' || evidence?.state === 'published' || evidence?.state === 'indexes_received' ? 'done'
    : evidence && ['running', 'waiting', 'pending_layout', 'pending_publication'].includes(evidence.state) ? 'active'
    : evidence && ['failed', 'unknown', 'dependency_failed'].includes(evidence.state) ? 'attention' : undefined
  return ref ? <button className="flow-node" data-tone={tone} onClick={() => onRecord(ref)} title={`${role} · ${title} · ${state}，查看原记录`}>{contents}</button>
    : <div className="flow-node" data-tone={tone}>{contents}</div>
}
function Trace({ kind, pulse }: { kind: 'work' | 'indexes' | 'plan'; pulse: boolean }) {
  return <span className="flow-trace" data-kind={kind} aria-hidden="true">{pulse && <span className="flow-packet" />}</span>
}
function FlowGraph({ items, workCount, fresh, onRecord }: { items: RunnerFlowEvidence[]; workCount: number; fresh: Set<string>; onRecord: OpenRecord }) {
  const work = items.filter(item => item.kind === 'work')
  const accepted = new Map(items.filter(item => item.kind === 'accepted').map(item => [item.work_id, item]))
  const batches = items.filter(item => item.kind === 'indexes')
  const indexes = new Map(batches.flatMap(item => (item.work_ids ?? []).map(id => [id, item] as const)).reverse())
  const plan = items.find(item => item.kind === 'plan')
  const dispatch = work.find(item => item.from === 'Router')
  const workerIndex = work.map(item => item.work_id ? indexes.get(item.work_id) : undefined)
  const rail = (connected: boolean[]) => {
    const first = connected.indexOf(true), last = connected.lastIndexOf(true)
    if (first < 0) return undefined
    return { '--rail-first': `${(first + .5) * 100 / work.length}%`, '--rail-last': `${(last + .5) * 100 / work.length}%` } as CSSProperties
  }
  const dispatchRail = rail(work.map(item => item.from === 'Router'))
  const indexRail = rail(workerIndex.map(Boolean))
  const pulse = (item: RunnerFlowEvidence) => fresh.has(edgeKey(item))
  return <>
    <section className="flow-graph" aria-label="数据交接图">
      <div className="flow-topology">
        <FlowNode role="Router" title="分派工作" icon="flow" state={dispatch ? '已分派指令' : '等待指令'} evidence={dispatch} onRecord={onRecord} />
        <div className="flow-worker-stack" aria-label={`Worker 工作项，显示 ${work.length} 项，共 ${workCount} 项`}>
          {dispatchRail && <i className="flow-rail" data-kind="work" style={dispatchRail} aria-hidden="true" />}
          {indexRail && <i className="flow-rail" data-kind="indexes" style={indexRail} aria-hidden="true" />}
          {dispatch && <span className="flow-trunk" data-kind="work" aria-hidden="true" />}
          {indexRail && <span className="flow-trunk" data-kind="indexes" aria-hidden="true" />}
          {work.map((item, index) => {
            const outcome = accepted.get(item.work_id)
            const output = workerIndex[index]
            return <div className="flow-worker-branch" key={item.id}>
              <div>{item.from === 'Router' && <Trace kind="work" pulse={false} />}</div>
              <FlowNode role="Worker" title={`${roleLabels[item.role ?? ''] ?? '工作'} · ${shortId(item.work_id ?? item.id)}`} icon="doc" state={stateLabel(outcome ?? item)} evidence={outcome ?? item} onRecord={onRecord} />
              <div>{output && <Trace kind="indexes" pulse={false} />}</div>
              {item.from === 'Router' && pulse(item) && <span className="flow-packet flow-routed-packet" data-kind="work" style={{ '--flow-target': `${(index + .5) * 100 / work.length}%` } as CSSProperties} aria-hidden="true" />}
              {output && pulse(output) && <span className="flow-packet flow-routed-packet" data-kind="indexes" style={{ '--flow-target': `${(index + .5) * 100 / work.length}%` } as CSSProperties} aria-hidden="true" />}
            </div>
          })}
          {!work.length && <p className="flow-empty">暂无 Worker 工作项</p>}
        </div>
        <FlowNode role="Collator" title="编排成果" icon="agent" state={stateLabel(batches[0], '等待成果')} evidence={batches[0]} onRecord={onRecord} />
        <div className="flow-plan-link">{plan && <Trace kind="plan" pulse={pulse(plan)} />}</div>
        <FlowNode role="Host" title="发布内容" icon="check" state={stateLabel(plan, '等待方案')} evidence={plan} onRecord={onRecord} />
      </div>
    </section>
    {work.length < workCount && <p className="flow-empty">图中显示 {work.length} / {workCount} 项 Worker 工作。其余工作可在交接记录查看。</p>}
    <div className="flow-legend" aria-label="连线图例"><span data-kind="work"><i />任务指令</span><span data-kind="indexes"><i />成果索引</span><span data-kind="plan"><i />排版方案</span></div>
  </>
}

export function RunnerFlow({ taskId, epoch, scope, options, onScope }: {
  taskId: string; epoch: string; scope: RunnerFlowScope | null; options: ReturnType<typeof useFlowOptions>; onScope(scope: RunnerFlowScope): void
}) {
  const [extra, setExtra] = useState<{ cursor: string | null; options: RunnerFlowOption[] } | null>(null)
  const [loading, setLoading] = useState(false), [error, setError] = useState('')
  const selected = flowScopeKey(scope)
  const choices = new Map([...(scope ? [scope] : []), ...options.page?.options ?? [], ...extra?.options ?? []].map(item => [flowScopeKey(item), item]))
  const next = extra ? extra.cursor : options.page?.next_cursor
  async function more(cursor: string) {
    setLoading(true); setError('')
    try {
      const page = await hostRequest<RunnerFlowOptions>({ type: 'host.runner.flow', task_id: taskId, cursor })
      if (page.task_id === taskId) setExtra(old => ({ options: [...old?.options ?? [], ...page.options], cursor: page.next_cursor }))
    } catch { setError('无法读取更多执行。'); setExtra(null) }
    finally { setLoading(false) }
  }
  return <section className="runner-flow" aria-label="执行流程">
    <h2 className="flow-heading">执行流程</h2><div className="flow-scope"><label>执行<select aria-label="执行" value={selected} disabled={!choices.size} onChange={event => { const item = choices.get(event.target.value); if (item) onScope(scopeFor(item)) }}>
      {!choices.size && <option value="">{options.page ? '暂无执行' : '正在读取…'}</option>}
      {[...choices].map(([key, item]) => <option key={key} value={key}>{label(item)}</option>)}
    </select></label>{next && <button disabled={loading} onClick={() => void more(next)}>更多执行</button>}</div>
    {(error || options.error) && <p role="alert">{error || '执行暂不可读，会重新查询。'}</p>}
    {!scope && options.page && <p className="flow-empty">此任务还没有执行记录。</p>}
    {scope?.run_id && <FlowEvidence key={`${epoch}:${selected}`} taskId={taskId} scope={scope} />}
  </section>
}

function FlowEvidence({ taskId, scope }: { taskId: string; scope: RunnerFlowScope }) {
  const [cursor, setCursor] = useState<string | null>(null), [page, setPage] = useState<RunnerFlowPage | null>(null)
  const [graph, setGraph] = useState<{ items: RunnerFlowEvidence[]; workCount: number } | null>(null)
  const [error, setError] = useState(''), [record, setRecord] = useState<RunnerFlowEvidence['ref']>()
  const [retry, setRetry] = useState(0)
  const seen = useRef(new Set<string>()), initialized = useRef(false)
  const [fresh, setFresh] = useState(new Set<string>())
  const binding = flowScopeKey(scope)
  useEffect(() => {
    let stale = false, pending = false
    async function load() {
      if (pending || document.hidden) return
      pending = true
      try {
        const result = await hostRequest<RunnerFlowPage>({ type: 'host.runner.flow', task_id: taskId, scope, ...(cursor ? { cursor } : {}) })
        if (!stale && result.task_id === taskId && flowScopeKey(result.scope) === binding) {
          if (!cursor) {
            const items = result.graph ?? result.items
            const links = items.filter(item => item.from && item.to).map(edgeKey)
            if (initialized.current && !matchMedia('(prefers-reduced-motion: reduce)').matches) setFresh(new Set(links.filter(key => !seen.current.has(key))))
            else setFresh(new Set())
            links.forEach(key => seen.current.add(key))
            initialized.current = true
            setGraph({ items, workCount: result.work_count })
          }
          setPage(result); setError('')
        }
      } catch { if (!stale) setError('此执行的交接暂不可读，请重新查询。') }
      finally { pending = false }
    }
    void load()
    const timer = cursor ? undefined : setInterval(load, 1000)
    return () => { stale = true; clearInterval(timer) }
  }, [taskId, binding, cursor, retry])
  function changePage(next: string | null) { initialized.current = false; setFresh(new Set()); setPage(null); setError(''); setCursor(next) }
  const title = (item: RunnerFlowEvidence) => item.kind === 'work' && !item.from ? '工作记录' : kindLabels[item.kind]
  return <>
    {error && <p role="alert">{error} <button onClick={() => { if (cursor) changePage(null); else setRetry(value => value + 1) }}>重新查询交接</button></p>}
    {!page && !error && <p role="status">正在读取交接…</p>}
    {graph && <FlowGraph items={graph.items} workCount={graph.workCount} fresh={fresh} onRecord={setRecord} />}
    {page && <>
      <header className="flow-section-heading"><h2>最近交接</h2><span>{page.work_count} 项 Worker 工作</span></header>
      {!page.items.length && <p className="flow-empty">没有可验证的交接证据。</p>}
      <ol className="flow-evidence">{page.items.map(item => <li key={item.id}>
        <div><b>{title(item)}</b>{item.from && <span>{item.from} → {item.to}</span>}<span>{stateLabels[item.state] ?? item.state}</span></div>
        <div>{item.work_id && <span>工作 {shortId(item.work_id)}{item.role && roleLabels[item.role] ? ` · ${roleLabels[item.role]}` : ''}{item.attempt ? ` · 尝试 ${item.attempt}` : ''}</span>}
          {item.count !== undefined && <span>{item.count} 项索引</span>}{item.shared && <span>共享批次</span>}
          {item.at && Number.isFinite(Date.parse(item.at)) && <time dateTime={item.at}>{new Date(item.at).toLocaleTimeString()}</time>}
          {item.ref && <button onClick={() => setRecord(item.ref)}>查看原记录</button>}</div>
      </li>)}</ol>
      {(cursor || page.next_cursor) && <div className="inline-actions">{cursor && <button onClick={() => changePage(null)}>返回首批交接</button>}{page.next_cursor && <button onClick={() => changePage(page.next_cursor)}>更多交接</button>}</div>}
    </>}
    {record && <AgentDialog title="交接原记录" close={() => setRecord(undefined)}><RecordBrowser taskId={taskId} initialId={record.id} kind={record.kind} label="交接依据" followReferences={false} /></AgentDialog>}
  </>
}
