-- a stop belongs to an address, so it survives a client being recreated or given another email; only the keyed hash is kept
CREATE TABLE email_stops (
  firm_id TEXT NOT NULL,
  email_hash TEXT NOT NULL,
  stopped_at INTEGER NOT NULL,
  PRIMARY KEY (firm_id, email_hash)
) WITHOUT ROWID;
