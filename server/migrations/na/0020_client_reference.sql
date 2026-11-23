-- a file number or other reference from the account's own records, filled by the CSV import or by hand
ALTER TABLE clients ADD COLUMN reference TEXT;
-- the import looks clients up by address; stored addresses are lowercased, but older rows may not be
CREATE INDEX idx_clients_email ON clients (firm_id, lower(email)) WHERE email IS NOT NULL;
