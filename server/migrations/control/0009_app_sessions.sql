-- sessions made by the phone apps carry which app, and the device's push token once it registers one
ALTER TABLE sessions ADD COLUMN app TEXT CHECK (app IN ('android', 'ios'));
ALTER TABLE sessions ADD COLUMN push_token TEXT;
CREATE INDEX idx_sessions_push ON sessions (push_token) WHERE push_token IS NOT NULL;

ALTER TABLE pending_logins ADD COLUMN app TEXT CHECK (app IN ('android', 'ios'));

-- a login code works only where it was asked for: an app's platform, or NULL for the web
ALTER TABLE login_codes ADD COLUMN platform TEXT CHECK (platform IN ('android', 'ios'));

-- single-use values handed to an app so its attestation can't be replayed
CREATE TABLE app_challenges (
  challenge TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_app_challenges_expires ON app_challenges (expires_at);

-- an iPhone's App Attest key, kept from the attestation so later assertions can be checked against its counter
CREATE TABLE app_keys (
  key_id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  env TEXT NOT NULL CHECK (env IN ('production', 'development')),
  created_at INTEGER NOT NULL
);

-- what an app holds for a client: tied to one link, which is looked up again on every request
CREATE TABLE client_sessions (
  token_hash TEXT PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  region TEXT NOT NULL,
  link_hash TEXT NOT NULL,
  app TEXT NOT NULL CHECK (app IN ('android', 'ios')),
  push_token TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_client_sessions_link ON client_sessions (region, link_hash);
CREATE INDEX idx_client_sessions_push ON client_sessions (push_token) WHERE push_token IS NOT NULL;
