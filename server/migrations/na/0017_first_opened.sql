-- the first time the client opened their link page, set once
ALTER TABLE requests ADD COLUMN first_opened_at INTEGER;
