import type { ChatMessage } from './adapter'

export interface RequestLink { request_id: string; evidence_event_id: string }
export interface RequestEvidence { version: 1; request_id: string; purpose: string; stage: string | null; entries: Record<string, any>[]; originals: Record<string, any>[]; supplements: Record<string, any>[]; reviewed_requests: RequestLink[] }


export interface MessageEvidence {
  kind: string
  request_type?: string
  response_request?: RequestLink
  representation: string
  source?: { kind: 'message' | 'event'; id: string }
  recorded_sequence?: number
  read_target?: { kind: string; id: string }
  reuse_tool_call_id?: string
  linked_action?: { kind: 'action'; id: string }
  owner_run_id?: string
  reviewed_requests?: RequestLink[]
}

// Weak metadata never enters stored records or the provider's message schema.
const evidence = new WeakMap<ChatMessage, MessageEvidence>()
export function attachEvidence<T extends ChatMessage>(message: T, value: MessageEvidence): T {
  evidence.set(message, value)
  return message
}
export const evidenceMessage = attachEvidence
export const messageEvidence = (message: ChatMessage): MessageEvidence | undefined => evidence.get(message)
export function copyEvidence<T extends ChatMessage>(from: ChatMessage, to: T, changes?: Partial<MessageEvidence>): T {
  const value = evidence.get(from)
  if (value) evidence.set(to, { ...value, ...changes })
  return to
}

export function requestEvidence(messages: ChatMessage[], request_id: string, purpose: string): RequestEvidence {
  const bodies = new Map<string, number>()
  const entries = messages.flatMap((message, index) => {
    const original = evidence.get(message)
    if (!original) return []
    const { reuse_tool_call_id, response_request, owner_run_id: _owner, reviewed_requests: _reviewed, ...facts } = original
    const entry: Record<string, unknown> = { message: index, ...facts, ...(response_request ? { response_request_id: response_request.request_id } : {}) }
    if (message.role === 'tool') {
      try {
        const value = JSON.parse(message.content ?? '')
        if (reuse_tool_call_id) {
          const earlier = bodies.get(reuse_tool_call_id)
          if (earlier !== undefined) { entry.representation = 'exact-body-reuse'; entry.reused_from_message = earlier }
        }
        if (original.read_target) {
          const part = value.data
          entry.delivery = { execution: value.execution, delivery: value.delivery, truncated: value.truncated === true || part?.truncated === true }
          if (value.execution === 'success' && value.delivery === 'delivered' && part?.metadata?.id === original.read_target.id) {
            if (Number.isSafeInteger(part.revision)) entry.observed_revision = part.revision
            if (typeof part.content_version === 'string') entry.content_version = part.content_version
            entry.read_observation = { representation: part.representation ?? (part.content_selection ? 'selected-plaintext' : 'structured-object'), truncated: part.truncated === true, has_continuation: typeof part.next_cursor === 'string', ...(part.actual_range ? { actual_range: part.actual_range } : {}) }
          }
        }
        if (message.tool_call_id && typeof value.data?.data?.text === 'string') bodies.set(message.tool_call_id, index)
      } catch { /* A malformed body establishes no additional structured facts. */ }
    }
    return [entry]
  })
  const originals = entries.filter(entry => entry.source).map(entry => ({ at: `messages/${entry.message}`, source: entry.source, recorded_sequence: entry.recorded_sequence, representation: entry.representation }))
  return { version: 1, request_id, purpose, stage: purpose === 'summary' ? 'current-context' : null, entries, originals, supplements: [], reviewed_requests: [] }
}
