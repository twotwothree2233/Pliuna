-- Structural metadata is additive; the published Bundle stays authoritative.
CREATE TABLE IF NOT EXISTS runner_content_trees (
 task_id TEXT NOT NULL REFERENCES tasks(id), view_id TEXT NOT NULL,
 tree_revision INTEGER NOT NULL CHECK(tree_revision>=1),
 view_revision INTEGER NOT NULL CHECK(view_revision>=1),
 state_revision INTEGER NOT NULL CHECK(state_revision>=1),
 bundle_resource_id TEXT NOT NULL REFERENCES resources(id),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), installed_at TEXT NOT NULL,
 PRIMARY KEY(task_id,view_id,tree_revision)
);
CREATE TABLE IF NOT EXISTS runner_content_tree_heads (
 task_id TEXT NOT NULL REFERENCES tasks(id), view_id TEXT NOT NULL,
 tree_revision INTEGER NOT NULL CHECK(tree_revision>=1),
 PRIMARY KEY(task_id,view_id),
 FOREIGN KEY(task_id,view_id,tree_revision) REFERENCES runner_content_trees(task_id,view_id,tree_revision)
);
CREATE TABLE IF NOT EXISTS runner_content_tree_cursors (
 cursor_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
 view_id TEXT NOT NULL, tree_revision INTEGER NOT NULL CHECK(tree_revision>=1),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 FOREIGN KEY(task_id,view_id,tree_revision) REFERENCES runner_content_trees(task_id,view_id,tree_revision)
);
CREATE TABLE IF NOT EXISTS runner_content_intent_relations (
 task_id TEXT NOT NULL REFERENCES tasks(id), update_id TEXT NOT NULL,
 previous_update_id TEXT NOT NULL,
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 PRIMARY KEY(task_id,update_id,previous_update_id)
);
