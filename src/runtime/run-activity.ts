import type Database from 'better-sqlite3'
import type { RunActivity } from '../shared/types'

type Item = RunActivity['items'][number] & { sequence: number; position: number; created_at: string }

// Project only status metadata. Tool arguments, results and reply bodies stay in their original records.
export function runActivity(db: Database.Database, task: string, run: string): RunActivity {
  const request = db.prepare("SELECT substr(json_extract(payload_json,'$.text'),1,121) text FROM records WHERE task_id=? AND kind='message.user' AND json_extract(payload_json,'$.run_id')=? ORDER BY sequence DESC LIMIT 1").get(task, run) as { text: string } | undefined
  const items = db.prepare(`
    WITH requests AS MATERIALIZED (
      SELECT r.id,r.sequence,r.created_at,CAST(c.key AS INTEGER) position,
        json_extract(c.value,'$.id') call_id,
        substr(json_extract(c.value,'$.function.name'),1,80) name,
        CASE WHEN json_valid(json_extract(c.value,'$.function.arguments')) THEN json_extract(c.value,'$.function.arguments') ELSE '{}' END args
      FROM records r,json_each(r.payload_json,'$.message.tool_calls') c
      WHERE r.task_id=? AND r.kind='model.response' AND json_extract(r.payload_json,'$.run_id')=?
      ORDER BY r.sequence DESC,position DESC LIMIT 3
    ), paired AS MATERIALIZED (
      SELECT q.*,(SELECT CASE WHEN json_valid(json_extract(s.payload_json,'$.message.content')) THEN json_extract(s.payload_json,'$.message.content') ELSE '{}' END
        FROM records s WHERE s.task_id=? AND s.kind='model.tool_result' AND s.sequence>q.sequence
          AND json_extract(s.payload_json,'$.run_id')=? AND json_extract(s.payload_json,'$.message.tool_call_id')=q.call_id
        ORDER BY s.sequence LIMIT 1) result
      FROM requests q
    ), details AS MATERIALIZED (
      SELECT p.*,CASE WHEN json_valid(json_extract(args,'$.input_json')) THEN json_extract(args,'$.input_json') ELSE '{}' END input
      FROM paired p
    )
    SELECT id||':'||position id,'tool' type,sequence,position,created_at,name,
      substr(json_extract(args,'$.operation'),1,80) operation,
      substr(json_extract(args,'$.kind'),1,80) target_kind,
      substr(coalesce(json_extract(args,'$.id'),json_extract(args,'$.capability'),json_extract(input,'$.id'),json_extract(result,'$.data.id'),json_extract(result,'$.data.resource.id')),1,120) target_id,
      substr(coalesce(json_extract(result,'$.data.metadata.display_name'),json_extract(result,'$.data.data.display_name'),json_extract(input,'$.display_name')),1,120) label,
      substr(json_extract(result,'$.execution'),1,32) execution,
      substr(json_extract(result,'$.delivery'),1,32) delivery,
      substr(json_extract(result,'$.error.code'),1,80) error
    FROM details
  `).all(task, run, task, run) as Item[]

  // The local development fixture predates model.response records. Keep its actual host operations visible.
  if (!items.length) {
    items.push(...db.prepare(`
      SELECT id,'tool' type,0 sequence,rowid position,created_at,'write' name,
        substr(coalesce(json_extract(request_json,'$.input.type'),json_extract(request_json,'$.type')),1,80) operation,NULL target_kind,
        substr(coalesce(json_extract(request_json,'$.input.id'),json_extract(request_json,'$.id')),1,120) target_id,NULL label,
        CASE WHEN state='ended' THEN result END execution,NULL delivery,
        substr(json_extract(result_json,'$.code'),1,80) error
      FROM actions WHERE task_id=? AND run_id=? ORDER BY rowid DESC LIMIT 3
    `).all(task, run) as Item[])
  }
  const reply = db.prepare("SELECT id,sequence,created_at,kind FROM records WHERE task_id=? AND kind IN ('message.assistant','message.assistant.partial') AND json_extract(payload_json,'$.run_id')=? ORDER BY sequence DESC LIMIT 1").get(task, run) as { id: string; sequence: number; created_at: string; kind: string } | undefined
  if (reply) items.push({ id: reply.id, sequence: reply.sequence, created_at: reply.created_at, position: 0, type: 'reply', name: 'reply', operation: null, target_kind: null, target_id: null, label: null, execution: reply.kind === 'message.assistant.partial' ? 'partial' : 'success', delivery: null, error: null })
  const recent = items.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.sequence - b.sequence || a.position - b.position).slice(-3)
  const text = request?.text
  return {
    request: text ? (Array.from(text).length > 120 ? Array.from(text).slice(0, 120).join('') + '…' : text) : null,
    items: recent.map(({ sequence, position, created_at, ...item }) => item)
  }
}
