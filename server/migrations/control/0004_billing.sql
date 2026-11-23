ALTER TABLE firms ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE firms ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE firms ADD COLUMN current_period_end INTEGER;
ALTER TABLE firms ADD COLUMN cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0, 1));
ALTER TABLE firms ADD COLUMN closed_at INTEGER;
CREATE UNIQUE INDEX idx_firms_customer ON firms (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

CREATE TABLE stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
