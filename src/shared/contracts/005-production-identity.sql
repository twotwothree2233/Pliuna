-- Additive on existing v2 databases; historical IDs and results stay unchanged.
CREATE TABLE IF NOT EXISTS runner_artifact_slots (
 work_id TEXT NOT NULL REFERENCES runner_work(work_id),
 output_key TEXT NOT NULL,
 task_id TEXT NOT NULL REFERENCES tasks(id),
 artifact_id TEXT NOT NULL UNIQUE,
 PRIMARY KEY(work_id,output_key)
);
CREATE TABLE IF NOT EXISTS runner_production_submissions (
 response_record_id TEXT PRIMARY KEY REFERENCES records(id),
 task_id TEXT NOT NULL REFERENCES tasks(id),
 work_id TEXT NOT NULL REFERENCES runner_work(work_id),
 attempt_id TEXT NOT NULL REFERENCES runner_attempts(attempt_id),
 draft_json TEXT NOT NULL CHECK(json_valid(draft_json)),
 result_json TEXT NOT NULL CHECK(json_valid(result_json))
);
