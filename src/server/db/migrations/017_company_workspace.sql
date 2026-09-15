CREATE TABLE company_workspaces (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL CHECK (length(display_name) > 0),
  root_path TEXT NOT NULL UNIQUE CHECK (length(root_path) > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE company_users (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES company_workspaces(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL CHECK (length(display_name) > 0),
  role TEXT NOT NULL CHECK (role IN ('owner', 'operator', 'reviewer')),
  password_salt TEXT NOT NULL CHECK (length(password_salt) > 0),
  password_hash TEXT NOT NULL CHECK (length(password_hash) > 0),
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE company_sessions (
  id_hash TEXT PRIMARY KEY CHECK (length(id_hash) > 0),
  user_id TEXT NOT NULL REFERENCES company_users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE company_projects (
  id TEXT PRIMARY KEY,
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

CREATE TABLE company_project_ingestion_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES company_projects(id) ON DELETE CASCADE,
  source_sha256 TEXT NOT NULL CHECK (length(source_sha256) > 0),
  state TEXT NOT NULL CHECK (state IN ('scanning', 'proposed', 'confirmed', 'failed', 'superseded')),
  proposal_json TEXT NOT NULL CHECK (length(proposal_json) > 0),
  operation_id TEXT NOT NULL CHECK (length(operation_id) > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX company_project_ingestion_runs_open_source_idx
  ON company_project_ingestion_runs(source_sha256)
  WHERE state IN ('scanning', 'proposed', 'confirmed');

CREATE TABLE company_project_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES company_projects(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES company_users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (length(event_type) > 0),
  payload_json TEXT NOT NULL CHECK (length(payload_json) > 0),
  created_at TEXT NOT NULL
);

CREATE INDEX company_users_workspace_idx ON company_users(workspace_id);
CREATE INDEX company_sessions_user_idx ON company_sessions(user_id);
CREATE INDEX company_projects_workspace_idx ON company_projects(workspace_id);
CREATE INDEX company_project_ingestion_runs_project_idx ON company_project_ingestion_runs(project_id, created_at);
CREATE INDEX company_project_events_project_idx ON company_project_events(project_id, created_at);
