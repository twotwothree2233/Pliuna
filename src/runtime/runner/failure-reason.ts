import type Database from 'better-sqlite3'

// A Run reason must come from a required work's causal attempt, not its latest event.
export function runnerFailureReason(db: Database.Database, taskId: string, runId: string, primaryReason: string | null): string | null {
  if (primaryReason !== null && primaryReason !== 'required_work_settled') return primaryReason
  const row = db.prepare(`SELECT json_extract(ended.payload_json,'$.code') code
    FROM runner_work failed
    JOIN runner_work source ON source.task_id=failed.task_id AND source.run_id=failed.run_id
      AND source.work_id=json_extract(failed.payload_json,'$.root_cause.work_id')
    JOIN runner_attempts attempt ON attempt.task_id=source.task_id AND attempt.run_id=source.run_id
      AND attempt.work_id=source.work_id AND attempt.attempt_id=json_extract(failed.payload_json,'$.root_cause.attempt_id')
    JOIN records ended ON ended.task_id=attempt.task_id AND ended.kind='worker.ended'
      AND json_extract(ended.payload_json,'$.owner.attempt_id')=attempt.attempt_id
    WHERE failed.task_id=? AND failed.run_id=? AND failed.state IN ('failed','dependency_failed')
      AND json_extract(failed.payload_json,'$.required')=1
      AND json_extract(failed.payload_json,'$.root_cause.kind')='failure'
      AND json_extract(source.payload_json,'$.role')!='diagnostic' AND attempt.state='failed'
      AND json_extract(ended.payload_json,'$.state')='failed'
      AND json_extract(ended.payload_json,'$.run_id')=attempt.run_id
      AND json_extract(ended.payload_json,'$.owner.task_id')=attempt.task_id
      AND json_extract(ended.payload_json,'$.owner.run_id')=attempt.run_id
      AND json_extract(ended.payload_json,'$.owner.work_id')=attempt.work_id
      AND json_extract(ended.payload_json,'$.owner.role')=json_extract(source.payload_json,'$.role')
      AND json_extract(ended.payload_json,'$.owner.purpose')=json_extract(attempt.payload_json,'$.purpose')
      AND json_extract(ended.payload_json,'$.owner.request_id') IS json_extract(attempt.payload_json,'$.request_id')
      AND json_extract(ended.payload_json,'$.owner.intent_revision') IS json_extract(attempt.payload_json,'$.intent_revision')
      AND json_extract(ended.payload_json,'$.owner.batch_id') IS json_extract(attempt.payload_json,'$.batch_id')
      AND json_extract(ended.payload_json,'$.owner.composition_version') IS json_extract(attempt.payload_json,'$.composition_version')
      AND json_extract(ended.payload_json,'$.owner.trigger_request_id') IS json_extract(attempt.payload_json,'$.trigger_request_id')
      AND json_type(ended.payload_json,'$.code')='text'
      AND length(json_extract(ended.payload_json,'$.code')) BETWEEN 1 AND 128
      AND instr(json_extract(ended.payload_json,'$.code'),char(0))=0
      AND json_extract(ended.payload_json,'$.code') NOT GLOB '*[^A-Za-z0-9_.:-]*'
    ORDER BY ended.sequence LIMIT 1`).get(taskId, runId) as { code: string } | undefined
  return row?.code ?? primaryReason
}
