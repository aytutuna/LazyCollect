-- the people a request is about: a principal applicant, a spouse, dependants. Client data, so they go with the request.
-- An item can belong to one of them: person_pos is the person's position, as show_if_pos is an item's, so a copied
-- request keeps the link. label_base is the item's own wording before the person's name is added.
CREATE TABLE people (
  id TEXT PRIMARY KEY CHECK (length(id) = 32),
  firm_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('principal', 'spouse', 'child', 'other')),
  name TEXT NOT NULL,
  dob TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (firm_id, request_id) REFERENCES requests (firm_id, id)
);
CREATE UNIQUE INDEX idx_people_request ON people (firm_id, request_id, position);

-- items that apply to each person are kept here as the template items they came from, so a person added later gets them
ALTER TABLE requests ADD COLUMN per_person_json TEXT;
-- the date documents must stay valid until; empty means the deadline plus six months
ALTER TABLE requests ADD COLUMN valid_until TEXT;

ALTER TABLE items ADD COLUMN person_pos INTEGER;
ALTER TABLE items ADD COLUMN label_base TEXT;
-- translation companions: the position of the document they belong to, and which part of the set they are
ALTER TABLE items ADD COLUMN for_pos INTEGER;
ALTER TABLE items ADD COLUMN companion TEXT CHECK (companion IN ('question', 'translation', 'affidavit'));
ALTER TABLE items ADD COLUMN translation INTEGER NOT NULL DEFAULT 0 CHECK (translation IN (0, 1));
-- a document can ask for the date it expires, or for the date it was issued and count a number of months from it
ALTER TABLE items ADD COLUMN expiry_rule TEXT CHECK (expiry_rule IN ('expiry', 'issue'));
ALTER TABLE items ADD COLUMN valid_months INTEGER CHECK (valid_months BETWEEN 1 AND 120);
ALTER TABLE items ADD COLUMN expires_on TEXT;
ALTER TABLE items ADD COLUMN issued_on TEXT;
CREATE INDEX idx_items_person ON items (firm_id, request_id, person_pos) WHERE person_pos IS NOT NULL;
CREATE INDEX idx_items_expiry ON items (firm_id, request_id) WHERE expiry_rule IS NOT NULL;
