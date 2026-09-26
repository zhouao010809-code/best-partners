ALTER TABLE personal_project_creations ADD COLUMN discarded_at TEXT;
ALTER TABLE personal_project_creations ADD COLUMN request_id TEXT;
ALTER TABLE personal_project_creations ADD COLUMN request_hash TEXT CHECK (request_hash IS NULL OR length(request_hash) = 64);
CREATE UNIQUE INDEX personal_project_creations_request_idx
  ON personal_project_creations(project_id, request_id) WHERE request_id IS NOT NULL;
ALTER TABLE personal_project_creation_exchanges ADD COLUMN dismissed_at TEXT;
CREATE INDEX personal_project_creations_lifecycle_idx
  ON personal_project_creations(project_id, discarded_at, updated_at DESC);
