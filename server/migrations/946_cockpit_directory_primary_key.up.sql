-- Attach the CONCURRENTLY-built unique index as the table's primary key.
ALTER TABLE cockpit_directory
    ADD CONSTRAINT cockpit_directory_pkey PRIMARY KEY USING INDEX cockpit_directory_pkey_uidx;
