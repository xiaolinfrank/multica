-- Attach the CONCURRENTLY-built unique index as the table's primary key.
ALTER TABLE module
    ADD CONSTRAINT module_pkey PRIMARY KEY USING INDEX module_pkey_uidx;
