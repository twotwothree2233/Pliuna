import type Database from 'better-sqlite3'

export type RequestDelivery = {
  request_id: string
  intent_revision: number
  input_event_id: string
} & ({ state: 'open' } | { state: 'complete' | 'incomplete'; missing_requirement_ids: string[] })

export function requestDelivery(db: Database.Database, task: string, request: string, revision?: number): RequestDelivery | null {
  const row = db.prepare(`SELECT r.payload_json FROM records r WHERE r.task_id=? AND r.kind IN ('runner.delivery.opened','runner.delivery.settled')
    AND json_extract(r.payload_json,'$.request_id')=? AND json_extract(r.payload_json,'$.intent_revision')=COALESCE(?,(
      SELECT intent_revision FROM runner_current_content_plans WHERE task_id=r.task_id AND request_id=json_extract(r.payload_json,'$.request_id')))
    ORDER BY r.sequence DESC LIMIT 1`).get(task, request, revision ?? null) as { payload_json: string } | undefined
  return row ? JSON.parse(row.payload_json) as RequestDelivery : null
}

export function deliveryHasUnsettledExecution(db: Database.Database, task: string, request: string, revision: number): boolean {
  return !!db.prepare(`WITH related AS (
      SELECT n.run_id FROM runner_runs n WHERE n.task_id=@task AND n.request_id=@request AND n.intent_revision=@revision AND n.purpose='production'
      UNION
      SELECT json_extract(b.payload_json,'$.run_id') FROM runner_batches b,json_each(b.payload_json,'$.indexes') i
      JOIN runner_artifacts a ON a.task_id=b.task_id AND a.artifact_id=json_extract(i.value,'$.artifact_id') AND a.artifact_revision=json_extract(i.value,'$.artifact_revision')
      WHERE b.task_id=@task AND json_extract(a.payload_json,'$.request_id')=@request AND json_extract(a.payload_json,'$.intent_revision')=@revision
      UNION
      SELECT json_extract(b.payload_json,'$.run_id') FROM runner_batches b,json_each(b.payload_json,'$.targets') t
      WHERE b.task_id=@task AND json_array_length(b.payload_json,'$.indexes')=0
        AND json_extract(t.value,'$.request_id')=@request AND json_extract(t.value,'$.intent_revision')=@revision
    ) SELECT 1 WHERE EXISTS (SELECT 1 FROM related l JOIN runs r ON r.task_id=@task AND r.id=l.run_id WHERE r.state IN ('running','waiting','closing'))
      OR EXISTS (SELECT 1 FROM related l JOIN calls c ON c.task_id=@task AND c.run_id=l.run_id WHERE c.state!='ended' OR c.execution='unknown')
      OR EXISTS (SELECT 1 FROM related l JOIN runner_attempts a ON a.task_id=@task AND a.run_id=l.run_id WHERE a.state='unknown' OR json_extract(a.payload_json,'$.dispatch_state')='unknown')
      OR EXISTS (SELECT 1 FROM related l JOIN runner_batches b ON b.task_id=@task AND json_extract(b.payload_json,'$.run_id')=l.run_id
         JOIN runner_publications p ON p.task_id=b.task_id AND p.batch_id=b.batch_id WHERE p.state='unknown')`).get({ task, request, revision })
}
