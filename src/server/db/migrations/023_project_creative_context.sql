CREATE TABLE personal_project_creative_profiles (
  project_id TEXT PRIMARY KEY REFERENCES personal_projects(id) ON DELETE CASCADE,
  audience TEXT NOT NULL,
  goal TEXT NOT NULL,
  style TEXT NOT NULL,
  facts TEXT NOT NULL,
  avoid TEXT NOT NULL,
  samples_json TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  updated_at TEXT NOT NULL
);

-- Defaults make older drafts/snapshots readable without rewriting immutable rows
-- or their original export_content/content_sha256.
ALTER TABLE personal_project_creations ADD COLUMN reference_selection_json TEXT NOT NULL DEFAULT '{"mode":"auto","paths":[]}';
ALTER TABLE personal_project_creation_versions ADD COLUMN reference_selection_json TEXT NOT NULL DEFAULT '{"mode":"auto","paths":[]}';
