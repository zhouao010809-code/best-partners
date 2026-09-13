CREATE TABLE personal_queue_visibility (
  material_path TEXT PRIMARY KEY,
  removed_at TEXT NOT NULL
);
CREATE TABLE personal_trash_entries (
  id TEXT PRIMARY KEY,
  material_path TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('moving','trashed','restoring','restored','needs-review')),
  manifest_json TEXT NOT NULL,
  problem TEXT,
  indexed INTEGER NOT NULL DEFAULT 0,
  restored_at TEXT
);
CREATE UNIQUE INDEX personal_trash_active_path ON personal_trash_entries(material_path) WHERE status != 'restored';
