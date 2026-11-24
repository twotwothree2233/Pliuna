-- Applied once, inside the business schema v1 -> v2 transaction.
-- Legacy rows keep their original attribution; runner metadata is opt-in.
DROP INDEX one_unfinished_run;
CREATE UNIQUE INDEX one_active_request_run ON runs(request_id)
 WHERE request_id IS NOT NULL AND state IN ('running','waiting');

CREATE TABLE runner_inputs (
 input_event_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
 record_id TEXT NOT NULL REFERENCES records(id), kind TEXT NOT NULL,
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), created_at TEXT NOT NULL
);
CREATE TABLE runner_consumptions (
 input_event_id TEXT NOT NULL REFERENCES runner_inputs(input_event_id),
 task_id TEXT NOT NULL REFERENCES tasks(id), stage TEXT NOT NULL CHECK(stage IN ('received','routed','installed')),
 result_json TEXT NOT NULL CHECK(json_valid(result_json)), installed_at TEXT NOT NULL,
 PRIMARY KEY(input_event_id,stage)
);
CREATE TABLE runner_content_plans (
 task_id TEXT NOT NULL REFERENCES tasks(id), request_id TEXT NOT NULL REFERENCES requests(id),
 intent_revision INTEGER NOT NULL CHECK(intent_revision>=1),
 input_event_id TEXT NOT NULL REFERENCES runner_inputs(input_event_id),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 PRIMARY KEY(request_id,intent_revision)
);
CREATE INDEX runner_content_plans_by_task ON runner_content_plans(task_id,request_id,intent_revision);
CREATE VIEW runner_current_content_plans AS
 SELECT (SELECT first.rowid FROM runner_content_plans first WHERE first.request_id=p.request_id ORDER BY first.intent_revision LIMIT 1) AS position,
        p.task_id,p.request_id,p.intent_revision,p.input_event_id,p.payload_json
 FROM runner_content_plans p WHERE NOT EXISTS (
   SELECT 1 FROM runner_content_plans n WHERE n.task_id=p.task_id AND n.request_id=p.request_id AND n.intent_revision>p.intent_revision
 );
