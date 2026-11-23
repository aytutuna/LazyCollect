ALTER TABLE sessions ADD COLUMN id TEXT;
ALTER TABLE sessions ADD COLUMN label TEXT;
UPDATE sessions SET id = lower(hex(randomblob(16)));
CREATE UNIQUE INDEX idx_sessions_id ON sessions (id);
