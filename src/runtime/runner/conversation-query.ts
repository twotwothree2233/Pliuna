import type Database from 'better-sqlite3'
import type { MessageRequestState, Run, TaskMessage, TaskMessagePage, TaskMessageText } from '../../shared/types'
import { ContractError } from '../../shared/validation'
import { conversationRecordKinds } from './conversation'
import { runnerFailureReason } from './failure-reason'

interface Cursors { read(binding: string, cursor: string): unknown; write(binding: string, value: unknown): string }
export interface BoundConversationDependency { message_id: string; request_id: string; result_id: string }
const pageBytes = 48 * 1024, pageItems = 24, previewBytes = 1024, chunkBytes = 8192
const payload = `CASE WHEN json_valid(r.payload_json) THEN r.payload_json ELSE '{}' END`
const field = (key: string) => `json_extract(${payload},'$.${key}')`
const text = `CAST(CASE r.kind WHEN 'model.response' THEN ${field('message.content')} ELSE ${field('text')} END AS BLOB)`
const user = "r.kind IN ('message.user','runner.input.received')"
const productionReceipt = `EXISTS (SELECT 1 FROM runner_work_outputs o
  JOIN runner_work w ON w.task_id=o.task_id AND w.work_id=o.work_id
  JOIN records result ON result.task_id=o.task_id AND result.id=json_extract(o.payload_json,'$.result_ref.id')
  WHERE o.task_id=r.task_id AND o.work_id=${field('owner.work_id')} AND o.request_id=${field('request_id')}
  AND o.intent_revision=${field('intent_revision')} AND json_extract(w.payload_json,'$.role')=${field('owner.role')}
  AND json_extract(o.payload_json,'$.run_id')=${field('run_id')} AND json_extract(o.payload_json,'$.attempt_id')=${field('owner.attempt_id')}
  AND result.id=${field('result_ref.id')} AND result.kind='worker.result' AND result.sequence<r.sequence
  AND json_extract(result.payload_json,'$.value.answer')=${field('text')})`
const publicationReceipt = `EXISTS (SELECT 1 FROM runner_chapter_publications p
  JOIN runner_chapter_updates u ON u.task_id=p.task_id AND u.update_id=p.update_id
  JOIN actions a ON a.task_id=p.task_id AND a.id=json_extract(p.result_json,'$.action_id')
  WHERE p.task_id=r.task_id AND p.operation_id=${field('operation_id')} AND p.state='published'
  AND p.update_id=${field('update_id')} AND u.input_event_id=${field('input_event_id')}
  AND a.run_id=${field('run_id')} AND json_extract(a.source_json,'$.owner.attempt_id')=${field('owner.attempt_id')})`
const visible = `(${conversationRecordKinds} OR (json_type(${payload},'$.text')='text' AND (
  r.kind IN ('chapter.route.clarification','conversation.delivery') OR (r.kind='message.assistant.partial'
    AND json_type(${payload},'$.owner') IS NULL AND json_type(${payload},'$.routing_operation_id') IS NULL))))
  AND (r.kind!='runner.answer' OR (${productionReceipt} OR ${publicationReceipt}))`
const run = `(SELECT id FROM runs WHERE task_id=r.task_id AND id=${field('run_id')})`
const request = `COALESCE(${field('request_id')},${field('runner_input.request_id')},(SELECT request_id FROM runs WHERE task_id=r.task_id AND id=${run}))`
const originalInput = `(SELECT i.record_id FROM runner_inputs i JOIN runner_content_plans g
  ON g.task_id=i.task_id AND g.input_event_id=i.input_event_id WHERE i.task_id=r.task_id
  AND i.input_event_id=${field('input_event_id')} AND g.request_id=${request} AND g.intent_revision=${field('intent_revision')})`
const chapterInput = `(SELECT COALESCE(json_extract(origin.payload_json,'$.source_record_id'),origin.id)
  FROM runner_chapter_updates u JOIN records origin ON origin.task_id=u.task_id AND origin.id=json_extract(u.payload_json,'$.record_id')
  WHERE u.task_id=r.task_id AND u.update_id=${field('update_id')} AND u.input_event_id=${field('input_event_id')})`
const queuedInput = `(SELECT json_extract(q.input_json,'$.user_record_id') FROM requests q WHERE q.task_id=r.task_id AND q.id=${request})`
// Chapter Runs retain the request of the published content. Their initiating
// message comes from the specific update, not from that earlier request.
export function runMessage(runAlias: string): string {
  return `COALESCE((SELECT json_extract(rr.payload_json,'$.message_id') FROM runner_runs rr WHERE rr.task_id=${runAlias}.task_id AND rr.run_id=${runAlias}.id),
    (SELECT COALESCE(json_extract(origin.payload_json,'$.source_record_id'),origin.id)
    FROM runner_chapter_updates u JOIN records origin ON origin.task_id=u.task_id AND origin.id=json_extract(u.payload_json,'$.record_id')
    WHERE u.task_id=${runAlias}.task_id AND u.update_id=${runAlias}.chapter_update_id),
    (SELECT COALESCE(json_extract(q.input_json,'$.user_record_id'),
      (SELECT r.id FROM records r WHERE r.task_id=q.task_id AND r.kind='message.user' AND json_extract(r.payload_json,'$.request_id')=q.id ORDER BY r.sequence LIMIT 1))
      FROM requests q WHERE q.task_id=${runAlias}.task_id AND q.id=${runAlias}.request_id))`
}

