CREATE TABLE assistant_conversations (
  id TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE assistant_requests (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES assistant_conversations(id)
);
