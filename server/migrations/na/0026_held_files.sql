-- a copy of every file the service removes or a person removes through the client link, kept for 30 days; the account's wrapped
-- key is copied too, since the account's own row may be gone by the time anyone asks for the file back
CREATE TABLE held_files (
  id TEXT PRIMARY KEY CHECK (length(id) = 32),
  file_id TEXT NOT NULL,
  firm_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  held_key TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  uploaded_by TEXT NOT NULL,
  uploaded_at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  dek_wrapped TEXT,
  held_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_held_file ON held_files (file_id);
CREATE INDEX idx_held_expires ON held_files (expires_at);
