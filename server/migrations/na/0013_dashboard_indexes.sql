-- the home screen groups every item of an account's requests; this one is read without touching the table
CREATE INDEX idx_items_summary ON items (firm_id, request_id, status, required);
-- views and the status filter walk an account's live requests by status and deadline
CREATE INDEX idx_requests_status ON requests (firm_id, status, deadline) WHERE deleted_at IS NULL;
