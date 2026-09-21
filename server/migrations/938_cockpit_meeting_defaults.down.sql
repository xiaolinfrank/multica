ALTER TABLE cockpit
    DROP COLUMN IF EXISTS meeting_project_id,
    DROP COLUMN IF EXISTS meeting_module_id,
    DROP COLUMN IF EXISTS meeting_dir;
