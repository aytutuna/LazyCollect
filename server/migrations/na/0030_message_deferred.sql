-- when an email was first put off because the provider was busy; after a day it is given up on
ALTER TABLE messages ADD COLUMN deferred_at INTEGER;
