PRAGMA foreign_keys = ON;

CREATE TABLE personal_projects (
  id TEXT PRIMARY KEY,
  root_path TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL CHECK (length(display_name) > 0),
  source_revision INTEGER NOT NULL DEFAULT 0 CHECK (source_revision >= 0),
  source_sha256 TEXT NOT NULL CHECK (
    length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  availability TEXT NOT NULL CHECK (availability IN ('ready', 'scanning', 'unavailable', 'reconnect-required')),
  output_root TEXT NOT NULL DEFAULT 'AI工作区' CHECK (output_root = 'AI工作区'),
  write_policy TEXT NOT NULL DEFAULT 'new-output-confirmed' CHECK (write_policy = 'new-output-confirmed'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_scanned_at TEXT
);

CREATE INDEX personal_projects_availability_idx ON personal_projects(availability, updated_at DESC);

CREATE TABLE personal_project_scan_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES personal_projects(id) ON DELETE CASCADE,
  root_path TEXT NOT NULL,
  source_sha256 TEXT NOT NULL CHECK (
    length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  state TEXT NOT NULL CHECK (state IN ('scanning', 'proposed', 'confirmed', 'failed', 'superseded')),
  proposal_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX personal_project_scan_runs_project_idx
  ON personal_project_scan_runs(project_id, created_at DESC);
CREATE INDEX personal_project_scan_runs_source_idx
  ON personal_project_scan_runs(root_path, source_sha256, created_at DESC);

CREATE TABLE personal_project_files (
  project_id TEXT NOT NULL REFERENCES personal_projects(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'directory')),
  bytes INTEGER,
  modified_at TEXT,
  sha256 TEXT CHECK (
    sha256 IS NULL OR (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  parse_status TEXT CHECK (parse_status IN ('readable', 'unsupported', 'too-large', 'failed')),
  parse_problem TEXT,
  content_text TEXT,
  origin TEXT NOT NULL DEFAULT 'source' CHECK (origin IN ('source', 'output')),
  indexed_revision INTEGER NOT NULL CHECK (indexed_revision >= 0),
  PRIMARY KEY (project_id, relative_path),
  CHECK (relative_path <> '' AND relative_path NOT LIKE '/%' AND NOT (length(relative_path) >= 2 AND substr(relative_path, 2, 1) = ':' AND substr(relative_path, 1, 1) GLOB '[A-Za-z]') AND instr(relative_path, char(92)) = 0 AND instr(relative_path, '//') = 0 AND relative_path NOT LIKE './%' AND relative_path NOT LIKE '../%' AND relative_path NOT LIKE '%/./%' AND relative_path NOT LIKE '%/../%' AND relative_path NOT LIKE '%/.' AND relative_path NOT LIKE '%/..' AND instr(relative_path, char(0)) = 0 AND instr(relative_path, char(1)) = 0 AND instr(relative_path, char(2)) = 0 AND instr(relative_path, char(3)) = 0 AND instr(relative_path, char(4)) = 0 AND instr(relative_path, char(5)) = 0 AND instr(relative_path, char(6)) = 0 AND instr(relative_path, char(7)) = 0 AND instr(relative_path, char(8)) = 0 AND instr(relative_path, char(9)) = 0 AND instr(relative_path, char(10)) = 0 AND instr(relative_path, char(11)) = 0 AND instr(relative_path, char(12)) = 0 AND instr(relative_path, char(13)) = 0 AND instr(relative_path, char(14)) = 0 AND instr(relative_path, char(15)) = 0 AND instr(relative_path, char(16)) = 0 AND instr(relative_path, char(17)) = 0 AND instr(relative_path, char(18)) = 0 AND instr(relative_path, char(19)) = 0 AND instr(relative_path, char(20)) = 0 AND instr(relative_path, char(21)) = 0 AND instr(relative_path, char(22)) = 0 AND instr(relative_path, char(23)) = 0 AND instr(relative_path, char(24)) = 0 AND instr(relative_path, char(25)) = 0 AND instr(relative_path, char(26)) = 0 AND instr(relative_path, char(27)) = 0 AND instr(relative_path, char(28)) = 0 AND instr(relative_path, char(29)) = 0 AND instr(relative_path, char(30)) = 0 AND instr(relative_path, char(31)) = 0 AND instr(relative_path, char(127)) = 0)
);

CREATE INDEX personal_project_files_search_idx ON personal_project_files(project_id, parse_status, origin);

CREATE TABLE personal_project_write_plans (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES personal_projects(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('选题评估', '内容草稿', '周计划', '复盘草稿', '工作日志')),
  title TEXT NOT NULL CHECK (length(title) > 0),
  summary TEXT NOT NULL,
  content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (
    length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  source_revision INTEGER NOT NULL CHECK (source_revision >= 0),
  target_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'stale')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  confirm_request_id TEXT UNIQUE,
  result_path TEXT,
  problem TEXT,
  CHECK (target_path <> '' AND target_path NOT LIKE '/%' AND NOT (length(target_path) >= 2 AND substr(target_path, 2, 1) = ':' AND substr(target_path, 1, 1) GLOB '[A-Za-z]') AND instr(target_path, char(92)) = 0 AND instr(target_path, '//') = 0 AND target_path NOT LIKE './%' AND target_path NOT LIKE '../%' AND target_path NOT LIKE '%/./%' AND target_path NOT LIKE '%/../%' AND target_path NOT LIKE '%/.' AND target_path NOT LIKE '%/..' AND instr(target_path, char(0)) = 0 AND instr(target_path, char(1)) = 0 AND instr(target_path, char(2)) = 0 AND instr(target_path, char(3)) = 0 AND instr(target_path, char(4)) = 0 AND instr(target_path, char(5)) = 0 AND instr(target_path, char(6)) = 0 AND instr(target_path, char(7)) = 0 AND instr(target_path, char(8)) = 0 AND instr(target_path, char(9)) = 0 AND instr(target_path, char(10)) = 0 AND instr(target_path, char(11)) = 0 AND instr(target_path, char(12)) = 0 AND instr(target_path, char(13)) = 0 AND instr(target_path, char(14)) = 0 AND instr(target_path, char(15)) = 0 AND instr(target_path, char(16)) = 0 AND instr(target_path, char(17)) = 0 AND instr(target_path, char(18)) = 0 AND instr(target_path, char(19)) = 0 AND instr(target_path, char(20)) = 0 AND instr(target_path, char(21)) = 0 AND instr(target_path, char(22)) = 0 AND instr(target_path, char(23)) = 0 AND instr(target_path, char(24)) = 0 AND instr(target_path, char(25)) = 0 AND instr(target_path, char(26)) = 0 AND instr(target_path, char(27)) = 0 AND instr(target_path, char(28)) = 0 AND instr(target_path, char(29)) = 0 AND instr(target_path, char(30)) = 0 AND instr(target_path, char(31)) = 0 AND instr(target_path, char(127)) = 0),
  CHECK (result_path IS NULL OR (result_path <> '' AND result_path NOT LIKE '/%' AND NOT (length(result_path) >= 2 AND substr(result_path, 2, 1) = ':' AND substr(result_path, 1, 1) GLOB '[A-Za-z]') AND instr(result_path, char(92)) = 0 AND instr(result_path, '//') = 0 AND result_path NOT LIKE './%' AND result_path NOT LIKE '../%' AND result_path NOT LIKE '%/./%' AND result_path NOT LIKE '%/../%' AND result_path NOT LIKE '%/.' AND result_path NOT LIKE '%/..' AND instr(result_path, char(0)) = 0 AND instr(result_path, char(1)) = 0 AND instr(result_path, char(2)) = 0 AND instr(result_path, char(3)) = 0 AND instr(result_path, char(4)) = 0 AND instr(result_path, char(5)) = 0 AND instr(result_path, char(6)) = 0 AND instr(result_path, char(7)) = 0 AND instr(result_path, char(8)) = 0 AND instr(result_path, char(9)) = 0 AND instr(result_path, char(10)) = 0 AND instr(result_path, char(11)) = 0 AND instr(result_path, char(12)) = 0 AND instr(result_path, char(13)) = 0 AND instr(result_path, char(14)) = 0 AND instr(result_path, char(15)) = 0 AND instr(result_path, char(16)) = 0 AND instr(result_path, char(17)) = 0 AND instr(result_path, char(18)) = 0 AND instr(result_path, char(19)) = 0 AND instr(result_path, char(20)) = 0 AND instr(result_path, char(21)) = 0 AND instr(result_path, char(22)) = 0 AND instr(result_path, char(23)) = 0 AND instr(result_path, char(24)) = 0 AND instr(result_path, char(25)) = 0 AND instr(result_path, char(26)) = 0 AND instr(result_path, char(27)) = 0 AND instr(result_path, char(28)) = 0 AND instr(result_path, char(29)) = 0 AND instr(result_path, char(30)) = 0 AND instr(result_path, char(31)) = 0 AND instr(result_path, char(127)) = 0))
);

CREATE INDEX personal_project_write_plans_project_idx ON personal_project_write_plans(project_id, created_at DESC);

CREATE TABLE personal_project_operations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES personal_projects(id) ON DELETE CASCADE,
  plan_id TEXT REFERENCES personal_project_write_plans(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  target_path TEXT NOT NULL,
  old_sha256 TEXT CHECK (
    old_sha256 IS NULL OR (length(old_sha256) = 64 AND old_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  new_sha256 TEXT CHECK (
    new_sha256 IS NULL OR (length(new_sha256) = 64 AND new_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (target_path <> '' AND target_path NOT LIKE '/%' AND NOT (length(target_path) >= 2 AND substr(target_path, 2, 1) = ':' AND substr(target_path, 1, 1) GLOB '[A-Za-z]') AND instr(target_path, char(92)) = 0 AND instr(target_path, '//') = 0 AND target_path NOT LIKE './%' AND target_path NOT LIKE '../%' AND target_path NOT LIKE '%/./%' AND target_path NOT LIKE '%/../%' AND target_path NOT LIKE '%/.' AND target_path NOT LIKE '%/..' AND instr(target_path, char(0)) = 0 AND instr(target_path, char(1)) = 0 AND instr(target_path, char(2)) = 0 AND instr(target_path, char(3)) = 0 AND instr(target_path, char(4)) = 0 AND instr(target_path, char(5)) = 0 AND instr(target_path, char(6)) = 0 AND instr(target_path, char(7)) = 0 AND instr(target_path, char(8)) = 0 AND instr(target_path, char(9)) = 0 AND instr(target_path, char(10)) = 0 AND instr(target_path, char(11)) = 0 AND instr(target_path, char(12)) = 0 AND instr(target_path, char(13)) = 0 AND instr(target_path, char(14)) = 0 AND instr(target_path, char(15)) = 0 AND instr(target_path, char(16)) = 0 AND instr(target_path, char(17)) = 0 AND instr(target_path, char(18)) = 0 AND instr(target_path, char(19)) = 0 AND instr(target_path, char(20)) = 0 AND instr(target_path, char(21)) = 0 AND instr(target_path, char(22)) = 0 AND instr(target_path, char(23)) = 0 AND instr(target_path, char(24)) = 0 AND instr(target_path, char(25)) = 0 AND instr(target_path, char(26)) = 0 AND instr(target_path, char(27)) = 0 AND instr(target_path, char(28)) = 0 AND instr(target_path, char(29)) = 0 AND instr(target_path, char(30)) = 0 AND instr(target_path, char(31)) = 0 AND instr(target_path, char(127)) = 0)
);

CREATE INDEX personal_project_operations_project_idx ON personal_project_operations(project_id, created_at DESC);
CREATE INDEX personal_project_operations_plan_idx ON personal_project_operations(plan_id, created_at DESC);
