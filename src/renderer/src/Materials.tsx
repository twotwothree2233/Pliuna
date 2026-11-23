import { useEffect, useRef, useState } from 'react'
import { DialogFocus } from './Dialog'
import { hostRequest } from './ModelSettings'
import { RecordBrowser, formatBytes, formatTime } from './TaskInspector'
import { WorkspaceIcon } from './WorkspaceIcon'

type Item = {
  operation_id: string
  display_name: string
  state: 'waiting' | 'importing' | 'success' | 'failed' | 'cancelled'
  code: string | null
  received_bytes: number
  expected_bytes: number | null
  resource: { id: string } | null
  removed?: boolean
  retry_of: string | null
  created_at: string
}
type Page = { items: Item[]; next_before: number | null }
const labels = { waiting: '等待中', importing: '导入中', success: '已导入', failed: '失败', cancelled: '已取消' }
const inProgress = (item: Item) => item.state === 'waiting' || item.state === 'importing'

export function Materials({ taskId, active, onDirty }: { taskId: string; active: boolean; onDirty: (id: string, dirty: boolean) => void }) {
  const [recent, setRecent] = useState<Page | null>(null), [older, setOlder] = useState<Page | null>(null)
  const [view, setView] = useState<'materials' | 'history'>('materials')
  const [version, setVersion] = useState(0), [error, setError] = useState(''), [listError, setListError] = useState('')
  const [busy, setBusy] = useState(false), [paging, setPaging] = useState(false)
  const [text, setText] = useState(''), [name, setName] = useState('文本材料'), [retry, setRetry] = useState<Item | null>(null)
  const [textPending, setTextPending] = useState(false), [unknown, setUnknown] = useState(false)
  const [discardOpen, setDiscardOpen] = useState(false), [addingText, setAddingText] = useState(false)
  const [openOperation, setOpenOperation] = useState<string | null>(null), [linkedResource, setLinkedResource] = useState<string | null>(null)
  const pendingText = useRef<{ id: string; text: string } | null>(null), loadSequence = useRef(0)
  const seenSuccess = useRef<Set<string> | null>(null)
  const pendingImports = useRef(new Set<string>())

  useEffect(() => {
    onDirty('material-text', !!text || unknown)
    return () => onDirty('material-text', false)
  }, [text, unknown])

  async function loadRecent() {
    const sequence = ++loadSequence.current
    try {
      const page = await hostRequest<Page>({ type: 'material.list', task_id: taskId })
      const pending = pendingText.current
      // Large batches can have pending operations outside the first page.
      const byId = new Map(page.items.map(item => [item.operation_id, item]))
      const missing = [...new Set([...pendingImports.current, ...(pending ? [pending.id] : [])])].filter(id => !byId.has(id))
      for (const item of await Promise.all(missing.map(id => hostRequest<Item>({ type: 'material.status', task_id: taskId, operation_id: id })))) byId.set(item.operation_id, item)
      if (sequence !== loadSequence.current) return
      const items = [...byId.values()]
      const successes = items.filter(item => item.state === 'success')
      const previousSuccess = seenSuccess.current
      if (successes.some(item => previousSuccess ? !previousSuccess.has(item.operation_id) : pendingImports.current.has(item.operation_id))) setVersion(value => value + 1)
      seenSuccess.current = new Set(successes.map(item => item.operation_id))
      for (const item of items) if (!inProgress(item)) pendingImports.current.delete(item.operation_id)
      const result = pending && byId.get(pending.id)
      if (pending && pendingText.current === pending && result && !inProgress(result)) {
        if (result.state === 'success') {
          setText(value => value === pending.text ? '' : value)
          setAddingText(false)
        }
        pendingText.current = null
        setTextPending(false)
      }
      setRecent(page)
      setListError('')
    } catch (e) {
      if (sequence === loadSequence.current) setListError(String(e))
    }
  }

  useEffect(() => {
    void loadRecent()
    const timer = setInterval(() => { void loadRecent() }, 1000)
    return () => { clearInterval(timer); loadSequence.current++ }
  }, [taskId])

  function showRecent() {
    setOlder(null)
    setOpenOperation(null)
    setLinkedResource(null)
    void loadRecent()
  }

  async function showOlder(before: number) {
    setPaging(true)
    setError('')
    try {
      setOlder(await hostRequest<Page>({ type: 'material.list', task_id: taskId, before }))
      setOpenOperation(null)
      setLinkedResource(null)
    } catch (e) { setError(String(e)) }
    finally { setPaging(false) }
  }

  async function start(type: 'material.pick' | 'material.text') {
    setBusy(true)
    setError('')
    try {
      const base = { task_id: taskId, ...(retry ? { retry_of: retry.operation_id } : {}) }
      const result = await hostRequest<{ cancelled?: boolean; items: Item[] }>(type === 'material.text' ? { type, ...base, display_name: name, text } : { type, ...base })
      if (result.cancelled) return
      for (const item of result.items) pendingImports.current.add(item.operation_id)
      if (type === 'material.text') {
        pendingText.current = { id: result.items[0]!.operation_id, text }
        setTextPending(true)
      }
      setRetry(null)
      showRecent()
    } catch (e) {
      if (/UNKNOWN_RESULT|CONNECTION_LOST|OFFLINE/.test(String(e))) {
        setUnknown(true)
        setView('history')
        showRecent()
      } else setError(String(e))
    } finally { setBusy(false) }
  }

  async function checkOperation(type: 'material.cancel' | 'material.status', item: Item) {
    setError('')
    try {
      const current = await hostRequest<Item>({ type, task_id: taskId, operation_id: item.operation_id })
      setOlder(page => page && { ...page, items: page.items.map(row => row.operation_id === current.operation_id ? current : row) })
      await loadRecent()
    } catch (e) { setError(String(e)) }
  }

  const page = older ?? recent
  const latest = recent?.items ?? []
  const retried = new Set(latest.filter(item => item.state !== 'failed' && item.state !== 'cancelled').map(item => item.retry_of))
  const pendingCount = latest.filter(inProgress).length
  const failedCount = latest.filter(item => item.state === 'failed' && !retried.has(item.operation_id)).length
  const importDisabled = busy || textPending || unknown || !active

  return <section className="inspector task-reading materials-page" aria-label="材料导入">
    <header className="task-page-heading materials-heading">
      <h2>材料</h2>
      <div className="material-add-actions">
        <button className="primary" disabled={importDisabled} onClick={() => void start('material.pick')}>选择文件导入{retry ? '（仅重试此项）' : ''}</button>
        <button aria-expanded={addingText} aria-controls="material-text-entry" onClick={() => setAddingText(value => !value)}>粘贴文本</button>
      </div>
    </header>
    {retry && <div className="material-notice" role="status"><span>重试：{retry.display_name}</span><button onClick={() => setRetry(null)}>取消重试选择</button></div>}
    <div id="material-text-entry" className="material-text-entry" hidden={!addingText}>
      <label>材料名称<input disabled={busy || textPending} value={name} maxLength={200} onChange={event => setName(event.target.value)} /></label>
      <label>添加为材料的文本<textarea disabled={busy || textPending} value={text} onChange={event => setText(event.target.value)} /></label>
      <div className="inline-actions">
        <button className="primary" disabled={importDisabled || !text || !name} onClick={() => void start('material.text')}>将文本保存为材料</button>
        {text && <button disabled={busy || textPending} onClick={() => setDiscardOpen(true)}>丢弃未导入文本</button>}
      </div>
    </div>
    {discardOpen && <DialogFocus><div className="overlay"><section className="modal" role="dialog" aria-modal="true" aria-label="丢弃未导入文本" onKeyDown={event => { if (event.key === 'Escape') setDiscardOpen(false) }}>
      <h2>丢弃未导入文本？</h2><p>只清除当前草稿。</p>
      <div className="inline-actions"><button onClick={() => setDiscardOpen(false)}>取消</button><button disabled={busy || textPending} onClick={() => { setText(''); setDiscardOpen(false) }}>确认丢弃</button></div>
    </section></div></DialogFocus>}
    {unknown && <div role="alert" className="notice">注册结果未知。请先核对导入记录。<button onClick={() => { if (confirm('已检查原导入操作并确认结果？解除暂停不会重新导入。')) setUnknown(false) }}>已核对原结果，解除暂停</button></div>}
    {error && <p role="alert" className="error">{error}</p>}
    <nav className="materials-nav" aria-label="材料浏览方式">
      <button aria-pressed={view === 'materials'} onClick={() => setView('materials')}>材料列表</button>
      <button aria-pressed={view === 'history'} onClick={() => setView('history')}>导入记录{pendingCount > 0 && <span className="material-counter">{pendingCount} 项导入中</span>}{failedCount > 0 && <span className="material-counter is-failed">{failedCount} 项失败</span>}</button>
    </nav>
    <div hidden={view !== 'materials'}>
      <RecordBrowser taskId={taskId} kind="resource" label="全部资源" materials={{ version, onRefresh: showRecent }} />
    </div>
    {view === 'history' && <section className="material-import-history" aria-label="导入操作">
      <div className="material-history-tools"><span>{older ? '更早记录' : '最近导入'}</span><button disabled={paging} onClick={showRecent}>{older ? '返回最近导入' : '刷新导入结果'}</button></div>
      {listError && <p role="alert" className="error">{listError}</p>}
      {!page ? <p role="status" className="record-caption">正在读取…</p> : !page.items.length && <p role="status" className="material-empty">暂无导入记录</p>}
      {page?.items.map(item => <article className="material-operation" key={item.operation_id}>
        <button className="record-row material-operation-toggle" aria-expanded={openOperation === item.operation_id} onClick={() => { setOpenOperation(openOperation === item.operation_id ? null : item.operation_id); setLinkedResource(null) }}>
          <WorkspaceIcon name="doc" />
          <span className="record-row-main"><strong>{item.display_name}</strong>{item.expected_bytes !== null && inProgress(item) && <small>{formatBytes(item.received_bytes)} / {formatBytes(item.expected_bytes)}</small>}</span>
          <span className="record-row-meta">{formatTime(item.created_at)}</span>
          <span className={'material-operation-state ' + item.state}>{item.removed ? '已删除' : labels[item.state]}</span>
          <span className="material-chevron" aria-hidden="true">{openOperation === item.operation_id ? '⌄' : '›'}</span>
        </button>
        {openOperation === item.operation_id && <div className="material-operation-detail">
          <div className="inline-actions">
            {inProgress(item) && <button onClick={() => void checkOperation('material.cancel', item)}>取消此项导入</button>}
            {item.state === 'failed' && <button onClick={() => setRetry(item)}>选择来源重试此失败项</button>}
            {item.resource && <button aria-expanded={linkedResource === item.resource.id} onClick={() => setLinkedResource(linkedResource ? null : item.resource!.id)}>{item.removed ? '查看原材料' : '查看关联材料'}</button>}
            <button onClick={() => void checkOperation('material.status', item)}>查询此原操作</button>
          </div>
          <details><summary>操作详情</summary><p className="mono">{item.operation_id}</p>{item.code && <p className="mono">{item.code}</p>}</details>
          {linkedResource && <RecordBrowser key={linkedResource} taskId={taskId} kind="resource" label="关联材料" initialId={linkedResource} />}
        </div>}
      </article>)}
      {page?.next_before != null && <button className="record-more" disabled={paging} onClick={() => void showOlder(page.next_before!)}>查看更早导入操作</button>}
    </section>}
    <details className="record-help materials-help"><summary>导入与使用说明</summary>
      <p>每批最多导入 50 项。单文件上限 256 MiB，粘贴文本上限 256 KiB。导入只保存材料，不会启动 Agent 或解析文件。</p>
      <p>发送请求时默认使用当前任务已导入和正在导入的材料。可在 Agent 输入框旁调整本次范围。</p>
    </details>
  </section>
}
