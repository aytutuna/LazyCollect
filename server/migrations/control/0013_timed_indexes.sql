-- the timed run clears expired rows and looks for ending trials and closed accounts every few minutes; none had an index to do it with
CREATE INDEX idx_login_codes_created ON login_codes (created_at);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);
CREATE INDEX idx_client_sessions_expires ON client_sessions (expires_at);
CREATE INDEX idx_stripe_events_received ON stripe_events (received_at);
CREATE INDEX idx_firms_trialing ON firms (trial_ends_at) WHERE plan_status = 'trialing' AND closed_at IS NULL;
CREATE INDEX idx_firms_apple_period ON firms (current_period_end) WHERE plan_source = 'apple';
CREATE INDEX idx_firms_closed ON firms (closed_at) WHERE closed_at IS NOT NULL;
