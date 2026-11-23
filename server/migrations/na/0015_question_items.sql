-- items can be questions: the kind says what is asked, options_json lists the choices, and the answer lives here with the
-- rest of the client's data. show_if_pos names the position of the yes/no or choice item that must have show_if_value as its
-- answer for this one to be shown; a position survives copying a checklist, an id would not. A question reuses the statuses
-- (answered is 'submitted'), so no CHECK changes and the table is not rebuilt.
ALTER TABLE items ADD COLUMN kind TEXT NOT NULL DEFAULT 'file' CHECK (kind IN ('file', 'yesno', 'text', 'longtext', 'number', 'date', 'choice', 'multi'));
ALTER TABLE items ADD COLUMN options_json TEXT;
ALTER TABLE items ADD COLUMN show_if_pos INTEGER;
ALTER TABLE items ADD COLUMN show_if_value TEXT;
ALTER TABLE items ADD COLUMN answer TEXT;
ALTER TABLE items ADD COLUMN answer_at INTEGER;
