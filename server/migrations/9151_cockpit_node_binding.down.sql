ALTER TABLE cockpit_node
    DROP CONSTRAINT IF EXISTS cockpit_node_module_requires_project,
    DROP COLUMN IF EXISTS module_id,
    DROP COLUMN IF EXISTS project_id;
