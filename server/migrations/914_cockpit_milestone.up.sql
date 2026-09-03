-- Fork-only (900-999 range): the programme's milestone plan. A milestone is not
-- a task — it has no owner, no progress and no budget; it is a date the
-- programme commits to, with the condition that proves it met and the guard
-- that keeps it on track.
CREATE TABLE cockpit_milestone (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    cockpit_id   UUID NOT NULL,
    name         TEXT NOT NULL DEFAULT '',
    plan_date    DATE,
    -- Set once the milestone actually landed. A milestone with an actual date
    -- reads as done regardless of its status label.
    actual_date  DATE,
    status       TEXT NOT NULL DEFAULT '',
    -- The branch this milestone belongs to, by cockpit_node.id. Nullable so a
    -- programme-wide milestone need not be pinned to one module.
    node_id      UUID,
    -- Acceptance condition and the governance that protects the date.
    condition    TEXT NOT NULL DEFAULT '',
    guard        TEXT NOT NULL DEFAULT '',
    position     DOUBLE PRECISION NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
