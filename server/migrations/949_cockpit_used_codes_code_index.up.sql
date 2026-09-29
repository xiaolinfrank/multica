-- Backing unique index for cockpit_used_codes; own single-statement
-- migration so CONCURRENTLY runs outside an implicit transaction (repo
-- convention). The next-code read and the create-time insert both key
-- off it, the latter through ON CONFLICT DO NOTHING.
CREATE UNIQUE INDEX CONCURRENTLY cockpit_used_codes_uidx
    ON cockpit_used_codes (cockpit_id, code);
