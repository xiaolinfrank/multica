-- Fork-only (900-999 range): the many-to-many link between a cockpit node and
-- the issues that carry out the work. The source board stored a single
-- free-text "BIO-176（待确认）" per task; a real link is a set, and it resolves
-- to a live issue whose title and status the board can render.
--
-- No foreign key (repository rule): a deleted issue leaves a dangling row,
-- which the read path resolves by dropping links whose issue no longer exists.
CREATE TABLE cockpit_node_issue (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    node_id      UUID NOT NULL,
    issue_id     UUID NOT NULL,
    position     DOUBLE PRECISION NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
