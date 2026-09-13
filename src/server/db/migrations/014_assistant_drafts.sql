CREATE TABLE assistant_drafts (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  payload TEXT,
  updated_at TEXT NOT NULL,
  last_active INTEGER NOT NULL
);
CREATE INDEX assistant_drafts_active ON assistant_drafts(last_active DESC);
