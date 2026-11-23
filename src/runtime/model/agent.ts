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
import type { WorkerProfile } from '../runner/worker-profile'
import { RUNNER_LIMITS } from '../runner/limits'
export interface AgentHost {
  context?(messages: ChatMessage[], recovery?: ContextRecovery): Promise<ChatMessage[]>
  valid(): void
  state(state: 'running' | 'waiting', reason?: string): void
  budget(value: BudgetState): void
  record(kind: string, payload: Record<string, unknown>): void
  tool(request: unknown, signal: AbortSignal): Promise<unknown>
  toolsSettled?(): void
}
export interface ContextRecovery { overflow: true; partial?: string }
export interface WorkerResultIssue {
  code: string
  path: string
  value: unknown
  message: string
  sources?: readonly { task_id: string; kind: 'record' | 'resource' | 'action'; id: string }[]
  bundle_resource_ids?: readonly string[]
}
export interface WorkerExecution<Result> {
  profile: WorkerProfile<Result>
  validateResult?(result: Result): WorkerResultIssue | null
  onResult(result: Result): void | Promise<void>
}
type LegacyBudgetLimits = NonNullable<ModelLease['config']['limits']> & { run_model_requests?: number; run_tool_requests?: number; run_tokens?: number; run_wall_ms?: number }
export interface BudgetState { model_requests: number; tool_requests: number; tokens: number; accounting: 'estimated' | 'mixed' | 'provider-usage'; cost: 'unknown'; template: 'agent-v0.1'; limits_version: string; unbounded_output_requests?: number; limits?: LegacyBudgetLimits }
export class RunBudget {
  private usageResponses = 0
  private observations = new Map<string, { input: string[]; tokens: number; tools: string }>()
  private reservations = new Map<number, { messages: ChatMessage[]; tools: ToolDefinition[] | undefined; config: ModelLease['config'] }[]>()
  readonly state: BudgetState = { model_requests: 0, tool_requests: 0, tokens: 0, accounting: 'estimated', cost: 'unknown', template: 'agent-v0.1', limits_version: defaults.version }
  constructor(private config: ModelLease['config']) { this.config = structuredClone(config) }
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
    const input = this.plan(messages, tools, config).estimated_input
    const output = config.max_output_tokens ?? 0
    if (!providerCheck && !this.plan(messages, tools, config).fits) throw this.rejection(messages, tools, stage, 'CONTEXT_BUDGET_EXCEEDED', config)
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
  }
  abandon(reservation: number): void {
    const entries = this.reservations.get(reservation); entries?.shift()
    if (!entries?.length) this.reservations.delete(reservation)
  }
  tool(): void { this.state.tool_requests++ }
}
export async function runAgent<Result = void>(service: ModelService, lease: ModelLease, task: string, initial: ChatMessage[], host: AgentHost, signal: AbortSignal, budget = new RunBudget(lease.config), execution?: WorkerExecution<Result>): Promise<void> {
  const profile = execution?.profile, tools = profile ? [...profile.tools] : modelTools
  const collator = profile?.role === 'collator'
  // A diagnosis returns bounded metadata, so cap its per-request output allowance.
  const requestConfig = profile?.role === 'diagnostic' ? { ...lease.config, max_output_tokens: Math.min(lease.config.max_output_tokens ?? 4096, 4096) } : lease.config
  if (profile && (new Set(tools).size !== tools.length || tools.some(tool => !modelTools.includes(tool)))) throw new ContractError('INVALID_WORKER_PROFILE', 'Worker tools must use the existing tool definitions')
  let messages: ChatMessage[] = [{ role: 'system', content: profile?.system ?? agentTemplate }, ...initial]
  let rejectedInput: string | undefined
  const rejectedResults = new Set<string>()
  const rejectedIssues = new Set<string>()
  const queryResults = host.toolsSettled && profile && !collator && profile.role !== 'diagnostic' ? new QueryResults() : undefined
  let resultCorrection = '', preflightCorrection = ''
  while (true) {
    host.valid(); if (signal.aborted) throw new ModelError('MODEL_CANCELLED')
    if (host.context) messages = await host.context(messages)
    host.valid(); if (signal.aborted) throw new ModelError('MODEL_CANCELLED')
    let response: Completion | undefined
    let providerCheck = false
    for (let attempt = 0; !response; attempt++) {
      let reservation: number
      try { reservation = budget.reserve(messages, tools, requestConfig, 'main-input', providerCheck) }
      catch (error) {
        if (error instanceof ModelError && error.code === 'CONTEXT_BUDGET_EXCEEDED' && host.context && !signal.aborted) {
          const before = serializedInput(messages, tools)
          messages = await host.context(messages, { overflow: true })
          host.valid(); if (signal.aborted) throw new ModelError('MODEL_CANCELLED')
          if (serializedInput(messages, tools) >= before) throw new ModelError('CONTEXT_RECOVERY_NO_PROGRESS')
          reservation = budget.reserve(messages, tools, requestConfig, 'main-input', true)
        } else throw error
      }
      host.budget(budget.state)
      host.state('waiting', 'model_queue')
      let partial = ''
      let requestLink: RequestLink | undefined
      try {
        response = await service.request(lease, task, messages, tools, signal, text => { partial = text }, requestConfig.max_output_tokens, () => host.state('running', 'model_generating'), 'main', link => { requestLink = link })
        host.valid(); try { budget.settle(reservation, response) } finally { host.budget(budget.state) }
      } catch (e) {
        budget.abandon(reservation)
        if (partial) host.record('message.assistant.partial', { text: partial, incomplete: true, ...(requestLink ? { request_link: requestLink } : {}) })
        if (e instanceof ModelError && e.code === 'MODEL_CONTEXT_LENGTH_EXCEEDED' && host.context && !signal.aborted) {
          const before = serializedInput(messages, tools)
          messages = await host.context(messages, { overflow: true, ...(partial ? { partial } : {}) })
          host.valid(); if (signal.aborted) throw new ModelError('MODEL_CANCELLED')
          if (serializedInput(messages, tools) >= before) throw new ModelError('CONTEXT_RECOVERY_NO_PROGRESS')
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
    if (!response.calls.length && execution) {
      let result: Result
      try { result = workerResult(execution.profile, response) }
      catch (error) {
        const correction = execution.profile.resultCorrection
        if (!correction || response.finish !== 'stop' || !(error instanceof WorkerResultError) || !error.correctable) throw error
        const signature = resultSignature(response.text)
        if (rejectedResults.has(signature)) throw error
        rejectedResults.add(signature)
        host.record('worker.result.rejected', { code: error.code, ...association })
        resultCorrection = correction
        messages[0] = { role: 'system', content: [execution.profile.system, resultCorrection, preflightCorrection].filter(Boolean).join('\n\n') }
        continue
      }
      host.valid(); if (signal.aborted) throw new ModelError('MODEL_CANCELLED')
      const issue = execution.validateResult?.(result)
      host.valid(); if (signal.aborted) throw new ModelError('MODEL_CANCELLED')
      if (issue) {
        const signature = resultSignature(JSON.stringify({ code: issue.code, path: issue.path, value: issue.value }))
        const repeated = rejectedIssues.has(signature)
        host.record('worker.result.rejected', { ...issue, ...(repeated ? { no_progress: true } : {}), ...association })
        if (repeated) throw new ContractError(issue.code, issue.message)
        rejectedIssues.add(signature)
        preflightCorrection = `The host rejected this result before acceptance. Correct the reported field and return the complete result. Reuse successful resources and tool results; do not repeat successful operations. Available sources identify existing evidence; choose the relevant source yourself. Host preflight data: ${JSON.stringify(issue)}`
        messages[0] = { role: 'system', content: [execution.profile.system, resultCorrection, preflightCorrection].filter(Boolean).join('\n\n') }
        continue
      }
      if (host.context) await host.context(messages)
      host.valid(); if (signal.aborted) throw new ModelError('MODEL_CANCELLED')
      await execution.onResult(result)
      host.valid(); if (signal.aborted) throw new ModelError('MODEL_CANCELLED')
      if (response.text) host.record('message.assistant', { text: response.text, ...association })
      return
    }
    if (response.text) host.record('message.assistant', { text: response.text, ...association })
    if (!response.calls.length) {
      if (host.context) await host.context(messages)
      return
    }
    let failed = false
    for (const call of response.calls) {
      host.valid(); if (signal.aborted) throw new ModelError('MODEL_CANCELLED')
      const errorCall = collator && !['list', 'read', 'write', 'call'].includes(call.function.name) ? { ...call, function: { ...call.function, name: 'unknown' } } : call
      let result: unknown
      let queryResultId: number | undefined
      let repeatedRejection = false
      if (failed) result = toolError(errorCall, 'PREVIOUS_TOOL_FAILED', 'Earlier tool failed; this call was not executed')
      else {
        budget.tool(); host.budget(budget.state)
        let raw: unknown
        let validating = true
        try {
          if (collator && call.function.name !== 'read') throw new ContractError('WORKER_CAPABILITY_DENIED', 'Collator can read only its frozen runner metadata')
          raw = JSON.parse(call.function.arguments)
          const request = modelToolRequest(call.function.name, raw)
          profile?.authorize(request)
          validating = false
          rejectedInput = undefined
          const delivered = await host.tool(request, signal)
          if (request.type === 'list' || request.type === 'read') queryResultId = queryResults?.identify(call, delivered)
          result = modelToolResult(call.function.name, raw, delivered)
          const outcome = result as { execution?: string; delivery?: string } | null
          if ((outcome?.execution && outcome.execution !== 'success') || outcome?.delivery === 'failed') failed = true
        } catch (e) {
          host.valid(); if (signal.aborted) throw new ModelError('MODEL_CANCELLED')
          failed = true
          if (validating && (e instanceof SyntaxError || e instanceof ContractError && e.code === 'INVALID_REQUEST')) {
            // A fresh call ID cannot make unchanged, rejected input executable.
            const signature = JSON.stringify([call.function.name, call.function.arguments])
            repeatedRejection = rejectedInput === signature
            rejectedInput = signature
          }
          const suggestion = !collator && e instanceof ContractError ? modelToolSuggestion(call.function.name, raw, e, request => {
            if (!tools.some(tool => tool.function.name === request.type)) throw new ContractError('WORKER_CAPABILITY_DENIED', 'Suggested tool is unavailable')
            profile?.authorize(request)
          }) : undefined
          result = toolError(errorCall, e instanceof ContractError || e instanceof ModelError ? e.code : 'TOOL_FAILED', collator ? 'Collator tool request was denied; only frozen runner metadata is available' : e instanceof ContractError ? e.message : 'Tool not executed; no automatic replay', suggestion)
        }
      }
      const content = JSON.stringify(result)
      if (Buffer.byteLength(content) > (call.function.name === 'read' ? accountingResultLimit(result) : defaults.read.text_bytes)) throw new ModelError('TOOL_RESULT_LIMIT')
      const message: ChatMessage = { role: 'tool', tool_call_id: call.id, content }
      host.record('model.tool_result', { message, ...association, ...(queryResultId === undefined ? {} : { query_result_id: queryResultId }) }); messages.push(message)
      if (repeatedRejection) throw new ModelError('MODEL_TOOL_NO_PROGRESS')
    }
    host.toolsSettled?.()
  }
}

// Compare delivered query data within one attempt. Only the opaque local ID is
// recorded as progress metadata; the observer never receives arguments or data.
class QueryResults {
  private readonly entries = new Map<string, { id: number; data: string; bytes: number }>()
  private bytes = 0
  private nextId = 0

  identify(call: ToolCall, value: unknown): number | undefined {
    const result = value as { execution?: string; delivery?: string; data?: unknown } | null
    if (result?.execution !== 'success' || result.delivery !== 'delivered' || result.data === undefined) return
    const key = JSON.stringify([call.function.name, resultSignature(call.function.arguments)])
    const data = JSON.stringify(result.data)
    const bytes = Buffer.byteLength(key) + Buffer.byteLength(data), maxBytes = RUNNER_LIMITS.progress_query_result_bytes
    const previous = this.entries.get(key)
    if (previous) { this.entries.delete(key); this.bytes -= previous.bytes }
    if (bytes > maxBytes) return
    while (this.bytes + bytes > maxBytes || this.entries.size >= RUNNER_LIMITS.progress.evidence_max_calls) {
      const oldest = this.entries.keys().next().value!
      this.bytes -= this.entries.get(oldest)!.bytes; this.entries.delete(oldest)
    }
    const id = previous?.data === data ? previous.id : ++this.nextId
    this.entries.set(key, { id, data, bytes }); this.bytes += bytes
    return id
  }
}

function resultSignature(text: string): string {
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical)
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]))
    return value
  }
  try { return JSON.stringify(canonical(JSON.parse(text))) } catch { return text.trim() }
}
class WorkerResultError extends ContractError {
  constructor(readonly correctable: boolean) { super('INVALID_WORKER_RESULT', 'Worker result does not satisfy its required contract') }
}
function workerResult<Result>(profile: WorkerProfile<Result>, response: Completion): Result {
  try {
    const result = profile.parseResult(response)
    if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof (result as { then?: unknown }).then === 'function') {
      void Promise.resolve(result).catch(() => {})
      throw Error()
    }
    return result
  } catch (error) { throw new WorkerResultError(error instanceof ContractError && error.code === 'INVALID_WORKER_RESULT') }
}
function toolError(call: ToolCall, code: string, message: string, suggestion?: string): unknown { return { request_type: call.function.name, execution: 'not_executed', delivery: 'delivered', truncated: false, error: { code, message, ...(suggestion ? { suggestion } : {}) } } }
