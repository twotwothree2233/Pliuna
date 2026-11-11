-- Core contract draft: run only in a disposable database until implemented.
PRAGMA foreign_keys = ON;
CREATE TABLE schema_version(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
INSERT INTO schema_version VALUES (1, 'draft-not-applied');
CREATE TABLE tasks (
 id TEXT PRIMARY KEY, title TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('active','stopping','stopped','deleting')),
 revision INTEGER NOT NULL CHECK(revision >= 1), next_sequence INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE requests (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
 state TEXT NOT NULL CHECK(state IN ('queued','confirmation_required','started','cancelled','rejected')),
 config_selection_json TEXT NOT NULL, input_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE runs (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), request_id TEXT REFERENCES requests(id),
 state TEXT NOT NULL CHECK(state IN ('running','waiting','completed','failed','cancelled','interrupted')),
 wait_reason TEXT, intended_terminal TEXT, primary_reason TEXT,
 commit_valid INTEGER NOT NULL DEFAULT 1 CHECK(commit_valid IN (0,1)),
 runtime_epoch TEXT NOT NULL, limits_json TEXT NOT NULL, budget_json TEXT NOT NULL,
 created_at TEXT NOT NULL, ended_at TEXT
);
CREATE UNIQUE INDEX one_unfinished_run ON runs(task_id) WHERE state IN ('running','waiting');
CREATE TABLE calls (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT REFERENCES runs(id),
 parent_call_id TEXT REFERENCES calls(id), instance_id TEXT, capability_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('registered','waiting','executing','finalizing','ended')),
 wait_reason TEXT, dispatch TEXT NOT NULL CHECK(dispatch IN ('not_sent','sent','unknown')),
 execution TEXT CHECK(execution IN ('not_executed','success','partial','failure','cancelled','unknown')),
 delivery TEXT NOT NULL CHECK(delivery IN ('not_applicable','pending','delivered','failed')),
 input_json TEXT NOT NULL, result_json TEXT, limits_json TEXT NOT NULL,
 commit_valid INTEGER NOT NULL CHECK(commit_valid IN (0,1)), created_at TEXT NOT NULL, ended_at TEXT
);
CREATE TABLE actions (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT REFERENCES runs(id),
 call_id TEXT REFERENCES calls(id), kind TEXT NOT NULL CHECK(kind IN ('mutation','invocation')),
 state TEXT NOT NULL CHECK(state IN ('registered','waiting','executing','ended')),
 wait_reason TEXT, result TEXT CHECK(result IN ('success','not_executed','failure','cancelled','unknown')),
 source_json TEXT NOT NULL, request_json TEXT NOT NULL, authorization_json TEXT,
 commit_valid INTEGER NOT NULL CHECK(commit_valid IN (0,1)), result_json TEXT,
 created_at TEXT NOT NULL, ended_at TEXT
);
CREATE TABLE approvals (
 id TEXT PRIMARY KEY, action_id TEXT NOT NULL UNIQUE REFERENCES actions(id),
 decision TEXT NOT NULL CHECK(decision IN ('pending','approve','deny')),
 validity TEXT NOT NULL CHECK(validity IN ('valid','expired','revoked')),
 mode TEXT NOT NULL CHECK(mode IN ('manual','assisted')),
 handling TEXT NOT NULL CHECK(handling IN ('evaluating','awaiting_human','resolved')),
 expires_at TEXT NOT NULL, evaluation_json TEXT, binding_json TEXT NOT NULL
);
CREATE TABLE records (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), sequence INTEGER NOT NULL,
 kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(task_id,sequence)
);
CREATE TABLE resources (
 id TEXT PRIMARY KEY, storage_key TEXT NOT NULL, sha256 TEXT NOT NULL, byte_length INTEGER NOT NULL CHECK(byte_length>=0),
 media_type TEXT NOT NULL, display_name TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE task_resources (
 task_id TEXT NOT NULL REFERENCES tasks(id), resource_id TEXT NOT NULL REFERENCES resources(id),
 PRIMARY KEY(task_id,resource_id)
);
CREATE TABLE task_data (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), revision INTEGER NOT NULL CHECK(revision>=1),
 schema_json TEXT NOT NULL, value_json TEXT NOT NULL, references_json TEXT NOT NULL,
 creator_run_id TEXT REFERENCES runs(id), auto_edit_valid INTEGER NOT NULL DEFAULT 0 CHECK(auto_edit_valid IN (0,1))
);
CREATE TABLE surfaces (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id), revision INTEGER NOT NULL CHECK(revision>=1), layout_json TEXT NOT NULL
);
CREATE TABLE views (
 id TEXT PRIMARY KEY, surface_id TEXT NOT NULL REFERENCES surfaces(id), revision INTEGER NOT NULL CHECK(revision>=1),
 bundle_resource_id TEXT NOT NULL REFERENCES resources(id), state_revision INTEGER NOT NULL CHECK(state_revision>=1),
 draft_json TEXT NOT NULL, compatibility_version TEXT NOT NULL,
 creator_run_id TEXT REFERENCES runs(id), auto_edit_valid INTEGER NOT NULL DEFAULT 0 CHECK(auto_edit_valid IN (0,1))
);
CREATE TABLE view_history (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), view_id TEXT NOT NULL,
 view_revision INTEGER NOT NULL, bundle_resource_id TEXT NOT NULL REFERENCES resources(id),
 evidence_snapshot_json TEXT NOT NULL, UNIQUE(view_id,view_revision)
);
CREATE TABLE answers (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), view_history_id TEXT NOT NULL REFERENCES view_history(id),
 form_id TEXT NOT NULL, raw_json TEXT NOT NULL, value_json TEXT NOT NULL,
 event_id TEXT NOT NULL UNIQUE REFERENCES records(id), created_at TEXT NOT NULL
);
CREATE TABLE object_references (
 task_id TEXT NOT NULL REFERENCES tasks(id), source_kind TEXT NOT NULL, source_id TEXT NOT NULL, name TEXT NOT NULL,
 target_kind TEXT NOT NULL, target_id TEXT NOT NULL, expected_revision INTEGER,
 protects_resource INTEGER NOT NULL CHECK(protects_resource IN (0,1)),
 blocks_remove INTEGER NOT NULL CHECK(blocks_remove IN (0,1)),
 PRIMARY KEY(source_kind,source_id,name)
);
CREATE INDEX references_to_target ON object_references(target_kind,target_id);
CREATE TABLE staging (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL,
 runtime_epoch TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('receiving','prepared','publishing','committed','invalid')),
 storage_key TEXT NOT NULL, resource_id TEXT REFERENCES resources(id), expected_bytes INTEGER NOT NULL,
 received_bytes INTEGER NOT NULL DEFAULT 0, sha256 TEXT, created_at TEXT NOT NULL
);
CREATE TABLE cleanup_jobs (
 id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id), owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL,
 necessary INTEGER NOT NULL CHECK(necessary IN (0,1)), state TEXT NOT NULL CHECK(state IN ('pending','running','failed','done')),
 attempt INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, detail_json TEXT NOT NULL
);
CREATE TABLE recovery_points (
 id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('candidate','valid','invalid')),
 manifest_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX one_valid_recovery ON recovery_points(state) WHERE state='valid';
CREATE TABLE recovery_tasks (
 recovery_id TEXT NOT NULL REFERENCES recovery_points(id), task_id TEXT NOT NULL,
 PRIMARY KEY(recovery_id,task_id)
);
CREATE TABLE recovery_resources (
 recovery_id TEXT NOT NULL REFERENCES recovery_points(id), resource_id TEXT NOT NULL REFERENCES resources(id),
 PRIMARY KEY(recovery_id,resource_id)
);
