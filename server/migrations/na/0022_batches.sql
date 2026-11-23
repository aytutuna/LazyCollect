-- one checklist sent to many clients; the requests are drafts from the start and the cron sends them
CREATE TABLE batches (
  id TEXT PRIMARY KEY CHECK (length(id) = 32),
  firm_id TEXT NOT NULL,
  title TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('template', 'request', 'repeat')),
  source_name TEXT,
  deadline INTEGER,
  reminders_on INTEGER NOT NULL CHECK (reminders_on IN (0, 1)),
  send_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'sending', 'done', 'cancelled')),
  total INTEGER NOT NULL,
  limited_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX idx_batches_firm ON batches (firm_id, created_at);
CREATE INDEX idx_batches_due ON batches (send_at) WHERE status IN ('scheduled', 'sending');

CREATE TABLE batch_items (
  firm_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sent', 'no_email', 'skipped', 'failed', 'cancelled')),
  reason TEXT,
  tries INTEGER NOT NULL DEFAULT 0,
  linked_at INTEGER,
  sent_at INTEGER,
  PRIMARY KEY (firm_id, request_id),
  FOREIGN KEY (firm_id, request_id) REFERENCES requests (firm_id, id)
) WITHOUT ROWID;
CREATE INDEX idx_batch_items_batch ON batch_items (firm_id, batch_id, state, position);
