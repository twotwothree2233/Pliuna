import { type ReactNode, Fragment, useEffect, useRef, useState } from 'react'
import type { Snapshot, View } from '../../shared/types'
import { hostRequest } from './ModelSettings'
import { modelErrorMessage } from './model-errors'
import { RunOutcome } from './RunOutcome'
import { ContentReader } from './ContentReader'
import type { ModelRequest } from '../../shared/contracts.generated'
import { extractionCoverage, sourceFacts, sourceFieldLocations, type Provenance } from './source-facts'

type Kind = Extract<ModelRequest, { type: 'list' }>['input']['kind']
type Item = { id: string; display_name?: string; revision?: number; state?: string; result?: string; decision?: string; kind?: string; created_at?: string; media_type?: string; byte_length?: number }
type DerivedResults = { items: { resource_id: string; call_id: string; partial: boolean; plugin_version: string }[]; truncated: boolean }
type ReadResult = { data: unknown; metadata?: { provenance?: Provenance | null; derived_results?: DerivedResults }; representation?: string; next_cursor: string | null; truncated: boolean; content_version?: string }
export function RecordBrowser({ taskId, kind, label, initialId, initialRevision, followReferences = true, onComplete, onReturnToContent, onContinue, continueDisabled = false, answers }: { taskId: string; kind: Kind; label: string; initialId?: string; initialRevision?: number; followReferences?: boolean; onComplete?(id: string): void; onReturnToContent?(): void; onContinue?(id: string): void; continueDisabled?: boolean; answers?: Snapshot['answers'] }) {
  const [items, setItems] = useState<Item[]>([]), [cursor, setCursor] = useState<string | null>(null)
  const [selection, setSelection] = useState<Item | null>(null), [detail, setDetail] = useState(''), [readCursor, setReadCursor] = useState<string | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [provenance, setProvenance] = useState<Provenance | null>(null), [originalCall, setOriginalCall] = useState<string | null>(null)
  const [derivedResults, setDerivedResults] = useState<DerivedResults | null>(null)
  const [listedTotal, setListedTotal] = useState(0)
  const [windowed, setWindowed] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [linkedTarget, setLinkedTarget] = useState<{ kind: 'resource' | 'task_data'; id: string; revision?: number } | null>(null)
  const [query, setQuery] = useState(''), [status, setStatus] = useState('all'), [detailTab, setDetailTab] = useState('value')
  useEffect(() => { if (initialId) void read({ id: initialId, revision: initialRevision }); else void load() }, [taskId, kind, initialId, initialRevision])
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
    if (!more) { setSelection(item); setDetailTab('value'); textWindow.current = ''; setWindowed(false); setDetail(''); setReadCursor(null); setLinkedTarget(null); setProvenance(null); setOriginalCall(null); setDerivedResults(null) }
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
  let parsed: Record<string, any> | null = null
  if (detail && !readCursor && !windowed) { try { const value = JSON.parse(detail); if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value } catch { /* Partial records remain available as raw text. */ } }
  const filtered = items.filter(item => (status === 'all' || (item.state ?? item.decision) === status) && [item.id, item.display_name, item.kind, item.state, item.result].some(value => value?.toLowerCase().includes(query.toLowerCase())))
  const statuses = [...new Set(items.map(item => item.state ?? item.decision).filter((value): value is string => !!value))]
  const rawRecord = <pre>{detail}</pre>
  const answerIndex = answers?.findIndex(answer => answer.id === selection?.id) ?? -1
  const previousAnswer = answerIndex > 0 ? answers?.[answerIndex - 1] : undefined
  const recordDetail = selection && <article className="record-detail" aria-label={label + '全文'}>
    <header className="record-detail-heading"><h4>{selection.display_name ?? (kind === 'task_data' ? '数据值' : recordTitle(kind))}{selection.revision ? ` · r${selection.revision}` : ''}</h4><span className="mono">{selection.id}</span></header>
    {parsed && kind === 'task_data' ? <>
      <nav className="record-detail-tabs" aria-label="数据展示方式">{[['value', '数据值'], ['raw', '原始 JSON'], ['schema', '结构']].map(([id, title]) => <button key={id} aria-pressed={detailTab === id} onClick={() => setDetailTab(id!)}>{title}</button>)}</nav>
      {detailTab === 'value' ? <><RecordValue value={parsed.value} /><details className="record-raw"><summary>只读原记录</summary>{rawRecord}</details></> : detailTab === 'schema' ? <pre>{JSON.stringify(parsed.schema, null, 2)}</pre> : rawRecord}
      <p className="muted">当前读取版本 r{parsed.revision} · 修改数据仍需授权。</p>
    </> : parsed && kind === 'answer' ? <>
      <p className="record-caption">已提交 · 只读 · {formatTime(selection.created_at)} · 原题版本 v{parsed.view_history?.view_revision ?? parsed.view_history?.revision ?? '—'}</p>
      <RecordValue value={parsed.value} />
      <details><summary>当时的题目与保存依据</summary><p>表单 {parsed.form_id} · 保留提交时版本，不运行旧界面。</p>{parsed.view_history?.bundle?.html && <p>{plainMarkup(parsed.view_history.bundle.html).slice(0, 4000)}</p>}<p className="mono">{parsed.view_history_id}</p></details>
      {parsed.view_history?.bundle_resource_id && <ReadDisclosure title="原题定义"><p className="muted">只读查看提交时保存的界面定义，不执行其中的表单。</p><RecordBrowser key={parsed.view_history.bundle_resource_id} taskId={taskId} kind="resource" label="提交时原题" initialId={parsed.view_history.bundle_resource_id} followReferences={false} /></ReadDisclosure>}
      {previousAnswer && <ReadDisclosure title="与上一次作答对照"><p className="record-caption">{formatTime(previousAnswer.created_at)}</p>{previousAnswer.truncated ? <RecordBrowser taskId={taskId} kind="answer" label="上一次完整作答" initialId={previousAnswer.id} followReferences={false} /> : <RecordValue value={previousAnswer.value} />}</ReadDisclosure>}
      <details className="record-raw"><summary>只读原记录</summary>{rawRecord}</details>
      {(onReturnToContent || onContinue) && <div className="inline-actions">{onReturnToContent && <button onClick={onReturnToContent}>回到当前内容</button>}{onContinue && <button disabled={continueDisabled} onClick={() => onContinue(selection.id)}>基于已保存作答继续</button>}</div>}
    </> : parsed && kind === 'resource' ? <>
      <nav className="record-detail-tabs" aria-label="资源展示方式">{[['value', '预览'], ['source', '来源与记录']].map(([id, title]) => <button key={id} aria-pressed={detailTab === id} onClick={() => setDetailTab(id!)}>{title}</button>)}</nav>
      {detailTab === 'source' ? <><RecordValue value={{ 格式: parsed.media_type ?? selection.media_type ?? '未知', 大小: formatBytes(parsed.byte_length ?? selection.byte_length ?? 0), 保存时间: formatTime(parsed.created_at ?? selection.created_at), 原始身份: selection.id }} /><details className="record-raw"><summary>只读原记录</summary>{rawRecord}</details></> : <>
        {parsed.content?.type === 'text' ? <p className="record-value-text">{parsed.content.text}</p> : parsed.content?.type === 'json' ? <RecordValue value={parsed.content.value} /> : typeof parsed.text === 'string' ? <p className="record-value-text">{parsed.text}</p> : <p className="muted">已保存此资源。当前格式暂不支持直接预览，可查看来源与记录。</p>}
        <details className="record-raw"><summary>只读原记录</summary>{rawRecord}</details>
      </>}
    </> : parsed && kind === 'run' ? <><dl className="run-facts"><div><dt>状态</dt><dd>{stateLabel(String(parsed.state))}</dd></div><div><dt>开始</dt><dd>{formatTime(parsed.created_at)}</dd></div><div><dt>结束</dt><dd>{formatTime(parsed.ended_at) || '尚未结束'}</dd></div></dl><div className="run-reading-outcome"><h4>运行结果</h4><p>{parsed.primary_reason === 'fixture_complete' ? '开发夹具已结束；内容来自本机示例。' : parsed.primary_reason === 'model_stop' ? '模型已交还控制权。具体动作与交付结果可在下方核对。' : modelErrorMessage(parsed.primary_reason ?? parsed.wait_reason ?? '运行中')}</p><small className="mono">{parsed.primary_reason ?? parsed.wait_reason}</small></div><ReadDisclosure title="动作结果与用量"><RunOutcome taskId={taskId} run={{ id: selection.id, state: String(parsed.state ?? ''), primary_reason: parsed.primary_reason, wait_reason: parsed.wait_reason, budget_json: JSON.stringify(parsed.budget ?? {}) }} /></ReadDisclosure><details className="record-raw"><summary>只读原记录</summary>{rawRecord}</details></> : rawRecord}
    {windowed && <p className="notice">为限制内存，仅显示末尾 256K 字符；旧片段已读但不再显示，可重新查询原记录。</p>}
    {readCursor ? <><p className="muted">当前为 JSON 文本片段，不是完整对象。</p><button disabled={busy} onClick={() => void read(selection, true)}>继续读取全文</button></> : detail && <p role="status" className="record-caption">全文读取完成</p>}
    <div className="inline-actions"><button disabled={busy} onClick={() => void read(selection)}>重新查询原记录</button>{!initialId && <button disabled={busy} onClick={() => { generation.current++; setSelection(null); setDetail(''); onComplete?.('') }}>收起详情</button>}{initialRevision !== undefined && <button disabled={busy} onClick={() => void read({ id: selection.id })}>查看当前版本（不更新引用）</button>}</div>
    {references.filter(reference => reference.target.kind === 'resource' || reference.target.kind === 'task_data').map(reference => <button key={reference.name} disabled={busy} onClick={() => setLinkedTarget({ kind: reference.target.kind as 'resource' | 'task_data', id: reference.target.id, revision: reference.target.expected_revision })}>查看引用{reference.target.kind === 'resource' ? '资源' : '数据'}：{reference.name}{reference.target.expected_revision !== undefined ? ` · 绑定 r${reference.target.expected_revision}` : ''}</button>)}
    {followReferences && provenance && <section aria-label="派生材料来源"><h4>派生材料来源</h4><details><summary>来源绑定说明</summary><p className="muted">原件身份与原 Call 已按保存事实核对。这是保存的来源绑定，不是本次重新提取或对原件语义的认证。页码和提取文字由工具报告，不代表内容已核实；仅导航，不自动读取、重新解析或启动模型。</p></details><p>插件版本 {provenance.plugin_version} · {provenance.pages.length} 个页面索引 · {extractionCoverage(provenance.partial)}</p>{provenance.notice && <p role="status">{provenance.notice}</p>}<details><summary>宿主登记的来源事实</summary><dl>{sourceFacts(provenance).map(row => <div key={row.label}><dt>{row.label}</dt><dd className="mono">{row.value}</dd></div>)}</dl><p>这里只展示来源导航返回的字段；派发、执行与交付状态请查看原 Call，不从来源摘要推导全部业务已完成。</p></details><details><summary>各项来源字段在哪里</summary><dl>{sourceFieldLocations.map(row => <div key={row.label}><dt>{row.label}</dt><dd>{row.location}</dd></div>)}</dl><p>字段未返回不等于事实矛盾；尚未读取不能声称已经核对。精确参数在执行记录的 material.derived 原事件中按原 ID 查询。</p></details><button disabled={busy} onClick={() => setLinkedTarget({ kind: 'resource', id: provenance.input.id })}>查看派生原件</button><button disabled={busy} onClick={() => setOriginalCall(provenance.call_id)}>查看派生原 Call</button><details><summary>工具报告的页面字节索引</summary><p>start / end 为提取文本的 UTF-8 字节范围 [start, end)，不是原 PDF 的字节偏移。页码与文本语义均为工具报告，宿主只核对结构、边界及来源绑定。</p><pre>{JSON.stringify(provenance.pages, null, 2)}</pre></details></section>}
    {followReferences && !!derivedResults?.items.length && <section aria-label="已有派生结果"><h4>已有派生结果（最近 20 项）</h4><details><summary>派生结果说明</summary><p className="muted">每次解析是独立结果，不覆盖旧结果。选择只读查看不会重新解析或调用模型。未标记部分结果也不保证语义完整；是否适合当前问题仍需读取结果判断。</p></details>{derivedResults.items.map((item, index) => <button key={item.resource_id} disabled={busy} onClick={() => setLinkedTarget({ kind: 'resource', id: item.resource_id })}>查看派生结果 {index + 1} · {item.partial ? '部分结果' : '工具未标记部分'} · v{item.plugin_version}</button>)}{derivedResults.truncated && <p>还有更早结果，请在事件记录中查询 material.derived；这里只显示最近 20 项。</p>}</section>}
    {selection && kind === 'resource' && <ReadDisclosure title="正文分段读取"><ContentReader key={selection.id} taskId={taskId} resourceId={selection.id} hasPages={!!provenance?.pages.length} /></ReadDisclosure>}
    {linkedTarget && <RecordBrowser key={`${linkedTarget.kind}:${linkedTarget.id}:${linkedTarget.revision}`} taskId={taskId} kind={linkedTarget.kind} label={linkedTarget.kind === 'resource' ? '引用资源' : '引用数据'} initialId={linkedTarget.id} initialRevision={linkedTarget.revision} followReferences={false} />}
    {originalCall && <RecordBrowser key={originalCall} taskId={taskId} kind="call" label="派生原 Call" initialId={originalCall} followReferences={false} />}
  </article>
  return <section aria-label={label + '分页浏览'} className="record-browser">
    <header className="section-heading"><h3>{label}</h3><button disabled={busy} onClick={() => void load()}>刷新{label}</button></header>
    {!initialId && <div className="record-tools"><input type="search" aria-label={`搜索${label}已加载记录`} placeholder="搜索已加载记录…" value={query} onChange={e => setQuery(e.target.value)} />{statuses.length > 1 && <select aria-label={`${label}状态筛选`} value={status} onChange={e => setStatus(e.target.value)}><option value="all">全部状态</option>{statuses.map(value => <option key={value} value={value}>{stateLabel(value)}</option>)}</select>}</div>}
    <details className="record-help"><summary>读取范围与记录说明</summary><p>每页最多 50 条，按创建顺序读取；无时间字段按保存顺序。列表为实时结果，最多保留最近加载的 200 项。搜索与状态筛选只覆盖已加载记录，查看不会执行或批准操作。</p>{['view_history', 'answer'].includes(kind) && <p>发布时保存的依据不代表材料已核实。未声明数据和可变引用目标不会递归冻结，不以当前数据替代历史。</p>}</details>
    {initialRevision !== undefined && <p className="notice">引用绑定版本 r{initialRevision}；不自动跟随或保存旧版全文。查看当前版本不会修改引用。</p>}
    {error && <p role="alert" className="error">{error}。内容变化时请刷新列表并重新读取，不能拼接旧片段。</p>}
    <div className="object-list record-rows">{filtered.map(item => <Fragment key={item.id}><button className="record-row" disabled={busy} aria-expanded={selection?.id === item.id} onClick={() => { if (selection?.id === item.id) { setSelection(null); setDetail(''); onComplete?.('') } else void read(item) }}><span className="record-row-main"><strong>{item.display_name ?? (kind === 'answer' ? `第 ${listedTotal - items.length + items.indexOf(item) + 1} 次提交` : item.kind ?? recordTitle(kind))}</strong><small className="mono">{item.id}</small></span><span className="record-row-meta">{formatTime(item.created_at)}{item.revision ? ` · r${item.revision}` : ''}{item.byte_length !== undefined ? ` · ${formatBytes(item.byte_length)}` : ''}<small>{stateLabel(item.state ?? item.decision ?? '')}{item.result ? ` · ${item.result}` : ''}</small></span><span aria-hidden="true" className="record-chevron">{selection?.id === item.id ? '⌄' : '›'}</span></button>{selection?.id === item.id && recordDetail}</Fragment>)}</div>
    {initialId && !filtered.some(item => item.id === selection?.id) && recordDetail}
    {busy && !detail && <p className="record-caption">正在读取…</p>}
    {!busy && !filtered.length && !!items.length && <p role="status" className="muted">已加载记录中没有匹配项。</p>}
    {cursor && <button className="record-more" disabled={busy} onClick={() => void load(true)}>加载更多{label}</button>}
    {loaded && !items.length && <p role="status" className="muted">没有可用的{label}记录</p>}
    {!!items.length && !cursor && <p role="status" className="record-caption">{label}已加载到底 · 已遍历 {listedTotal} 条，当前显示 {items.length} 条</p>}
  </section>
}