export function approvalMessages(db: Database.Database, task: string, run: string): string[] {
  // A shared publication is attributable to its exact required contributions.
  const rows = db.prepare(`SELECT DISTINCT i.record_id AS id FROM runner_runs rr
    JOIN runner_batches b ON b.task_id=rr.task_id AND b.batch_id=rr.batch_id
    JOIN json_each(b.payload_json,'$.indexes') t
    JOIN runner_artifacts a ON a.task_id=b.task_id AND a.artifact_id=json_extract(t.value,'$.artifact_id')
      AND a.artifact_revision=json_extract(t.value,'$.artifact_revision')
    JOIN runner_content_plans g ON g.task_id=a.task_id AND g.request_id=json_extract(a.payload_json,'$.request_id')
      AND g.intent_revision=json_extract(a.payload_json,'$.intent_revision')
    JOIN runner_inputs i ON i.task_id=g.task_id AND i.input_event_id=g.input_event_id
    WHERE rr.task_id=? AND rr.run_id=? AND rr.purpose='composition' ORDER BY i.rowid LIMIT 64`).all(task, run) as { id: string }[]
  if (rows.length) return rows.map(row => row.id)
  const direct = db.prepare(`SELECT ${runMessage('c')} AS id FROM runs c WHERE c.task_id=? AND c.id=?`).get(task, run) as { id: string | null } | undefined
  return direct?.id ? [direct.id] : []
}
const replyTo = `CASE WHEN NOT (${user}) THEN (SELECT origin.id FROM records origin
  WHERE origin.task_id=r.task_id AND origin.sequence<r.sequence AND origin.kind IN ('message.user','runner.input.received')
  AND origin.id=CASE WHEN r.kind='runner.answer' THEN COALESCE(${chapterInput},${originalInput})
  ELSE COALESCE(${field('reply_to')},${queuedInput},(SELECT CASE WHEN count(*)=1 THEN min(u.id) END FROM records u
    WHERE u.task_id=r.task_id AND u.sequence<r.sequence AND u.kind='message.user' AND json_extract(u.payload_json,'$.run_id')=${run})) END) END`
const fail = (code: string, message: string): never => { throw new ContractError(code, message) }
const sequence = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

// An incomplete UTF-8 suffix belongs to the next chunk. SQLite returns bytes,
// so neither embedded nulls nor supplementary characters can change offsets.
function decode(bytes: Buffer, more: boolean): { text: string; size: number } {
  let size = bytes.length
  if (more) {
    let i = size - 1
    while (i >= 0 && (bytes[i]! & 0xc0) === 0x80) i--
    const first = bytes[i]!, width = first < 0x80 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4
    if (size - i < width) size = i
  }
  return { text: bytes.toString('utf8', 0, size), size }
}

function lastSequence(db: Database.Database, task: string): number {
  const row = db.prepare("SELECT next_sequence-1 AS through FROM tasks WHERE id=? AND state!='deleting'").get(task) as { through: number } | undefined
  return row?.through ?? fail('NOT_FOUND', 'Task is unavailable')
}

export function runConversationReply(db: Database.Database, task: string, runId: string) {
  return db.prepare(`SELECT r.id,r.sequence,r.created_at,r.kind FROM records r
    WHERE r.task_id=@task AND r.sequence<=@through AND ${field('run_id')}=@runId
    AND NOT (${user}) AND ${visible} ORDER BY r.sequence DESC LIMIT 1`)
    .get({ task, runId, through: lastSequence(db, task) }) as
    { id: string; sequence: number; created_at: string; kind: string } | undefined
}

export function conversationReference(db: Database.Database, task: string, id: string, through: number) {
  return db.prepare(`SELECT r.id,r.kind,${request} AS request_id FROM records r
    WHERE r.task_id=@task AND r.id=@id AND r.sequence<=@through AND ${visible}`).get({ task, id, through }) as
    { id: string; kind: string; request_id: string | null } | undefined
}

export function conversationDependencyResult(db: Database.Database, task: string, id: string, requestId: string) {
  const through = lastSequence(db, task)
  const row = db.prepare(`SELECT r.id,r.sequence,r.kind,COALESCE(substr(${text},1,${16 * 1024}),X'') AS body,length(${text}) AS bytes FROM records r
    WHERE r.task_id=@task AND r.sequence<=@through AND ${request}=@requestId
    AND NOT (${user}) AND r.kind!='chapter.route.clarification' AND ${visible} AND ${replyTo}=@id ORDER BY r.sequence LIMIT 1`)
    .get({ task, id, requestId, through }) as { id: string; sequence: number; kind: string; body: Buffer; bytes: number } | undefined
  if (!row) return null
  return { id: row.id, kind: row.kind, sequence: row.sequence, text: row.body.length === row.bytes ? row.body.toString('utf8') : null }
}

