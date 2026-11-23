-- staff invite emails have no request to hang a message on, but they count toward the account's daily email cap
CREATE TABLE staff_mail (
  id TEXT PRIMARY KEY CHECK (length(id) = 32),
  firm_id TEXT NOT NULL,
  sent_at INTEGER NOT NULL
);
CREATE INDEX idx_staff_mail_firm ON staff_mail (firm_id, sent_at);
