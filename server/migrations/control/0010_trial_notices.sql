-- one row per owner, trial end and kind of email, written before the email goes out so a run never sends one twice;
-- a changed trial end is a new trial and gets its emails again
CREATE TABLE trial_notices (
  firm_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('start', 'soon', 'end')),
  trial_ends_at INTEGER NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (firm_id, user_id, kind, trial_ends_at)
);
