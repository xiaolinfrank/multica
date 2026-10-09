ALTER TABLE cockpit_node
    DROP CONSTRAINT cockpit_node_module_requires_project,
    DROP COLUMN module_id,
    DROP COLUMN project_id;
