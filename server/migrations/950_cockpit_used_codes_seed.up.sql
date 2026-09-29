-- Every code a live node wears has been used by definition; record them so
-- day-one next-code answers already skip past the existing rows. Codes
-- deleted before this migration are unrecoverable — the ledger starts
-- here, on what still exists.
INSERT INTO cockpit_used_codes (workspace_id, cockpit_id, code)
SELECT DISTINCT workspace_id, cockpit_id, code
FROM cockpit_node;
