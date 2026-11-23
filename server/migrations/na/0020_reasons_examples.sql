-- why a document was sent back: a JSON array of reason codes, next to the free-text note; files that were live at that
-- review are marked so the client page and the dashboard can tell the sent-back file from a newer one
ALTER TABLE items ADD COLUMN reject_reasons TEXT;
ALTER TABLE files ADD COLUMN sent_back_at INTEGER;

-- an example of what a good document looks like. items.example holds an examples id, or the name of a built-in
-- illustration; templates keep the same value in their items_json. Examples belong to the account, not to a client.
ALTER TABLE items ADD COLUMN example TEXT;
CREATE TABLE examples (
  id TEXT PRIMARY KEY CHECK (length(id) = 32),
  firm_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_examples_firm ON examples (firm_id, created_at);
CREATE INDEX idx_items_example ON items (firm_id, example) WHERE example IS NOT NULL;
