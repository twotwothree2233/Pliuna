import defaults from '../../shared/contracts/development-defaults.json'
import agentTemplate from './prompts/agent-v0.1.txt?raw'
import { ContractError } from '../../shared/validation'
import { ModelError, type ChatMessage, type Completion, type ToolCall, type ToolDefinition } from './adapter'
import { ModelService, type ModelLease } from './service'

import { modelTools } from './tools'
import { modelToolRequest, modelToolResult, modelToolSuggestion } from './tool-input'
import { accountingResultLimit } from './accounting'
import { type RequestLink } from './request-evidence'
import { capacityPlan, serializedInput, rejectedContext, type RejectionStage } from './capacity'
export interface AgentHost {
  context?(messages: ChatMessage[], recovery?: ContextRecovery): Promise<ChatMessage[]>
  valid(): void
  state(state: 'running' | 'waiting', reason?: string): void
  budget(value: BudgetState): void
  record(kind: string, payload: Record<string, unknown>): void
  tool(request: unknown, signal: AbortSignal): Promise<unknown>
}
export interface ContextRecovery { overflow: true; partial?: string }
export interface BudgetState { model_requests: number; tool_requests: number; tokens: number; accounting: 'estimated' | 'mixed' | 'provider-usage'; cost: 'unknown'; template: 'agent-v0.1'; limits_version: string; unbounded_output_requests?: number; limits?: ModelLease['config']['limits'] }
export class RunBudget {
  private usageResponses = 0
  private observations = new Map<string, { input: string[]; tokens: number; tools: string }>()
  private reservations = new Map<number, { messages: ChatMessage[]; tools: ToolDefinition[] | undefined; config: ModelLease['config'] }[]>()
  readonly state: BudgetState = { model_requests: 0, tool_requests: 0, tokens: 0, accounting: 'estimated', cost: 'unknown', template: 'agent-v0.1', limits_version: defaults.version }
  constructor(private config: ModelLease['config'], private created = Date.now()) { this.config = structuredClone(config); this.state.limits = this.config.limits }
  fits(messages: ChatMessage[], tools: ToolDefinition[] | undefined, config = this.config): boolean {
    return this.plan(messages, tools, config).fits
  }
  plan(messages: ChatMessage[], tools: ToolDefinition[] | undefined, config = this.config) {
    const observed = this.observations.get(JSON.stringify({ config, tools }))
    if (!observed) return capacityPlan(config, messages, tools)
    const samePrefix = observed.tools === JSON.stringify(tools) && observed.input.every((value, index) => JSON.stringify(messages[index]) === value)
    if (!samePrefix) return capacityPlan(config, messages, tools)
    // Usage measures the last completed request, not newly appended tool results.
    // Unknown deltas go to the provider; byte size must not overrule known usage.
    const tokens = observed.tokens
    return { estimated_input: tokens, available_input: config.context_tokens, remaining: config.context_tokens - tokens, output_reserve: config.max_output_tokens ?? null, fits: true, needsCompaction: tokens >= config.context_tokens * (1 - defaults.context.safety_fraction), measurement: 'provider-usage' as const }
  }
  hasUsage(config = this.config): boolean { return [...this.observations.keys()].some(key => JSON.parse(key).config.id === config.id && JSON.stringify(JSON.parse(key).config) === JSON.stringify(config)) }
  observe(messages: ChatMessage[], tools: ToolDefinition[] | undefined, usage: NonNullable<Completion['usage']>, config = this.config): void {
    this.observations.set(JSON.stringify({ config, tools }), { input: messages.map(message => JSON.stringify(message)), tools: JSON.stringify(tools), tokens: usage.prompt_tokens + usage.completion_tokens })
  }
  estimate(messages: ChatMessage[], tools: ToolDefinition[] | undefined): number { return serializedInput(messages, tools) }
  rejection(messages: ChatMessage[], tools: ToolDefinition[] | undefined, stage: RejectionStage, code = 'CONTEXT_BUDGET_EXCEEDED', config = this.config) { return rejectedContext(config, messages, tools, stage, code) }
  reserve(messages: ChatMessage[], tools: ToolDefinition[] | undefined, config = this.config, stage: RejectionStage = 'main-input', providerCheck = false): number {
    this.check()
    const input = this.plan(messages, tools, config).estimated_input
    const output = config.max_output_tokens ?? 0
    if (!providerCheck && !this.plan(messages, tools, config).fits) throw this.rejection(messages, tools, stage, 'CONTEXT_BUDGET_EXCEEDED', config)
    if (config.max_output_tokens === undefined && this.config.limits?.run_tokens !== undefined) throw new ModelError('OUTPUT_BUDGET_UNKNOWN')
    if ((this.config.limits?.run_model_requests !== undefined && this.state.model_requests >= this.config.limits.run_model_requests) || (this.config.limits?.run_tokens !== undefined && this.state.tokens + input + output > this.config.limits.run_tokens)) throw new ModelError('RUN_BUDGET_EXCEEDED')
    this.state.model_requests++; this.state.tokens += input + output
    if (config.max_output_tokens === undefined) this.state.unbounded_output_requests = (this.state.unbounded_output_requests ?? 0) + 1
    this.state.accounting = this.usageResponses ? 'mixed' : 'estimated'
    const reservation = input + output
    this.reservations.set(reservation, [...(this.reservations.get(reservation) ?? []), { messages: structuredClone(messages), tools, config }])
    return reservation
  }
  settle(reservation: number, response: Completion, messages?: ChatMessage[], tools?: ToolDefinition[]): void {
    const entries = this.reservations.get(reservation), reserved = entries?.shift()
    if (!entries?.length) this.reservations.delete(reservation)
    if (response.usage) {
      this.state.tokens += response.usage.prompt_tokens + response.usage.completion_tokens - reservation
      this.usageResponses++
      this.state.accounting = this.usageResponses === this.state.model_requests ? 'provider-usage' : 'mixed'
      if (reserved) this.observe(messages ?? reserved.messages, messages ? tools : reserved.tools, response.usage, reserved.config)
    } else if (reserved) {
      this.observations.delete(JSON.stringify({ config: reserved.config, tools: reserved.tools }))
    }
    if (this.config.limits?.run_tokens !== undefined && this.state.tokens > this.config.limits.run_tokens) throw new ModelError('RUN_BUDGET_EXCEEDED')
  }
  abandon(reservation: number): void {
    const entries = this.reservations.get(reservation); entries?.shift()
    if (!entries?.length) this.reservations.delete(reservation)
  }
  tool(): void { this.check(); if (++this.state.tool_requests > (this.config.limits?.run_tool_requests ?? Infinity)) throw new ModelError('RUN_BUDGET_EXCEEDED') }
  check(): void { if (this.config.limits?.run_wall_ms !== undefined && Date.now() - this.created >= this.config.limits.run_wall_ms) throw new ModelError('RUN_WALL_LIMIT') }
}
export async function runAgent(service: ModelService, lease: ModelLease, task: string, initial: ChatMessage[], host: AgentHost, signal: AbortSignal, budget = new RunBudget(lease.config)): Promise<void> {
  let messages: ChatMessage[] = [{ role: 'system', content: agentTemplate }, ...initial]
  while (true) {
    host.valid(); if (signal.aborted) throw new ModelError('MODEL_CANCELLED')
    if (host.context) messages = await host.context(messages)
    host.valid(); if (signal.aborted) throw new ModelError('MODEL_CANCELLED')
    let response: Completion | undefined
    let providerCheck = false
    for (let attempt = 0; !response; attempt++) {
      let reservation: number
      try { reservation = budget.reserve(messages, modelTools, lease.config, 'main-input', providerCheck) }
      catch (error) {
        if (error instanceof ModelError && error.code === 'CONTEXT_BUDGET_EXCEEDED' && host.context && !signal.aborted) {
          const before = serializedInput(messages, modelTools)
          messages = await host.context(messages, { overflow: true })
          host.valid(); if (signal.aborted) throw new ModelError('MODEL_CANCELLED')
          if (serializedInput(messages, modelTools) >= before) throw new ModelError('CONTEXT_RECOVERY_NO_PROGRESS')
          reservation = budget.reserve(messages, modelTools, lease.config, 'main-input', true)
        } else throw error
      }
      host.budget(budget.state)
      host.state('waiting', 'model_queue')
      let partial = ''
      let requestLink: RequestLink | undefined
      try {
        response = await service.request(lease, task, messages, modelTools, signal, text => { partial = text }, lease.config.max_output_tokens, () => host.state('running', 'model_generating'), 'main', link => { requestLink = link })
        host.valid(); try { budget.settle(reservation, response) } finally { host.budget(budget.state) }
      } catch (e) {
        budget.abandon(reservation)
        if (partial) host.record('message.assistant.partial', { text: partial, incomplete: true, ...(requestLink ? { request_link: requestLink } : {}) })
        if (e instanceof ModelError && e.code === 'MODEL_CONTEXT_LENGTH_EXCEEDED' && host.context && !signal.aborted) {
          const before = serializedInput(messages, modelTools)
          messages = await host.context(messages, { overflow: true, ...(partial ? { partial } : {}) })
          host.valid(); if (signal.aborted) throw new ModelError('MODEL_CANCELLED')
          if (serializedInput(messages, modelTools) >= before) throw new ModelError('CONTEXT_RECOVERY_NO_PROGRESS')
          providerCheck = true
          continue
        }
        if (!(e instanceof ModelError) || !e.retryable || e.partial || partial || attempt >= defaults.model.no_output_retries || signal.aborted) throw e
        await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, defaults.model.retry_delay_ms); const abort = () => { clearTimeout(timer); reject(new ModelError('MODEL_CANCELLED')) }; signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort() })
      }
    }
    host.state('running')
    const assistant: ChatMessage = { role: 'assistant', content: response.text || null, ...(response.calls.length ? { tool_calls: response.calls } : {}) }
    messages.push(assistant)
    const association = response.request_link ? { request_link: response.request_link } : {}
    host.record('model.response', { message: assistant, finish: response.finish, ...association })
    if (response.text) host.record('message.assistant', { text: response.text, ...association })
    if (!response.calls.length) {
      if (host.context) await host.context(messages)
      return
    }
    let failed = false
    for (const call of response.calls) {
      host.valid(); if (signal.aborted) throw new ModelError('MODEL_CANCELLED')
      let result: unknown
      if (failed) result = toolError(call, 'PREVIOUS_TOOL_FAILED', 'Earlier tool failed; this call was not executed')
      else {
        budget.tool(); host.budget(budget.state)
        let raw: unknown
        try {
          raw = JSON.parse(call.function.arguments)
          const request = modelToolRequest(call.function.name, raw)
          result = modelToolResult(call.function.name, raw, await host.tool(request, signal))
          const outcome = result as { execution?: string; delivery?: string } | null
          if ((outcome?.execution && outcome.execution !== 'success') || outcome?.delivery === 'failed') failed = true
        } catch (e) {
          host.valid(); if (signal.aborted) throw new ModelError('MODEL_CANCELLED')
          failed = true
          result = toolError(call, e instanceof ContractError || e instanceof ModelError ? e.code : 'TOOL_FAILED', e instanceof ContractError ? e.message : 'Tool not executed; no automatic replay', e instanceof ContractError ? modelToolSuggestion(call.function.name, raw, e) : undefined)
        }
      }
      const content = JSON.stringify(result)
      if (Buffer.byteLength(content) > (call.function.name === 'read' ? accountingResultLimit(result) : defaults.read.text_bytes)) throw new ModelError('TOOL_RESULT_LIMIT')
      const message: ChatMessage = { role: 'tool', tool_call_id: call.id, content }
      host.record('model.tool_result', { message, ...association }); messages.push(message)
    }
  }
}
function toolError(call: ToolCall, code: string, message: string, suggestion?: string): unknown { return { request_type: call.function.name, execution: 'not_executed', delivery: 'delivered', truncated: false, error: { code, message, ...(suggestion ? { suggestion } : {}) } } }
