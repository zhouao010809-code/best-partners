CREATE TEMP TABLE company_migration_018_ids (
  table_name TEXT NOT NULL,
  id TEXT NOT NULL,
  PRIMARY KEY (table_name, id)
);

CREATE TEMP TRIGGER company_migration_018_id_collision
BEFORE INSERT ON company_migration_018_ids
WHEN EXISTS (
  SELECT 1
  FROM company_migration_018_ids
  WHERE table_name = NEW.table_name AND id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'migration 018 legacy ID collision: ' || NEW.table_name || ':' || NEW.id);
END;

INSERT INTO company_migration_018_ids (table_name, id)
SELECT 'company_workspaces', id FROM company_workspaces WHERE id IS NOT NULL
UNION ALL
SELECT 'company_workspaces', 'migration-018:company_workspaces:' || rowid FROM company_workspaces WHERE id IS NULL
UNION ALL
SELECT 'company_users', id FROM company_users WHERE id IS NOT NULL
UNION ALL
SELECT 'company_users', 'migration-018:company_users:' || rowid FROM company_users WHERE id IS NULL
UNION ALL
SELECT 'company_sessions', id_hash FROM company_sessions WHERE id_hash IS NOT NULL
UNION ALL
SELECT 'company_sessions', 'migration-018:company_sessions:' || rowid FROM company_sessions WHERE id_hash IS NULL
UNION ALL
SELECT 'company_projects', id FROM company_projects WHERE id IS NOT NULL
UNION ALL
SELECT 'company_projects', 'migration-018:company_projects:' || rowid FROM company_projects WHERE id IS NULL
UNION ALL
SELECT 'company_project_ingestion_runs', id FROM company_project_ingestion_runs WHERE id IS NOT NULL
UNION ALL
SELECT 'company_project_ingestion_runs', 'migration-018:company_project_ingestion_runs:' || rowid FROM company_project_ingestion_runs WHERE id IS NULL
UNION ALL
SELECT 'company_project_events', id FROM company_project_events WHERE id IS NOT NULL
UNION ALL
SELECT 'company_project_events', 'migration-018:company_project_events:' || rowid FROM company_project_events WHERE id IS NULL;

DROP TRIGGER company_migration_018_id_collision;
DROP TABLE company_migration_018_ids;

DROP INDEX IF EXISTS company_users_workspace_idx;
DROP INDEX IF EXISTS company_sessions_user_idx;
DROP INDEX IF EXISTS company_projects_workspace_idx;
DROP INDEX IF EXISTS company_project_ingestion_runs_project_idx;
DROP INDEX IF EXISTS company_project_ingestion_runs_open_source_idx;
DROP INDEX IF EXISTS company_project_events_project_idx;
DROP INDEX IF EXISTS company_project_events_operation_idx;

