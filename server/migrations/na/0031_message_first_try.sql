-- when an email was first tried; one that keeps being put off is given up on after a day, as long as the provider remembers its idempotency key
ALTER TABLE messages ADD COLUMN first_try_at INTEGER;
