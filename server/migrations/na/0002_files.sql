CREATE UNIQUE INDEX idx_items_scope ON items (firm_id, request_id, id);

CREATE TABLE files (
  id TEXT PRIMARY KEY CHECK (length(id) = 32),
  firm_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  upload_id TEXT NOT NULL,
  uploaded_by TEXT NOT NULL CHECK (uploaded_by IN ('client', 'user')),
  uploaded_at INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE (firm_id, id),
  UNIQUE (firm_id, item_id, upload_id),
  FOREIGN KEY (firm_id, request_id) REFERENCES requests (firm_id, id),
  FOREIGN KEY (firm_id, request_id, item_id) REFERENCES items (firm_id, request_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_files_item ON files (firm_id, item_id, uploaded_at);
CREATE INDEX idx_files_request ON files (firm_id, request_id);
