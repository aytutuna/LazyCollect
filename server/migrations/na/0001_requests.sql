CREATE TABLE clients (
  id TEXT PRIMARY KEY CHECK (length(id) = 32),
  firm_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  locale TEXT NOT NULL DEFAULT 'en',
  email_ok_at INTEGER,
  sms_ok_at INTEGER,
  consent_by TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX idx_clients_firm ON clients (firm_id, name);

CREATE TABLE templates (
  id TEXT PRIMARY KEY CHECK (length(id) = 32),
  firm_id TEXT NOT NULL,
  name TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'en',
  items_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_templates_firm ON templates (firm_id, name);

CREATE TABLE requests (
  id TEXT PRIMARY KEY CHECK (length(id) = 32),
  firm_id TEXT NOT NULL,
  client_id TEXT NOT NULL REFERENCES clients (id),
  title TEXT NOT NULL,
  note TEXT,
  deadline INTEGER NOT NULL,
  firm_name TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'complete', 'expired', 'closed')),
  sent_at INTEGER,
  closed_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX idx_requests_firm ON requests (firm_id, created_at);
CREATE INDEX idx_requests_client ON requests (firm_id, client_id);

CREATE TABLE items (
  id TEXT PRIMARY KEY CHECK (length(id) = 32),
  firm_id TEXT NOT NULL,
  request_id TEXT NOT NULL REFERENCES requests (id),
  position INTEGER NOT NULL,
  label TEXT NOT NULL,
  help TEXT,
  required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'empty' CHECK (status IN ('empty', 'submitted', 'approved', 'rejected')),
  reject_note TEXT,
  reviewed_by TEXT,
  reviewed_at INTEGER
);
CREATE INDEX idx_items_request ON items (firm_id, request_id, position);

CREATE TABLE links (
  token_hash TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL,
  request_id TEXT NOT NULL REFERENCES requests (id),
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_links_request ON links (firm_id, request_id);

CREATE TABLE audit (
  id TEXT PRIMARY KEY CHECK (length(id) = 32),
  firm_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'client', 'system')),
  actor_id TEXT,
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  ip_hash TEXT
);
CREATE INDEX idx_audit_object ON audit (firm_id, object_type, object_id, at);
