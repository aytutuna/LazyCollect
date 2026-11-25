-- the tax year a request was made for, the checklist it came from (a built-in id or one of the account's own), and the wording of
-- each item before the year was filled in, so Repeat can fill in the next one
ALTER TABLE requests ADD COLUMN tax_year INTEGER;
ALTER TABLE requests ADD COLUMN template_ref TEXT;
ALTER TABLE items ADD COLUMN tpl_json TEXT;
-- a copy of a built-in checklist keeps the facts of the years it was copied with, so it can say when the built-in has newer ones
ALTER TABLE templates ADD COLUMN source_id TEXT;
ALTER TABLE templates ADD COLUMN facts_json TEXT;
