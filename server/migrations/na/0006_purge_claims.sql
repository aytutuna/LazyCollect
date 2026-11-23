ALTER TABLE requests ADD COLUMN deleted_reason TEXT CHECK (deleted_reason IN ('retention'));
ALTER TABLE requests ADD COLUMN purging_at INTEGER;
ALTER TABLE requests ADD COLUMN purge_failed_at INTEGER;
ALTER TABLE clients ADD COLUMN purge_failed_at INTEGER;

-- what is left of a message once its request is purged: no address, text or provider error
CREATE TABLE message_log (
  id TEXT PRIMARY KEY CHECK (length(id) = 32),
  firm_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  kind TEXT NOT NULL,
  seq INTEGER NOT NULL,
  template_version INTEGER NOT NULL,
  body_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  sent_at INTEGER NOT NULL
);
CREATE INDEX idx_message_log_firm ON message_log (firm_id, request_id);
