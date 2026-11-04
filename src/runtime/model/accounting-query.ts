import type Database from 'better-sqlite3'
import { assertContract, ContractError } from '../../shared/validation'
import type { RequestAccounting } from './accounting'

type Row = { id: string; payload_json: string }
export function accountingFacts(rows: Row[]) {
  const requests = new Map<string, RequestAccounting & { event_id: string; dispatched: boolean }>()
  for (const row of rows) {
    const { run_id: _, ...value } = JSON.parse(row.payload_json)
    assertContract<RequestAccounting>('request_accounting', value)
    if (value.version === 2 && ((value.output_policy === 'service-default') !== (value.output_reserve === null))) throw new ContractError('ACCOUNTING_INVALID', 'Output policy and reserve conflict')
    const old = requests.get(value.request_id)
    if (!old && value.phase !== 'reserved') throw new ContractError('ACCOUNTING_INVALID', 'Accounting sequence has no reservation')
    const next = old?.phase === 'reserved' ? ['dispatched', 'failed'] : old?.phase === 'dispatched' ? ['completed', 'unknown'] : []
    const identity = (item: RequestAccounting) => JSON.stringify([item.version, item.output_policy, item.model_id, item.model_revision, item.purpose, item.input_bytes, item.estimated_input_tokens, item.output_reserve, item.context_tokens, ...Object.keys(item.components).sort().map(key => [key, item.components[key as keyof typeof item.components]])])
    if (old && (!next.includes(value.phase) || identity(value) !== identity(old))) throw new ContractError('ACCOUNTING_INVALID', 'Accounting sequence is inconsistent')
    if (!Number.isFinite(Date.parse(value.at)) || new Date(value.at).toISOString() !== value.at) throw new ContractError('ACCOUNTING_INVALID', 'Accounting timestamp is invalid')
    if (Object.values(value.components).reduce((sum, bytes) => sum + bytes, 0) !== value.input_bytes || (value.phase !== 'completed' && value.usage !== null) || (!['unknown', 'failed'].includes(value.phase) && value.error !== null)) throw new ContractError('ACCOUNTING_INVALID', 'Accounting fields are inconsistent')
    requests.set(value.request_id, { ...value, event_id: row.id, dispatched: old?.dispatched === true || value.phase === 'dispatched' })
  }
  return { version: 1, recorded: !!rows.length, requests: [...requests.values()].map(item => ({ ...item, phase: item.phase === 'dispatched' ? 'unknown' : item.phase, notice: item.phase === 'reserved' ? 'No dispatch record; no automatic retry.' : !item.usage ? 'Usage unavailable; not zero and not an invoice.' : 'Provider usage, not a monetary invoice.' })) }
}

export function readRequestAccounting(db: Database.Database, task: string, run: string) {
  const rows = db.prepare("SELECT id,payload_json FROM records WHERE task_id=? AND kind='model.request.accounting' AND json_extract(payload_json,'$.run_id')=? ORDER BY sequence LIMIT 201").all(task, run) as Row[]
  if (rows.length > 200) return { version: 1, recorded: true, requests: [], complete: false, notice: 'Ledger exceeds the inline window, not an invalid Run. Use the host paged ledger or inspect original model.request.accounting events; no complete usage total is available here.' }
  return { ...accountingFacts(rows), complete: true }
}

export function accountingPage(db: Database.Database, task: string, run: string, through: number, after: number) {
  const selected = db.prepare("SELECT json_extract(payload_json,'$.request_id') request_id,min(sequence) first_sequence FROM records WHERE task_id=? AND kind='model.request.accounting' AND json_extract(payload_json,'$.run_id')=? AND sequence<=? GROUP BY request_id HAVING min(sequence)>? ORDER BY first_sequence LIMIT 21").all(task, run, through, after) as { request_id: string; first_sequence: number }[]
  const identities = selected.slice(0, 20).map(item => item.request_id)
  if (identities.some(identity => typeof identity !== 'string')) throw new ContractError('ACCOUNTING_INVALID', 'Accounting request identity is missing')
  // Batch the selected chains: do not rescan the entire Run once per request.
  const selectedRows = identities.length ? db.prepare(`SELECT id,payload_json FROM records WHERE task_id=? AND kind='model.request.accounting' AND json_extract(payload_json,'$.run_id')=? AND sequence<=? AND json_extract(payload_json,'$.request_id') IN (${identities.map(() => '?').join(',')}) ORDER BY sequence LIMIT 81`).all(task, run, through, ...identities) as Row[] : []
  const chains = new Map<string, Row[]>()
  for (const row of selectedRows) {
    const key = JSON.parse(row.payload_json).request_id
    const chain = chains.get(key) ?? []; chain.push(row); chains.set(key, chain)
  }
  const requests = []
  for (const item of selected.slice(0, 20)) {
    const rows = chains.get(item.request_id) ?? []
    const facts = accountingFacts(rows)
    if (rows.length > 3 || facts.requests.length !== 1) throw new ContractError('ACCOUNTING_INVALID', 'Accounting request stage chain is invalid')
    requests.push(facts.requests[0]!)
  }
  return { requests, next_after: selected.length > 20 ? selected[19]!.first_sequence : null }
}
