CREATE TABLE personal_project_brand_profiles (
  project_id TEXT PRIMARY KEY REFERENCES personal_projects(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  positioning TEXT NOT NULL,
  purchase_reason TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  claims_json TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0)
);