export function RecordValue({ value }: { value: unknown }) {
  if (value === null || typeof value !== 'object') return <p className="record-value-text">{value === null ? 'null' : String(value ?? '')}</p>
  const entries = Object.entries(value)
  if (!entries.length) return <p className="muted">{Array.isArray(value) ? '空列表' : '空对象'}</p>
  return <table className="record-values"><tbody>{entries.map(([key, entry]) => <tr key={key}><th scope="row">{key}</th><td>{entry !== null && typeof entry === 'object' ? JSON.stringify(entry, null, 2) : String(entry)}</td></tr>)}</tbody></table>
}
export function formatTime(value?: string) { return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '' }
export function formatBytes(bytes: number) { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB` }
function recordTitle(kind: Kind) { return ({ task_data: '数据对象', answer: '正式作答', resource: '任务资源', run: '任务运行', action: '动作', approval: '审批', call: '工具调用', message: '消息', event: '事件', view_history: '界面历史' } as Partial<Record<Kind, string>>)[kind] ?? '记录' }
function stateLabel(state: string) { return ({ completed: '已完成', running: '运行中', waiting: '等待中', success: '已完成', interrupted: '已中断', failed: '失败', cancelled: '已取消', ended: '已结束', approve: '已批准', deny: '已拒绝' } as Record<string, string>)[state] ?? state }

export function TaskData({ snapshot }: { snapshot: Snapshot }) {
  return <section className="inspector task-reading" aria-label="任务数据查看器">
    <header className="task-page-heading"><h2>任务数据</h2><p>{snapshot.task_data.total} 个结构化对象 · 当前保存版本</p></header>
    {!snapshot.task_data.total && <div className="empty-state"><h3>尚无任务数据</h3><p>Agent 保存的结构化对象会显示在这里。</p></div>}
    <RecordBrowser taskId={snapshot.task.id} kind="task_data" label="全部任务数据" />
  </section>
}

export function AnswerHistory({ snapshot, onReturnToContent, onContinue, continueDisabled }: { snapshot: Snapshot; onReturnToContent(): void; onContinue(id: string): void; continueDisabled: boolean }) {
  return <section className="inspector history task-reading" aria-label="作答记录查看器">
    <header className="task-page-heading"><h2>作答记录</h2><p>{snapshot.answer_total} 份正式提交 · 保留当时题目与答案</p></header>
    {!snapshot.answer_total && <div className="empty-state"><h3>尚无正式作答</h3><p>完成内容中的练习并明确提交后，可以在这里回看。</p><button onClick={onReturnToContent}>前往内容</button></div>}
    <RecordBrowser taskId={snapshot.task.id} kind="answer" label="全部作答" onReturnToContent={onReturnToContent} onContinue={onContinue} continueDisabled={continueDisabled} answers={snapshot.answers} />
  </section>
}

export function ExecutionHistory({ snapshot }: { snapshot: Snapshot }) {
  return <section className="inspector task-reading" aria-label="执行记录查看器">
    <header className="task-page-heading"><h2>执行记录</h2><p>按运行查看结果，展开核对消息、动作和审批。</p></header>
    {!snapshot.runs.length && <div className="empty-state"><h3>尚无执行记录</h3><p>发送第一条请求后，就能查看运行过程。</p></div>}
    <RecordBrowser taskId={snapshot.task.id} kind="run" label="全部运行" />
    <div className="execution-categories">{([['message', '全部消息'], ['action', '原动作'], ['approval', '原审批'], ['call', '原工具调用'], ['event', '全部事件'], ['view_history', '界面历史依据']] as const).map(([kind, label]) => <ExecutionCategory key={kind} taskId={snapshot.task.id} kind={kind} label={label} />)}</div>
  </section>
}
function ExecutionCategory({ taskId, kind, label }: { taskId: string; kind: Kind; label: string }) {
  const [open, setOpen] = useState(false)
  return <details className="execution-category" onToggle={event => setOpen(event.currentTarget.open)}><summary>{label}</summary>{open && <RecordBrowser taskId={taskId} kind={kind} label={label} />}</details>
}

function plainMarkup(html: string) { return html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() }
export function viewTitle(view: View, index: number) {
  const heading = view.bundle.html.match(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i)?.[1]
  return heading ? plainMarkup(heading).slice(0, 80) || `内容 ${index + 1}` : `内容 ${index + 1}`
}

function ReadDisclosure({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return <details onToggle={event => setOpen(event.currentTarget.open)}><summary>{title}</summary>{open && children}</details>
}
