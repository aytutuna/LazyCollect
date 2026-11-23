-- items gain 'unavailable' (the client has no such document) and 'waived' (the account accepted that), and the
-- reason the client gave. SQLite cannot change a CHECK in place, so the table is rebuilt; files point at it.
PRAGMA defer_foreign_keys = on;

-- the rows are parked first and put back after the new table exists, so the foreign keys from files
-- are satisfied again by the time the transaction commits
CREATE TABLE items_old AS SELECT * FROM items;
DROP TABLE items;
CREATE TABLE items (
  id TEXT PRIMARY KEY CHECK (length(id) = 32),
  firm_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  label TEXT NOT NULL,
  help TEXT,
  required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'empty' CHECK (status IN ('empty', 'submitted', 'approved', 'rejected', 'unavailable', 'waived')),
  reject_note TEXT,
  reviewed_by TEXT,
  reviewed_at INTEGER,
  unavailable_note TEXT,
  unavailable_at INTEGER,
  FOREIGN KEY (firm_id, request_id) REFERENCES requests (firm_id, id)
);
-- the unique index is the parent key the foreign keys from files look up
CREATE INDEX idx_items_request ON items (firm_id, request_id, position);
CREATE UNIQUE INDEX idx_items_scope ON items (firm_id, request_id, id);
CREATE INDEX idx_items_summary ON items (firm_id, request_id, status, required);
INSERT INTO items (id, firm_id, request_id, position, label, help, required, status, reject_note, reviewed_by, reviewed_at)
  SELECT id, firm_id, request_id, position, label, help, required, status, reject_note, reviewed_by, reviewed_at FROM items_old;
DROP TABLE items_old;

-- the email log gains 'answer', for a reply to a client's question
CREATE TABLE messages_new (
  id TEXT PRIMARY KEY CHECK (length(id) = 32),
  firm_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email')),
  kind TEXT NOT NULL CHECK (kind IN ('invite', 'reminder', 'deadline', 'rejected', 'answer')),
  seq INTEGER NOT NULL,
  template_version INTEGER NOT NULL,
  body_hash TEXT NOT NULL,
  provider_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  sent_at INTEGER NOT NULL,
  UNIQUE (firm_id, request_id, kind, seq, channel),
  FOREIGN KEY (firm_id, request_id) REFERENCES requests (firm_id, id),
  FOREIGN KEY (firm_id, client_id) REFERENCES clients (firm_id, id)
);
INSERT INTO messages_new SELECT id, firm_id, request_id, client_id, channel, kind, seq, template_version, body_hash, provider_id, status, attempts, error, sent_at FROM messages;
DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;
CREATE INDEX idx_messages_client ON messages (firm_id, client_id, sent_at);

-- the thread between a client and the account on one request; plain text, client data
CREATE TABLE notes (
  id TEXT PRIMARY KEY CHECK (length(id) = 32),
  firm_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  author TEXT NOT NULL CHECK (author IN ('client', 'user')),
  user_id TEXT,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (firm_id, request_id) REFERENCES requests (firm_id, id)
);
CREATE INDEX idx_notes_request ON notes (firm_id, request_id, created_at);
