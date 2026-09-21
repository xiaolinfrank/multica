-- Backing index for cockpit_meeting_node's primary key, attached in 936 via
-- PRIMARY KEY USING INDEX. Own single-statement migration so CONCURRENTLY
-- runs outside an implicit transaction (repo convention).
CREATE UNIQUE INDEX CONCURRENTLY cockpit_meeting_node_pkey_uidx
    ON cockpit_meeting_node (meeting_id, node_id);
