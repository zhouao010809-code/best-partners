CREATE TABLE personal_trash_entries_v11 (
  id TEXT PRIMARY KEY,
  material_path TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('moving','trashed','restoring','restored','needs-review','deleting','deleted')),
  manifest_json TEXT NOT NULL,
  problem TEXT,
  indexed INTEGER NOT NULL DEFAULT 0,
  restored_at TEXT,
  delete_manifest_json TEXT,
  deleted_at TEXT
);
INSERT INTO personal_trash_entries_v11(id,material_path,title,created_at,status,manifest_json,problem,indexed,restored_at)
SELECT id,material_path,title,created_at,status,manifest_json,problem,indexed,restored_at FROM personal_trash_entries;
DROP TABLE personal_trash_entries;
ALTER TABLE personal_trash_entries_v11 RENAME TO personal_trash_entries;
CREATE UNIQUE INDEX personal_trash_active_path ON personal_trash_entries(material_path) WHERE status NOT IN ('restored','deleted');
