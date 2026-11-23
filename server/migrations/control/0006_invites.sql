-- no token: an invite is accepted by signing in with the invited address
CREATE TABLE invites (
  id TEXT PRIMARY KEY CHECK (length(id) = 32),
  firm_id TEXT NOT NULL REFERENCES firms (id),
  email TEXT NOT NULL,
  name TEXT,
  invited_by TEXT NOT NULL REFERENCES users (id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  revoked_at INTEGER
);
CREATE UNIQUE INDEX idx_invites_live ON invites (firm_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX idx_invites_firm_created ON invites (firm_id, created_at);
CREATE INDEX idx_invites_email ON invites (email);
