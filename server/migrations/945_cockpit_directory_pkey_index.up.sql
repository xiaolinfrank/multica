-- Backing index for cockpit_directory's primary key, attached in 946 via
-- PRIMARY KEY USING INDEX. Own single-statement migration so CONCURRENTLY
-- runs outside an implicit transaction (repo convention). It is also the
-- index the board's directory read and the upsert's ON CONFLICT use.
CREATE UNIQUE INDEX CONCURRENTLY cockpit_directory_pkey_uidx
    ON cockpit_directory (cockpit_id, party, name);
