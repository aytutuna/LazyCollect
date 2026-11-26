-- English was Canadian English until US English became the base text; every account so far is Canadian
UPDATE firms SET locale = 'en-CA' WHERE locale = 'en';
