-- Attach the CONCURRENTLY-built unique index as the table's primary key.
ALTER TABLE cockpit_meeting_node
    ADD CONSTRAINT cockpit_meeting_node_pkey PRIMARY KEY USING INDEX cockpit_meeting_node_pkey_uidx;
