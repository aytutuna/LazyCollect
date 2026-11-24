-- the language of a request: its checklist, the client's page and the emails about it
ALTER TABLE requests ADD COLUMN locale TEXT NOT NULL DEFAULT 'en';
