-- Cockpit pending changes (BayClaw fork).
--
-- One row is a PROPOSED edit to one field of one node. What an agent writes
-- back (or a person files by hand) lands here first; nothing on the board
-- moves until a human applies or rejects it. This is the review queue the
-- prototype calls 待确认.
--
-- Values are stored as text and re-parsed at apply time, so a proposal can
-- outlive format tweaks without a migration. `old_value` is the snapshot taken
-- when the change was queued, for the queue's old → new diff; apply re-reads
-- the live column and records what it actually overwrote, so a decision made
-- against a board that moved underneath it still audits true.
--
-- No foreign keys (repository rule). workspace_id is carried for the
-- workspace-teardown sweep; node deletion and import clear the affected rows
-- in the same request, because there is no cascade to do it for them.
CREATE TABLE cockpit_pending_change (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id   UUID NOT NULL,
    cockpit_id     UUID NOT NULL,
    node_id        UUID NOT NULL,
    -- One of the node's plain data fields (name, status, end_date, progress,
    -- budget_amount, …). Tree-shape fields (code, parent_id, position) are
    -- deliberately not proposable: an accepted re-parent against a board that
    -- moved is not a review, it is a surprise.
    field          TEXT NOT NULL,
    old_value      TEXT NOT NULL DEFAULT '',
    new_value      TEXT NOT NULL,
    -- 'manual' | 'agent' — who proposed it. The queue badges agent rows so a
    -- reviewer knows whose word they are taking.
    source         TEXT NOT NULL DEFAULT 'manual',
    reason         TEXT NOT NULL DEFAULT '',
    -- 'pending' | 'applied' | 'rejected' | 'withdrawn'
    status         TEXT NOT NULL DEFAULT 'pending',
    created_by_type  TEXT NOT NULL DEFAULT '',
    created_by_label TEXT NOT NULL DEFAULT '',
    decided_by_type  TEXT NOT NULL DEFAULT '',
    decided_by_label TEXT NOT NULL DEFAULT '',
    decided_at     TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
