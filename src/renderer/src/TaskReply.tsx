import { useEffect, useState } from 'react'
import type { LatestMessages, RecordEntry, Snapshot } from '../../shared/types'
import { hostRequest } from './ModelSettings'
import { RecordBrowser } from './TaskInspector'
import { useRunnerPage } from './RunnerGoals'
import { runnerReplyNotice, selectRunnerAnswer } from './runner-projection'

type MessagePart = { data: { payload?: Record<string, unknown>; text?: string }; representation?: string; next_cursor: string | null }

/** Read saved messages independently of the bounded mixed-event snapshot. */
export function TaskReply({ snapshot, onRecords }: { snapshot: Snapshot; onRecords(): void }) {
  return snapshot.runner?.goals.length || snapshot.runner?.next_cursor ? <RunnerTaskReply snapshot={snapshot} onRecords={onRecords} /> : <LegacyTaskReply snapshot={snapshot} onRecords={onRecords} />
}
function RunnerTaskReply({ snapshot, onRecords }: { snapshot: Snapshot; onRecords(): void }) {
  const page = useRunnerPage(snapshot), [selected, setSelected] = useState('')
  const goals = page.projection?.goals ?? [], goal = goals.find(item => item.request_id === selected) ?? [...goals].reverse().find(item => item.state === 'active' && (runnerReplyNotice(item) || selectRunnerAnswer(item))) ?? goals[0]
  const reply = goal ? selectRunnerAnswer(goal) : null
  const notice = goal ? runnerReplyNotice(goal) : null
  return <section className="task-reply" aria-label="任务回复">
    <header className="task-reply-heading"><h2>目标回复</h2><button className="agent-text-link" onClick={onRecords}>查看执行记录 →</button></header>
    {!!goals.length && <label className="runner-reply-selection">选择目标<select value={goal?.request_id ?? ''} onChange={event => setSelected(event.target.value)}>{goals.map(item => <option key={item.request_id} value={item.request_id}>{item.title || '未命名目标'}{item.state === 'withdrawn' ? '（已撤回）' : ''}</option>)}</select></label>}
    {page.error && <p role="alert">{page.error}<button onClick={page.retry}>重新查询回复</button></p>}
    {page.loading && !goal && <p role="status">正在读取目标回复…</p>}
    {goal?.request && <details className="task-request"><summary>此目标的指令</summary><SavedMessage key={goal.request.id} taskId={snapshot.task.id} entry={goal.request} /></details>}
    {notice ? <p className="task-reply-text" role="status">{notice}</p> : reply ? <><time className="task-reply-time" dateTime={reply.created_at}>{new Date(reply.created_at).toLocaleString()}</time><SavedMessage key={reply.id} taskId={snapshot.task.id} entry={reply} /></> : goal && <p className="muted">{goal.state === 'withdrawn' ? '此目标已撤回。历史内容可在执行记录中查看。' : '此目标尚无已保存的最终回复。已有内容可继续阅读。'}</p>}
    {(page.cursor || page.projection?.next_cursor) && <nav className="runner-page" aria-label="回复目标分页">{page.cursor && <button disabled={page.loading} onClick={page.first}>返回首批目标</button>}{page.projection?.next_cursor && <button disabled={page.loading} onClick={() => page.next(page.projection!.next_cursor!)}>更多目标回复</button>}</nav>}
  </section>
}
function LegacyTaskReply({ snapshot, onRecords }: { snapshot: Snapshot; onRecords(): void }) {
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
  return <section className="task-reply" aria-label="任务回复">
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
          const part: MessagePart = await hostRequest<MessagePart>({ type: 'task.query', task_id: taskId, query: { type: 'read', input: { target: { kind: entry.kind.startsWith('runner.') ? 'event' : 'message', id: entry.id }, ...(cursor ? { cursor } : {}) } } })
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
    {original && <RecordBrowser taskId={taskId} kind={entry.kind.startsWith('runner.') ? 'event' : 'message'} label="完整回复" initialId={entry.id} />}
  </div>
}