ALTER TABLE company_workspaces RENAME TO company_workspaces_018_old;
CREATE TABLE company_workspaces (
  id TEXT NOT NULL PRIMARY KEY,
  display_name TEXT NOT NULL CHECK (length(display_name) > 0),
  root_path TEXT NOT NULL UNIQUE CHECK (length(root_path) > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO company_workspaces (id, display_name, root_path, created_at, updated_at)
SELECT COALESCE(id, 'migration-018:company_workspaces:' || rowid), display_name, root_path, created_at, updated_at
FROM company_workspaces_018_old;
DROP TABLE company_workspaces_018_old;

ALTER TABLE company_users RENAME TO company_users_018_old;
CREATE TABLE company_users (
  id TEXT NOT NULL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES company_workspaces(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL CHECK (length(display_name) > 0),
  role TEXT NOT NULL CHECK (role IN ('owner', 'operator', 'reviewer')),
  password_salt TEXT NOT NULL CHECK (length(password_salt) > 0),
  password_hash TEXT NOT NULL CHECK (length(password_hash) > 0),
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO company_users (id, workspace_id, display_name, role, password_salt, password_hash, disabled, created_at, updated_at)
SELECT COALESCE(id, 'migration-018:company_users:' || rowid), workspace_id, display_name, role, password_salt, password_hash, disabled, created_at, updated_at
FROM company_users_018_old;
DROP TABLE company_users_018_old;

ALTER TABLE company_sessions RENAME TO company_sessions_018_old;
CREATE TABLE company_sessions (
  id_hash TEXT NOT NULL PRIMARY KEY CHECK (length(id_hash) > 0),
  user_id TEXT NOT NULL REFERENCES company_users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
INSERT INTO company_sessions (id_hash, user_id, expires_at, created_at, last_seen_at)
SELECT COALESCE(id_hash, 'migration-018:company_sessions:' || rowid), user_id, expires_at, created_at, last_seen_at
FROM company_sessions_018_old;
DROP TABLE company_sessions_018_old;

ALTER TABLE company_projects RENAME TO company_projects_018_old;
CREATE TABLE company_projects (
  id TEXT NOT NULL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES company_workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) > 0),
  client_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'acceptance', 'completed', 'paused', 'archived')),
  project_root TEXT NOT NULL CHECK (length(project_root) > 0),
  source_root TEXT NOT NULL CHECK (length(source_root) > 0),
  config_sha256 TEXT NOT NULL CHECK (length(config_sha256) > 0),
  confidence_json TEXT NOT NULL CHECK (length(confidence_json) > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, project_root)
);
INSERT INTO company_projects (id, workspace_id, name, client_name, status, project_root, source_root, config_sha256, confidence_json, created_at, updated_at)
SELECT COALESCE(id, 'migration-018:company_projects:' || rowid), workspace_id, name, client_name, status, project_root, source_root, config_sha256, confidence_json, created_at, updated_at
FROM company_projects_018_old;
DROP TABLE company_projects_018_old;

ALTER TABLE company_project_ingestion_runs RENAME TO company_project_ingestion_runs_018_old;
CREATE TABLE company_project_ingestion_runs (
  id TEXT NOT NULL PRIMARY KEY,
  project_id TEXT REFERENCES company_projects(id) ON DELETE SET NULL,
  source_sha256 TEXT NOT NULL CHECK (length(source_sha256) > 0),
  state TEXT NOT NULL CHECK (state IN ('scanning', 'proposed', 'confirmed', 'failed', 'superseded')),
  proposal_json TEXT NOT NULL CHECK (length(proposal_json) > 0),
  operation_id TEXT NOT NULL CHECK (length(operation_id) > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO company_project_ingestion_runs (id, project_id, source_sha256, state, proposal_json, operation_id, created_at, updated_at)
SELECT COALESCE(id, 'migration-018:company_project_ingestion_runs:' || rowid), project_id, source_sha256, state, proposal_json, operation_id, created_at, updated_at
FROM company_project_ingestion_runs_018_old;
DROP TABLE company_project_ingestion_runs_018_old;

ALTER TABLE company_project_events RENAME TO company_project_events_018_old;
CREATE TABLE company_project_events (
  id TEXT NOT NULL PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES company_projects(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES company_users(id),
  operation_id TEXT NOT NULL CHECK (length(operation_id) > 0),
  event_type TEXT NOT NULL CHECK (length(event_type) > 0),
  payload_json TEXT NOT NULL CHECK (length(payload_json) > 0),
  created_at TEXT NOT NULL
);
INSERT INTO company_project_events (id, project_id, actor_id, operation_id, event_type, payload_json, created_at)
-- 017 had no event operation_id; derive a traceable value instead of claiming an old one was preserved.
SELECT COALESCE(id, 'migration-018:company_project_events:' || rowid),
       project_id,
       actor_id,
       'migration-018:' || COALESCE(id, 'company_project_events:' || rowid),
       event_type,
       payload_json,
       created_at
FROM company_project_events_018_old;
DROP TABLE company_project_events_018_old;

CREATE INDEX company_users_workspace_idx ON company_users(workspace_id);
CREATE INDEX company_sessions_user_idx ON company_sessions(user_id);
CREATE INDEX company_projects_workspace_idx ON company_projects(workspace_id);
CREATE INDEX company_project_ingestion_runs_project_idx ON company_project_ingestion_runs(project_id, created_at);
CREATE UNIQUE INDEX company_project_ingestion_runs_open_source_idx
  ON company_project_ingestion_runs(source_sha256)
  WHERE state IN ('scanning', 'proposed');
CREATE INDEX company_project_events_project_idx ON company_project_events(project_id, created_at);
CREATE INDEX company_project_events_operation_idx ON company_project_events(operation_id);
