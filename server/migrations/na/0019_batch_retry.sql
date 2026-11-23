-- a blocked batch waits until next_try_at instead of being looked at on every run
ALTER TABLE batches ADD COLUMN next_try_at INTEGER;
ALTER TABLE batches ADD COLUMN blocked_since INTEGER;
ALTER TABLE batches ADD COLUMN stop_reason TEXT;
UPDATE batches SET next_try_at = send_at;
DROP INDEX idx_batches_due;
CREATE INDEX idx_batches_try ON batches (next_try_at) WHERE status IN ('scheduled', 'sending');
