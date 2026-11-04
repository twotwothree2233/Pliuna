import { useEffect, useRef, useState } from 'react'
import type { Snapshot } from '../../shared/types'
import { hostRequest } from './ModelSettings'
import { RunOutcome } from './RunOutcome'
import { ContentReader } from './ContentReader'
import type { ModelRequest } from '../../shared/contracts.generated'
import { extractionCoverage, sourceFacts, sourceFieldLocations, type Provenance } from './source-facts'

type Kind = Extract<ModelRequest, { type: 'list' }>['input']['kind']
type Item = { id: string; display_name?: string; revision?: number; state?: string; result?: string; decision?: string; created_at?: string }
type DerivedResults = { items: { resource_id: string; call_id: string; partial: boolean; plugin_version: string }[]; truncated: boolean }
type ReadResult = { data: unknown; metadata?: { provenance?: Provenance | null; derived_results?: DerivedResults }; representation?: string; next_cursor: string | null; truncated: boolean; content_version?: string }
export function RecordBrowser({ taskId, kind, label, initialId, initialRevision, followReferences = true, onComplete }: { taskId: string; kind: Kind; label: string; initialId?: string; initialRevision?: number; followReferences?: boolean; onComplete?(id: string): void }) {
  const [items, setItems] = useState<Item[]>([]), [cursor, setCursor] = useState<string | null>(null)
  const [selection, setSelection] = useState<Item | null>(null), [detail, setDetail] = useState(''), [readCursor, setReadCursor] = useState<string | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [provenance, setProvenance] = useState<Provenance | null>(null), [originalCall, setOriginalCall] = useState<string | null>(null)
  const [derivedResults, setDerivedResults] = useState<DerivedResults | null>(null)
  const [listedTotal, setListedTotal] = useState(0)
  const [windowed, setWindowed] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [linkedTarget, setLinkedTarget] = useState<{ kind: 'resource' | 'task_data'; id: string; revision?: number } | null>(null)
  useEffect(() => { if (initialId) void read({ id: initialId, revision: initialRevision }) }, [initialId, initialRevision])
  const textWindow = useRef('')
  const generation = useRef(0)
  useEffect(() => { return () => { generation.current++ } }, [])
  async function load(more = false) {
    onComplete?.('')
    const current = ++generation.current; setBusy(true); setError('')
    try {
      const page = await hostRequest<{ items: Item[]; next_cursor: string | null }>({ type: 'task.query', task_id: taskId, query: { type: 'list', input: { kind, limit: 50, ...(more && cursor ? { cursor } : {}) } } })
      if (current !== generation.current) return
      setLoaded(true); setListedTotal(old => more ? old + page.items.length : page.items.length)
      setItems(old => more ? [...new Map([...old, ...page.items].map(item => [item.id, item])).values()].slice(-200) : page.items); setCursor(page.next_cursor)
      if (!more) { setSelection(null); setDetail(''); setReadCursor(null); setLinkedTarget(null); setProvenance(null); setOriginalCall(null); setDerivedResults(null) }
    } catch (e) { if (current === generation.current) setError(String(e)) }
    finally { if (current === generation.current) setBusy(false) }
  }
  async function read(item: Item, more = false) {
    onComplete?.('')
    const current = ++generation.current; setBusy(true); setError('')
    if (!more) { setSelection(item); textWindow.current = ''; setWindowed(false); setDetail(''); setReadCursor(null); setLinkedTarget(null); setProvenance(null); setOriginalCall(null); setDerivedResults(null) }
    try {
      const result = await hostRequest<ReadResult>({ type: 'task.query', task_id: taskId, query: { type: 'read', input: { target: { kind, id: item.id, ...(item.revision ? { expected_revision: item.revision } : {}) }, ...(more && readCursor ? { cursor: readCursor } : {}) } } })
      if (current !== generation.current) return
      setProvenance(result.metadata?.provenance ?? (result.data as { provenance?: Provenance | null })?.provenance ?? null)
      setDerivedResults(result.metadata?.derived_results ?? (result.data as { derived_results?: DerivedResults })?.derived_results ?? null)
      const text = result.representation ? (result.data as { text: string }).text : JSON.stringify(result.data, null, 2)
      const next = more ? textWindow.current + text : text
      if (next.length > 256 * 1024) setWindowed(true)
      textWindow.current = next.slice(-256 * 1024); setDetail(textWindow.current); setReadCursor(result.next_cursor)
      if (!result.next_cursor) onComplete?.(item.id)
    } catch (e) { if (current === generation.current) { setError(String(e)); textWindow.current = ''; setDetail(''); setReadCursor(null); setProvenance(null); setDerivedResults(null) } }
    finally { if (current === generation.current) setBusy(false) }
  }
  let references: { name: string; target: { kind: string; id: string; expected_revision?: number } }[] = []
  if (!windowed && followReferences && kind === 'task_data' && detail && !readCursor) { try { references = JSON.parse(detail).references ?? [] } catch { /* Incomplete text is not a JSON object. */ } }
  if (!windowed && followReferences && ['view_history', 'answer'].includes(kind) && detail && !readCursor) {
    try {
      const value = JSON.parse(detail), evidence = kind === 'answer' ? value.view_history?.evidence : value.evidence
      references = (evidence?.sources ?? []).flatMap((source: any) => (source.references ?? []).filter((ref: any) => ref.target.kind === 'resource').map((ref: any) => ({ ...ref, name: source.id + ' · ' + ref.name })))
    } catch { /* Evidence navigation requires a complete representation. */ }
  }
  return <section aria-label={label + '分页浏览'} className="record-browser">
    <header className="section-heading"><h3>{label}</h3><button disabled={busy} onClick={() => void load()}>刷新{label}</button></header>
    <p className="muted">每页最多 50 条，按创建顺序读取；无时间字段按保存顺序。列表为实时结果，界面最多保留最近加载的 200 项，变化后可刷新。查看不会执行或批准操作。</p>
    {['view_history', 'answer'].includes(kind) && <p className="notice">这里是发布时保存的依据，不代表材料已核实。源数据更新或移除不改写历史；未声明的数据和可变引用目标不会递归冻结。资源完整性单独列示，不以当前数据替代。</p>}
    {initialRevision !== undefined && <p className="notice">引用绑定版本 r{initialRevision}；不自动跟随或保存旧版全文。查看当前版本不会修改引用。</p>}
    {error && <p role="alert" className="error">{error}。内容变化时请刷新列表并重新读取，不能拼接旧片段。</p>}
    <div className="object-list">{items.map((item, index) => <button disabled={busy} key={item.id} onClick={() => void read(item)}><span>{index + 1}. {item.display_name && <strong>{item.display_name} · </strong>}<span className="mono">{item.id}</span></span><span>{item.state ?? item.decision ?? (item.revision ? `r${item.revision}` : '')} {item.result ?? ''} · 查看原结果</span></button>)}</div>
    {cursor && <button disabled={busy} onClick={() => void load(true)}>加载更多{label}</button>}
    {loaded && !items.length && <p role="status">没有可用的{label}记录</p>}
    {!!items.length && !cursor && <p role="status">{label}已加载到底 · 已遍历 {listedTotal} 条，当前显示 {items.length} 条</p>}
    {selection && <article aria-label={label + '全文'}><h4>只读原记录{kind === 'task_data' && (selection.revision ? ` · 请求 r${selection.revision}` : ' · 当前版本')}</h4><pre>{detail}</pre>{windowed && <p className="notice">为限制内存，仅显示末尾 256K 字符；旧片段已读但不再显示，可重新查询原记录。</p>}{readCursor ? <><p>当前为 JSON 文本片段，不是完整对象。</p><button disabled={busy} onClick={() => void read(selection, true)}>继续读取全文</button></> : detail && <p role="status">全文读取完成</p>}<button disabled={busy} onClick={() => void read(selection)}>重新查询原记录</button>{initialRevision !== undefined && <button disabled={busy} onClick={() => void read({ id: selection.id })}>查看当前版本（不更新引用）</button>}</article>}
    {references.filter(reference => reference.target.kind === 'resource' || reference.target.kind === 'task_data').map(reference => <button key={reference.name} disabled={busy} onClick={() => setLinkedTarget({ kind: reference.target.kind as 'resource' | 'task_data', id: reference.target.id, revision: reference.target.expected_revision })}>查看引用{reference.target.kind === 'resource' ? '资源' : '数据'}：{reference.name}{reference.target.expected_revision !== undefined ? ` · 绑定 r${reference.target.expected_revision}` : ''}</button>)}
    {followReferences && provenance && <section aria-label="派生材料来源"><h4>派生材料来源</h4><p className="notice">原件身份与原 Call 已按保存事实核对。这是保存的来源绑定，不是本次重新提取或对原件语义的认证。页码和提取文字由工具报告，不代表内容已核实；仅导航，不自动读取、重新解析或启动模型。</p><p>插件版本 {provenance.plugin_version} · {provenance.pages.length} 个页面索引 · {extractionCoverage(provenance.partial)}</p>{provenance.notice && <p role="status">{provenance.notice}</p>}<details><summary>宿主登记的来源事实</summary><dl>{sourceFacts(provenance).map(row => <div key={row.label}><dt>{row.label}</dt><dd className="mono">{row.value}</dd></div>)}</dl><p>这里只展示来源导航返回的字段；派发、执行与交付状态请查看原 Call，不从来源摘要推导全部业务已完成。</p></details><details><summary>各项来源字段在哪里</summary><dl>{sourceFieldLocations.map(row => <div key={row.label}><dt>{row.label}</dt><dd>{row.location}</dd></div>)}</dl><p>字段未返回不等于事实矛盾；尚未读取不能声称已经核对。精确参数在执行记录的 material.derived 原事件中按原 ID 查询。</p></details><button disabled={busy} onClick={() => setLinkedTarget({ kind: 'resource', id: provenance.input.id })}>查看派生原件</button><button disabled={busy} onClick={() => setOriginalCall(provenance.call_id)}>查看派生原 Call</button><details><summary>工具报告的页面字节索引</summary><p>start / end 为提取文本的 UTF-8 字节范围 [start, end)，不是原 PDF 的字节偏移。页码与文本语义均为工具报告，宿主只核对结构、边界及来源绑定。</p><pre>{JSON.stringify(provenance.pages, null, 2)}</pre></details></section>}
    {followReferences && !!derivedResults?.items.length && <section aria-label="已有派生结果"><h4>已有派生结果（最近 20 项）</h4><p className="notice">每次解析是独立结果，不覆盖旧结果。选择只读查看不会重新解析或调用模型。未标记部分结果也不保证语义完整；是否适合当前问题仍需读取结果判断。</p>{derivedResults.items.map((item, index) => <button key={item.resource_id} disabled={busy} onClick={() => setLinkedTarget({ kind: 'resource', id: item.resource_id })}>查看派生结果 {index + 1} · {item.partial ? '部分结果' : '工具未标记部分'} · v{item.plugin_version}</button>)}{derivedResults.truncated && <p>还有更早结果，请在事件记录中查询 material.derived；这里只显示最近 20 项。</p>}</section>}
    {selection && kind === 'resource' && <ContentReader key={selection.id} taskId={taskId} resourceId={selection.id} hasPages={!!provenance?.pages.length} />}
    {linkedTarget && <RecordBrowser key={`${linkedTarget.kind}:${linkedTarget.id}:${linkedTarget.revision}`} taskId={taskId} kind={linkedTarget.kind} label={linkedTarget.kind === 'resource' ? '引用资源' : '引用数据'} initialId={linkedTarget.id} initialRevision={linkedTarget.revision} followReferences={false} />}
    {originalCall && <RecordBrowser key={originalCall} taskId={taskId} kind="call" label="派生原 Call" initialId={originalCall} followReferences={false} />}
  </section>
}

