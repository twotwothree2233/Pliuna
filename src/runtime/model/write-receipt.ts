import { createHash } from 'node:crypto'
import type { ChatMessage } from './adapter'
import { copyEvidence, messageEvidence } from './request-evidence'

// Only completed pairs qualify. This is context data, never a request to replay.
export function projectWriteReceipts(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message, index) => {
    if (message.role !== 'assistant' || !message.tool_calls?.length) return message
    if (new Set(message.tool_calls.map(call => call.id)).size !== message.tool_calls.length) return message
    const source = messageEvidence(message)?.source
    if (!source) return message
    const following: ChatMessage[] = []
    for (const next of messages.slice(index + 1)) {
      if (next.role !== 'tool') break
      following.push(next)
    }
    if (following.length !== message.tool_calls.length || message.tool_calls.some(call => following.filter(next => next.tool_call_id === call.id).length !== 1)) return message
    let changed = false
    const calls = message.tool_calls.map(call => {
      if (call.function?.name !== 'write') return call
      const results = following.filter(next => next.tool_call_id === call.id)
      const resultSource = messageEvidence(results[0]!)?.source
      if (!resultSource) return call
      try {
        const result = JSON.parse(results[0]!.content ?? '')
        if (result.request_type !== 'write' || result.execution !== 'success' || result.delivery !== 'delivered' || result.truncated === true) return call
        const operationId = result.operation_id ?? result.data?.action_id
        if (typeof operationId !== 'string') return call
        const wire = JSON.parse(call.function.arguments)
        if (typeof wire?.operation !== 'string' || typeof wire.input_json !== 'string') return call
        const input = JSON.parse(wire.input_json)
        if (!input || typeof input !== 'object' || Array.isArray(input)) return call
        const operation = wire.operation
        const omitted: { path: string; utf8_bytes: number; sha256: string }[] = []
        const omit = (object: Record<string, unknown>, key: string, path: string) => {
          if (!Object.hasOwn(object, key)) return
          const value = JSON.stringify(object[key])
          if (value === undefined) return
          omitted.push({ path, utf8_bytes: Buffer.byteLength(value), sha256: createHash('sha256').update(value).digest('hex') })
          delete object[key]
        }
        if (operation === 'surface.update' && Array.isArray(input.operations)) {
          input.operations.forEach((op: any, position: number) => {
            if (!['view.create', 'view.replace'].includes(op.type) || op.bundle?.type !== 'inline') return
            const bundle = op.bundle.bundle
            if (bundle && typeof bundle === 'object') for (const key of ['html', 'css']) omit(bundle, key, `/operations/${position}/bundle/bundle/${key}`)
          })
        } else if (operation === 'resource.create' && input.content?.type === 'text') omit(input.content, 'text', '/content/text')
        else if (operation === 'task_data.create' && input.data && typeof input.data === 'object') omit(input.data, 'value', '/data/value')
        else if (operation === 'task_data.replace') omit(input, 'value', '/value')
        if (!omitted.length) return call
        const projected = JSON.stringify({ completed_write_receipt: { source, result_source: resultSource, operation_id: operationId, execution: result.execution, delivery: result.delivery, omitted, path_basis: 'decoded-input_json', body_supplied: false, replayable: false }, operation_metadata: { operation, decoded_input: input } })
        if (Buffer.byteLength(projected) >= Buffer.byteLength(call.function.arguments)) return call
        changed = true
        return { ...call, function: { ...call.function, arguments: projected } }
      } catch { return call }
    })
    return changed ? copyEvidence(message, { ...message, tool_calls: calls }, { representation: 'completed-write-receipt' }) : message
  })
}
