-- firms.locale is the language the account writes in; this is whether it writes to each client in the client's own language instead
ALTER TABLE firms ADD COLUMN client_langs INTEGER NOT NULL DEFAULT 0 CHECK (client_langs IN (0, 1));
