import { WorkspaceIcon } from './WorkspaceIcon'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { TaskListItem } from '../../shared/types'
import { hostRequest } from './ModelSettings'
import { readTaskPage, type TaskPage } from './task-directory'

const archiveDate = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' })

export function ArchiveSettings({ locked, onBusy, onRestored }: { locked: boolean; onBusy(busy: boolean): void; onRestored(): void }) {
  const [name, setName] = useState('')
  const [page, setPage] = useState<TaskPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null)
  const [restoring, setRestoring] = useState<string | null>(null)
  const requestId = useRef(0)
  const restoringTask = useRef(false)
  const search = useRef<HTMLInputElement>(null), heading = useRef<HTMLHeadingElement>(null)
  const more = useRef<HTMLButtonElement>(null)
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  const nextFocus = useRef<{ taskId?: string } | null>(null)
  const query = name.trim()

  const load = useCallback(async (query: string, cursor?: string, visibleCount = 1) => {
    const id = ++requestId.current
    setLoading(true); setLoadError(false)
    try {
      const items: TaskListItem[] = []
      let next = cursor
      do {
        const result = await readTaskPage(true, query, next)
        if (id !== requestId.current) return
        items.push(...result.items); next = result.next_cursor ?? undefined
      } while (next && items.length < visibleCount)
      if (cursor && document.activeElement === more.current) nextFocus.current = { taskId: items[0]?.id }
      if (!cursor && !query && !items.length && document.activeElement === search.current) nextFocus.current = {}
      setPage(previous => ({ items: cursor ? [...(previous?.items ?? []), ...items] : items, next_cursor: next ?? null }))
    } catch {
      if (id === requestId.current) {
        if (document.activeElement === more.current) search.current?.focus()
        setLoadError(true)
      }
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => void load(query), query ? 150 : 0)
    return () => { clearTimeout(timer); requestId.current++ }
  }, [load, query])

  useLayoutEffect(() => {
    if (!nextFocus.current) return
    const { taskId } = nextFocus.current
    nextFocus.current = null
    const target = (taskId ? buttons.current.get(taskId) : undefined) ?? search.current ?? heading.current
    target?.focus()
  }, [page])

  function searchFor(value: string) {
    setName(value)
    if (value.trim() === query) return
    requestId.current++
    setPage(null); setLoading(true); setLoadError(false); setFeedback(null)
  }

  async function restore(task: TaskListItem, button: HTMLButtonElement) {
    if (!page || locked || loading || restoringTask.current) return
    restoringTask.current = true
    setRestoring(task.id); onBusy(true); setFeedback(null)
    try {
      await hostRequest({ type: 'host.task.organize', task_id: task.id, field: 'archived', value: false })
      const index = page.items.indexOf(task)
      if (document.activeElement === button) nextFocus.current = { taskId: (page.items[index + 1] ?? page.items[index - 1])?.id }
      setPage({ items: page.items.filter(item => item.id !== task.id), next_cursor: null })
      setFeedback({ error: false, text: `已恢复「${task.title}」。` })
      onRestored()
      // Organization changes invalidate pagination cursors. Renew the loaded range.
      if (page.next_cursor) void load(query, undefined, page.items.length)
    } catch {
      setFeedback({ error: true, text: `未能恢复「${task.title}」。请重试。` })
    } finally {
      restoringTask.current = false; setRestoring(null); onBusy(false)
    }
  }

  const showSearch = Boolean(query || page?.items.length || !page || loading || loadError)
  const unavailable = locked || loading
  return <>
    <h1 tabIndex={-1}>归档</h1>
    <p className="settings-lead">恢复任务后，它会重新出现在工作台任务列表中。</p>
    <section className="settings-section archive-settings" aria-labelledby="archive-heading">
      <div className="settings-section-heading archive-toolbar">
        <div className="archive-heading"><h2 id="archive-heading" ref={heading} tabIndex={-1}>已归档任务</h2>
          {page && !loadError && <span>{page.items.length}{page.next_cursor ? '+' : ''} 项</span>}</div>
        {showSearch && <label className="archive-search"><WorkspaceIcon name="search" /><input ref={search} type="search" aria-label="搜索归档任务" placeholder="按任务名称搜索" value={name} maxLength={200} readOnly={locked} onChange={event => { if (!locked) searchFor(event.target.value) }} /></label>}
      </div>
      <div className="archive-results" aria-busy={loading}>
        {!!page?.items.length && <ul className="archive-list" aria-label="归档任务">{page.items.map(task => <li key={task.id}>
          <WorkspaceIcon name="doc" /><div className="archive-task"><strong>{task.title}</strong><p>{task.archived_at === null ? '归档时间未记录' : <>归档于 <time dateTime={new Date(task.archived_at).toISOString()}>{archiveDate.format(task.archived_at)}</time></>}</p></div>
          <button type="button" aria-label={`恢复任务：${task.title}`} aria-disabled={unavailable || Boolean(restoring)}
            ref={element => { if (element) buttons.current.set(task.id, element); else buttons.current.delete(task.id) }}
            onClick={event => void restore(task, event.currentTarget)}><WorkspaceIcon name="restore" />{restoring === task.id ? '恢复中…' : '恢复任务'}</button>
        </li>)}</ul>}
        {loading && !page?.items.length && <div className="archive-empty" role="status">正在查询归档任务…</div>}
        {loadError && <div className="archive-empty"><p role="alert">读取归档任务失败。</p><button type="button" disabled={unavailable} onClick={() => { search.current?.focus(); void load(query, undefined, page?.items.length) }}>重新查询</button></div>}
        {!loading && !loadError && page?.items.length === 0 && (query
          ? <div className="archive-empty"><strong>未找到匹配的任务</strong><button type="button" disabled={locked} onClick={() => { searchFor(''); search.current?.focus() }}>清除搜索</button></div>
          : <div className="archive-empty"><strong>暂无已归档任务</strong><p>在工作台归档的任务会出现在这里。</p></div>)}
      </div>
      {page?.next_cursor && !loadError && <button ref={more} className="archive-more" type="button" aria-disabled={unavailable} onClick={() => {
        if (!unavailable && page.next_cursor) void load(query, page.next_cursor)
      }}>{loading ? '加载中…' : '加载更多'}</button>}
      <p className="archive-feedback" role="status">{!feedback?.error ? feedback?.text : ''}</p>
      {feedback?.error && <p className="archive-feedback error" role="alert">{feedback.text}</p>}
    </section>
  </>
}
