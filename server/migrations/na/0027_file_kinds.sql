-- the kinds of file an account takes, as a JSON list of kind ids; null means the ones that are on to begin with
ALTER TABLE firm_settings ADD COLUMN file_kinds TEXT;
