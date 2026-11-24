-- sessions made by the phone apps carry which app, and the device's push token once it registers one
ALTER TABLE sessions ADD COLUMN app TEXT CHECK (app IN ('android', 'ios'));
ALTER TABLE sessions ADD COLUMN push_token TEXT;
CREATE INDEX idx_sessions_push ON sessions (push_token) WHERE push_token IS NOT NULL;

ALTER TABLE pending_logins ADD COLUMN app TEXT CHECK (app IN ('android', 'ios'));
