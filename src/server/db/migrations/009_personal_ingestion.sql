CREATE TABLE personal_candidate_reviews (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES personal_extraction_runs(id),
  ordinal INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL CHECK (state IN ('pending','discarded','committed')),
  decision TEXT NOT NULL CHECK (decision IN ('later','keep','discard')),
  draft_json TEXT NOT NULL,
  target_json TEXT NOT NULL,
  committed_path TEXT,
  batch_id TEXT,
  UNIQUE(run_id, ordinal)
);
CREATE TABLE personal_ingestion_previews (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  plan_json TEXT NOT NULL
);
CREATE TABLE personal_ingestion_batches (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('writing','committed','needs-review')),
  indexed INTEGER NOT NULL DEFAULT 0,
  plan_json TEXT NOT NULL,
  problem TEXT
);
CREATE TABLE personal_ingestion_source_heads (
  run_id TEXT PRIMARY KEY,
  material_path TEXT NOT NULL,
  current_raw_sha256 TEXT NOT NULL,
  evidence_sha256 TEXT NOT NULL
);
CREATE INDEX personal_reviews_source_run ON personal_candidate_reviews(run_id, state);
CREATE INDEX personal_ingestion_batch_run ON personal_ingestion_batches(run_id, created_at);
