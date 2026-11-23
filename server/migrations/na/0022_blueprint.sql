-- which of a request's items for each person an item was made from, so an edit to it can reach the people added later
ALTER TABLE items ADD COLUMN blueprint TEXT;
