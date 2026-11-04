import type { FileHandle } from 'node:fs/promises'
import defaults from '../../shared/contracts/development-defaults.json'
import { ContractError } from '../../shared/validation'
import { verifiedResource, type Resource } from './resource-reader'
import type { ReadSelection } from '../model/tool-input'

const BLOCK = 256 * 1024
const SCAN = 1024 * 1024
const invalid = (message: string): never => { throw new ContractError('RESOURCE_RANGE_INVALID', message) }
type Location = { offset: number; line: number; line_start: number }
type Pending = { start: number; end: number; offset: number; line: number; end_line: number; location: Location; match?: { start_bytes: number; end_bytes: number } }
export interface TextPosition { scan: Location; pending?: Pending; selected?: { start: number; end: number }; done: boolean }

async function bytes(file: FileHandle, start: number, end: number, valid: () => void): Promise<Buffer> {
  valid()
  const buffer = Buffer.alloc(end - start)
  let count = 0
  while (count < buffer.length) {
    const part = await file.read(buffer, count, buffer.length - count, start + count)
    if (!part.bytesRead) throw new ContractError('RESOURCE_CORRUPT', 'Resource ended during reading')
    count += part.bytesRead; valid()
  }
  return buffer
}
function advance(location: Location, buffer: Buffer): Location {
  let { line, line_start } = location
  for (let i = buffer.indexOf(10); i >= 0; i = buffer.indexOf(10, i + 1)) { line++; line_start = location.offset + i + 1 }
  return { offset: location.offset + buffer.length, line, line_start }
}
async function lineEnd(file: FileHandle, location: Location, size: number, valid: () => void): Promise<Location> {
  while (location.offset < size) {
    const buffer = await bytes(file, location.offset, Math.min(size, location.offset + BLOCK), valid), newline = buffer.indexOf(10)
    if (newline >= 0) return advance(location, buffer.subarray(0, newline + 1))
    location = advance(location, buffer)
  }
  return location
}
async function locationAt(file: FileHandle, offset: number, valid: () => void): Promise<Location> {
  let location: Location = { offset: 0, line: 1, line_start: 0 }
  while (location.offset < offset) location = advance(location, await bytes(file, location.offset, Math.min(offset, location.offset + BLOCK), valid))
  return location
}
async function lineRange(file: FileHandle, lines: [number, number], size: number, valid: () => void): Promise<{ start: number; end: number }> {
  let location: Location = { offset: 0, line: 1, line_start: 0 }, start = lines[0] === 1 ? 0 : -1
  while (location.offset < size) {
    const buffer = await bytes(file, location.offset, Math.min(size, location.offset + BLOCK), valid)
    for (let i = buffer.indexOf(10); i >= 0; i = buffer.indexOf(10, i + 1)) {
      location.line++; location.line_start = location.offset + i + 1
      if (location.line === lines[0]) start = location.line_start
      if (location.line > lines[1]) return { start, end: location.line_start }
    }
    location.offset += buffer.length
  }
  if (start < 0) return invalid('Start line exceeds text; lines are one-based inclusive')
  return { start, end: size }
}
async function find(file: FileHandle, scan: Location, needle: Buffer, size: number, valid: () => void): Promise<{ scan: Location; pending?: Pending; done: boolean }> {
  const boundary = Math.min(size, scan.offset + SCAN)
  // Keep only the overlap needed to discover literals crossing scan blocks.
  while (scan.offset < boundary) {
    const end = Math.min(size, scan.offset + BLOCK + needle.length - 1)
    const buffer = await bytes(file, scan.offset, end, valid), index = buffer.indexOf(needle)
    const consumed = Math.min(BLOCK, boundary - scan.offset)
    if (index >= 0 && index < consumed) {
      const first = advance(scan, buffer.subarray(0, index)), after = advance(first, buffer.subarray(index, index + needle.length))
      const last = needle.at(-1) === 10 ? after : await lineEnd(file, after, size, valid)
      return { scan: after, done: after.offset === size, pending: { start: first.line_start, end: last.offset, offset: first.line_start, line: first.line, location: { offset: first.line_start, line: first.line, line_start: first.line_start }, end_line: needle.at(-1) === 10 ? after.line - 1 : last.line - (last.line_start === last.offset && last.offset > 0 ? 1 : 0), match: { start_bytes: first.offset, end_bytes: after.offset } } }
    }
    scan = advance(scan, buffer.subarray(0, consumed))
  }
  return { scan, done: scan.offset === size }
}
async function fragment(file: FileHandle, start: number, end: number, maxChars: number, valid: () => void): Promise<{ text: string; chars: number; end: number }> {
  const buffer = await bytes(file, start, Math.min(end, start + maxChars * 4 + 4), valid)
  let stop = buffer.length
  if (start + stop < end) {
    let lead = stop - 1
    while (lead >= 0 && (buffer[lead]! & 0xc0) === 0x80) lead--
    if (lead >= 0) { const byte = buffer[lead]!, needed = byte < 128 ? 1 : byte < 224 ? 2 : byte < 240 ? 3 : 4; if (stop - lead < needed) stop = lead }
  }
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, stop)) }
  catch { throw new ContractError('RESOURCE_CORRUPT', 'Resource is not valid UTF-8') }
  let selected = '', chars = 0
  for (const point of text) { if (chars === maxChars) break; selected += point; chars++ }
  return { text: selected, chars, end: start + Buffer.byteLength(selected) }
}

