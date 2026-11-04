import { randomUUID } from 'node:crypto'
import { assertContract, ContractError } from '../../shared/validation'
import { montyLimits } from './contract'

export interface MontyResource { id: string; body: Buffer; media_type: string; display_name: string }
const invalid = (): never => { throw new ContractError('MONTY_OUTPUT_INVALID', 'Calculation value cannot be faithfully delivered; no repr conversion or automatic replay') }
function keys(value: Record<string, unknown>, expected: string[]) { if (Object.keys(value).sort().join(',') !== expected.sort().join(',')) invalid() }
export function materializeValue(input: unknown): { value: unknown; resources: MontyResource[] } {
  const resources: MontyResource[] = []
  let total = 0
  function json(value: unknown): unknown {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
    if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return value
    if (Array.isArray(value)) return value.map(json)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, json(v)]))
    return invalid()
  }
  function visit(value: unknown): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
    const item = value as Record<string, unknown>
    if (item.type === 'json') { keys(item, ['type', 'value']); return { type: 'json', value: json(item.value) } }
    if (item.type === 'bigint') { keys(item, ['type', 'decimal']); if (typeof item.decimal !== 'string' || !/^-?(0|[1-9][0-9]*)$/.test(item.decimal)) invalid(); return item }
    if (item.type === 'nonfinite') { keys(item, ['type', 'value']); if (!['nan', 'positive_infinity', 'negative_infinity'].includes(item.value as string)) invalid(); return item }
    if (item.type === 'bytes') {
      keys(item, ['type', 'hex']); if (typeof item.hex !== 'string' || item.hex.length % 2 || !/^[0-9a-f]*$/.test(item.hex)) return invalid()
      const body = Buffer.from(item.hex, 'hex'); total += body.length
      if (total > montyLimits.result_bytes) throw new ContractError('MONTY_RESULT_LIMIT', 'Calculation output exceeds the published resource limit')
      const id = randomUUID(); resources.push({ id, body, media_type: 'application/octet-stream', display_name: 'Calculation bytes' })
      return { type: 'bytes', resource: { kind: 'resource', id }, byte_length: body.length }
    }
    if (['list', 'tuple', 'set', 'frozenset'].includes(item.type as string)) { keys(item, ['type', 'items']); if (!Array.isArray(item.items)) return invalid(); return { type: item.type, items: item.items.map(visit) } }
    if (item.type === 'map') {
      keys(item, ['type', 'entries']); if (!Array.isArray(item.entries)) return invalid()
      return { type: 'map', entries: item.entries.map(entry => { if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return invalid(); keys(entry, ['key', 'value']); return { key: visit(entry.key), value: visit(entry.value) } }) }
    }
    return invalid()
  }
  const value = visit(input)
  assertContract('wire_value', value)
  total += Buffer.byteLength(JSON.stringify(value))
  if (total > montyLimits.result_bytes) throw new ContractError('MONTY_RESULT_LIMIT', 'Calculation output exceeds the published resource limit')
  return { value, resources }
}
