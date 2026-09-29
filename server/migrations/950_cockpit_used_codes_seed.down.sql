-- The seed rows are indistinguishable from codes spent after the migration
-- ran, so the down direction clears the whole ledger on purpose: rolling the
-- seed back means starting the spent-code history over.
DELETE FROM cockpit_used_codes;
