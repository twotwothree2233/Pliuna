CREATE INDEX IF NOT EXISTS runner_work_by_run ON runner_work(task_id,run_id);
CREATE INDEX IF NOT EXISTS runner_runs_by_goal ON runner_runs(task_id,request_id,intent_revision,purpose);
CREATE INDEX IF NOT EXISTS runner_batches_by_task ON runner_batches(task_id);
CREATE INDEX IF NOT EXISTS records_run_accounting ON records(task_id,json_extract(payload_json,'$.run_id'),sequence)
 WHERE kind='model.request.accounting' AND json_valid(payload_json);
CREATE UNIQUE INDEX IF NOT EXISTS records_material_removal ON records(task_id,json_extract(payload_json,'$.resource_id'))
 WHERE kind='material.removed';
