import { useEffect, useState } from 'react'
import type { LatestMessages, RecordEntry, Snapshot } from '../../shared/types'
import { hostRequest } from './ModelSettings'
import { RecordBrowser } from './TaskInspector'

type MessagePart = { data: { payload?: Record<string, unknown>; text?: string }; representation?: string; next_cursor: string | null }

/** Read saved messages independently of the bounded mixed-event snapshot. */
export function TaskReply({ snapshot, onRecords }: { snapshot: Snapshot; onRecords(): void }) {
  const [latest, setLatest] = useState<LatestMessages | null>(null), [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let cancelled = false
    void hostRequest<LatestMessages>({ type: 'host.messages.latest', task_id: snapshot.task.id }).then(value => {
      if (!cancelled) { setLatest(value); setError('') }
    }).catch(cause => { if (!cancelled) setError(String(cause)) })
    return () => { cancelled = true }
  }, [snapshot.task.id, snapshot.runtime_epoch, snapshot.records.at(-1)?.id, snapshot.record_total, retry])
  if (!latest?.request && !latest?.reply && !error) return null
  return <section className={"task-reply" + (!snapshot.views.length ? " task-reply-primary" : "")} aria-label="任务回复">
    <header className="task-reply-heading"><h2>最近保存的回复</h2><button className="agent-text-link" onClick={onRecords}>查看执行记录 →</button></header>
    {error && <p role="alert">回复暂未读取。<button onClick={() => setRetry(value => value + 1)}>重新查询回复</button></p>}
    {latest?.request && <details className="task-request"><summary>最新指令 · {new Date(latest.request.created_at).toLocaleString()}</summary><SavedMessage key={latest.request.id} taskId={snapshot.task.id} entry={latest.request} /></details>}
    {latest?.reply ? <><time className="task-reply-time" dateTime={latest.reply.created_at}>{new Date(latest.reply.created_at).toLocaleString()}</time><SavedMessage key={latest.reply.id} taskId={snapshot.task.id} entry={latest.reply} />{latest.reply.kind === 'message.assistant.partial' && <p className="task-reply-partial">回复未完成，已收到的文字保留。</p>}</> : <p className="muted">尚无已保存回复。执行状态见 Agent 栏。</p>}
  </section>
}
function SavedMessage({ taskId, entry }: { taskId: string; entry: Pick<RecordEntry, 'id' | 'kind' | 'created_at'> }) {
  const [payload, setPayload] = useState<Record<string, unknown> | null>(null), [error, setError] = useState(''), [large, setLarge] = useState(false), [original, setOriginal] = useState(false), [retry, setRetry] = useState(0)
  useEffect(() => {
    let cancelled = false
    async function read() {
      setError(''); setPayload(null); setLarge(false)
      try {
        let cursor: string | null = null, text = ''
        do {
          const part: MessagePart = await hostRequest<MessagePart>({ type: 'task.query', task_id: taskId, query: { type: 'read', input: { target: { kind: 'message', id: entry.id }, ...(cursor ? { cursor } : {}) } } })
          if (cancelled) return
          if (!part.representation) { setPayload(part.data.payload ?? {}); return }
          text += part.data.text ?? ''
          if (text.length > 256 * 1024) { setLarge(true); return }
          cursor = part.next_cursor
        } while (cursor)
        setPayload((JSON.parse(text) as RecordEntry).payload)
      } catch (cause) { if (!cancelled) setError(String(cause)) }
    }
    void read()
    return () => { cancelled = true }
  }, [taskId, entry.id, retry])
  return <div className="saved-message">
    {error ? <p role="alert">{error}<button onClick={() => setRetry(value => value + 1)}>重新读取</button></p> : payload ? <>{payload.model_config_id === 'fixture' && <small className="task-reply-time">开发夹具 · 本机固定示例</small>}<p className="task-reply-text">{String(payload.text ?? '')}</p></> : large ? <p className="muted">回复较长，按原消息分段读取。</p> : <p className="muted">正在读取已保存内容…</p>}
    {large && <button onClick={() => setOriginal(value => !value)}>{original ? '收起原消息' : '读取完整回复'}</button>}
    {original && <RecordBrowser taskId={taskId} kind="message" label="完整回复" initialId={entry.id} />}
  </div>
}
