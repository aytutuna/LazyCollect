ALTER TABLE firms ADD COLUMN require_passkeys INTEGER NOT NULL DEFAULT 0 CHECK (require_passkeys IN (0, 1));

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY CHECK (length(id) = 32),
  user_id TEXT NOT NULL REFERENCES users (id),
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  name TEXT NOT NULL,
  user_verified INTEGER NOT NULL CHECK (user_verified IN (0, 1)),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX idx_passkeys_user ON passkeys (user_id);

-- one row per challenge handed out; the browser's answer names it, and it is deleted when used
CREATE TABLE passkey_challenges (
  challenge TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  kind TEXT NOT NULL CHECK (kind IN ('register', 'authenticate')),
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_passkey_challenges_expires ON passkey_challenges (expires_at);

-- an email code or link that was good but still owes a passkey; its token lives only in a cookie
CREATE TABLE pending_logins (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  step TEXT NOT NULL CHECK (step IN ('passkey', 'enrol')),
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_pending_logins_expires ON pending_logins (expires_at);
