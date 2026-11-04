import { parentPort, workerData } from 'node:worker_threads'
import { readFile } from 'node:fs/promises'
import { denyNetwork } from './network-guard.mjs'
denyNetwork()
console.log = console.warn = (...args) => console.error(...args)
const limits = Object.freeze({ input: 16777216, pages: 200, total: 8388608, page: 262144 })
const fail = code => { throw new Error(code) }
const safePrefix = (text, max) => { let used = 0, end = 0; for (const point of text) { const n = Buffer.byteLength(point); if (used + n > max) break; used += n; end += point.length } return text.slice(0, end) }
let loading, passwordRequired = false
try {
  const data = new Uint8Array(workerData.bytes)
  if (!data.length || data.length > limits.input) fail('PDF_INPUT_LIMIT')
  if (!Buffer.from(data.subarray(0, 1024)).includes(Buffer.from('%PDF-'))) fail('PDF_INVALID')
  const source = JSON.parse(await readFile(new URL('./vendor-source.json', import.meta.url), 'utf8'))
  const allowed = new Set(source.files.map(f => f.path))
  class LocalAssets {
    async fetch({ kind, filename }) {
      const folder = kind === 'cMapUrl' ? 'cmaps' : kind === 'standardFontDataUrl' ? 'standard_fonts' : null
      const path = `vendor/${folder}/${filename}`
      if (!folder || !/^[A-Za-z0-9_.-]+$/.test(filename) || !allowed.has(path)) fail('PDF_ASSET_DENIED')
      return new Uint8Array(await readFile(new URL('./' + path, import.meta.url)))
    }
  }
  const { getDocument } = await import('./vendor/legacy/build/pdf.mjs')
  loading = getDocument({ data, BinaryDataFactory: LocalAssets, cMapUrl: 'bundled/', cMapPacked: true, standardFontDataUrl: 'bundled/', useWorkerFetch: false, useWasm: false, useSystemFonts: false, disableFontFace: true, enableXfa: false, stopAtErrors: true, isOffscreenCanvasSupported: false, isImageDecoderSupported: false, disableRange: true, disableStream: true, disableAutoFetch: true, verbosity: 0 })
  let rejectPassword
  const password = new Promise((_, reject) => { rejectPassword = reject })
  loading.onPassword = () => { passwordRequired = true; rejectPassword(Error('PDF_PASSWORD_REQUIRED')) }
  const doc = await Promise.race([loading.promise, password])
  if ((await doc.getMetadata()).info.EncryptFilterName) fail('PDF_ENCRYPTED_UNSUPPORTED')
  let text = '', bytes = 0, partial = doc.numPages > limits.pages, nonempty = false
  const notices = new Set(partial ? ['PDF_PAGE_LIMIT: only the first 200 real pages were extracted.'] : [])
  const pages = []
  for (let number = 1; number <= Math.min(doc.numPages, limits.pages); number++) {
    const page = await doc.getPage(number), reader = page.streamTextContent({ disableNormalization: false }).getReader()
    const heading = `--- Page ${number} ---\n`
    let body = '', pageBytes = Buffer.byteLength(heading) + 1, pageLimited = false
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break
        for (const item of chunk.value.items) {
          if (typeof item.str !== 'string') continue
          const part = item.str + (item.hasEOL ? '\n' : ' '), remaining = limits.page - pageBytes
          const accepted = safePrefix(part, Math.max(0, remaining))
          body += accepted; pageBytes += Buffer.byteLength(accepted)
          if (accepted !== part) { pageLimited = true; break }
        }
        if (pageLimited) { await reader.cancel(new Error('PDF_PAGE_TEXT_LIMIT')); break }
      }
    } finally { reader.releaseLock(); page.cleanup() }
    nonempty ||= !!body.trim()
    let section = `${heading}${body}\n`
    const remaining = limits.total - bytes
    if (Buffer.byteLength(section) > remaining) { section = safePrefix(section, remaining); partial = true; notices.add('PDF_TEXT_LIMIT: extraction stopped at the total UTF-8 limit.') }
    const start = bytes; bytes += Buffer.byteLength(section); text += section
    pages.push({ page: number, start, end: bytes })
    if (pageLimited) { partial = true; notices.add('PDF_PAGE_TEXT_LIMIT: one or more indexed pages were truncated.') }
    if (bytes >= limits.total) { if (number < doc.numPages) { partial = true; notices.add('PDF_TEXT_LIMIT: extraction stopped at the total UTF-8 limit.') } break }
  }
  if (!nonempty) fail('PDF_NO_TEXT')
  parentPort.postMessage({ ok: true, text, pages, partial, notice: [...notices].join(' ').slice(0, 2000), page_count: doc.numPages })
} catch (error) {
  const message = String(error?.message ?? '')
  parentPort.postMessage({ ok: false, code: passwordRequired ? 'PDF_PASSWORD_REQUIRED' : /^PDF_[A-Z_]+$/.test(message) ? message : error?.name === 'PasswordException' ? 'PDF_PASSWORD_REQUIRED' : 'PDF_INVALID_OR_UNSUPPORTED' })
} finally { await loading?.destroy().catch(() => {}) }