export function TaskData({ snapshot }: { snapshot: Snapshot }) {
  const [value, setValue] = useState<{ id: string; revision: number; value: unknown; schema: unknown } | null>(null)
  const [error, setError] = useState('')
  const generation = useRef(0)
  useEffect(() => () => { generation.current++ }, [])
  async function read(id: string, revision: number) {
    const current = ++generation.current; setError(''); setValue(null)
    try {
      const next = await hostRequest<NonNullable<typeof value>>({ type: 'task.data.read', task_id: snapshot.task.id, id, expected_revision: revision })
      if (current === generation.current) setValue(next)
    } catch (e) { if (current === generation.current) setError(String(e)) }
  }
  return <section className="inspector" aria-label="任务数据查看器">
    <header className="section-heading"><h2>任务数据</h2><span>{snapshot.task_data.total} 个对象 · 只读查看</span></header>
    <p className="muted">Agent 保存的结构化数据。不是宿主权限或已核实的事实；修改已有数据仍需按具体操作授权。</p>
    <RecordBrowser taskId={snapshot.task.id} kind="task_data" label="全部任务数据" />
    {error && <p role="alert" className="error">{error}</p>}
    {!snapshot.task_data.total && <div className="empty-state"><h3>尚无任务数据</h3><p>Agent 创建的对象会列在这里，不会生成演示数据。</p></div>}
    <div className="object-list">{snapshot.task_data.items.map(item => <button key={item.id} aria-pressed={value?.id === item.id} onClick={() => void read(item.id, item.revision)}><span className="mono">{item.id}</span><span>r{item.revision} · 查看</span></button>)}</div>
    {snapshot.task_data.total > snapshot.task_data.items.length && <p className="notice">下方为最近 {snapshot.task_data.items.length} 个快捷入口；完整记录使用上方“全部任务数据”。</p>}
    {value && <article className="data-detail"><header className="section-heading"><h3>数据值 · r{value.revision}</h3><span className="mono">{value.id}</span></header>{snapshot.task_data.items.find(x => x.id === value.id)?.revision !== value.revision && <p className="notice">对象已有新版本，请重新选择读取；这里保留的是刚才读取的版本。</p>}<pre>{JSON.stringify(value.value, null, 2)}</pre><details><summary>固定数据结构（schema）</summary><pre>{JSON.stringify(value.schema, null, 2)}</pre></details></article>}
  </section>
}

