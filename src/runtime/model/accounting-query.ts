import type Database from 'better-sqlite3'
import { assertContract, ContractError } from '../../shared/validation'
import { validateRunnerContract } from '../../shared/runner-validation'
import type { RequestAccounting } from './accounting'
import type { TaskUsageSummary } from '../../shared/types'

type Row = { id: string; payload_json: string }
export function accountingFacts(rows: Row[]) {
  const requests = new Map<string, RequestAccounting & { event_id: string; dispatched: boolean }>()
  const owners = new Map<string, string>()
  for (const row of rows) {
    const { run_id: runId, owner: rawOwner, ...value } = JSON.parse(row.payload_json)
    const owner = rawOwner === undefined ? undefined : validateRunnerContract('runner_execution_scope', rawOwner)
    if (owner && owner.run_id !== runId) throw new ContractError('ACCOUNTING_INVALID', 'Accounting owner belongs to another Run')
    assertContract<RequestAccounting>('request_accounting', value)
    if (value.version === 2 && ((value.output_policy === 'service-default') !== (value.output_reserve === null))) throw new ContractError('ACCOUNTING_INVALID', 'Output policy and reserve conflict')
    const old = requests.get(value.request_id)
    const binding = JSON.stringify(owner ? Object.fromEntries(Object.entries(owner).sort(([a], [b]) => a.localeCompare(b))) : null)
    if (old && owners.get(value.request_id) !== binding) throw new ContractError('ACCOUNTING_INVALID', 'Accounting owner changed within one request')
    if (!old && value.phase !== 'reserved') throw new ContractError('ACCOUNTING_INVALID', 'Accounting sequence has no reservation')
    const next = old?.phase === 'reserved' ? ['dispatched', 'failed'] : old?.phase === 'dispatched' ? ['completed', 'unknown'] : []
    const identity = (item: RequestAccounting) => JSON.stringify([item.version, item.output_policy, item.model_id, item.model_revision, item.purpose, item.input_bytes, item.estimated_input_tokens, item.output_reserve, item.context_tokens, ...Object.keys(item.components).sort().map(key => [key, item.components[key as keyof typeof item.components]])])
    if (old && (!next.includes(value.phase) || identity(value) !== identity(old))) throw new ContractError('ACCOUNTING_INVALID', 'Accounting sequence is inconsistent')
    if (!Number.isFinite(Date.parse(value.at)) || new Date(value.at).toISOString() !== value.at) throw new ContractError('ACCOUNTING_INVALID', 'Accounting timestamp is invalid')
    if (Object.values(value.components).reduce((sum, bytes) => sum + bytes, 0) !== value.input_bytes || (value.phase !== 'completed' && value.usage !== null) || (!['unknown', 'failed'].includes(value.phase) && value.error !== null)) throw new ContractError('ACCOUNTING_INVALID', 'Accounting fields are inconsistent')
    requests.set(value.request_id, { ...value, event_id: row.id, dispatched: old?.dispatched === true || value.phase === 'dispatched' })
    owners.set(value.request_id, binding)
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

function usageScope(run: string | undefined) {
  return "task_id=? AND kind='model.request.accounting' AND json_valid(payload_json)" +
    (run === undefined ? '' : " AND json_extract(payload_json,'$.run_id')=?")
}
export function usagePosition(db: Database.Database, task: string, run?: string): number {
  const scope = run === undefined ? [task] : [task, run]
  return (db.prepare(`SELECT sequence FROM records WHERE ${usageScope(run)} ORDER BY sequence DESC LIMIT 1`).get(...scope) as { sequence: number } | undefined)?.sequence ?? 0
}

// Aggregate the persisted ledger in SQLite, including routing before a Run exists.
export function usageSummary(db: Database.Database, task: string, through: number, run?: string): TaskUsageSummary {
  const scope = run === undefined ? [task] : [task, run]
  const totals = db.prepare(`WITH facts AS MATERIALIZED (
    SELECT sequence,payload_json,
      json_extract(payload_json,'$.request_id') AS request,
      json_array(json_extract(payload_json,'$.run_id'),json_extract(payload_json,'$.routing_operation_id')) AS execution,
      json_extract(payload_json,'$.phase') AS phase,
      json_extract(payload_json,'$.owner') AS owner
    FROM records WHERE ${usageScope(run)} AND sequence<=?
      AND json_extract(payload_json,'$.version') IN (1,2)
      AND json_type(payload_json,'$.request_id')='text' AND json_extract(payload_json,'$.request_id')!=''
      AND (json_type(payload_json,'$.owner') IS NULL OR
        (json_extract(payload_json,'$.owner.task_id')=task_id AND json_extract(payload_json,'$.owner.run_id')=json_extract(payload_json,'$.run_id')))
  ), dispatched AS (
    SELECT execution,request,MIN(sequence) AS position FROM facts WHERE phase='dispatched' GROUP BY execution,request
  ), settled AS (
    SELECT COALESCE(MIN(CASE WHEN e.phase='completed' THEN e.sequence END),MIN(e.sequence)) AS position
    FROM dispatched d JOIN facts f ON f.sequence=d.position
    JOIN facts e ON e.execution=d.execution AND e.request=d.request AND e.sequence>f.sequence AND e.owner IS f.owner
      AND ${run === undefined ? "e.phase IN ('completed','unknown')" : "e.phase='completed'"}
    WHERE EXISTS (SELECT 1 FROM facts r WHERE r.execution=d.execution AND r.request=d.request AND r.phase='reserved' AND r.owner IS f.owner AND r.sequence<f.sequence)
    GROUP BY d.execution,d.request
  ), reported AS (
    SELECT json_extract(f.payload_json,'$.usage.prompt_tokens') AS input,
      json_extract(f.payload_json,'$.usage.completion_tokens') AS output,
      CASE WHEN json_extract(f.payload_json,'$.version')=2 AND json_type(f.payload_json,'$.usage.cached_prompt_tokens')='integer'
        THEN json_extract(f.payload_json,'$.usage.cached_prompt_tokens') END AS cached
    FROM settled s JOIN facts f ON f.sequence=s.position
    WHERE json_type(f.payload_json,'$.usage.prompt_tokens')='integer' AND json_type(f.payload_json,'$.usage.completion_tokens')='integer'
      AND input BETWEEN 0 AND 9007199254740991 AND output BETWEEN 0 AND 9007199254740991
  ), clean AS (
    SELECT input,output,CASE WHEN typeof(cached)='integer' AND cached BETWEEN 0 AND input THEN cached END AS cached FROM reported
  ) SELECT (SELECT COUNT(*) FROM dispatched) AS dispatched_requests,COUNT(*) AS reported_requests,
    COUNT(cached) AS cache_reported_requests,TOTAL(input) AS input_tokens,TOTAL(output) AS output_tokens,TOTAL(cached) AS cached_input_tokens FROM clean`).get(...scope, through) as Omit<TaskUsageSummary, 'task_id' | 'through_sequence' | 'cache_hit_ratio'>
  if (!Number.isSafeInteger(totals.input_tokens + totals.output_tokens)) throw new ContractError('ACCOUNTING_RANGE', 'Usage exceeds the supported exact range')
  return {
    task_id: task, through_sequence: through, ...totals,
    cache_hit_ratio: totals.input_tokens > 0 && totals.dispatched_requests === totals.cache_reported_requests ? totals.cached_input_tokens / totals.input_tokens : null
  }
}
