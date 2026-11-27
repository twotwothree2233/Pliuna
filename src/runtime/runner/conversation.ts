import type Database from 'better-sqlite3'
import type { ContentPlan } from '../../shared/contracts.generated'
import { ContractError } from '../../shared/validation'
import type { ChatMessage } from '../model/adapter'
import { captureExecutionScope, type ConversationSource } from '../model/request-evidence'
import { containsProducerResult } from './production-result'

export interface ConversationBinding {
  version: 1
  through_sequence: number
  reply_to_request_id: string | null
  resource_ids?: string[]
}
export interface ConversationResult {
  id: string
  sequence: number
  kind: string
  text: string | null
  publication?: { operation_id: string; surface_revision: number; surface_history_id: string; manifest_id: string }
  views?: Array<{
    view_id: string
    history: { kind: 'view_history'; id: string; selection: { revision: number } }
    content: { kind: 'resource'; id: string; selection: { view: 'object' } }
  }>
}
export interface ConversationHistory {
  messages: Array<{ source: ConversationSource; message: ChatMessage }>
  refs: Array<{ kind: 'event'; id: string }>
  truncated: boolean
  resource_ids: string[]
  preceding_result?: ConversationResult
}

export function fitConversation(history: ConversationHistory, fits: (candidate: ConversationHistory) => boolean): ConversationHistory {
  let candidate: ConversationHistory = {
    ...history,
    messages: [...history.messages],
    refs: history.refs.map(ref => ({ ...ref })),
    resource_ids: [...history.resource_ids]
  }
  if (fits(candidate) || !candidate.messages.length && !candidate.refs.length) return candidate
  const refs: ConversationHistory['refs'] = [], seen = new Set<string>()
  for (const ref of candidate.refs) {
    if (!seen.has(ref.id)) { refs.push(ref); seen.add(ref.id) }
  }
  // Recent messages take priority; navigation uses the remaining capacity.
  candidate = { ...candidate, refs: [], truncated: true }
  for (;;) {
    if (fits(candidate)) break
    if (!candidate.messages.length) return candidate
    const oldest = candidate.messages[0]!
    if (!seen.has(oldest.source.id)) { refs.push({ kind: 'event', id: oldest.source.id }); seen.add(oldest.source.id) }
    candidate = { ...candidate, messages: candidate.messages.slice(1) }
  }
  candidate = { ...candidate, refs }
  while (!fits(candidate) && candidate.refs.length) candidate = { ...candidate, refs: candidate.refs.slice(1) }
  return candidate
}

const recordBytes = 1024 * 1024, contextBytes = 8 * recordBytes, recordCount = 4096
const tailBytes = 256 * 1024, tailCount = 64, navigationBytes = 64 * 1024
interface ConversationRow { id: string; sequence: number; kind: string; bytes: number; payload_json: string | null; request_id: string | null }
const safePayload = (alias: string) => `CASE WHEN json_valid(${alias}.payload_json) THEN ${alias}.payload_json ELSE '{}' END`
const payload = safePayload('r')
export const conversationRecordKinds = `
  (r.kind='message.user' AND json_type(${payload},'$.text')='text')
  OR (r.kind='runner.answer' AND json_extract(${payload},'$.purpose')='final_answer'
      AND json_extract(${payload},'$.owner.purpose')='production'
      AND json_extract(${payload},'$.owner.role') IN ('producer','lightweight','integrator')
      AND json_extract(${payload},'$.owner.task_id')=r.task_id
      AND json_extract(${payload},'$.owner.request_id')=json_extract(${payload},'$.request_id')
      AND json_type(${payload},'$.text')='text')
  OR (r.kind='runner.input.received' AND json_type(${payload},'$.text')='text'
      AND EXISTS (SELECT 1 FROM runner_inputs i JOIN runner_consumptions c ON c.input_event_id=i.input_event_id AND c.task_id=i.task_id AND c.stage='installed'
        JOIN records installed ON installed.task_id=i.task_id AND installed.kind='runner.input.installed'
        WHERE i.task_id=r.task_id AND i.record_id=r.id AND i.kind='correction'
          AND installed.sequence<=@through
          AND json_extract(${safePayload('installed')},'$.input_event_id')=i.input_event_id
          AND json_extract(${safePayload('installed')},'$.route.route')='direct'
          AND json_extract(${safePayload('installed')},'$.route.kind')='correction'))
  OR (r.kind='message.assistant' AND json_type(${payload},'$.text')='text'
      AND json_type(${payload},'$.owner') IS NULL AND json_type(${payload},'$.routing_operation_id') IS NULL
      AND (json_extract(${payload},'$.model_config_id')='fixture' OR
        (json_type(${payload},'$.run_id') IS NULL AND json_type(${payload},'$.request_link') IS NULL) OR
        EXISTS (SELECT 1 FROM runs legacy WHERE legacy.task_id=r.task_id AND legacy.id=json_extract(${payload},'$.run_id')
          AND legacy.state='completed' AND NOT EXISTS (SELECT 1 FROM runner_runs managed WHERE managed.run_id=legacy.id)
          AND NOT EXISTS (SELECT 1 FROM records trace WHERE trace.task_id=r.task_id AND trace.sequence<=@through
            AND trace.kind='model.response' AND json_extract(${safePayload('trace')},'$.run_id')=legacy.id))))
  OR (r.kind='model.response' AND json_type(${payload},'$.owner') IS NULL
      AND json_type(${payload},'$.routing_operation_id') IS NULL
      AND json_extract(${payload},'$.finish')='stop'
      AND json_extract(${payload},'$.message.role')='assistant'
      AND json_type(${payload},'$.message.content')='text'
      AND COALESCE(json_array_length(${payload},'$.message.tool_calls'),0)=0
      AND EXISTS (SELECT 1 FROM runs legacy WHERE legacy.task_id=r.task_id AND legacy.id=json_extract(${payload},'$.run_id')
        AND NOT EXISTS (SELECT 1 FROM runner_runs managed WHERE managed.run_id=legacy.id)))
  OR (r.kind='conversation.reply' AND json_type(${payload},'$.text')='text'
      AND EXISTS (SELECT 1 FROM requests q JOIN runs run ON run.task_id=q.task_id AND run.request_id=q.id
        WHERE q.task_id=r.task_id AND q.id=json_extract(${payload},'$.request_id') AND run.id=json_extract(${payload},'$.run_id')
          AND json_extract(q.input_json,'$.conversation_run_id')=run.id AND run.state='completed'
          AND json_extract(q.input_json,'$.user_record_id')=json_extract(${payload},'$.reply_to')))`

