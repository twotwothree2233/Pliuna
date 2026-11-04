import type Database from 'better-sqlite3'
import { assertContract, ContractError } from '../../shared/validation'
import type { HistoryRecord } from './context'
import type { RequestEvidence, RequestLink } from './request-evidence'

// Only explicit record links are followed; legacy adjacency is not evidence.
export function requestRelations(db: Database.Database, task: string, records: HistoryRecord[]) {
  const responses: Record<string, unknown>[] = [], requests = new Map<string, Record<string, unknown>>()
  const targets = new Set(records.filter(record => record.kind === 'model.tool_result').map(record => record.id))
  let latestReference: Record<string, unknown> | undefined
  const latest = records.filter(record => record.kind === 'message.assistant').sort((a,b) => b.sequence-a.sequence)[0]
  const equivalent = latest?.payload.request_link ? records.find(record => record.kind === 'model.response' && !record.payload.message?.tool_calls?.length && record.payload.message?.content === latest.payload.text && record.payload.request_link?.request_id === latest.payload.request_link.request_id && record.payload.request_link?.evidence_event_id === latest.payload.request_link.evidence_event_id && record.payload.run_id === latest.payload.run_id) : undefined
  for (const record of [latest, equivalent]) if (record) targets.add(record.id)
  const owner = (record: HistoryRecord) => typeof record.payload.run_id === 'string' ? { owner_run_id: record.payload.run_id } : {}
  const latestChat = latest ? { record_id: latest.id, kind: latest.kind, sequence: latest.sequence, ...owner(latest), ...(equivalent ? { equivalent_response_id: equivalent.id } : {}), ...(latest.payload.request_link ? { request_link: latest.payload.request_link } : { association: 'unrecorded' }) } : null
  for (const record of records.filter(record => record === latest || record.kind === 'model.tool_result')) {
    if (!['model.response', 'message.assistant', 'model.tool_result'].includes(record.kind)) continue
    const link = record.payload.request_link as RequestLink | undefined
    if (!link) { responses.push({ record_id: record.id, ...owner(record), association: 'unrecorded' }); continue }
    assertContract('model_request_link', link)
    responses.push({ record_id: record.id, ...owner(record), request_id: link.request_id, relation: record.kind === 'model.tool_result' ? 'call-dispatched-by' : 'produced-by' })
    if (requests.has(link.evidence_event_id)) continue
    const row = db.prepare("SELECT CASE WHEN length(CAST(payload_json AS BLOB))<=1048576 THEN payload_json END payload_json,sequence FROM records WHERE task_id=? AND id=? AND kind='model.request.evidence'").get(task, link.evidence_event_id) as { payload_json: string; sequence: number } | undefined
    if (!row || typeof row.payload_json !== 'string') throw new ContractError('REQUEST_EVIDENCE_INVALID', 'Explicit request evidence is missing in this task')
    const { run_id, ...manifest } = JSON.parse(row.payload_json) as RequestEvidence & { run_id: string }
    assertContract<RequestEvidence>('request_evidence', manifest)
    if (manifest.request_id !== link.request_id || record.payload.run_id !== run_id || row.sequence >= record.sequence) throw new ContractError('REQUEST_EVIDENCE_INVALID', 'Request and response association mismatch')
    const sources: Record<string, any>[] = [...manifest.entries.filter(item => item.source).map(item => ({ ...item, entry_type: 'input' })), ...manifest.originals.map(item => ({ ...item, entry_type: 'original' })), ...manifest.supplements.map(item => ({ ...item, entry_type: 'database-supplement' }))]
    const matched = sources.filter(item => targets.has(item.source.id)).map(item => {
      const { source, ...position } = item
      return { source_id: source.id, ...position }
    })
    const trigger = manifest.entries.find(item => item.kind === 'host-state' && item.source?.kind === 'message')?.source
    let chatReference: Record<string, unknown> = { status: 'unrecorded' }
    if (trigger) {
      const user = db.prepare("SELECT sequence,json_extract(payload_json,'$.run_id') run_id FROM records WHERE task_id=? AND id=? AND kind='message.user'").get(task, trigger.id) as { sequence: number; run_id?: string } | undefined
      if (!user || user.run_id !== run_id || user.sequence >= row.sequence) throw new ContractError('REQUEST_EVIDENCE_INVALID', 'Original request trigger is unavailable or out of order')
      const previous = db.prepare("SELECT id,sequence FROM records WHERE task_id=? AND kind='message.assistant' AND sequence<? ORDER BY sequence DESC LIMIT 1").get(task, user.sequence) as { id: string; sequence: number } | undefined
      chatReference = { user_message_id: trigger.id, previous_chat_id: previous?.id ?? null }
    }
    requests.set(link.evidence_event_id, { request_link: link, owner_run_id: run_id, purpose: manifest.purpose, stage: manifest.stage, chat_reference: chatReference, matched_input_sources: matched })
    if (record === latest && trigger) latestReference = chatReference
  }
  if (!records.some(record => record.kind === 'model.tool_result')) return { latest_chat_message: latestChat, ...(latestReference ? { historical_chat_reference: latestReference } : {}) }
  return { latest_chat_message: latestChat, scope: 'same-task-explicit-links', responses, requests: [...requests.values()] }
}
