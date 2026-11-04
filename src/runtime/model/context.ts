import template from './prompts/summary-v0.1.txt?raw'
import { ModelError, type ChatMessage, type ToolDefinition } from './adapter'
import type { ModelLease, ModelService } from './service'
import { RunBudget, type ContextRecovery } from './agent'
import { attachEvidence, messageEvidence, type RequestLink } from './request-evidence'
import { serializedInput } from './capacity'

export interface HistoryRecord { id: string; sequence: number; kind: string; payload: Record<string, any> }
export interface HistoryGroup { messages: ChatMessage[]; records: HistoryRecord[]; through: number; current?: boolean; complete?: boolean }
export interface InstalledSummary {
  version: 2
  text: string
  through_sequence: number
  latest_user_id: string | null
  retained_interactions: string[][]
  template: 'summary-v0.1'
  model_id: string
  model_revision: number
  installed_at: string
  request_link?: RequestLink
}

export function recordedMessage(record: HistoryRecord): ChatMessage | undefined {
  const { payload, kind } = record
  const message: ChatMessage | undefined = kind === 'message.user'
    ? { role: 'user', content: JSON.stringify({ request: payload.text, ...(payload.materials ? { request_materials: payload.materials } : {}) }) }
    : kind === 'model.response' || kind === 'model.tool_result' ? payload.message
    : kind === 'message.assistant' && payload.model_config_id === 'fixture' ? { role: 'assistant', content: payload.text } : undefined
  if (!message) return
  return attachEvidence(message, { kind, representation: 'recorded-message', source: { kind: kind.startsWith('message.') ? 'message' : 'event', id: record.id }, recorded_sequence: record.sequence, ...(typeof payload.run_id === 'string' ? { owner_run_id: payload.run_id } : {}), ...(payload.request_link ? { response_request: payload.request_link } : {}) })
}

// One response and every result of its tool batch form an indivisible interaction.
export function interactions(messages: ChatMessage[]): ChatMessage[][] {
  const result: ChatMessage[][] = []
  let pending: ChatMessage[] = [], calls = new Set<string>()
  for (const message of messages) {
    if (message.role === 'assistant') {
      if (calls.size) throw new ModelError('CONTEXT_NO_SAFE_GROUP')
      pending = [message]; calls = new Set(message.tool_calls?.map(call => call.id))
      if (!calls.size) { result.push(pending); pending = [] }
    } else if (message.role === 'tool') {
      if (!pending.length || !calls.delete(message.tool_call_id!)) throw new ModelError('CONTEXT_NO_SAFE_GROUP')
      pending.push(message)
      if (!calls.size) { result.push(pending); pending = [] }
    } else if (calls.size) throw new ModelError('CONTEXT_NO_SAFE_GROUP')
  }
  if (calls.size) throw new ModelError('CONTEXT_NO_SAFE_GROUP')
  return result
}

export function historyGroups(records: HistoryRecord[], currentRun: string): HistoryGroup[] {
  const byId = new Map(records.map(record => [record.id, record]))
  const messages = records.flatMap(record => { const message = recordedMessage(record); return message ? [message] : [] })
  annotateReads(messages)
  const rounds = interactions(messages).map(group => {
    const members = group.map(message => byId.get(messageEvidence(message)!.source!.id)!)
    return { messages: group, records: members, through: members.at(-1)!.sequence, current: members[0]!.payload.run_id === currentRun, complete: true }
  })
  const inputs = messages.filter(message => message.role === 'user').map(message => {
    const record = byId.get(messageEvidence(message)!.source!.id)!
    return { messages: [message], records: [record], through: record.sequence, current: record.payload.run_id === currentRun, complete: false }
  })
  return [...rounds, ...inputs].sort((a, b) => a.records[0]!.sequence - b.records[0]!.sequence)

}

