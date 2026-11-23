import { useEffect, useRef, useState } from 'react'
// @ts-expect-error The reference plugin vendors the PDF.js build without its declarations.
import { AnnotationMode, PDFWorker, getDocument } from '../../../reference-plugins/pdf-text/vendor/legacy/build/pdf.mjs'
import PdfWorker from '../../../reference-plugins/pdf-text/vendor/legacy/build/pdf.worker.mjs?worker'

const assets = import.meta.glob<string>([
  '../../../reference-plugins/pdf-text/vendor/cmaps/*.bcmap',
  '../../../reference-plugins/pdf-text/vendor/standard_fonts/*.{pfb,ttf}'
], { eager: true, import: 'default', query: '?url&inline' })

function decode(base64: string) {
  const text = atob(base64), bytes = new Uint8Array(text.length)
  for (let i = 0; i < bytes.length; i++) bytes[i] = text.charCodeAt(i)
  return bytes
}

// The parser can read bundled fonts and maps only, in both file and HTTP renderers.
class PdfAssets {
  async fetch({ kind, filename }: { kind: string; filename: string }) {
    const folder = kind === 'cMapUrl' ? 'cmaps' : kind === 'standardFontDataUrl' ? 'standard_fonts' : null
    const url = folder && assets[`../../../reference-plugins/pdf-text/vendor/${folder}/${filename}`]
    if (!url?.startsWith('data:') || !url.includes(';base64,')) throw Error('PDF asset unavailable')
    return decode(url.slice(url.indexOf(',') + 1))
  }
}

type Draw = { promise: Promise<void>; cancel(): void }
type Viewport = { width: number; height: number }
type PdfPage = {
  getViewport(options: { scale: number }): Viewport
  render(options: { canvas: HTMLCanvasElement; viewport: Viewport; annotationMode: number }): Draw
  cleanup(): void
}
type Document = { numPages: number; getPage(index: number): Promise<PdfPage> }
type Loading = { promise: Promise<Document>; onPassword: () => void; destroy(): Promise<void> }

export default function MaterialPdfPreview({ base64, name }: { base64: string; name: string }) {
  const [document, setDocument] = useState<Document | null>(null)
  const [error, setError] = useState('')
  const [page, setPage] = useState(1)
  const [rendering, setRendering] = useState(true)
  const [pageError, setPageError] = useState(false)
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let active = true, port: Worker | undefined, worker: { destroy(): void } | undefined, loading: Loading | undefined
    const fail = (message: string) => { if (active) setError(message) }
    try {
      port = new PdfWorker()
      port.addEventListener('error', event => { event.preventDefault(); fail('无法启动 PDF 预览。') })
      worker = new PDFWorker({ port })
      const task: Loading = getDocument({
        data: decode(base64), worker, BinaryDataFactory: PdfAssets, cMapPacked: true, useWorkerFetch: false,
        useWasm: false, disableFontFace: true, enableXfa: false, maxImageSize: 16_000_000,
        canvasMaxAreaInBytes: 64_000_000, disableAutoFetch: true, verbosity: 0
      })
      loading = task
      task.onPassword = () => fail('此 PDF 需要密码，已保存原件。')
      void task.promise.then(value => { if (active) setDocument(value) }, () => fail('无法打开此 PDF。'))
    } catch { fail('无法打开此 PDF。') }
    return () => {
      active = false
      // The supplied Worker belongs to this preview, including when loading is interrupted.
      const stop = () => { port?.terminate(); worker?.destroy() }
      if (!loading) { stop(); return }
      const timeout = setTimeout(stop, 1000)
      void loading.destroy().catch(() => {}).finally(() => { clearTimeout(timeout); stop() })
    }
  }, [base64])

  useEffect(() => {
    const target = canvas.current
    if (!target || !document || error) return
    let active = true, draw: Draw | undefined, pdfPage: PdfPage | undefined
    setRendering(true); setPageError(false)
    void document.getPage(page).then(source => {
      pdfPage = source
      if (!active) { source.cleanup(); return }
      const size = source.getViewport({ scale: 1 })
      const viewport = source.getViewport({ scale: Math.min(2, 1200 / size.width, 1600 / size.height) })
      target.width = Math.max(1, Math.round(viewport.width))
      target.height = Math.max(1, Math.round(viewport.height))
      draw = source.render({ canvas: target, viewport, annotationMode: AnnotationMode.DISABLE })
      return draw.promise
    }).catch(() => { if (active) setPageError(true) })
      .finally(() => { if (active) setRendering(false) })
    return () => { active = false; draw?.cancel(); pdfPage?.cleanup() }
  }, [document, page, error])

  if (error) return <p className="muted" role="status">{error}</p>
  if (!document) return <p className="record-caption" role="status">正在打开 PDF…</p>
  return <section className="material-pdf" aria-label="PDF 预览">
    <div className="material-format-tools">
      <button disabled={page <= 1 || rendering} onClick={() => { setRendering(true); setPage(page - 1) }}>上一页</button>
      <span aria-live="polite">第 {page} 页 / 共 {document.numPages} 页</span>
      <button disabled={page >= document.numPages || rendering} onClick={() => { setRendering(true); setPage(page + 1) }}>下一页</button>
    </div>
    {rendering && <p className="record-caption" role="status">正在渲染页面…</p>}
    {pageError && <p className="muted" role="status">无法显示此页。</p>}
    <canvas ref={canvas} hidden={rendering || pageError} role="img" aria-label={`${name}，第 ${page} 页`} />
  </section>
}
