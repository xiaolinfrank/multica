CREATE UNIQUE INDEX CONCURRENTLY cockpit_node_project_binding_unique
    ON cockpit_node (cockpit_id, project_id)
    WHERE project_id IS NOT NULL AND module_id IS NULL;