export function summaryMessage(value: InstalledSummary): ChatMessage {
  return attachEvidence({ role: 'user', content: `工作摘要：\n${value.text}` }, { kind: 'summary', representation: 'summary-only' })
}
export function latestUser(messages: ChatMessage[]): ChatMessage | undefined {
  return [...messages].reverse().find(message => message.role === 'user' && ['message.user', 'host-state'].includes(messageEvidence(message)?.kind ?? ''))
}
export function retainedContext(messages: ChatMessage[], summary: InstalledSummary): ChatMessage[] {
  const user = latestUser(messages)
  return [messages[0]!, summaryMessage(summary), ...(user ? [user] : []), ...interactions(messages).slice(-2).flat()]
}
export interface CompactionHost {
  valid(): void
  state(reason: string): void
  budget(): void
  install(value: InstalledSummary): void
}
export async function compactContext(service: ModelService, lease: ModelLease, task: string, budget: RunBudget, signal: AbortSignal, messages: ChatMessage[], through: number, tools: ToolDefinition[] | undefined, host: CompactionHost, recovery?: ContextRecovery): Promise<ChatMessage[]> {
  const valid = () => { host.valid(); if (signal.aborted) throw new ModelError('MODEL_CANCELLED') }
  valid()
  const rounds = interactions(messages).slice(-2), user = latestUser(messages)
  const ids = rounds.map(round => round.map(message => {
    const source = messageEvidence(message)?.source
    if (!source) throw new ModelError('SUMMARY_SOURCE_INVALID')
    return source.id
  }))
  const latest = user ? messageEvidence(user)?.source?.id : null
  if (user && !latest) throw new ModelError('SUMMARY_SOURCE_INVALID')
  // No reconstruction or previews: only the current input and the organizing instruction.
  const deferred = recovery ? interactions(messages).at(-1) ?? [] : []
  const input: ChatMessage[] = [...messages.filter(message => !deferred.includes(message)), { role: 'system', content: template }]
  const reservation = budget.reserve(input, undefined, lease.config, 'summary-input', !!recovery || budget.hasUsage())
  host.budget(); host.state('context_compacting')
  let result
  try { result = await service.request(lease, task, input, undefined, signal, undefined, lease.config.max_output_tokens, undefined, 'summary') }
  catch (error) {
    budget.abandon(reservation)
    if (!recovery && error instanceof ModelError && error.code === 'MODEL_CONTEXT_LENGTH_EXCEEDED') {
      valid()
      return compactContext(service, lease, task, budget, signal, messages, through, tools, host, { overflow: true })
    }
    throw error
  }
  valid()
  try { budget.settle(reservation, result) } finally { host.budget() }
  if (result.calls.length || !result.text.trim()) throw new ModelError('SUMMARY_INVALID_FORMAT')
  const notice = recovery ? '\n\n当前请求处理到一半，压缩后继续。最近完整交互保留在后文，已执行工具不重放。' + (recovery.partial ? '\n以下是被中断响应的未完成文字，不是已完成结果：\n' + recovery.partial : '') : ''
  const candidate: InstalledSummary = { version: 2, text: result.text + notice, through_sequence: through, latest_user_id: latest ?? null, retained_interactions: ids, template: 'summary-v0.1', model_id: lease.id, model_revision: lease.revision, installed_at: new Date().toISOString(), ...(result.request_link ? { request_link: result.request_link } : {}) }
  const next = retainedContext(messages, candidate)
  if (recovery && serializedInput(next, tools) >= serializedInput(messages, tools)) throw new ModelError('CONTEXT_RECOVERY_NO_PROGRESS')
  if (!recovery && !budget.fits(next, tools)) throw budget.rejection(next, tools, 'summary-install', 'CONTEXT_MINIMUM_TOO_LARGE')
  valid(); host.install(candidate)
  return next
}

export function assembleContext(fixed: ChatMessage[], summary: InstalledSummary | null, groups: HistoryGroup[]): ChatMessage[] {
  return [fixed[0]!, ...(summary ? [summaryMessage(summary)] : []), ...groups.flatMap(group => group.messages), ...fixed.slice(1)]
}

export function annotateReads(messages: ChatMessage[]): void {
  const calls = new Map<string, { kind: string; id: string }>()
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) if (call.function?.name === 'read') try {
      const value = JSON.parse(call.function.arguments)
      if (typeof value.kind === 'string' && typeof value.id === 'string') calls.set(call.id, { kind: value.kind, id: value.id })
    } catch { /* Invalid arguments establish no read identity. */ }
    if (message.role !== 'tool') continue
    const value = messageEvidence(message), target = calls.get(message.tool_call_id!)
    if (value && target) attachEvidence(message, { ...value, read_target: target })
    calls.delete(message.tool_call_id!)
  }
}

// Interrupted batches cannot be replayed as live API calls. Keep every byte as history.
export function restoreMessages(records: HistoryRecord[]): ChatMessage[] {
  const output: ChatMessage[] = []
  let pending: ChatMessage[] = [], calls = new Set<string>(), owner: unknown
  const flush = () => {
    if (pending.length) output.push(attachEvidence({ role: 'user', content: JSON.stringify({ interrupted_history: pending, complete: false }) }, { kind: 'interrupted-history', representation: 'complete-originals-wrapper' }))
    pending = []; calls.clear()
  }
  for (const record of records) {
    const message = recordedMessage(record)
    if (!message) continue
    if (owner !== record.payload.run_id || message.role === 'user' || message.role === 'assistant') flush()
    owner = record.payload.run_id
    if (message.role === 'assistant' && message.tool_calls?.length) {
      pending = [message]; calls = new Set(message.tool_calls.map(call => call.id))
    } else if (message.role === 'tool') {
      if (!calls.delete(message.tool_call_id!)) { flush(); pending = [message]; flush(); continue }
      pending.push(message)
      if (!calls.size) { output.push(...pending); pending = [] }
    } else output.push(message)
  }
  flush(); annotateReads(output)
  return output
}