export function conversationPage(db: Database.Database, task: string, cursors: Cursors, before?: string, after?: string): TaskMessagePage {
  return db.transaction(() => {
    const latest = lastSequence(db, task)
    const olderKey = JSON.stringify(['messages-before', task]), updateKey = JSON.stringify(['messages-after', task])
    let through = latest, low = 0, high = latest
    if (before !== undefined) {
      const position = cursors.read(olderKey, before)
      if (!Array.isArray(position) || position.length !== 2 || !sequence(position[0]) || !sequence(position[1]) || position[0] > latest || position[1] > position[0]) fail('INVALID_CURSOR', 'Invalid history cursor')
      const [top, edge] = position as [number, number]
      through = top; high = edge - 1
    }
    if (after !== undefined) {
      const position = cursors.read(updateKey, after)
      if (!sequence(position) || position > latest) return fail('INVALID_CURSOR', 'Invalid message update cursor')
      low = position
    }
    const forward = after !== undefined
    type Row = Omit<TaskMessage, 'text' | 'truncated'> & { preview: Buffer; bytes: number }
    const rows = db.prepare(`SELECT r.id,r.sequence,r.created_at,r.kind,CASE WHEN ${user} THEN 'user' ELSE 'assistant' END AS role,
      ${request} AS request_id,${run} AS run_id,${replyTo} AS reply_to,COALESCE(substr(${text},1,${previewBytes}),X'') AS preview,length(${text}) AS bytes
      FROM records r WHERE r.task_id=@task AND r.sequence>@low AND r.sequence<=@high AND ${visible}
      ORDER BY r.sequence ${forward ? 'ASC' : 'DESC'} LIMIT ${pageItems + 1}`).all({ task, low, high, through }) as Row[]
    const items: TaskMessage[] = []
    const executions = db.prepare(`SELECT c.id,c.state,c.primary_reason,c.wait_reason FROM runs c WHERE c.task_id=@task AND (
      (@run IS NOT NULL AND c.id=@run) OR (@role='user' AND (${runMessage('c')})=@message
      AND (c.request_id=@request OR c.chapter_update_id IS NOT NULL))) ORDER BY c.rowid DESC LIMIT 1`)
    const requestState = db.prepare("SELECT id,state,json_extract(input_json,'$.code') AS code FROM requests WHERE task_id=? AND id=?")
    let bytes = 0
    for (const { preview, bytes: fullSize, ...row } of rows.slice(0, pageItems)) {
      const truncated = fullSize > preview.length
      const execution = executions.get({ task, run: row.run_id, role: row.role, message: row.id, request: row.request_id }) as Run | undefined
      if (execution?.state === 'failed') execution.primary_reason = runnerFailureReason(db, task, execution.id, execution.primary_reason)
      const request_state = row.role === 'user' && row.request_id ? requestState.get(task, row.request_id) as MessageRequestState | undefined : undefined
      const item = { ...row, text: decode(preview, truncated).text, truncated, ...(execution ? { execution } : {}), ...(request_state ? { request_state } : {}) }
      const size = Buffer.byteLength(JSON.stringify(item))
      if (items.length && bytes + size > pageBytes) break
      bytes += size; items.push(item)
    }
    const edge = items.at(-1)?.sequence, more = edge !== undefined && rows.length > items.length
    return { items: forward ? items : items.reverse(),
      older_cursor: !forward && more ? cursors.write(olderKey, [through, edge]) : null,
      update_cursor: cursors.write(updateKey, forward && more ? edge : through), more_updates: forward && more }
  })()
}

export function conversationText(db: Database.Database, task: string, id: string, cursors: Cursors, cursor?: string): TaskMessageText {
  return db.transaction(() => {
    const key = JSON.stringify(['message-text', task, id]), through = lastSequence(db, task)
    const offset = cursor === undefined ? 0 : cursors.read(key, cursor)
    if (!sequence(offset)) return fail('INVALID_CURSOR', 'Invalid message text cursor')
    const row = db.prepare(`SELECT COALESCE(substr(${text},@start,${chunkBytes}),X'') AS part,length(${text}) AS bytes FROM records r
      WHERE r.task_id=@task AND r.id=@id AND r.sequence<=@through AND ${visible}`)
      .get({ task, id, through, start: offset + 1 }) as { part: Buffer; bytes: number } | undefined
    if (!row) return fail('NOT_FOUND', 'Message is unavailable within this task')
    const part = decode(row.part, offset + row.part.length < row.bytes), next = offset + part.size
    return { text: part.text, next_cursor: next < row.bytes ? cursors.write(key, next) : null }
  })()
}
