CREATE TABLE assistant_action_plans (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES assistant_conversations(id),
  message_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind = 'archive'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'stale')),
  payload TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  confirm_request_id TEXT UNIQUE,
  confirm_fingerprint TEXT,
  result_action_id TEXT,
  result_payload TEXT,
  problem TEXT
);
CREATE INDEX assistant_action_plans_conversation_idx ON assistant_action_plans(conversation_id, created_at);
