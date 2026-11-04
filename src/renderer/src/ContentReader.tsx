import { useRef, useState } from 'react'
import { hostRequest } from './ModelSettings'

type Part = { data: { text: string }; content_version: string; next_cursor: string | null; actual_range: { start_bytes: number; end_bytes: number; chars: number }; partial: boolean | null; location_verification: string | null }
export function ContentReader({ taskId, resourceId, hasPages }: { taskId: string; resourceId: string; hasPages: boolean }) {
  const [chars, setChars] = useState('4000'), [start, setStart] = useState('0'), [end, setEnd] = useState('')
  const [pages, setPages] = useState(false), [firstPage, setFirstPage] = useState('1'), [lastPage, setLastPage] = useState('1')
  const [part, setPart] = useState<Part | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const version = useRef<string | null>(null)
  async function read(more = false) {
    setBusy(true); setError('')
    try {
      const integer = (text: string, min: number, max = Number.MAX_SAFE_INTEGER) => {
        if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) < min || Number(text) > max) throw Error('请输入有效整数；每段字符数为 1–32000。')
        return Number(text)
      }
      const content = { max_chars: integer(chars, 1, 32000), ...(pages ? { pages: { start: integer(firstPage, 1), end: integer(lastPage, 1) } } : { offset_bytes: integer(start, 0), ...(end ? { end_bytes: integer(end, 0) } : {}) }) }
      const result = await hostRequest<Part>({ type: 'task.query', task_id: taskId, query: { type: 'read', input: { target: { kind: 'resource', id: resourceId }, ...(more && part?.next_cursor ? { cursor: part.next_cursor } : { content }) } } })
      if (more && version.current !== result.content_version) throw Error('正文版本变化，请丢弃旧片段并重新读取。')
      version.current = result.content_version; setPart(result)
    } catch (e) { setPart(null); version.current = null; setError(String(e)) }
    finally { setBusy(false) }
  }
  return <section aria-label="正文分段读取" className="content-reader">
    <h4>正文分段读取</h4><p>仅 UTF-8 纯文本；不解析原 PDF。默认 4000、最多 32000 个 Unicode 字符，响应最多 256KiB。只读，不启动模型或重新提取。</p>
    <fieldset disabled={busy} onChange={() => { setPart(null); version.current = null }}>
      <label>每段字符数<input type="number" min="1" max="32000" value={chars} onChange={e => setChars(e.target.value)} /></label>
      {hasPages && <label><input type="checkbox" checked={pages} onChange={e => setPages(e.target.checked)} />按工具报告的页索引选择</label>}
      {pages ? <><label>起始页<input type="number" min="1" value={firstPage} onChange={e => setFirstPage(e.target.value)} /></label><label>结束页<input type="number" min="1" value={lastPage} onChange={e => setLastPage(e.target.value)} /></label></> : <><label>起始 UTF-8 字节<input type="number" min="0" value={start} onChange={e => setStart(e.target.value)} /></label><label>结束 UTF-8 字节（不填到末尾）<input type="number" min="0" value={end} onChange={e => setEnd(e.target.value)} /></label></>}
    </fieldset>
    <button disabled={busy} onClick={() => void read()}>读取选定正文</button>{part?.next_cursor && <button disabled={busy} onClick={() => void read(true)}>读取下一段正文</button>}
    {error && <p role="alert">{error}。请重新选择后读取；不拼接旧版本。</p>}
    {part && <><p role="status">本段字节 [{part.actual_range.start_bytes}, {part.actual_range.end_bytes}) · {part.actual_range.chars} 字符 · {part.next_cursor ? '选定范围尚未读完' : '选定范围已读完（不等于全文完整）'}</p><p>提取标记：{part.partial === null ? '无派生记录' : part.partial ? '部分结果' : '工具未标记部分，不保证语义完整'}；页码定位：{part.location_verification ?? '无工具页索引'}。仅显示当前片段。</p><pre>{part.data.text}</pre><small>正文版本 {part.content_version}</small></>}
  </section>
}
