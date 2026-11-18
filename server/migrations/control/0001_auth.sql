CREATE TABLE firms (
  id TEXT PRIMARY KEY CHECK (length(id) = 32),
  name TEXT,
  region TEXT NOT NULL DEFAULT 'na',
  tz TEXT NOT NULL DEFAULT 'America/Toronto',
  locale TEXT NOT NULL DEFAULT 'en',
  plan_status TEXT NOT NULL CHECK (plan_status IN ('trialing', 'active', 'past_due', 'canceled')),
  trial_ends_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY CHECK (length(id) = 32),
  firm_id TEXT NOT NULL REFERENCES firms (id),
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  created_at INTEGER NOT NULL,
  disabled_at INTEGER
);
CREATE INDEX idx_users_firm ON users (firm_id);

CREATE TABLE login_codes (
  id TEXT PRIMARY KEY CHECK (length(id) = 32),
  email TEXT NOT NULL,
  email_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  link_hash TEXT NOT NULL UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  link_used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_login_codes_email ON login_codes (email_hash, created_at);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  firm_id TEXT NOT NULL REFERENCES firms (id),
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions (user_id);
