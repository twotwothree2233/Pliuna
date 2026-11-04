import { messageEvidence } from './request-evidence'
import { randomUUID } from 'node:crypto'
import type { ChatMessage, Completion, ToolDefinition } from './adapter'
import type { ModelLease } from './service'
import defaults from '../../shared/contracts/development-defaults.json'
import { assertContract } from '../../shared/validation'

export type RequestPurpose = 'main' | 'summary' | 'summary_correction' | 'approval'
export interface RequestAccounting {
  version: 1 | 2; output_policy?: 'configured' | 'service-default'; request_id: string; model_id: string; model_revision: number; purpose: RequestPurpose
  phase: 'reserved' | 'dispatched' | 'completed' | 'failed' | 'unknown'; at: string
  input_bytes: number; estimated_input_tokens: number; output_reserve: number | null; context_tokens: number
  components: Record<'rules' | 'tools' | 'history' | 'summary' | 'current' | 'tool_results' | 'envelope', number>
  usage: Completion['usage'] | null; error: string | null
}
export function requestAccounting(lease: ModelLease, messages: ChatMessage[], tools: ToolDefinition[] | undefined, outputLimit: number | undefined, purpose: RequestPurpose, requestId = randomUUID()) {
  const components: RequestAccounting['components'] = { rules: 0, tools: tools ? Buffer.byteLength(JSON.stringify(tools)) : 0, history: 0, summary: 0, current: 0, tool_results: 0, envelope: 0 }
  for (const message of messages) {
    let kind: keyof typeof components = message.role === 'system' ? 'rules' : message.role === 'tool' ? 'tool_results' : 'history'
    if (messageEvidence(message)?.kind === 'host-state') kind = 'current'
    else if (message.role === 'user') { try { const value = JSON.parse(message.content ?? '{}'); if (value.working_summary) kind = 'summary'; else if (value.host_context || value.coverage || value.source_format || value.source) kind = 'current' } catch { /* Plain history remains history, not parsed authority. */ } }
    components[kind] += Buffer.byteLength(JSON.stringify(message))
  }
  const input = Buffer.byteLength(JSON.stringify({ messages, tools }))
  components.envelope = input - Object.values(components).reduce((n, value) => n + value, 0)
  const base = { version: 2 as const, output_policy: (outputLimit ?? lease.config.max_output_tokens) === undefined ? 'service-default' as const : 'configured' as const, request_id: requestId, model_id: lease.id, model_revision: lease.revision, purpose, input_bytes: input, estimated_input_tokens: input + 256, output_reserve: outputLimit ?? lease.config.max_output_tokens ?? null, context_tokens: lease.config.context_tokens, components }
  return (phase: RequestAccounting['phase'], usage: Completion['usage'] | null = null, error: string | null = null) => {
    const event: RequestAccounting = { ...base, phase, usage, error, at: new Date().toISOString() }
    assertContract('request_accounting', event)
    lease.accounting?.(event)
  }
}

export function accountingResultLimit(result: unknown): number {
  return selectedContentResult(result) ? defaults.read.content_response_bytes : defaults.read.text_bytes
}
export function selectedContentResult(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false
  const value = result as { request_type?: unknown; execution?: unknown; delivery?: unknown; content_selection?: unknown; data?: { content_selection?: unknown } }
  return value.content_selection === true || (value.request_type === 'read' && value.execution === 'success' && value.delivery === 'delivered' && value.data?.content_selection === true)
}
