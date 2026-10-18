CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS cockpit_primary_creation_idx ON cockpit_issue_primary (workspace_id,creation_key) WHERE creation_key IS NOT NULL;
