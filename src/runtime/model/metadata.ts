import type { ModelConfiguration } from '../../shared/contracts.generated'
import type { ModelCandidate } from './adapter'

export const officialProviders: Record<string, string> = {
  'https://api.openai.com/v1': 'openai',
  'https://api.deepseek.com': 'deepseek',
  'https://api.deepseek.com/v1': 'deepseek'
}
export const unknownCapabilities = () => ({ tools: 'unknown', streaming: 'unknown', vision: 'unknown', structured_output: 'unknown' } as const)
export function modelMetadata(candidate?: ModelCandidate, fetchedAt?: string, manual = { context: true, output: true }): NonNullable<ModelConfiguration['metadata']> {
  const field = (name: 'context_tokens' | 'max_output_tokens', override: boolean) => ({ source: candidate?.[name] !== undefined && !override ? 'service' as const : 'manual' as const, fetched_at: candidate?.[name] !== undefined && !override ? fetchedAt ?? null : null, manual_override: override })
  return { context_tokens: field('context_tokens', manual.context), max_output_tokens: field('max_output_tokens', manual.output), capabilities: unknownCapabilities() }
}
export function legacyMetadata(): NonNullable<ModelConfiguration['metadata']> {
  return { context_tokens: { source: 'legacy', fetched_at: null, manual_override: true }, max_output_tokens: { source: 'legacy', fetched_at: null, manual_override: true }, capabilities: unknownCapabilities() }
}
// Directory data never establishes runtime capability or rewrites a saved configuration.
export function directoryCandidate(payload: unknown, base: string, provider: string, wire: string): ModelCandidate | null {
  if (officialProviders[base.replace(/\/$/, '')] !== provider) return null
  const root = payload as any, p = root?.[provider], row = p?.models?.[wire]
  if (!p || p.id !== provider || !row || row.id !== wire) return null
  const context = row.limit?.context, output = row.limit?.output
  const valid = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max
  const result: ModelCandidate = { id: wire, conflicts: [] }
  if (valid(context, 1, Number.MAX_SAFE_INTEGER)) result.context_tokens = context
  if (valid(output, 1, Number.MAX_SAFE_INTEGER)) result.max_output_tokens = output
  return result
}
