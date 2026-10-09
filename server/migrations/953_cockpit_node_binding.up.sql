-- Stable bindings to existing project/module identities; inherited bindings
-- are resolved through parent_id, never copied into descendants.
ALTER TABLE cockpit_node
    ADD COLUMN project_id UUID,
    ADD COLUMN module_id UUID,
    ADD CONSTRAINT cockpit_node_module_requires_project CHECK (module_id IS NULL OR project_id IS NOT NULL);
