CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE extraction_runs (
  id TEXT PRIMARY KEY,
  material_path TEXT NOT NULL,
  source_raw_sha256 TEXT NOT NULL,
  reading_state TEXT NOT NULL CHECK (reading_state IN ('已看', '未看')),
  state TEXT NOT NULL,
  candidate_set_hash TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX one_active_run_per_material_version
ON extraction_runs(material_path, source_raw_sha256)
WHERE state NOT IN ('completed', 'invalidated');

CREATE TABLE idempotency_records (
  key TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE search_index (
  path TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  raw_sha256 TEXT NOT NULL,
  upstream_version TEXT,
  yaml_json TEXT NOT NULL,
  links_json TEXT NOT NULL,
  indexed_at TEXT NOT NULL
);

CREATE TABLE schema_issues (
  path TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  detail TEXT NOT NULL,
  observed_at TEXT NOT NULL
);
