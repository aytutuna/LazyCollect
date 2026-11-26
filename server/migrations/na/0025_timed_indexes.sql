-- the 24 hour count of an account's emails reads every message the account ever sent unless sent_at is in the index
CREATE INDEX idx_messages_firm_sent ON messages (firm_id, sent_at);
-- the sweep looks for removed files and for uploads that never finished
CREATE INDEX idx_files_deleted ON files (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX idx_examples_created ON examples (created_at);
