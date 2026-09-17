-- Backing index for module's primary key, attached in 925 via
-- PRIMARY KEY USING INDEX. Own single-statement migration so CONCURRENTLY runs
-- outside an implicit transaction (repo convention).
CREATE UNIQUE INDEX CONCURRENTLY module_pkey_uidx
    ON module (id);
