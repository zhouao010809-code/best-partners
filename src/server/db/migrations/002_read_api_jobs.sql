CREATE TABLE index_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE index_jobs (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  requested_index_version INTEGER NOT NULL CHECK (requested_index_version >= 0),
  result_index_version INTEGER CHECK (result_index_version >= 0),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'interrupted')),
  progress_completed INTEGER NOT NULL DEFAULT 0 CHECK (progress_completed >= 0),
  progress_total INTEGER NOT NULL DEFAULT 0 CHECK (progress_total >= 0),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (progress_completed <= progress_total)
);

CREATE UNIQUE INDEX one_active_index_rebuild
ON index_jobs((1))
WHERE status IN ('queued', 'running');