export async function readTextSelection(root: string, resource: Resource, selection: ReadSelection, maxChars: number, previous: TextPosition | undefined, pageRange: { start: number; end: number } | undefined, valid: () => void): Promise<any> {
  valid()
  const result = await verifiedResource(root, resource, async file => {
    valid()
    let position: TextPosition = previous ?? { scan: { offset: 0, line: 1, line_start: 0 }, done: false }
    if (selection.find !== undefined) {
      const matches: any[] = []
      let remaining = maxChars, responseBytes = 0
      const scanStart = position.scan.offset, needle = Buffer.from(selection.find)
      while (remaining > 0) {
        if (!position.pending && !position.done) {
          if (position.scan.offset - scanStart >= SCAN) break
          position = await find(file, position.scan, needle, resource.byte_length, valid)
        }
        const pending = position.pending
        if (!pending) break
        const part = await fragment(file, pending.offset, pending.end, remaining, valid)
        const after = advance(pending.location, Buffer.from(part.text))
        const item = { text: part.text, match: pending.match, actual_range: { start_bytes: pending.offset, end_bytes: part.end, chars: part.chars }, lines: { start: pending.location.line, end: Math.max(pending.location.line, after.line - (part.text.endsWith('\n') ? 1 : 0)) }, line_fragment: { start_bytes: pending.offset - pending.location.line_start, complete: part.end === resource.byte_length || part.text.endsWith('\n') } }
        const size = Buffer.byteLength(JSON.stringify(item)) + 1
        if (responseBytes + size > defaults.read.content_response_bytes - 16384) break
        matches.push(item); responseBytes += size; remaining -= part.chars
        position = { ...position, ...(part.end < pending.end ? { pending: { ...pending, offset: part.end, location: after } } : { pending: undefined }) }
      }
      return { data: { matches }, position, scanned_range: { start_bytes: scanStart, end_bytes: position.scan.offset }, completion: { selection_complete: position.done && !position.pending, search_complete: position.done, full_body_delivered: false } }
    }
    if (!position.selected) position.selected = pageRange ?? (selection.lines ? await lineRange(file, selection.lines, resource.byte_length, valid) : { start: 0, end: resource.byte_length })
    const { start, end } = position.selected, offset = previous ? position.scan.offset : start
    const part = await fragment(file, offset, end, maxChars, valid)
    const first = previous ? position.scan : selection.lines ? { offset: start, line: selection.lines[0], line_start: start } : start ? await locationAt(file, start, valid) : { offset: 0, line: 1, line_start: 0 }
    position = { ...position, scan: advance(first, Buffer.from(part.text)), done: part.end === end }
    return { data: { text: part.text }, actual_range: { start_bytes: offset, end_bytes: part.end, chars: part.chars }, selected_range: { start_bytes: start, end_bytes: end }, lines: { start: first.line, end: Math.max(first.line, position.scan.line - (part.text.endsWith('\n') ? 1 : 0)) }, line_fragment: { start_bytes: offset - first.line_start, complete: part.end === resource.byte_length || part.text.endsWith('\n') }, position, completion: { selection_complete: position.done, search_complete: null, full_body_delivered: start === 0 && end === resource.byte_length && position.done } }
  }, valid, true)
  valid()
  if (Buffer.byteLength(JSON.stringify(result)) > defaults.read.content_response_bytes - 8192) throw new ContractError('TOOL_RESULT_LIMIT', 'Read response exceeds resource protection')
  return result
}
