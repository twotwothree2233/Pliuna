-- Additive chapter metadata. Existing Views and execution evidence stay intact.
CREATE TABLE IF NOT EXISTS runner_chapter_manifests (
 task_id TEXT NOT NULL REFERENCES tasks(id), view_id TEXT NOT NULL,
 manifest_revision INTEGER NOT NULL CHECK(manifest_revision>=1),
 view_revision INTEGER NOT NULL CHECK(view_revision>=1),
 bundle_resource_id TEXT NOT NULL REFERENCES resources(id),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), installed_at TEXT NOT NULL,
 PRIMARY KEY(task_id,view_id,manifest_revision)
);
CREATE TABLE IF NOT EXISTS runner_chapter_heads (
 task_id TEXT NOT NULL REFERENCES tasks(id), view_id TEXT NOT NULL,
 manifest_revision INTEGER NOT NULL CHECK(manifest_revision>=1),
 PRIMARY KEY(task_id,view_id),
 FOREIGN KEY(task_id,view_id,manifest_revision) REFERENCES runner_chapter_manifests(task_id,view_id,manifest_revision)
);
CREATE TABLE IF NOT EXISTS runner_chapter_updates (
 task_id TEXT NOT NULL REFERENCES tasks(id), update_id TEXT NOT NULL UNIQUE,
 input_event_id TEXT NOT NULL UNIQUE, request_id TEXT NOT NULL REFERENCES requests(id),
 intent_revision INTEGER NOT NULL CHECK(intent_revision>=1), view_id TEXT NOT NULL,
 state TEXT NOT NULL, input_json TEXT NOT NULL CHECK(json_valid(input_json)),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), installed_at TEXT NOT NULL,
 PRIMARY KEY(task_id,update_id)
);
CREATE TABLE IF NOT EXISTS runner_chapter_intents (
 task_id TEXT NOT NULL REFERENCES tasks(id), view_id TEXT NOT NULL, region_id TEXT NOT NULL,
 intent_revision INTEGER NOT NULL CHECK(intent_revision>=1), update_id TEXT NOT NULL,
 PRIMARY KEY(task_id,view_id,region_id),
 FOREIGN KEY(task_id,update_id) REFERENCES runner_chapter_updates(task_id,update_id)
);
CREATE TABLE IF NOT EXISTS runner_chapter_proposals (
 task_id TEXT NOT NULL REFERENCES tasks(id), proposal_id TEXT NOT NULL UNIQUE,
 update_id TEXT NOT NULL, bundle_resource_id TEXT NOT NULL REFERENCES resources(id),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 PRIMARY KEY(task_id,proposal_id),
 FOREIGN KEY(task_id,update_id) REFERENCES runner_chapter_updates(task_id,update_id)
);
CREATE TABLE IF NOT EXISTS runner_chapter_inheritance (
 task_id TEXT NOT NULL REFERENCES tasks(id), update_id TEXT NOT NULL, region_id TEXT NOT NULL,
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 PRIMARY KEY(task_id,update_id,region_id),
 FOREIGN KEY(task_id,update_id) REFERENCES runner_chapter_updates(task_id,update_id)
);
CREATE TABLE IF NOT EXISTS runner_chapter_publications (
 task_id TEXT NOT NULL REFERENCES tasks(id), operation_id TEXT NOT NULL UNIQUE,
 update_id TEXT NOT NULL, previous_operation_id TEXT, state TEXT NOT NULL,
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
 PRIMARY KEY(task_id,operation_id),
 FOREIGN KEY(task_id,update_id) REFERENCES runner_chapter_updates(task_id,update_id),
 FOREIGN KEY(task_id,previous_operation_id) REFERENCES runner_chapter_publications(task_id,operation_id)
);
CREATE TABLE IF NOT EXISTS runner_chapter_resources (
 task_id TEXT NOT NULL REFERENCES tasks(id), owner_kind TEXT NOT NULL,
 owner_id TEXT NOT NULL, resource_id TEXT NOT NULL REFERENCES resources(id),
 PRIMARY KEY(task_id,owner_kind,owner_id,resource_id)
);
CREATE TABLE IF NOT EXISTS runner_chapter_publication_evidence (
 task_id TEXT NOT NULL REFERENCES tasks(id), operation_id TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(sequence>=1), state TEXT NOT NULL,
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), installed_at TEXT NOT NULL,
 PRIMARY KEY(task_id,operation_id,sequence),
 FOREIGN KEY(task_id,operation_id) REFERENCES runner_chapter_publications(task_id,operation_id)
);
CREATE TABLE IF NOT EXISTS runner_chapter_assemblies (
 task_id TEXT NOT NULL REFERENCES tasks(id), artifact_id TEXT NOT NULL,
 artifact_revision INTEGER NOT NULL CHECK(artifact_revision>=1),
 update_id TEXT NOT NULL, operation_id TEXT NOT NULL,
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 PRIMARY KEY(task_id,artifact_id,artifact_revision), UNIQUE(task_id,operation_id),
 FOREIGN KEY(task_id,update_id) REFERENCES runner_chapter_updates(task_id,update_id),
 FOREIGN KEY(task_id,operation_id) REFERENCES runner_chapter_publications(task_id,operation_id)
);
CREATE INDEX IF NOT EXISTS runner_chapter_updates_by_view ON runner_chapter_updates(task_id,view_id,state);
CREATE INDEX IF NOT EXISTS runner_chapter_publications_by_update ON runner_chapter_publications(task_id,update_id);
