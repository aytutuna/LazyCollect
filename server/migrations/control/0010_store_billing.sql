-- where a firm's plan was bought, and the App Store subscription behind it; NULL is the web or a trial
ALTER TABLE firms ADD COLUMN plan_source TEXT CHECK (plan_source IN ('stripe', 'apple', 'play'));
ALTER TABLE firms ADD COLUMN apple_original_transaction_id TEXT;
CREATE UNIQUE INDEX idx_firms_apple ON firms (apple_original_transaction_id) WHERE apple_original_transaction_id IS NOT NULL;
UPDATE firms SET plan_source = 'stripe' WHERE stripe_subscription_id IS NOT NULL;
