-- Fork-only (900-999 range): the work-breakdown items a meeting was about.
-- A meeting's issues are the work it created; these are the branches of the
-- programme it moved — the L2/L3 rows of the execution gantt people pick when
-- they file the record, so the gantt can show which of its tasks were last
-- discussed and when.
--
-- No foreign key (repository rule): node deletion clears these rows in
-- application code, and the read path joins to cockpit_node anyway.
--
-- No surrogate id and no inline PRIMARY KEY — see 930 and the 923-925
-- convention.
CREATE TABLE cockpit_meeting_node (
    workspace_id UUID NOT NULL,
    meeting_id   UUID NOT NULL,
    node_id      UUID NOT NULL,
    position     DOUBLE PRECISION NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
