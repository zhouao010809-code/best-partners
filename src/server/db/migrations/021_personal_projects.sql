PRAGMA foreign_keys = ON;

-- Absolute roots are intentionally kept only in this private SQLite database.
CREATE TABLE personal_projects (
  id TEXT PRIMARY KEY,
  root_path TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  source_revision INTEGER NOT NULL DEFAULT 0 CHECK (source_revision >= 0),
  availability TEXT NOT NULL CHECK (availability IN ('ready', 'scanning', 'unavailable', 'reconnect-required')),
  output_root TEXT NOT NULL DEFAULT 'AI工作区' CHECK (output_root IN ('AI工作区', 'AI工作区/')),
  file_count INTEGER NOT NULL DEFAULT 0 CHECK (file_count >= 0),
  readable_file_count INTEGER NOT NULL DEFAULT 0 CHECK (readable_file_count >= 0),
  issue_count INTEGER NOT NULL DEFAULT 0 CHECK (issue_count >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_scanned_at TEXT
);

CREATE INDEX personal_projects_availability_idx ON personal_projects(availability, updated_at DESC);

CREATE TABLE personal_project_scan_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES personal_projects(id) ON DELETE CASCADE,
  canonical_root TEXT NOT NULL,
  source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'),
  source_revision INTEGER NOT NULL CHECK (source_revision >= 0),
  status TEXT NOT NULL CHECK (status IN ('scanning', 'proposed', 'completed', 'confirmed', 'failed', 'stale')),
  file_count INTEGER NOT NULL DEFAULT 0 CHECK (file_count >= 0),
  readable_file_count INTEGER NOT NULL DEFAULT 0 CHECK (readable_file_count >= 0),
  issue_count INTEGER NOT NULL DEFAULT 0 CHECK (issue_count >= 0),
  proposal_json TEXT NOT NULL DEFAULT '{}',
  summary_json TEXT NOT NULL DEFAULT '{}',
  operation_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (canonical_root <> '')
);

CREATE INDEX personal_project_scan_runs_project_idx
  ON personal_project_scan_runs(project_id, created_at DESC);
CREATE INDEX personal_project_scan_runs_source_idx
  ON personal_project_scan_runs(canonical_root, source_sha256, created_at DESC);

CREATE TABLE personal_project_files (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES personal_projects(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('source', 'output')),
  parse_status TEXT NOT NULL CHECK (parse_status IN ('readable', 'unsupported', 'too-large', 'failed')),
  kind TEXT NOT NULL DEFAULT 'file' CHECK (kind IN ('file', 'directory')),
  bytes INTEGER NOT NULL DEFAULT 0 CHECK (bytes >= 0),
  modified_at TEXT,
  sha256 TEXT CHECK (sha256 IS NULL OR (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*')),
  mime_type TEXT,
  issue TEXT,
  content TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (relative_path <> '' AND relative_path NOT LIKE '/%' AND instr(relative_path, char(92)) = 0
    AND relative_path <> '.' AND relative_path <> '..'
    AND relative_path NOT LIKE './%' AND relative_path NOT LIKE '../%'
    AND relative_path NOT LIKE '%/./%' AND relative_path NOT LIKE '%/../%'
    AND relative_path NOT LIKE '%/..'),
  UNIQUE(project_id, relative_path)
);

CREATE INDEX personal_project_files_project_idx
  ON personal_project_files(project_id, origin, relative_path);
CREATE INDEX personal_project_files_status_idx
  ON personal_project_files(project_id, parse_status);

CREATE TABLE personal_project_write_plans (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES personal_projects(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES assistant_conversations(id) ON DELETE SET NULL,
  message_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'stale')),
  category TEXT NOT NULL CHECK (category IN ('选题评估', '内容草稿', '周计划', '复盘草稿', '工作日志')),
  target_path TEXT NOT NULL,
  project_revision INTEGER NOT NULL CHECK (project_revision >= 0),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  updated_at TEXT NOT NULL,
  problem TEXT,
  CHECK (target_path <> '' AND target_path NOT LIKE '/%' AND instr(target_path, char(92)) = 0
    AND target_path <> '.' AND target_path <> '..'
    AND target_path NOT LIKE './%' AND target_path NOT LIKE '../%'
    AND target_path NOT LIKE '%/./%' AND target_path NOT LIKE '%/../%' AND target_path NOT LIKE '%/..')
);

CREATE INDEX personal_project_write_plans_project_idx
  ON personal_project_write_plans(project_id, created_at DESC);
CREATE INDEX personal_project_write_plans_conversation_idx
  ON personal_project_write_plans(conversation_id, created_at DESC);

CREATE TABLE personal_project_operations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES personal_projects(id) ON DELETE CASCADE,
  write_plan_id TEXT REFERENCES personal_project_write_plans(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('scan', 'bind', 'reconnect', 'refresh', 'project-write')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'stale')),
  target_path TEXT,
  before_sha256 TEXT CHECK (before_sha256 IS NULL OR (length(before_sha256) = 64 AND before_sha256 NOT GLOB '*[^0-9a-f]*')),
  after_sha256 TEXT CHECK (after_sha256 IS NULL OR (length(after_sha256) = 64 AND after_sha256 NOT GLOB '*[^0-9a-f]*')),
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  problem TEXT,
  CHECK (target_path IS NULL OR (target_path <> '' AND target_path NOT LIKE '/%' AND instr(target_path, char(92)) = 0
    AND target_path <> '.' AND target_path <> '..'
    AND target_path NOT LIKE './%' AND target_path NOT LIKE '../%'
    AND target_path NOT LIKE '%/./%' AND target_path NOT LIKE '%/../%' AND target_path NOT LIKE '%/..'))
);

CREATE INDEX personal_project_operations_project_idx
  ON personal_project_operations(project_id, created_at DESC);
CREATE INDEX personal_project_operations_plan_idx
  ON personal_project_operations(write_plan_id, created_at DESC);
