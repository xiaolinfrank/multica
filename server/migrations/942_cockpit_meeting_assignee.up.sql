-- Fork-only (900-999 range): who a new meeting's task is assigned to.
--
-- A meeting's task defaults to the member who filed it, which is right when
-- the meeting is a diary entry and wrong once a programme has someone whose
-- job the minutes are. Here that is an agent ("会议纪要整理专员"); elsewhere
-- it is a person, and in a second deployment it is neither — so the choice is
-- a property of the PROGRAMME, remembered on the board, and never compiled in.
--
-- Two columns rather than one because an assignee in this schema is a pair:
-- assignee_type selects the table assignee_id points into ("member" / "agent"
-- / "squad"), and reading one without the other names the wrong row. Both
-- empty means what it has always meant — the member filing the meeting.
--
-- No foreign key (repository rule): an agent that is archived or deleted
-- leaves a board pointing at nothing, and the meeting handler validates the
-- pair on use and falls back to the member rather than refusing to file.
ALTER TABLE cockpit
    ADD COLUMN meeting_assignee_type TEXT NOT NULL DEFAULT '',
    ADD COLUMN meeting_assignee_id   UUID;
