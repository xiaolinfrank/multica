CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS module_project_directory_unique ON module (project_id, lower(directory_name)) WHERE directory_name IS NOT NULL;
