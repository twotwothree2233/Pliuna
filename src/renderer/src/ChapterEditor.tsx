import React, { useEffect, useRef, useState } from 'react'
import type { ChapterUpdate } from '../../shared/contracts.generated'
import type { View } from '../../shared/types'
import { hostRequest } from './ModelSettings'

export interface ChapterSourceRequest {
  request_id: string
  text: string
  text_truncated: boolean
  model_config_id: string
}
interface Props {
  taskId: string
  view: View
  modelId: string
  enabled: boolean
  save(): Promise<void>
  stateRevision(): number
  refresh(): Promise<void>
  onDirty(id: string, dirty: boolean): void
  sourceRequest?: ChapterSourceRequest
  onSourceResolved?(): void
}
interface PendingUpdate { update_id: string; input_event_id: string }

export function ChapterEditor({ taskId, view, modelId, enabled, save, stateRevision, refresh, onDirty, sourceRequest, onSourceResolved }: Props) {
  const [text, setText] = useState('')
  const [regions, setRegions] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [unknown, setUnknown] = useState<PendingUpdate | null>(null)
  const composing = useRef(false)
  const pending = useRef<PendingUpdate | null>(null)
  const editor = useRef<HTMLDetailsElement>(null)
  const marker = 'chapter-edit-' + view.id
  const chapters = view.chapter_manifest?.chapters ?? []
  const instruction = sourceRequest?.text ?? text
  const selectedModel = sourceRequest?.model_config_id ?? modelId
  useEffect(() => {
    if (!sourceRequest || !editor.current) return
    setRegions(chapters.length === 1 ? [chapters[0]!.region_id] : [])
    editor.current.open = true
    const frame = requestAnimationFrame(() => {
      editor.current?.scrollIntoView({ block: 'nearest' })
      editor.current?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [sourceRequest?.request_id, Boolean(view.chapter_manifest)])
  useEffect(() => {
    setRegions(previous => {
      const retained = previous.filter(id => chapters.some(chapter => chapter.region_id === id))
      return retained.length ? retained : chapters.length === 1 ? [chapters[0]!.region_id] : []
    })
  }, [view.chapter_manifest?.manifest_revision])
  useEffect(() => { onDirty(marker, Boolean(text.trim() || unknown)); return () => onDirty(marker, false) }, [text, unknown, marker])

  async function map() {
    setBusy(true); setError('')
    try {
      await save()
      await hostRequest({ type: 'chapters.map', task_id: taskId, view_id: view.id, expected_view_revision: view.revision })
      await refresh()
    } catch (error) { setError(String(error).replace(/^Error:\s*/, '')) } finally { setBusy(false) }
  }
  async function query() {
    if (!unknown) return
    setBusy(true); setError('')
    try {
      await hostRequest<ChapterUpdate>({ type: 'chapter.status', task_id: taskId, update_id: unknown.update_id })
      pending.current = null; setUnknown(null); if (!sourceRequest) setText(''); else onSourceResolved?.(); await refresh()
    } catch (error) { setError(String(error).replace(/^Error:\s*/, '')) } finally { setBusy(false) }
  }
  async function submit() {
    if (!enabled || busy || unknown || composing.current || !instruction.trim() || !regions.length || !selectedModel) return
    setBusy(true); setError('')
    let sent = false
    const identity = pending.current ?? { update_id: crypto.randomUUID(), input_event_id: crypto.randomUUID() }
    pending.current = identity
    try {
      await save()
      sent = true
      const regionIds: [string, ...string[]] = [regions[0]!, ...regions.slice(1)]
      await hostRequest<ChapterUpdate>({ type: 'chapter.update', task_id: taskId, ...identity, view_id: view.id, view_revision: view.revision, state_revision: stateRevision(), region_ids: regionIds, text: sourceRequest ? instruction : instruction.trim(), model_config_id: selectedModel, ...(sourceRequest ? { source_request_id: sourceRequest.request_id } : {}) })
      pending.current = null; if (!sourceRequest) setText(''); else onSourceResolved?.(); onDirty(marker, Boolean(sourceRequest && text.trim())); await refresh()
    } catch (error) {
      setError(String(error).replace(/^Error:\s*/, ''))
      if (sent && /UNKNOWN_RESULT|CONNECTION_LOST|OFFLINE|fetch|network|Failed to fetch/i.test(String(error))) setUnknown(identity)
      else pending.current = null
    } finally { setBusy(false) }
  }

  return <details className="chapter-editor" ref={editor}><summary>修改正文</summary>
    {sourceRequest && <div className="chapter-source"><p>请确认这条请求要修改的章节。</p><blockquote>{sourceRequest.text}{sourceRequest.text_truncated && '…'}</blockquote><small>{sourceRequest.text_truncated ? '此处显示摘要，更新会使用已保存的完整原请求。' : '更新会沿用原请求及其材料。'}</small></div>}
    {!view.chapter_manifest ? <><p>先定位可独立修改的章节，原正文会继续显示。</p><button disabled={!enabled || busy} onClick={() => void map()}>{busy ? '正在定位章节…' : '定位章节'}</button></> : <form onSubmit={event => { event.preventDefault(); void submit() }}>
      <fieldset disabled={!enabled || busy || Boolean(unknown)}><legend>选择要修改的章节</legend><div className="chapter-options">{chapters.map(chapter => <label key={chapter.region_id}><input type="checkbox" checked={regions.includes(chapter.region_id)} onChange={event => setRegions(previous => event.target.checked ? [...previous, chapter.region_id] : previous.filter(id => id !== chapter.region_id))} /><span>{chapter.title}</span></label>)}</div></fieldset>
      {!sourceRequest && <><label htmlFor={'chapter-instruction-' + view.id}>修改要求</label><textarea id={'chapter-instruction-' + view.id} value={text} disabled={!enabled || busy || Boolean(unknown)} onChange={event => setText(event.target.value)} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} placeholder="描述所选章节需要如何调整…" /></>}
      <div className="inline-actions"><button className="primary" disabled={!enabled || busy || !selectedModel || !instruction.trim() || !regions.length || Boolean(unknown)}>{busy ? '正在保存并提交…' : '更新所选章节'}</button>{!sourceRequest && text && !unknown && <button type="button" disabled={busy} onClick={() => { setText(''); setError('') }}>清除要求</button>}{sourceRequest && !unknown && <button type="button" disabled={busy} onClick={onSourceResolved}>稍后处理</button>}</div>
      {!selectedModel && <p>请先在设置中选择主模型。</p>}
    </form>}
    {unknown && <div role="status"><p>更新请求结果尚未确认。先查询原更新，再继续操作。</p><button disabled={busy} onClick={() => void query()}>查询原更新</button></div>}
    {error && <p className="error" role="alert">{error}</p>}
  </details>
}
