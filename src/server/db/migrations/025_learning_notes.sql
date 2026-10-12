-- Learning notes own their text and provenance. No source/conversation cascade.
CREATE TABLE learning_notes (
  vault_id TEXT NOT NULL,
  id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (vault_id, id)
);
CREATE INDEX learning_notes_by_source ON learning_notes (vault_id, source_path, updated_at DESC, id);
CREATE INDEX learning_notes_by_conversation ON learning_notes (vault_id, conversation_id, updated_at DESC, id);
