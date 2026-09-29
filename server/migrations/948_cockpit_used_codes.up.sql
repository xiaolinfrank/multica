-- Fork-only (900-999 range): the ledger of codes a board has ever handed out.
--
-- The gantt's "new execution task" mints `DIR-NN` codes under a direction,
-- and until now "the next free number" only looked at rows that still
-- exist: delete a task and its number comes back, and two different tasks
-- have then worn the same code in different weeks. Once handed out, a code
-- stays handed out — the row is written on create (and on rename and on
-- import) and deliberately outlives the node it named. Identity is
-- (cockpit_id, code), so no surrogate id and no inline PRIMARY KEY (repo
-- convention, see 923-925): the backing unique index is built CONCURRENTLY
-- in 949, live rows are seeded from cockpit_node in 950, and the index is
-- attached as the primary key in 951. No foreign
-- key: the sweep lives in DeleteWorkspaceCockpitData.
CREATE TABLE cockpit_used_codes (
    workspace_id UUID NOT NULL,
    cockpit_id   UUID NOT NULL,
    code         TEXT NOT NULL,
    used_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
