import { messageEvidence } from './request-evidence'
import defaults from '../../shared/contracts/development-defaults.json'
import type { ModelConfiguration } from '../../shared/contracts.generated'
import type { ChatMessage, ToolDefinition } from './adapter'
import { ModelError } from './adapter'

export type RejectionStage = 'main-input' | 'protected-input' | 'summary-input' | 'summary-correction' | 'summary-merge' | 'summary-install' | 'approval-input'
export function rejectedContext(config: ModelConfiguration, messages: ChatMessage[], tools: ToolDefinition[] | undefined, stage: RejectionStage, code = 'CONTEXT_BUDGET_EXCEEDED'): ContextRejectedError {
  const components = { rules: 0, tools: tools ? Buffer.byteLength(JSON.stringify(tools)) : 0, history: 0, summary: 0, current: 0, tool_results: 0, envelope: 0 }
  for (const message of messages) {
    let key: keyof typeof components = message.role === 'system' ? 'rules' : message.role === 'tool' ? 'tool_results' : 'history'
    if (messageEvidence(message)?.kind === 'host-state' || messageEvidence(message)?.kind === 'message.user') key = 'current'
    else if (messageEvidence(message)?.kind === 'summary') key = 'summary'
    else if (message.role === 'user') try {
      const body = JSON.parse(message.content ?? '{}')
      if (body?.working_summary) key = 'summary'
      else if (body?.host_context || body?.coverage || body?.source_format || body?.source) key = 'current'
    } catch { /* Plain messages stay history; no content enters the diagnostic. */ }
    components[key] += Buffer.byteLength(JSON.stringify(message))
  }
  const input_bytes = Buffer.byteLength(JSON.stringify({ messages, tools }))
  components.envelope = input_bytes - Object.values(components).reduce((sum, value) => sum + value, 0)
  const plan = capacityPlan(config, messages, tools)
  return new ContextRejectedError(code, { model_id: config.id, stage, code, measurement: plan.measurement, context_tokens: config.context_tokens, input_bytes, estimated_input: plan.estimated_input, available_input: plan.available_input, output_reserve: plan.output_reserve, safety_reserve: 0, estimation_overhead: 256, components })
}

export class ContextRejectedError extends ModelError {
  constructor(code: string, readonly diagnostic: { model_id: string; stage: RejectionStage; code: string; measurement: 'serialized-utf8-estimate'; context_tokens: number; input_bytes: number; estimated_input: number; available_input: number; output_reserve: number | null; safety_reserve: number; estimation_overhead: number; components: Record<'rules' | 'tools' | 'history' | 'summary' | 'current' | 'tool_results' | 'envelope', number> }) { super(code) }
}

export function inputCapacity(config: ModelConfiguration): number {
  return config.context_tokens
}

export function serializedInput(messages: ChatMessage[], tools?: ToolDefinition[]): number {
  return Buffer.byteLength(JSON.stringify({ messages, tools })) + 256
}

export function capacityPlan(config: ModelConfiguration, messages: ChatMessage[], tools?: ToolDefinition[]) {
  const estimated_input = serializedInput(messages, tools), available_input = inputCapacity(config)
  return { estimated_input, available_input, remaining: available_input - estimated_input, output_reserve: config.max_output_tokens ?? null, fits: estimated_input <= available_input, needsCompaction: estimated_input >= available_input - Math.ceil(available_input * defaults.context.safety_fraction), measurement: 'serialized-utf8-estimate' as const }
}
