-- set when the mail provider reports that an address does not exist; a changed email clears the client's mark
ALTER TABLE clients ADD COLUMN email_bounced_at INTEGER;
ALTER TABLE messages ADD COLUMN bounced_at INTEGER;
-- a bounce notice names the message by the provider's id
CREATE INDEX idx_messages_provider ON messages (provider_id) WHERE provider_id IS NOT NULL;
