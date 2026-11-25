-- the last time each step of the timed run worked or failed; the row "run" is a pass in which every step worked
CREATE TABLE timed_status (
  step TEXT PRIMARY KEY,
  ok_at INTEGER,
  failed_at INTEGER,
  error TEXT,
  alerted_at INTEGER
);
