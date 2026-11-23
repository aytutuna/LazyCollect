ALTER TABLE requests ADD COLUMN deleted_with_account INTEGER NOT NULL DEFAULT 0 CHECK (deleted_with_account IN (0, 1));