function invalid(): never { throw new ContractError('CONVERSATION_INVALID', 'Conversation binding is invalid; original records are retained') }
function validSequence(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 }
function bindingValue(binding: ConversationBinding): void {
  if (!binding || binding.version !== 1 || !validSequence(binding.through_sequence)
    || binding.reply_to_request_id !== null && (typeof binding.reply_to_request_id !== 'string' || !binding.reply_to_request_id)
    || binding.resource_ids !== undefined && (!Array.isArray(binding.resource_ids) || binding.resource_ids.length > recordCount
      || binding.resource_ids.some(id => typeof id !== 'string' || !id) || new Set(binding.resource_ids).size !== binding.resource_ids.length)) invalid()
}
export function precedingDelivery(db: Database.Database, task: string, binding: ConversationBinding) {
  bindingValue(binding)
  if (!binding.reply_to_request_id) return undefined
  const row = db.prepare(`SELECT p.payload_json, json_extract(${payload},'$.state') AS state
    FROM records r JOIN runner_content_plans p ON p.task_id=r.task_id
      AND p.request_id=json_extract(${payload},'$.request_id') AND p.intent_revision=json_extract(${payload},'$.intent_revision')
    WHERE r.task_id=? AND p.request_id=? AND r.sequence<=? AND r.kind IN ('runner.delivery.opened','runner.delivery.settled')
    ORDER BY r.sequence DESC LIMIT 1`).get(task, binding.reply_to_request_id, binding.through_sequence) as { payload_json: string; state: string } | undefined
  if (!row) return undefined
  const { request_id, intent_revision, requirements } = JSON.parse(row.payload_json) as ContentPlan
  const required_outputs = [...new Set(requirements.filter(item => item.required && item.kind !== 'content_check').map(item => item.kind))]
  return { request_id, intent_revision, state: row.state, required_outputs }
}
function rows(db: Database.Database, task: string, through: number): ConversationRow[] {
  return db.prepare(`SELECT r.id,r.sequence,r.kind,length(CAST(r.payload_json AS BLOB)) AS bytes,
    CASE WHEN length(CAST(r.payload_json AS BLOB))<=${recordBytes} THEN r.payload_json END AS payload_json,
    COALESCE(json_extract(${payload},'$.request_id'),json_extract(${payload},'$.runner_input.request_id'),
      (SELECT request_id FROM runs WHERE task_id=r.task_id AND id=json_extract(${payload},'$.run_id'))) AS request_id
    FROM records r WHERE r.task_id=@task AND r.sequence<=@through AND (${conversationRecordKinds})
    ORDER BY r.sequence DESC LIMIT ${recordCount + 1}`).all({ task, through }) as ConversationRow[]
}
function originalMessage(row: ConversationRow, task: string): ChatMessage | null {
  if (row.payload_json === null) return null
  const value = JSON.parse(row.payload_json) as Record<string, any>
  if (row.kind === 'runner.answer') {
    let owner
    try { owner = captureExecutionScope(value.owner, task) } catch { return null }
    if (!owner || owner.purpose !== 'production' || owner.request_id !== value.request_id || value.run_id !== undefined && value.run_id !== owner.run_id) return null
    if (containsProducerResult(value.text)) return null
    return { role: 'assistant', content: value.text }
  }
  if (row.kind === 'model.response') return containsProducerResult(value.message.content) ? null : { role: 'assistant', content: value.message.content }
  if (row.kind === 'message.assistant' || row.kind === 'conversation.reply') return containsProducerResult(value.text) ? null : { role: 'assistant', content: value.text }
  return { role: 'user', content: JSON.stringify({ request: value.text, ...(value.materials ? { request_materials: value.materials } : {}),
    ...(value.resource_ids?.length ? { resource_ids: value.resource_ids } : {}), ...(value.import_ids?.length ? { import_ids: value.import_ids } : {}) }) }
}