export function ExecutionHistory({ snapshot }: { snapshot: Snapshot }) {
  const [operations, setOperations] = useState<Record<string, unknown>[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void hostRequest<Record<string, unknown>[]>({ type: 'operation.list', task_id: snapshot.task.id, limit: 50 }).then(next => { if (active) setOperations(next) }, e => { if (active) setError(String(e)) })
    return () => { active = false }
  }, [snapshot.task.id, snapshot.task.revision])
  return <section className="inspector" aria-label="执行记录查看器"><header className="section-heading"><h2>执行记录</h2><span>近期摘要与完整分页</span></header>{([ ['run', '全部运行'], ['action', '原动作'], ['approval', '原审批'], ['call', '原工具调用'], ['message', '全部消息'], ['event', '全部事件'], ['view_history', '界面历史依据'] ] as const).map(([kind, label]) => <RecordBrowser key={kind} taskId={snapshot.task.id} kind={kind} label={label} />)}<p className="muted">执行状态与模型回复分开记录。只读查询不会重新执行。</p>{error && <p role="alert" className="error">{error}</p>}{snapshot.runs.length === 0 && <div className="empty-state"><h3>尚无执行记录</h3><p>发送任务请求后，执行状态和结束原因会显示在这里。</p></div>}{snapshot.runs.map(run => <details key={run.id}><summary><span className="mono">{run.id.slice(0, 8)}</span> · {run.state} · {run.primary_reason ?? run.wait_reason ?? '执行中'}</summary><RunOutcome run={run} taskId={snapshot.task.id} /></details>)}{operations.length > 0 && <><h3>宿主动作</h3>{operations.map(op => <details key={String(op.id)}><summary>{String(op.state)} · {String(op.result ?? '待处理')} · <span className="mono">{String(op.id).slice(0, 8)}</span></summary><pre>{JSON.stringify(op, null, 2)}</pre></details>)}</>}</section>
}
