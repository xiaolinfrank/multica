CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS cockpit_node_module_binding_unique
    ON cockpit_node (cockpit_id, module_id)
    WHERE module_id IS NOT NULL;
