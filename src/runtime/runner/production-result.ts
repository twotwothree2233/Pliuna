const keys = new Map(['version', 'complete', 'answer', 'artifacts', 'requirement_ids', 'unresolved'].map((key, index) => [key, 1 << index]))
const resultHeader = keys.get('version')! | keys.get('complete')!
type ObjectFrame = { kind: 'object'; start: number; depth: number; fields: number; key: boolean }
type Frame = ObjectFrame | { kind: 'array' }
type Envelope = { start: number; end?: number; depth: number; fields: number }

function protocolFields(fields: number): boolean {
  let count = 0
  for (let remaining = fields; remaining; remaining &= remaining - 1) count++
  return count >= 5 || (fields & resultHeader) === resultHeader && count >= 4
}

// Recognize keys at one object level, including malformed unquoted keys. Text
// inside strings and fields from separate objects cannot form an envelope.
function envelopes(text: string): Envelope[] {
  const stack: Frame[] = [], found: Envelope[] = []
  const retain = (frame: ObjectFrame, end?: number) => {
    if (protocolFields(frame.fields)) found.push({ start: frame.start, end, depth: frame.depth, fields: frame.fields })
  }
  for (let index = 0; index < text.length;) {
    const character = text[index]!, frame = stack.at(-1)
    if (frame && (character === '"' || character === "'")) {
      let end = index + 1
      while (end < text.length && text[end] !== character) end += text[end] === '\\' ? 2 : 1
      if (frame.kind === 'object' && frame.key && end < text.length) {
        let colon = end + 1
        while (/\s/.test(text[colon] ?? '') && colon < text.length) colon++
        if (text[colon] === ':') {
          let key: unknown
          if (end - index < 256) {
            try { key = character === '"' ? JSON.parse(text.slice(index, end + 1)) : text.slice(index + 1, end) } catch {}
          }
          if (typeof key === 'string') frame.fields |= keys.get(key) ?? 0
          frame.key = false
        }
      }
      index = Math.min(end + 1, text.length); continue
    }
    if (character === '{') { stack.push({ kind: 'object', start: index, depth: stack.length, fields: 0, key: true }); index++; continue }
    if (character === '[') { stack.push({ kind: 'array' }); index++; continue }
    if (character === '}' || character === ']') {
      const closed = stack.pop()
      if (closed?.kind === 'object') retain(closed, character === '}' ? index + 1 : undefined)
      index++; continue
    }
    if (frame?.kind === 'object' && character === ',') frame.key = true
    if (frame?.kind === 'object' && frame.key && /[A-Za-z_$]/.test(character)) {
      let end = index + 1
      while (end < text.length && /[A-Za-z0-9_$]/.test(text[end]!)) end++
      let colon = end
      while (colon < text.length && /\s/.test(text[colon]!)) colon++
      if (text[colon] === ':') { frame.fields |= keys.get(text.slice(index, end)) ?? 0; frame.key = false }
      index = end; continue
    }
    index++
  }
  for (const frame of stack) if (frame.kind === 'object') retain(frame)
  return found
}

/** Identify the explicit internal protocol, without treating resource names as protocol. */
export function containsProducerResult(text: string): boolean {
  return envelopes(text).length > 0
}

/** Descriptive prose and a code fence may wrap one complete JSON result. */
export function decodeProducerResult(text: string): unknown | undefined {
  const found = envelopes(text)
  if (!found.length) return undefined
  const envelope = found[0]!
  if (found.length !== 1 || envelope.depth !== 0 || envelope.end === undefined) throw Error('INVALID_PRODUCER_RESULT')
  return JSON.parse(text.slice(envelope.start, envelope.end)) as unknown
}
