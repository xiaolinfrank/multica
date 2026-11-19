-- Sibling folders must not collide, case-insensitively: the directory name is
-- what the NAS exposes and what the agent brief points at. NULL (not yet
-- materialised) rows are outside the constraint.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS cockpit_node_directory_unique
    ON cockpit_node (parent_id, lower(directory_name))
    WHERE directory_name IS NOT NULL;
