-- the same for what was made in English before: Canadian English
UPDATE requests SET locale = 'en-CA' WHERE locale = 'en';
UPDATE clients SET locale = 'en-CA' WHERE locale = 'en';
UPDATE templates SET locale = 'en-CA' WHERE locale = 'en';
