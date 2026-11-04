import type { Bundle } from '../shared/contracts.generated'
import { ContractError } from '../shared/validation'
import { checkDraft } from './managed'

// Compare JSON objects independently of key order; arrays retain their order.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}'
  return JSON.stringify(value)
}

export function replacementDraft(previous: Bundle, next: Bundle, draft: Record<string, unknown>, transition: {
  type: 'preserve'; compatibility_version: string
} | { type: 'reset'; initial: unknown }): Record<string, unknown> {
  if (transition.type === 'preserve') {
    if (canonical(previous.state.schema) !== canonical(next.state.schema) || previous.state.compatibility_version !== next.state.compatibility_version || transition.compatibility_version !== previous.state.compatibility_version) {
      throw new ContractError('STATE_INCOMPATIBLE', 'Preserve requires the same schema and compatibility version; never infer semantic compatibility from field names')
    }
    checkDraft(next, draft)
    return structuredClone(draft)
  }
  if (canonical(transition.initial) !== canonical(next.state.initial)) throw new ContractError('INVALID_INITIAL', 'Reset initial must exactly match bundle state.initial')
  checkDraft(next, transition.initial as Record<string, unknown>)
  return structuredClone(transition.initial as Record<string, unknown>)
}
