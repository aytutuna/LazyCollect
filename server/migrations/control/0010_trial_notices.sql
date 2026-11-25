-- one row per owner and trial email, written before the email goes out so a run never sends one twice
CREATE TABLE trial_notices (
  firm_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('start', 'soon', 'end')),
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (firm_id, user_id, kind)
);
