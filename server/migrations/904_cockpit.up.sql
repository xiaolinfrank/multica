-- Fork-only (900-999 range): the project cockpit — a workspace's programme-level
-- WBS, milestone plan, budget and meeting log, rendered as one live board.
--
-- One cockpit per workspace, created lazily on first read. The row carries only
-- the board-level copy (annual goal, the three narrative summary cards); every
-- structural element lives in its own table so two people editing different
-- parts of the board never write the same row.
CREATE TABLE cockpit (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID NOT NULL,
    title           TEXT NOT NULL DEFAULT '',
    -- Annual objective shown in the banner, with its target date.
    goal_title      TEXT NOT NULL DEFAULT '',
    goal_date       DATE,
    -- The three narrative cards at the foot of the overview. Empty means
    -- "derive it from the tasks"; non-empty is an author's override.
    summary_overall TEXT NOT NULL DEFAULT '',
    summary_next    TEXT NOT NULL DEFAULT '',
    summary_support TEXT NOT NULL DEFAULT '',
    -- Free-text provenance line ("source of truth is BIO-314 …").
    basis           TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