// Freeze user-visible history at acceptance. Dispatch never discovers newer
// replies, later corrections, or material bindings through this snapshot.
export function captureConversation(db: Database.Database, task: string): ConversationBinding {
  return db.transaction(() => {
    const current = db.prepare("SELECT next_sequence FROM tasks WHERE id=? AND state!='deleting'").get(task) as { next_sequence: number } | undefined
    if (!current || !validSequence(current.next_sequence) || current.next_sequence < 1) invalid()
    const through = current.next_sequence - 1, history = rows(db, task, through).slice(0, recordCount)
    const resources = new Set<string>(), requests = new Set(history.map(row => row.request_id).filter((id): id is string => typeof id === 'string' && !!id))
    const associated = db.prepare('SELECT 1 FROM task_resources WHERE task_id=? AND resource_id=?')
    let bytes = 0
    for (const request of requests) {
      const row = db.prepare(`SELECT length(CAST(input_json AS BLOB)) AS bytes,CASE WHEN length(CAST(input_json AS BLOB))<=${recordBytes} THEN input_json END AS input_json FROM requests WHERE task_id=? AND id=?`).get(task, request) as { bytes: number; input_json: string | null } | undefined
      if (!row?.input_json || bytes + row.bytes > contextBytes) continue
      bytes += row.bytes
      let input: Record<string, any>
      try { input = JSON.parse(row.input_json) } catch { continue }
      if (!input || typeof input !== 'object' || Array.isArray(input)) continue
      const ids = [...(Array.isArray(input.resource_ids) ? input.resource_ids : []),
        ...(Array.isArray(input.bound_materials) ? input.bound_materials.map((item: any) => item?.id) : []),
        ...(Array.isArray(input.attachments) ? input.attachments.filter((item: any) => item?.kind === 'resource').map((item: any) => item.id) : [])]
      for (const id of ids) if (resources.size < recordCount && typeof id === 'string' && id && associated.get(task, id)) resources.add(id)
    }
    return { version: 1 as const, through_sequence: through, reply_to_request_id: history.find(row => row.request_id)?.request_id ?? null, resource_ids: [...resources] }
  })()
}

export function loadConversation(db: Database.Database, task: string, binding: ConversationBinding): ConversationHistory {
  bindingValue(binding)
  return db.transaction(() => {
    const history = rows(db, task, binding.through_sequence), messages: ConversationHistory['messages'] = [], refs: ConversationHistory['refs'] = []
    let loaded = 0, bytes = 0, navigation = 0, truncated = history.length > recordCount
    for (const row of history.slice(0, recordCount)) {
      if (!validSequence(row.sequence) || row.sequence < 1 || typeof row.id !== 'string') invalid()
      let message: ChatMessage | null = null
      if (messages.length < tailCount && row.payload_json !== null && loaded + row.bytes <= contextBytes) {
        loaded += row.bytes
        const original = originalMessage(row, task)
        if (original && bytes + Buffer.byteLength(JSON.stringify(original)) <= tailBytes) message = original
      }
      if (message) {
        bytes += Buffer.byteLength(JSON.stringify(message))
        messages.push({ source: { task_id: task, id: row.id, sequence: row.sequence, kind: row.kind }, message })
      } else {
        truncated = true
        const ref = { kind: 'event' as const, id: row.id }, size = Buffer.byteLength(JSON.stringify(ref))
        if (navigation + size <= navigationBytes) { refs.push(ref); navigation += size }
      }
    }
    const associated = db.prepare('SELECT 1 FROM task_resources WHERE task_id=? AND resource_id=?')
    const resource_ids = (binding.resource_ids ?? []).filter(id => !!associated.get(task, id))
    return { messages: messages.reverse(), refs: refs.reverse(), truncated: truncated || resource_ids.length !== (binding.resource_ids?.length ?? 0), resource_ids }
  })()
}
