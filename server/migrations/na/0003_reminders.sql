ALTER TABLE requests ADD COLUMN reminders_on INTEGER NOT NULL DEFAULT 1 CHECK (reminders_on IN (0, 1));
ALTER TABLE requests ADD COLUMN next_reminder_at INTEGER;
ALTER TABLE requests ADD COLUMN reminder_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requests ADD COLUMN reject_mark_at INTEGER;
ALTER TABLE requests ADD COLUMN rejected_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requests ADD COLUMN notice_due_at INTEGER;
ALTER TABLE requests ADD COLUMN notified_at INTEGER;
ALTER TABLE clients ADD COLUMN email_stop_at INTEGER;
ALTER TABLE links ADD COLUMN token_enc TEXT;

-- requests that were already open start the cadence from their invite
UPDATE requests SET next_reminder_at = sent_at + 259200000 WHERE status = 'open' AND sent_at IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX idx_requests_reminder ON requests (next_reminder_at) WHERE next_reminder_at IS NOT NULL;
CREATE INDEX idx_requests_rejected ON requests (reject_mark_at) WHERE reject_mark_at IS NOT NULL;
CREATE INDEX idx_requests_notice ON requests (notice_due_at) WHERE notice_due_at IS NOT NULL;

CREATE TABLE messages (
  id TEXT PRIMARY KEY CHECK (length(id) = 32),
  firm_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email')),
  kind TEXT NOT NULL CHECK (kind IN ('invite', 'reminder', 'deadline', 'rejected')),
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
CREATE INDEX idx_messages_client ON messages (firm_id, client_id, sent_at);
