import type { ChatMessage } from './adapter'
import { messageEvidence } from './request-evidence'

export type ActionTarget = { kind: 'action' | 'approval'; id: string }
export function linkedAction(message: ChatMessage): { kind: 'action'; id: string } | undefined {
  if (message.role !== 'tool') return
  try {
    const value = JSON.parse(message.content ?? '')
    if (value.execution !== 'success' || value.delivery !== 'delivered') return
    let id: unknown
    if (value.request_type === 'write') id = value.data?.action_id ?? value.operation_id
    else if (value.request_type === 'read' && !value.truncated && !value.data?.truncated && value.data?.metadata?.id === value.data?.data?.id) {
      const object = value.data.data
      if (['mutation', 'invocation'].includes(object.kind)) id = object.id
      else if (typeof object.decision === 'string' && typeof object.validity === 'string') id = object.action_id
    }
    if (typeof id === 'string') return { kind: 'action', id }
  } catch { /* Text previews do not establish object links. */ }
}

export function historicalActionFacts(messages: ChatMessage[], lookup: (target: ActionTarget) => Record<string, unknown>) {
  const seen = new Map<string, Record<string, any>>(), items: Record<string, any>[] = []
  for (const message of messages) {
    const evidence = messageEvidence(message)
    if (!evidence || evidence.kind !== 'model.tool_result' || !evidence.source) continue
    const read = evidence.read_target
    const target: ActionTarget | undefined = read && (read.kind === 'action' || read.kind === 'approval') ? { kind: read.kind, id: read.id } : evidence.linked_action ?? linkedAction(message)
    if (!target) continue
    let requestType = evidence.request_type
    if (!requestType) try { requestType = JSON.parse(message.content ?? '{}').request_type } catch {}
    const origin = { source: evidence.source, recorded_sequence: evidence.recorded_sequence, representation: evidence.representation, request_type: requestType ?? 'unrecorded', ...(evidence.response_request ? { response_request: evidence.response_request } : {}) }
    const key = target.kind + ':' + target.id, previous = seen.get(key)
    if (previous) { if (!previous.origins.some((item: unknown) => JSON.stringify(item) === JSON.stringify(origin))) previous.origins.push(origin); continue }
    const item = { target, origin, origins: [origin], ...lookup(target) }
    seen.set(key, item); items.push(item)
  }
  return { scope: 'exact-linked-task-objects', complete_task_history: false, items }
}
