-- Cockpit version snapshots (BayClaw fork).
--
-- One row is a whole board frozen in the import-document shape: the same JSON
-- `multica cockpit import` consumes, so a restore is literally an import of
-- the payload and there is exactly one format to keep true. Snapshots are
-- taken automatically before every import and every restore (both destroy the
-- board they replace), and manually on demand.
--
-- No foreign keys (repository rule). cockpit_snapshot carries workspace_id so
-- workspace teardown can sweep it in the same single statement as the rest of
-- the cockpit tables.
CREATE TABLE cockpit_snapshot (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id   UUID NOT NULL,
    cockpit_id     UUID NOT NULL,
    -- 'import' | 'restore' | 'manual'
    trigger_kind   TEXT NOT NULL,
    label          TEXT NOT NULL DEFAULT '',
    -- The frozen board, as an import document.
    payload        JSONB NOT NULL,
    node_count     INTEGER NOT NULL DEFAULT 0,
    -- Who froze it: 'member' or 'agent'. The label is the display name
    -- resolved at write time, so the list stays readable even after the
    -- actor leaves the workspace.
    created_by_type  TEXT NOT NULL DEFAULT '',
    created_by_label TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
