-- a closed account is logged as one row of kind 'firm'
CREATE TABLE deletion_log_new (
  id TEXT PRIMARY KEY CHECK (length(id) = 32),
  firm_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('request', 'client', 'firm')),
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('deleted', 'retention', 'closed')),
  files INTEGER NOT NULL,
  at INTEGER NOT NULL
);
INSERT INTO deletion_log_new SELECT id, firm_id, kind, target_id, reason, files, at FROM deletion_log;
DROP TABLE deletion_log;
ALTER TABLE deletion_log_new RENAME TO deletion_log;
CREATE INDEX idx_deletion_log_firm ON deletion_log (firm_id, at);
