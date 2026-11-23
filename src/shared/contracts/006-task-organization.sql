CREATE TABLE IF NOT EXISTS task_organization (
 task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
 archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
 pin_order INTEGER UNIQUE CHECK(pin_order > 0)
);
