-- for the cron that starts the retention clock of open requests whose link has run out
CREATE INDEX idx_requests_open_deadline ON requests (deadline) WHERE status = 'open' AND ended_at IS NULL;
