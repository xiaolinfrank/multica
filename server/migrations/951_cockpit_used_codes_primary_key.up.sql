-- Attach the CONCURRENTLY-built unique index as the table's primary key.
ALTER TABLE cockpit_used_codes
    ADD CONSTRAINT cockpit_used_codes_pkey PRIMARY KEY USING INDEX cockpit_used_codes_uidx;
