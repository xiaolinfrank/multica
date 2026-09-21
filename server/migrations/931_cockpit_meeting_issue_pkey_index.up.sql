-- Backing index for cockpit_meeting_issue's primary key, attached in 932 via
-- PRIMARY KEY USING INDEX. Own single-statement migration so CONCURRENTLY
-- runs outside an implicit transaction (repo convention). It is also the
-- index the board's per-meeting read uses.
CREATE UNIQUE INDEX CONCURRENTLY cockpit_meeting_issue_pkey_uidx
    ON cockpit_meeting_issue (meeting_id, issue_id);
