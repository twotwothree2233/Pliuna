import { useEffect, useMemo, useState } from 'react'
import MarkdownIt from 'markdown-it'
import { materialExtension } from '../../shared/material-formats'
import { materialTable } from './material-table'
import { hostRequest } from './ModelSettings'

const markdown = new MarkdownIt({ html: false, linkify: false })
// Keep imported documents local. Links render as labels; images never load.
markdown.renderer.rules.link_open = () => ''
markdown.renderer.rules.link_close = () => ''
markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index]?.content ?? '')

const previewChars = 8000
const maxCachedChars = 128 * 1024
type Part = { data: { text: string }; next_cursor: string | null; content_version: string }

export function isPlainTextMaterial(mediaType?: string) {
  return mediaType === 'text/plain' || mediaType === 'text/plain; charset=utf-8'
}

export function MaterialTextPreview({ taskId, resourceId, name }: { taskId: string; resourceId: string; name?: string }) {
  const [request, setRequest] = useState<{ cursor: string | null }>({ cursor: null })
  const [preview, setPreview] = useState<{ text: string; cursor: string | null; version: string; windowed: boolean } | null>(null)
  const [busy, setBusy] = useState(true), [error, setError] = useState('')
  const [raw, setRaw] = useState(false)
  useEffect(() => {
    let active = true
    const cursor = request.cursor
    setBusy(true)
    setError('')
    void hostRequest<Part>({ type: 'task.query', task_id: taskId, query: { type: 'read', input: {
      target: { kind: 'resource', id: resourceId }, ...(cursor ? { cursor } : { content: { max_chars: previewChars } })
    } } }).then(part => {
      if (!active) return
      const previous = cursor ? preview : null
      if (previous && previous.version !== part.content_version) throw Error('材料已变化')
      const append = previous && previous.text.length + part.data.text.length <= maxCachedChars
      setPreview({ text: append ? previous.text + part.data.text : part.data.text, cursor: part.next_cursor, version: part.content_version, windowed: Boolean(previous && (!append || previous.windowed)) })
    }).catch(() => { if (active) setError('无法读取正文。') })
      .finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [taskId, resourceId, request])

  const text = preview?.text ?? ''
  const extension = materialExtension(name)
  const renderMarkdown = !preview?.windowed && ['md', 'markdown'].includes(extension)
  const delimiter = extension === 'csv' ? ',' : extension === 'tsv' ? '\t' : null
  const table = useMemo(() => delimiter && !preview?.windowed && !raw ? materialTable(text, delimiter, !!preview?.cursor) : null, [delimiter, preview, raw, text])
  const showTable = !!table?.rows.length
  const renderSource = !!extension && !['txt', 'md', 'markdown'].includes(extension)
  const html = useMemo(() => renderMarkdown ? markdown.render(text) : '', [renderMarkdown, text])
  function restart() { setPreview(null); setRequest({ cursor: null }) }

  return <section className="material-text-preview" aria-label="材料正文" aria-busy={busy}>
    {error && <p role="alert" className="error">{error} <button onClick={() => setRequest({ ...request })}>重试</button>{request.cursor && <button onClick={restart}>从头读取</button>}</p>}
    {!preview && busy && <p className="record-caption" role="status">正在读取正文…</p>}
    {preview && (text.length ? <>
      {delimiter && !preview.windowed && (showTable || raw) && <div className="material-format-tools">
        {showTable && table.clipped && <span>显示前 {table.rows.length} 行，每行最多 16 列</span>}
        <button disabled={busy} onClick={() => setRaw(!raw)}>{raw ? '返回表格' : '查看原文'}</button>
      </div>}
      {showTable ? <div className="material-table-scroll" role="region" aria-label="表格滚动区域" tabIndex={0}>
        <table aria-label="表格预览"><tbody>{table.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody></table>
      </div> : renderMarkdown ? <div className="material-markdown" dangerouslySetInnerHTML={{ __html: html }} />
        : renderSource ? <pre className="material-code"><code>{text}</code></pre>
        : <div className="record-value-text">{text}</div>}
    </> : <p className="muted">文件没有正文。</p>)}
    {preview && !showTable && (preview.cursor || preview.windowed) && <div className="material-preview-actions">
      {preview.cursor && <button disabled={busy || !!error} onClick={() => setRequest({ cursor: preview.cursor })}>{busy ? '正在读取…' : '继续阅读'}</button>}
      {preview.windowed && <><span>当前显示后续正文</span><button disabled={busy} onClick={restart}>回到开头</button></>}
    </div>}
  </section>
}
