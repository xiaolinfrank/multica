-- Attach the CONCURRENTLY-built unique index as the table's primary key.
ALTER TABLE cockpit_meeting_issue
    ADD CONSTRAINT cockpit_meeting_issue_pkey PRIMARY KEY USING INDEX cockpit_meeting_issue_pkey_uidx;
