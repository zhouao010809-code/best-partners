CREATE TABLE personal_discussions (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  request_id TEXT UNIQUE,
  payload TEXT NOT NULL
);
CREATE INDEX personal_discussions_updated ON personal_discussions(updated_at DESC);
CREATE TABLE personal_discussion_diaries (
  day TEXT PRIMARY KEY,
  cursors TEXT NOT NULL,
  pending_plan TEXT
);