CREATE TABLE runner_content_removals (
 task_id TEXT NOT NULL REFERENCES tasks(id), request_id TEXT NOT NULL,
 intent_revision INTEGER NOT NULL, message_id TEXT NOT NULL REFERENCES records(id),
 PRIMARY KEY(request_id,intent_revision),
 FOREIGN KEY(request_id,intent_revision) REFERENCES runner_content_plans(request_id,intent_revision)
);
CREATE TABLE runner_budgets (
 budget_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
 purpose TEXT NOT NULL CHECK(purpose IN ('production','composition')),
 request_id TEXT REFERENCES requests(id),
 limits_json TEXT NOT NULL CHECK(json_valid(limits_json)), created_at TEXT NOT NULL,
 CHECK((purpose='production' AND request_id IS NOT NULL) OR (purpose='composition' AND request_id IS NULL))
);
CREATE UNIQUE INDEX runner_production_budget ON runner_budgets(request_id) WHERE purpose='production';
CREATE TABLE runner_budget_reservations (
 reservation_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
 budget_id TEXT NOT NULL REFERENCES runner_budgets(budget_id), attempt_id TEXT,
 operation_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('reserved','settled','released','unknown')),
 reserved_json TEXT NOT NULL CHECK(json_valid(reserved_json)),
 usage_json TEXT CHECK(usage_json IS NULL OR json_valid(usage_json)),
 created_at TEXT NOT NULL, dispatched_at TEXT, settled_at TEXT,
 UNIQUE(budget_id,operation_id)
);
CREATE TABLE runner_runs (
 run_id TEXT PRIMARY KEY REFERENCES runs(id), task_id TEXT NOT NULL REFERENCES tasks(id),
 purpose TEXT NOT NULL CHECK(purpose IN ('production','composition')),
 request_id TEXT REFERENCES requests(id), intent_revision INTEGER,
 batch_id TEXT, composition_version INTEGER,
 budget_id TEXT NOT NULL REFERENCES runner_budgets(budget_id),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 CHECK((purpose='production' AND request_id IS NOT NULL AND intent_revision>=1 AND batch_id IS NULL AND composition_version IS NULL)
    OR (purpose='composition' AND request_id IS NULL AND intent_revision IS NULL AND batch_id IS NOT NULL AND composition_version>=1))
);
CREATE TABLE runner_work (
 work_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
 run_id TEXT NOT NULL REFERENCES runner_runs(run_id), plan_revision INTEGER NOT NULL CHECK(plan_revision>=1),
 state TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
);
CREATE TABLE runner_attempts (
 attempt_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
 work_id TEXT NOT NULL REFERENCES runner_work(work_id), run_id TEXT NOT NULL REFERENCES runner_runs(run_id),
 attempt_number INTEGER NOT NULL CHECK(attempt_number>=1), state TEXT NOT NULL,
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), UNIQUE(work_id,attempt_number)
);
CREATE TABLE runner_outlines (
 task_id TEXT NOT NULL REFERENCES tasks(id), outline_revision INTEGER NOT NULL CHECK(outline_revision>=1),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), PRIMARY KEY(task_id,outline_revision)
);
CREATE TABLE runner_artifact_owners (
 artifact_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
 work_id TEXT NOT NULL REFERENCES runner_work(work_id), plan_revision INTEGER NOT NULL CHECK(plan_revision>=1),
 section_id TEXT NOT NULL, current_revision INTEGER NOT NULL DEFAULT 0 CHECK(current_revision>=0)
);
CREATE TABLE runner_candidates (
 candidate_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
 artifact_id TEXT NOT NULL,
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 result_json TEXT NOT NULL CHECK(json_valid(result_json))
);
CREATE TABLE runner_artifacts (
 task_id TEXT NOT NULL REFERENCES tasks(id), artifact_id TEXT NOT NULL REFERENCES runner_artifact_owners(artifact_id),
 artifact_revision INTEGER NOT NULL CHECK(artifact_revision>=1),
 candidate_id TEXT NOT NULL UNIQUE REFERENCES runner_candidates(candidate_id),
 bundle_resource_id TEXT NOT NULL REFERENCES resources(id),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), PRIMARY KEY(artifact_id,artifact_revision)
);
CREATE TABLE runner_inventory_sources (
 task_id TEXT NOT NULL REFERENCES tasks(id), request_id TEXT NOT NULL REFERENCES requests(id),
 intent_revision INTEGER NOT NULL CHECK(intent_revision>=1),
 work_id TEXT NOT NULL REFERENCES runner_work(work_id), plan_revision INTEGER NOT NULL CHECK(plan_revision>=1),
 PRIMARY KEY(request_id,intent_revision),
 FOREIGN KEY(request_id,intent_revision) REFERENCES runner_content_plans(request_id,intent_revision)
);
CREATE TABLE runner_work_outputs (
 task_id TEXT NOT NULL REFERENCES tasks(id), request_id TEXT NOT NULL REFERENCES requests(id),
 intent_revision INTEGER NOT NULL CHECK(intent_revision>=1), work_id TEXT NOT NULL REFERENCES runner_work(work_id),
 plan_revision INTEGER NOT NULL CHECK(plan_revision>=1), result_revision INTEGER NOT NULL CHECK(result_revision>=1),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), PRIMARY KEY(work_id,plan_revision,result_revision),
 FOREIGN KEY(request_id,intent_revision) REFERENCES runner_content_plans(request_id,intent_revision)
);
CREATE TABLE runner_contribution_inventories (
 task_id TEXT NOT NULL REFERENCES tasks(id), request_id TEXT NOT NULL REFERENCES requests(id),
 intent_revision INTEGER NOT NULL CHECK(intent_revision>=1), inventory_revision INTEGER NOT NULL CHECK(inventory_revision>=1),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), PRIMARY KEY(request_id,intent_revision,inventory_revision),
 FOREIGN KEY(request_id,intent_revision) REFERENCES runner_content_plans(request_id,intent_revision)
);
CREATE TABLE runner_scopes (
 task_id TEXT NOT NULL REFERENCES tasks(id), composition_version INTEGER NOT NULL CHECK(composition_version>=1),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), PRIMARY KEY(task_id,composition_version)
);
CREATE TABLE runner_index_reads (
 read_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), branch_id TEXT NOT NULL
);
CREATE TABLE runner_index_read_items (
 read_id TEXT NOT NULL REFERENCES runner_index_reads(read_id) ON DELETE CASCADE, ordinal INTEGER NOT NULL,
 artifact_id TEXT NOT NULL, artifact_revision INTEGER NOT NULL,
 PRIMARY KEY(read_id,ordinal),
 FOREIGN KEY(artifact_id,artifact_revision) REFERENCES runner_artifacts(artifact_id,artifact_revision)
);
CREATE TABLE runner_index_cursors (
 cursor TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), branch_id TEXT NOT NULL,
 read_id TEXT NOT NULL REFERENCES runner_index_reads(read_id) ON DELETE CASCADE, next_offset INTEGER NOT NULL
);
CREATE TABLE runner_batches (
 batch_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), composition_version INTEGER NOT NULL,
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 FOREIGN KEY(task_id,composition_version) REFERENCES runner_scopes(task_id,composition_version)
);
CREATE TABLE runner_publications (
 operation_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
 batch_id TEXT NOT NULL UNIQUE REFERENCES runner_batches(batch_id), action_id TEXT REFERENCES actions(id),
 state TEXT NOT NULL CHECK(state IN ('registered','prepared','published','failure','cancelled','unknown')),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json))
);
CREATE TABLE runner_surface_history (
 surface_history_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), surface_id TEXT NOT NULL,
 surface_revision INTEGER NOT NULL CHECK(surface_revision>=1), action_id TEXT NOT NULL REFERENCES actions(id),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), UNIQUE(surface_id,surface_revision)
);
CREATE TABLE runner_manifests (
 manifest_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), composition_version INTEGER NOT NULL,
 operation_id TEXT NOT NULL REFERENCES runner_publications(operation_id),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 FOREIGN KEY(task_id,composition_version) REFERENCES runner_scopes(task_id,composition_version)
);
CREATE TABLE runner_view_mappings (
 task_id TEXT NOT NULL REFERENCES tasks(id), artifact_id TEXT NOT NULL,
 artifact_revision INTEGER NOT NULL, batch_id TEXT NOT NULL REFERENCES runner_batches(batch_id),
 view_id TEXT NOT NULL, view_revision INTEGER NOT NULL CHECK(view_revision>=1),
 source_bundle_resource_id TEXT NOT NULL REFERENCES resources(id), published_bundle_resource_id TEXT NOT NULL REFERENCES resources(id),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), PRIMARY KEY(artifact_id,artifact_revision,batch_id),
 FOREIGN KEY(artifact_id,artifact_revision) REFERENCES runner_artifacts(artifact_id,artifact_revision)
);
CREATE TABLE runner_deliveries (
 delivery_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
 request_id TEXT REFERENCES requests(id), purpose TEXT NOT NULL CHECK(purpose IN ('final_answer','progress','diagnostic','composition')),
 record_id TEXT NOT NULL REFERENCES records(id), payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
);
CREATE INDEX runner_work_by_task ON runner_work(task_id,state);
CREATE INDEX runner_inputs_by_task ON runner_inputs(task_id);
CREATE INDEX runner_delivery_by_purpose ON runner_deliveries(task_id,purpose,request_id);
