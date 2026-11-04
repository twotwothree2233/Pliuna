import type { ModelConfiguration } from '../../shared/contracts.generated'
import defaults from '../../shared/contracts/development-defaults.json'
import { jsonDiagnostic } from './json-diagnostic'

export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface ChatMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string }
export interface ToolDefinition { type: 'function'; function: { name: string; description: string; parameters: unknown } }
export interface Completion { request_link?: import('./request-evidence').RequestLink; text: string; calls: ToolCall[]; finish: 'stop' | 'tool_calls'; usage?: { prompt_tokens: number; completion_tokens: number } }
export interface ModelCandidate { id: string; context_tokens?: number; max_output_tokens?: number; conflicts: string[] }
export interface ModelCatalogue { models: ModelCandidate[]; source: 'service'; fetched_at: string }
export class ModelError extends Error {
  constructor(readonly code: string, readonly partial = false, readonly retryable = false, readonly usage?: Completion['usage'], readonly inputDiagnostic?: string) { super(inputDiagnostic ? `${code}: ${inputDiagnostic}` : code) }
}
function contextOverflow(error: unknown): boolean {
  if (!object(error)) return false
  if (['context_length_exceeded', 'context_window_exceeded', 'max_context_length_exceeded'].includes(error.code) || ['context_length_exceeded', 'context_window_exceeded'].includes(error.type)) return true
  return typeof error.message === 'string' && /maximum context length|context (?:length|window).*(?:exceed|too (?:long|large))|exceed.*(?:context length|context window)/i.test(error.message)
}
function object(v: unknown): v is Record<string, any> { return !!v && typeof v === 'object' && !Array.isArray(v) }
export function endpoint(base: string, route: string): string {
  let url: URL
  try { url = new URL(base) } catch { throw new ModelError('INVALID_SERVICE_URL') }
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new ModelError('INVALID_SERVICE_URL')
  url.pathname = url.pathname.replace(/\/$/, '') + '/' + route
  return url.href
}
export class ChatAdapter {
  constructor(private readonly transport: typeof fetch = fetch) {}
  async discover(config: Pick<ModelConfiguration, 'base_url'>, key: string, signal: AbortSignal): Promise<string[]> {
    return (await this.catalogue(config, key, signal)).models.map(model => model.id)
  }
  async catalogue(config: Pick<ModelConfiguration, 'base_url'>, key: string, signal: AbortSignal): Promise<ModelCatalogue> {
    try {
      const response = await this.transport(endpoint(config.base_url, 'models'), { headers: key ? { Authorization: `Bearer ${key}` } : {}, redirect: 'error', signal })
      if (!response.ok) { await response.body?.cancel(); throw this.httpError(response.status) }
      const text = await boundedText(response, signal)
      const data: unknown = JSON.parse(text)
      if (!object(data) || !Array.isArray(data.data)) throw new ModelError('INCOMPATIBLE_RESPONSE')
      if (data.data.length > 1000) throw new ModelError('MODEL_CATALOG_LIMIT')
      const rows = new Map<string, Record<string, any>[]>()
      for (const value of data.data) {
        if (!object(value) || typeof value.id !== 'string' || !value.id.trim() || value.id.length > 200 || /[\x00-\x1f]/.test(value.id)) throw new ModelError('INCOMPATIBLE_RESPONSE')
        rows.set(value.id, [...(rows.get(value.id) ?? []), value])
      }
      const models = [...rows].map(([id, values]): ModelCandidate => {
        const result: ModelCandidate = { id, conflicts: [] }
        const field = (name: 'context_tokens' | 'max_output_tokens', candidates: unknown[], min: number, max: number) => {
          const provided = candidates.filter(value => value !== undefined)
          if (!provided.length) return
          if (provided.some(value => !Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) || new Set(provided).size !== 1) { result.conflicts.push(name); return }
          result[name] = provided[0] as number
        }
        field('context_tokens', values.flatMap(value => [value.context_tokens, value.context_length, value.context_window, value.max_context_length, value.top_provider?.context_length]), 1, Number.MAX_SAFE_INTEGER)
        field('max_output_tokens', values.flatMap(value => [value.max_output_tokens, value.max_completion_tokens, value.top_provider?.max_completion_tokens]), 1, Number.MAX_SAFE_INTEGER)
        return result
      })
      return { models, source: 'service', fetched_at: new Date().toISOString() }
    } catch (e) { if (e instanceof ModelError) throw e; throw new ModelError(signal.aborted ? 'MODEL_CANCELLED' : 'MODEL_NETWORK_ERROR') }
  }
  private httpError(status: number): ModelError {
    if (status === 401 || status === 403) return new ModelError('MODEL_AUTHENTICATION')
    if (status === 404) return new ModelError('MODEL_UNAVAILABLE')
    if (status === 429 || status >= 500) return new ModelError('MODEL_TEMPORARY_ERROR', false, true)
    return new ModelError('MODEL_INVALID_REQUEST')
  }
  async complete(config: ModelConfiguration, key: string, messages: ChatMessage[], tools: ToolDefinition[] | undefined, signal: AbortSignal, onText?: (text: string) => void, outputLimit = config.max_output_tokens): Promise<Completion> {
    let partial = false, usage: Completion['usage'], upstream: ModelError | undefined
    try {
      const response = await this.transport(endpoint(config.base_url, 'chat/completions'), {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, redirect: 'error', signal,
        body: JSON.stringify({ model: config.wire_model_id, messages, stream: true, stream_options: { include_usage: true },
          ...(outputLimit === undefined ? {} : { [config.compatibility_profile === 'chat-max-tokens' ? 'max_tokens' : 'max_completion_tokens']: outputLimit }),
          ...(tools ? { tools, tool_choice: 'auto' } : {}) })
      })
      if (!response.ok) {
        if ([400, 413, 422].includes(response.status)) {
          let body: unknown
          try { body = JSON.parse(await boundedText(response, signal)) } catch { /* Never expose provider error bodies. */ }
          if (object(body) && contextOverflow(body.error)) throw new ModelError('MODEL_CONTEXT_LENGTH_EXCEEDED')
        } else await response.body?.cancel()
        throw this.httpError(response.status)
      }
      if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream') || !response.body) { await response.body?.cancel(); throw new ModelError('INCOMPATIBLE_STREAM') }
      let text = '', finish: string | null = null, done = false
      const calls = new Map<number, ToolCall>()
      const callIds = new Set<string>()
      for await (const frame of sse(response, signal, config.limits?.response_bytes)) {
        if (done) throw new ModelError('TRAILING_STREAM_DATA', partial)
        if (frame === '[DONE]') { done = true; break }
        let chunk: unknown
        try { chunk = JSON.parse(frame) } catch { throw new ModelError('INVALID_STREAM_JSON', partial) }
        partial = true
        if (!object(chunk)) throw new ModelError('INCOMPATIBLE_STREAM', partial)
        if (chunk.usage != null) {
          const u = chunk.usage
          if (!object(u) || ![u.prompt_tokens, u.completion_tokens].every(n => Number.isSafeInteger(n) && n >= 0)) throw new ModelError('INVALID_USAGE', partial)
          usage = { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens }
        }
        if (chunk.error) {
          if (contextOverflow(chunk.error)) throw new ModelError('MODEL_CONTEXT_LENGTH_EXCEEDED', partial, false, usage)
          const server = object(chunk.error) && (chunk.error.type === 'server_error' || chunk.error.code === 'internal_server_error')
          upstream ??= new ModelError(server ? 'MODEL_PROVIDER_SERVER_ERROR' : 'MODEL_PROVIDER_ERROR', partial)
          continue
        }
        if (upstream) continue
        if (!Array.isArray(chunk.choices) || chunk.choices.length > 1) throw new ModelError('INCOMPATIBLE_STREAM', partial)
        if (!chunk.choices.length) continue
        const choice = chunk.choices[0]
        if (!object(choice) || choice.index !== 0 || !object(choice.delta)) throw new ModelError('INCOMPATIBLE_STREAM', partial)
        const delta = choice.delta
        if (delta.refusal) throw new ModelError('MODEL_REFUSAL', partial)
        if (delta.role !== undefined && delta.role !== 'assistant') throw new ModelError('INCOMPATIBLE_ROLE', partial)
        if (delta.content !== undefined && delta.content !== null) {
          if (typeof delta.content !== 'string' || finish) throw new ModelError('INCOMPATIBLE_STREAM', partial)
          if (delta.content) { partial = true; text += delta.content; onText?.(text) }
        }
        if (delta.tool_calls !== undefined) {
          if (!tools || !Array.isArray(delta.tool_calls) || finish) throw new ModelError('UNEXPECTED_TOOL_CALL', partial)
          for (const part of delta.tool_calls) {
            partial = true
            if (!object(part) || !Number.isInteger(part.index) || part.index < 0 || part.index >= defaults.model.tool_calls) throw new ModelError('INVALID_TOOL_DELTA', true)
            let call = calls.get(part.index)
            if (!call) { call = { id: '', type: 'function', function: { name: '', arguments: '' } }; calls.set(part.index, call) }
            if (part.id !== undefined) {
              if (typeof part.id !== 'string' || !part.id || part.id.length > 200 || (call.id && call.id !== part.id) || (!call.id && callIds.has(part.id))) throw new ModelError('INVALID_TOOL_ID', true)
              if (!call.id) { call.id = part.id; callIds.add(part.id) }
            }
            if (part.type !== undefined && part.type !== 'function') throw new ModelError('INVALID_TOOL_TYPE', true)
            if (part.function !== undefined) {
              if (!object(part.function)) throw new ModelError('INVALID_TOOL_DELTA', true)
              for (const k of ['name', 'arguments'] as const) if (part.function[k] !== undefined) {
                if (typeof part.function[k] !== 'string') throw new ModelError('INVALID_TOOL_DELTA', true)
                call.function[k] += part.function[k]
              }
            }
          }
        }
        if (choice.finish_reason != null) {
          if (finish || !['stop', 'tool_calls'].includes(choice.finish_reason)) throw new ModelError('MODEL_INCOMPLETE', partial)
          finish = choice.finish_reason
        }
      }
      if (upstream) throw upstream
      if (!done || !finish || (finish === 'stop' && calls.size) || (finish === 'tool_calls' && !calls.size)) throw new ModelError('MODEL_INCOMPLETE', partial)
      const ordered = [...calls].sort(([a], [b]) => a - b)
      for (let i = 0; i < ordered.length; i++) {
        const [index, call] = ordered[i]!
        if (index !== i || !call.id || !['list', 'read', 'write', 'call'].includes(call.function.name)) throw new ModelError('INVALID_TOOL_CALL', true)
        let args: unknown
        try { args = JSON.parse(call.function.arguments) } catch { throw new ModelError('INVALID_TOOL_ARGUMENTS', true, false, usage, jsonDiagnostic(call.function.arguments, 'tool arguments')) }
        if (!object(args)) throw new ModelError('INVALID_TOOL_ARGUMENTS', true, false, usage, 'tool arguments must be a JSON object; no input was executed')
      }
      return { text, calls: ordered.map(([, c]) => c), finish: finish as Completion['finish'], usage }
    } catch (caught) {
      const e = upstream && !signal.aborted ? upstream : caught
      if (e instanceof ModelError) throw new ModelError(e.code, partial || e.partial, !partial && e.retryable, usage ?? e.usage, e.inputDiagnostic)
      throw new ModelError(signal.aborted ? 'MODEL_CANCELLED' : partial ? 'MODEL_STREAM_INTERRUPTED' : 'MODEL_NETWORK_ERROR', partial, !partial && !signal.aborted, usage)
    }
  }
}
async function* sse(response: Response, signal: AbortSignal, maximum?: number): AsyncGenerator<string> {
  const reader = response.body!.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = '', bytes = 0, data: string[] = []
  try {
    while (true) {
      if (signal.aborted) throw new ModelError('MODEL_CANCELLED')
      const item = await reader.read()
      if (item.done) { buffer += decoder.decode(); if (buffer || data.length) throw new ModelError('MODEL_INCOMPLETE'); break }
      bytes += item.value.byteLength
      if (maximum !== undefined && bytes > maximum) throw new ModelError('MODEL_OUTPUT_LIMIT')
      buffer += decoder.decode(item.value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, ''); buffer = buffer.slice(newline + 1)
        if (Buffer.byteLength(line) > defaults.model.frame_bytes) throw new ModelError('MODEL_FRAME_LIMIT')
        if (!line) { if (data.length) { yield data.join('\n'); data = [] } }
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
        else if (!line.startsWith(':') && !/^(event|id|retry):/.test(line)) throw new ModelError('INCOMPATIBLE_STREAM')
        if (Buffer.byteLength(data.join('\n')) > defaults.model.frame_bytes) throw new ModelError('MODEL_FRAME_LIMIT')
      }
      if (Buffer.byteLength(buffer) > defaults.model.frame_bytes) throw new ModelError('MODEL_FRAME_LIMIT')
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
async function boundedText(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) throw new ModelError('INCOMPATIBLE_RESPONSE')
  const reader = response.body.getReader(); let bytes = 0; const chunks: Uint8Array[] = []
  try { while (true) { if (signal.aborted) throw new ModelError('MODEL_CANCELLED'); const item = await reader.read(); if (item.done) break; bytes += item.value.byteLength; if (bytes > defaults.model.catalogue_bytes) throw new ModelError('MODEL_OUTPUT_LIMIT'); chunks.push(item.value) } }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
}
