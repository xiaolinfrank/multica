-- Fork-only (900-999 range): the issues a meeting is carried out through. A
-- meeting creates work, and the work is an ordinary Multica issue — the
-- meeting's own task filed under the programme's meeting module, plus
-- whatever existing issues the meeting touched.
--
-- No foreign key (repository rule): a deleted issue leaves a dangling row,
-- which the read path drops by joining to issue.
--
-- No surrogate id and no inline PRIMARY KEY: the pair IS the identity, and
-- the repo convention (see 923-925) builds a new table's backing index
-- CONCURRENTLY in its own migration (931) and attaches it as the primary key
-- afterwards (932).
CREATE TABLE cockpit_meeting_issue (
    workspace_id UUID NOT NULL,
    meeting_id   UUID NOT NULL,
    issue_id     UUID NOT NULL,
    -- 'task' marks the issue the platform opened for this meeting; '' is a
    -- link someone made by hand. One meeting has at most one 'task', but that
    -- is an application rule, not a constraint — re-provisioning a meeting
    -- whose task was deleted must not be blocked by a unique index on a role.
    role         TEXT NOT NULL DEFAULT '',
    position     DOUBLE PRECISION NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
