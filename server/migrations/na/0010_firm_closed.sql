-- set in the batch that revokes a closing account's links, so nothing can mint or use one in the gap before the control database says closed
ALTER TABLE firm_settings ADD COLUMN closed_at INTEGER;
