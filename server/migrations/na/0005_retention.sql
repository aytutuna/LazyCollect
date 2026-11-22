ALTER TABLE requests ADD COLUMN ended_at INTEGER;
ALTER TABLE requests ADD COLUMN keep_until INTEGER;
ALTER TABLE requests ADD COLUMN hold_at INTEGER;

-- finished requests start their default 7 years now, closed ones from their close
UPDATE requests SET
  ended_at = CASE WHEN status = 'closed' THEN COALESCE(closed_at, created_at) ELSE CAST(strftime('%s', 'now') AS INTEGER) * 1000 END
WHERE status IN ('complete', 'expired', 'closed');
UPDATE requests SET keep_until = ended_at + 7 * 31557600000 WHERE ended_at IS NOT NULL;

CREATE INDEX idx_requests_keep ON requests (keep_until) WHERE keep_until IS NOT NULL AND hold_at IS NULL;
CREATE INDEX idx_requests_deleted ON requests (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX idx_clients_deleted ON clients (deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE firm_settings (
  firm_id TEXT PRIMARY KEY,
  retention_years INTEGER NOT NULL DEFAULT 7 CHECK (retention_years BETWEEN 1 AND 10)
);

-- ids and counts only, so it can outlive the data it describes
CREATE TABLE deletion_log (
  id TEXT PRIMARY KEY CHECK (length(id) = 32),
  firm_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('request', 'client')),
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('deleted', 'retention')),
  files INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX idx_deletion_log_firm ON deletion_log (firm_id, at);

ALTER TABLE audit ADD COLUMN request_id TEXT GENERATED ALWAYS AS (json_extract(meta, '$.request')) VIRTUAL;
CREATE INDEX idx_audit_request ON audit (firm_id, request_id, at);
CREATE INDEX idx_audit_firm ON audit (firm_id, at, id);
