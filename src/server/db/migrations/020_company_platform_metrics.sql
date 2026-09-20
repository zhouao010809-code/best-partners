CREATE TABLE company_platform_metric_imports (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
  workspace_id TEXT NOT NULL REFERENCES company_workspaces(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES company_projects(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('douyin', 'xiaohongshu', 'wechat-channels')),
  source_relative_path TEXT NOT NULL CHECK (length(source_relative_path) > 0),
  source_sha256 TEXT NOT NULL CHECK (
    length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  raw_relative_path TEXT CHECK (raw_relative_path IS NULL OR length(raw_relative_path) > 0),
  source_type TEXT NOT NULL CHECK (source_type = 'official-export'),
  state TEXT NOT NULL CHECK (state IN ('imported', 'partial', 'duplicate', 'conflict', 'failed')),
  row_count INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  imported_count INTEGER NOT NULL DEFAULT 0 CHECK (imported_count >= 0),
  rejected_count INTEGER NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
  error_json TEXT NOT NULL DEFAULT '[]' CHECK (length(error_json) > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  imported_at TEXT,
  UNIQUE (workspace_id, project_id, source_sha256)
);

CREATE INDEX company_platform_metric_imports_workspace_idx
  ON company_platform_metric_imports(workspace_id, created_at);
CREATE INDEX company_platform_metric_imports_source_idx
  ON company_platform_metric_imports(workspace_id, source_sha256);

CREATE TABLE company_platform_metric_snapshots (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
  workspace_id TEXT NOT NULL REFERENCES company_workspaces(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES company_projects(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('douyin', 'xiaohongshu', 'wechat-channels')),
  account_ref TEXT,
  content_id TEXT NOT NULL CHECK (length(content_id) > 0),
  content_title TEXT,
  metric_date TEXT NOT NULL CHECK (metric_date GLOB '????-??-??'),
  metric_kind TEXT NOT NULL CHECK (metric_kind = 'cumulative'),
  observed_at TEXT NOT NULL,
  metrics_json TEXT NOT NULL CHECK (length(metrics_json) > 0),
  source_type TEXT NOT NULL CHECK (source_type = 'official-export'),
  source_relative_path TEXT NOT NULL CHECK (length(source_relative_path) > 0),
  raw_relative_path TEXT NOT NULL CHECK (length(raw_relative_path) > 0),
  source_sha256 TEXT NOT NULL CHECK (
    length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  source_row INTEGER NOT NULL CHECK (source_row >= 2),
  header_row INTEGER NOT NULL CHECK (header_row >= 1),
  sheet_name TEXT NOT NULL CHECK (length(sheet_name) > 0),
  raw_row_sha256 TEXT NOT NULL CHECK (
    length(raw_row_sha256) = 64 AND raw_row_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, project_id, source_sha256, source_row)
);

CREATE INDEX company_platform_metric_snapshots_project_date_idx
  ON company_platform_metric_snapshots(project_id, metric_date, observed_at);
CREATE INDEX company_platform_metric_snapshots_platform_date_idx
  ON company_platform_metric_snapshots(workspace_id, platform, metric_date, observed_at);
CREATE INDEX company_platform_metric_snapshots_content_idx
  ON company_platform_metric_snapshots(project_id, content_id, metric_date, observed_at);
