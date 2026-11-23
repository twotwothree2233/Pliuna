import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { Snapshot, TaskMessage, TaskMessagePage, TaskMessageText } from '../../shared/types'
import { hostRequest } from './ModelSettings'
import { WorkspaceIcon } from './WorkspaceIcon'

/** The scroll container belongs to Agent, so queue notices and messages scroll together. */
export function TaskReply({ snapshot, scroll, underMessage, unplaced }: {
  snapshot: Snapshot; scroll: RefObject<HTMLDivElement | null>
  underMessage?(message: TaskMessage, visible: ReadonlyMap<string, TaskMessage>): ReactNode
  unplaced?(visible: ReadonlyMap<string, TaskMessage>): ReactNode
}) {
  const taskId = snapshot.task.id
  const [items, setItems] = useState<TaskMessage[]>([])
  const [older, setOlder] = useState<string | null>(null)
  const [ready, setReady] = useState(false), [loading, setLoading] = useState(false)
  const [error, setError] = useState(''), [retry, setRetry] = useState(0)
  const after = useRef<string | null>(null), loaded = useRef(false), mounted = useRef(false), readingOlder = useRef(false)
  const position = useRef<{ follow?: boolean; id?: string; offset?: number; jump?: string } | null>(null)
  const tail = useRef<HTMLDivElement>(null)
  const shown = useRef(new Map<string, HTMLElement>())
  const watermark = snapshot.records.at(-1)?.id
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const merge = (batch: TaskMessage[]) => setItems(previous => {
    const ordered = new Map(previous.map(item => [item.id, item]))
    for (const message of batch) ordered.set(message.id, message)
    return [...ordered.values()].sort((left, right) => left.sequence - right.sequence)
  })
  const capturePosition = () => {
    const top = scroll.current?.getBoundingClientRect().top ?? 0
    for (const [id, node] of shown.current) {
      if (node.getBoundingClientRect().bottom <= top) continue
      const header = node.firstElementChild
      if (header) return { id, offset: header.getBoundingClientRect().top - top }
    }
    return null
  }
  useEffect(() => {
    let stale = false
    async function sync() {
      try {
        do {
          const cursor = after.current
          const page = await hostRequest<TaskMessagePage>({ type: 'host.messages.page', task_id: taskId, ...(cursor ? { after: cursor } : {}) })
          if (stale) return
          after.current = page.update_cursor
          const viewport = scroll.current
          if (!loaded.current) setOlder(page.older_cursor)
          if (page.items.length) {
            const local = page.items.some(item => item.role === 'user') && !!viewport?.closest('#pane-right')?.querySelector('textarea:focus')
            const nearEnd = !viewport || viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 72
            if (!position.current) position.current = !loaded.current || nearEnd || local ? { follow: true } : capturePosition()
            merge(page.items)
          }
          loaded.current = true
          setReady(true); setError('')
          if (!page.more_updates) break
        } while (!stale)
      } catch { if (!stale) setError('无法读取对话。') }
    }
    void sync()
    return () => { stale = true }
  }, [taskId, watermark, snapshot.record_total, retry, scroll])

  useLayoutEffect(() => {
    const viewport = scroll.current, anchor = position.current
    if (!viewport?.clientHeight || !anchor) return
    position.current = null
    if (anchor.jump) {
      const node = shown.current.get(anchor.jump)
      if (node) { node.focus({ preventScroll: true }); node.scrollIntoView({ block: 'nearest' }); return }
    }
    if (anchor.follow && tail.current) viewport.scrollTop = viewport.scrollHeight
    if (anchor.id && anchor.offset !== undefined) {
      const header = shown.current.get(anchor.id)?.firstElementChild
      if (header) viewport.scrollTop += header.getBoundingClientRect().top - viewport.getBoundingClientRect().top - anchor.offset
    }
  })

  async function history(jump?: string) {
    const current = jump ? shown.current.get(jump) : null
    if (current) { current.focus({ preventScroll: true }); current.scrollIntoView({ block: 'nearest' }); return }
    if (!older || readingOlder.current) return
    readingOlder.current = true
    setLoading(true); setError('')
    try {
      let cursor: string | null = older
      const batch: TaskMessage[] = []
      do {
        const page: TaskMessagePage = await hostRequest<TaskMessagePage>({ type: 'host.messages.page', task_id: taskId, before: cursor })
        if (!mounted.current) return
        batch.push(...page.items)
        cursor = page.older_cursor
      } while (jump && cursor && !batch.some(item => item.id === jump))
      position.current = { ...capturePosition(), jump }
      merge(batch); setOlder(cursor)
    } catch { if (mounted.current) setError('无法读取更早的消息。') }
    finally { readingOlder.current = false; if (mounted.current) setLoading(false) }
  }

  const byId = new Map(items.map(item => [item.id, item]))
  return <section className="task-reply" aria-label="任务对话">
    {error && <p role="alert" className="conversation-error">{error} <button onClick={() => { setError(''); setRetry(value => value + 1) }}>重试</button></p>}
    {!items.length && !error && <p className="agent-ready">{ready ? '发送你的第一个请求。' : '正在读取对话…'}</p>}
    {older && <button type="button" className="conversation-history" disabled={loading} onClick={() => void history()}>{loading ? '正在读取…' : '加载更早消息'}</button>}
    {items.map((message, index) => {
      const author = message.role === 'user' ? '你' : 'Agent'
      const parent = message.reply_to ? byId.get(message.reply_to) : undefined
      const showReference = message.reply_to && message.reply_to !== items[index - 1]?.id
      return <article key={message.id} ref={node => { if (node) shown.current.set(message.id, node); else shown.current.delete(message.id) }} tabIndex={-1} className="agent-message" aria-label={`${author}的消息`}>
        <header><span><WorkspaceIcon name={message.role === 'user' ? 'chat' : 'agent'} /></span><b>{author}</b></header>
        {showReference && (parent || older) && <button type="button" className="conversation-reference" disabled={loading} onClick={() => void history(message.reply_to!)}>{parent ? `回复：${parent.text.trim().slice(0, 64)}` : '加载原消息'}</button>}
        <MessageText taskId={taskId} message={message} />
        {underMessage?.(message, byId)}
      </article>
    })}
    {unplaced?.(byId)}
    <div ref={tail} />
  </section>
}

function MessageText({ taskId, message }: { taskId: string; message: TaskMessage }) {
  const [result, setResult] = useState<TaskMessageText | null>(null)
  const [loading, setLoading] = useState(false), [error, setError] = useState(false)
  async function read() {
    setLoading(true); setError(false)
    try {
      const cursor = result?.next_cursor
      const part = await hostRequest<TaskMessageText>({ type: 'host.messages.read', task_id: taskId, message_id: message.id, ...(cursor ? { cursor } : {}) })
      setResult({ text: (result?.text ?? '') + part.text, next_cursor: part.next_cursor })
    } catch { setError(true) }
    finally { setLoading(false) }
  }
  return <>
    <p className="task-reply-text">{result?.text ?? message.text}</p>
    {message.kind === 'message.assistant.partial' && <p className="task-reply-partial">回复未完成，已收到的文字保留。</p>}
    {(!result && message.truncated || !!result?.next_cursor) && <button type="button" className="conversation-reference" disabled={loading} onClick={() => void read()}>{loading ? '正在读取…' : error ? '读取失败，重试' : result ? '继续读取' : '展开原文'}</button>}
    {result && <button type="button" className="conversation-reference" disabled={loading} onClick={() => { setResult(null); setError(false) }}>收起原文</button>}
  </>
}
