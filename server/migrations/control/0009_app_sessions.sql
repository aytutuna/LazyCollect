-- sessions made by the phone apps carry which app, and the device's push token once it registers one
ALTER TABLE sessions ADD COLUMN app TEXT CHECK (app IN ('android', 'ios'));
ALTER TABLE sessions ADD COLUMN push_token TEXT;
CREATE INDEX idx_sessions_push ON sessions (push_token) WHERE push_token IS NOT NULL;

ALTER TABLE pending_logins ADD COLUMN app TEXT CHECK (app IN ('android', 'ios'));

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
