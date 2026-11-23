import { lazy, Suspense, useEffect, useState } from 'react'
import { binaryPreviewChunk, binaryPreviewLimit } from '../../shared/material-formats'
import { hostRequest } from './ModelSettings'

const MaterialPdfPreview = lazy(() => import('./MaterialPdfPreview'))
type Chunk = { base64: string; mime: string; offset: number; next_offset: number | null; byte_length: number; content_version: string }

export function MaterialBinaryPreview({ taskId, resourceId, name, mime, byteLength }: { taskId: string; resourceId: string; name: string; mime: string; byteLength: number }) {
  const [payload, setPayload] = useState('')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const tooLarge = byteLength > binaryPreviewLimit
  useEffect(() => {
    if (!byteLength || tooLarge) return
    let active = true
    setError('')
    async function load() {
      const pieces: string[] = []
      let version: string | undefined
      // The chunk size is divisible by three, so only the last piece has base64 padding.
      for (let offset = 0; offset < byteLength && active; offset += binaryPreviewChunk) {
        const part = await hostRequest<Chunk>({ type: 'material.read', representation: 'preview', task_id: taskId, resource_id: resourceId, offset })
        const next = offset + binaryPreviewChunk
        const expected = Math.min(binaryPreviewChunk, byteLength - offset)
        if (part.mime !== mime || part.offset !== offset || part.byte_length !== byteLength || !part.base64 || !part.content_version ||
            (version !== undefined && version !== part.content_version) ||
            part.base64.length !== 4 * Math.ceil(expected / 3) || part.next_offset !== (next < byteLength ? next : null)) throw Error('Invalid preview response')
        version = part.content_version
        pieces.push(part.base64)
      }
      if (active) setPayload(pieces.join(''))
    }
    void load().catch((reason: { code?: string }) => {
      if (active) setError(reason.code === 'UNSUPPORTED_REPRESENTATION' ? '文件内容与格式不符。' : '无法读取文件预览。')
    })
    return () => { active = false }
  }, [taskId, resourceId, mime, byteLength, tooLarge, attempt])

  if (!byteLength) return <p className="muted">文件为空。</p>
  if (tooLarge) return <p className="muted">此文件超过 8 MB，已保存原件。</p>
  if (error) return <p className="error" role="alert">{error} <button onClick={() => { setPayload(''); setError(''); setAttempt(value => value + 1) }}>重试</button></p>
  const loading = <p className="record-caption" role="status">正在加载预览…</p>
  if (!payload) return loading
  if (mime === 'application/pdf') return <Suspense fallback={loading}><MaterialPdfPreview base64={payload} name={name} /></Suspense>
  return <img className="material-image" alt={name} src={`data:${mime};base64,${payload}`} onError={() => setError('无法解码此图片。')} />
}
