CREATE TABLE personal_extraction_runs (
  id TEXT PRIMARY KEY,
  preview_token TEXT NOT NULL UNIQUE,
  material_path TEXT NOT NULL,
  title TEXT NOT NULL,
  reading_state TEXT NOT NULL CHECK (reading_state IN ('已看', '未看')),
  source_raw_sha256 TEXT NOT NULL,
  rule_fingerprint TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('generating', 'ready', 'failed', 'cancelled')),
  result_json TEXT,
  problem TEXT
);
CREATE UNIQUE INDEX personal_extraction_one_inflight
  ON personal_extraction_runs(material_path) WHERE status = 'generating';
CREATE INDEX personal_extraction_recent ON personal_extraction_runs(created_at DESC);
