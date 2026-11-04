import { createHash } from 'node:crypto'
import type { ChatMessage } from './adapter'
import { copyEvidence } from './request-evidence'

function selection(message: ChatMessage): any | undefined {
  if (message.role !== 'tool') return
  try {
    const value = JSON.parse(message.content ?? '')
    const part = value?.data
    if (value?.request_type !== 'read' || value.execution !== 'success' || value.delivery !== 'delivered' || part?.content_selection !== true) return
    if (typeof part.data?.text !== 'string' || typeof part.metadata?.id !== 'string' || typeof part.metadata?.sha256 !== 'string' || typeof part.content_version !== 'string') return
    const range = part.actual_range
    if (!range || !Number.isSafeInteger(range.start_bytes) || !Number.isSafeInteger(range.end_bytes) || range.start_bytes < 0 || range.end_bytes < range.start_bytes || Buffer.byteLength(part.data.text) !== range.end_bytes - range.start_bytes) return
    return value
  } catch { return }
}

// The caller supplies current-Run messages only. Rebuild on every input: no persistent cache.
export function projectContent(messages: ChatMessage[], sources = new Map<ChatMessage, string>()): ChatMessage[] {
  const seen = new Map<string, { text: string; tool_call_id: string; event_id?: string }>()
  return messages.map(message => {
    const value = selection(message)
    if (!value || !message.tool_call_id) return message
    const part = value.data, text: string = part.data.text
    const key = JSON.stringify([part.metadata.id, part.metadata.sha256, part.content_version, part.actual_range.start_bytes, part.actual_range.end_bytes, createHash('sha256').update(text).digest('hex')])
    const previous = seen.get(key)
    if (!previous) { seen.set(key, { text, tool_call_id: message.tool_call_id, ...(sources.has(message) ? { event_id: sources.get(message) } : {}) }); return message }
    if (previous.text !== text) return message
    const { text: _text, ...data } = part.data
    const content = JSON.stringify({ ...value, data: { ...part, data: { ...data, context_reuse: { tool_call_id: previous.tool_call_id, ...(previous.event_id ? { source: { kind: 'event', id: previous.event_id } } : {}) } } } })
    return Buffer.byteLength(content) < Buffer.byteLength(message.content!) ? copyEvidence(message, { ...message, content }, { reuse_tool_call_id: previous.tool_call_id }) : message
  })
}
