import { createHash } from 'node:crypto'
import { lstat,type FileHandle } from 'node:fs/promises'
import { managedFile,openRegularFile } from '../../platform/files'
import defaults from '../../shared/contracts/development-defaults.json'
import { ContractError } from '../../shared/validation'

export type Resource = { id: string; storage_key: string; byte_length: number; sha256: string }
const fail = (): never => { throw new ContractError('RESOURCE_CORRUPT', 'Plugin result resource is missing, changed or not valid UTF-8; it was not repaired') }
export async function verifiedResource<T>(root: string, resource: Resource, consume: (file: FileHandle) => Promise<T>, valid: () => void = () => {}, utf8 = false): Promise<T> {
  if (!/^[A-Za-z0-9_-]+$/.test(resource.storage_key) || !Number.isSafeInteger(resource.byte_length) || resource.byte_length < 0 || resource.byte_length > defaults.transport.resource_bytes) return fail()
  const path = managedFile(root, 'resources', resource.storage_key), initial = await lstat(path).catch(fail)
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1 || initial.size !== resource.byte_length) return fail()
  const file = await openRegularFile(path)
  try {
    const opened = await file.stat(), same = (s: typeof initial) => s.isFile() && s.nlink === 1 && s.ino === initial.ino && s.dev === initial.dev && s.size === initial.size && s.mtimeMs === initial.mtimeMs && s.ctimeMs === initial.ctimeMs
    if (!same(opened)) return fail()
    const hash = createHash('sha256'), buffer = Buffer.alloc(256 * 1024), decoder = utf8 ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }) : undefined
    for (let position = 0; position < initial.size;) {
      valid()
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, initial.size - position), position)
      if (!bytesRead) return fail()
      const chunk = buffer.subarray(0, bytesRead)
      try { decoder?.decode(chunk, { stream: true }) } catch { return fail() }
      hash.update(chunk); position += bytesRead
    }
    try { decoder?.decode() } catch { return fail() }
    if (hash.digest('hex') !== resource.sha256 || !same(await file.stat())) return fail()
    const result = await consume(file)
    if (!same(await file.stat()) || !same(await lstat(path))) return fail()
    return result
  } finally { await file.close() }
}
export async function readPluginResource(root: string, resource: Resource, offset: number, verifyOnly = false, maxChars?: number): Promise<{ text: string; truncated: boolean; next_offset: number | null }> {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > resource.byte_length) return fail()
  return verifiedResource(root, resource, async file => {
    if (verifyOnly) return { text: '', truncated: false, next_offset: null }
    const piece = Buffer.alloc(Math.min(maxChars === undefined ? 4096 : maxChars * 4 + 4, resource.byte_length - offset)), { bytesRead } = await file.read(piece, 0, piece.length, offset)
    let end = bytesRead
    if (offset + end < resource.byte_length) {
      let start = end - 1
      while (start >= 0 && (piece[start]! & 0xc0) === 0x80) start--
      if (start >= 0) { const first = piece[start]!, needed = first < 128 ? 1 : first < 224 ? 2 : first < 240 ? 3 : 4; if (end - start < needed) end = start }
    }
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(piece.subarray(0, end)) } catch { return fail() }
    if (maxChars !== undefined) {
      let selected = '', chars = 0, bytes = 0
      for (const point of text) {
        const cost = Buffer.byteLength(JSON.stringify(point)) - 2
        if (chars === maxChars || bytes + cost > defaults.read.text_bytes / 2) break
        selected += point; chars++; bytes += cost
      }
      text = selected; end = Buffer.byteLength(selected)
    }
    return { text, truncated: offset + end < resource.byte_length, next_offset: offset + end < resource.byte_length ? offset + end : null }
  })
}
export async function readPluginBytes(root: string, resource: Resource, offset: number, length: number, valid: () => void): Promise<{ base64: string; offset: number; next_offset: number | null; byte_length: number; sha256: string }> {
  valid()
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > resource.byte_length || !Number.isSafeInteger(length) || length < 1 || length > defaults.transport.upload_chunk_bytes) throw new ContractError('RESOURCE_RANGE_INVALID', 'Binary resource reads require a bounded byte range')
  const result = await verifiedResource(root, resource, async file => {
    valid()
    const bytes = Buffer.alloc(Math.min(length, resource.byte_length - offset))
    let read = 0
    while (read < bytes.length) { const part = await file.read(bytes, read, bytes.length - read, offset + read); if (!part.bytesRead) return fail(); read += part.bytesRead }
    return { base64: bytes.toString('base64'), offset, next_offset: offset + read < resource.byte_length ? offset + read : null, byte_length: resource.byte_length, sha256: resource.sha256 }
  })
  valid()
  return result
}
export async function verifyPluginFile(root: string, resource: Resource): Promise<string> {
  return verifiedResource(root, resource, async file => pluginFileIdentity(await file.stat()))
}
export async function readResourceContent(root: string, resource: Resource, start: number, end: number, maxChars: number, valid: () => void): Promise<{ text: string; chars: number; end: number }> {
  if (![start, end, maxChars].every(Number.isSafeInteger) || start < 0 || end < start || end > resource.byte_length || maxChars < 1 || maxChars > defaults.read.content_max_chars) throw new ContractError('RESOURCE_RANGE_INVALID', 'Invalid text range or max_chars; UTF-8 byte boundaries and 1..32000 characters required')
  valid()
  const result = await verifiedResource(root, resource, async file => {
    valid()
    for (const [field, offset] of [['offset_bytes', start], ['end_bytes', end]] as const) {
      if (offset < resource.byte_length) {
        const byte = Buffer.alloc(1); await file.read(byte, 0, 1, offset)
        if ((byte[0]! & 0xc0) === 0x80) {
          const base = Math.max(0, offset - 3), window = Buffer.alloc(Math.min(7, resource.byte_length - base))
          const { bytesRead } = await file.read(window, 0, window.length, base)
          let previous = offset - base, next = previous
          while (previous > 0 && (window[previous]! & 0xc0) === 0x80) previous--
          while (next < bytesRead && (window[next]! & 0xc0) === 0x80) next++
          try {
            const point = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(window.subarray(previous, next))
            if ([...point].length !== 1) return fail()
          } catch { return fail() }
          throw new ContractError('RESOURCE_RANGE_INVALID', `${field}=${offset} splits a UTF-8 character; nearest valid byte boundaries: ${base + previous}, ${base + next}. Range was not adjusted; use the existing cursor for sequential reading`)
        }
      }
    }
    const bytes = Buffer.alloc(Math.min(end - start, maxChars * 4 + 4))
    let length = 0
    while (length < bytes.length) { const part = await file.read(bytes, length, bytes.length - length, start + length); if (!part.bytesRead) return fail(); length += part.bytesRead }
    if (start + length < end) {
      let last = length - 1
      while (last >= 0 && (bytes[last]! & 0xc0) === 0x80) last--
      if (last >= 0) {
        const lead = bytes[last]!, needed = lead < 128 ? 1 : lead < 224 ? 2 : lead < 240 ? 3 : 4
        if (length - last < needed) length = last
      }
    }
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length)) } catch { return fail() }
    let selected = '', chars = 0
    for (const point of text) { if (chars === maxChars) break; selected += point; chars++ }
    return { text: selected, chars, end: start + Buffer.byteLength(selected) }
  })
  valid()
  return result
}
export const pluginFileIdentity = (stat: import('node:fs').Stats): string => JSON.stringify([stat.isFile(), stat.nlink, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs])
