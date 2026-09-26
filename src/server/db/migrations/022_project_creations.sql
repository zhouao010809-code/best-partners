PRAGMA foreign_keys = ON;

CREATE TABLE personal_project_creations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES personal_projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('topic', 'script')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 255),
  brief TEXT NOT NULL,
  body TEXT NOT NULL,
  audience TEXT NOT NULL,
  angle TEXT NOT NULL,
  rationale TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  final_version_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (final_version_id, id) REFERENCES personal_project_creation_versions(id, creation_id)
);
CREATE INDEX personal_project_creations_project_idx ON personal_project_creations(project_id, updated_at DESC);

CREATE TABLE personal_project_creation_versions (
  id TEXT PRIMARY KEY,
  creation_id TEXT NOT NULL REFERENCES personal_project_creations(id) ON DELETE CASCADE,
  number INTEGER NOT NULL CHECK (number > 0),
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  body TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  export_content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  created_at TEXT NOT NULL,
  UNIQUE (creation_id, number),
  UNIQUE (id, creation_id)
);
CREATE TRIGGER personal_project_creation_versions_immutable
BEFORE UPDATE ON personal_project_creation_versions
BEGIN
  SELECT RAISE(ABORT, 'Creation versions are immutable');
END;

CREATE TABLE personal_project_creation_exchanges (
  id TEXT PRIMARY KEY,
  creation_id TEXT NOT NULL REFERENCES personal_project_creations(id) ON DELETE CASCADE,
  instruction TEXT NOT NULL,
  suggestion_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX personal_project_creation_exchanges_item_idx ON personal_project_creation_exchanges(creation_id, created_at);

CREATE TABLE personal_project_creation_exports (
  version_id TEXT PRIMARY KEY REFERENCES personal_project_creation_versions(id) ON DELETE CASCADE,
  root_path TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (root_path, relative_path)
);
