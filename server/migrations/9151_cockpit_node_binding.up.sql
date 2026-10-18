-- Stable bindings to existing project/module identities; inherited bindings
-- are resolved through parent_id, never copied into descendants.
-- Renumbered from 953 (main's fen-precision migration wears that number now);
-- idempotent so a database that already applied the old stem replays safely.
ALTER TABLE cockpit_node
    ADD COLUMN IF NOT EXISTS project_id UUID,
    ADD COLUMN IF NOT EXISTS module_id UUID;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cockpit_node_module_requires_project'
      AND conrelid = 'cockpit_node'::regclass
  ) THEN
    ALTER TABLE cockpit_node
      ADD CONSTRAINT cockpit_node_module_requires_project
      CHECK (module_id IS NULL OR project_id IS NOT NULL);
  END IF;
END $$;
