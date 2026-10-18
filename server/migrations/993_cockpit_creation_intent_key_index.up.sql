CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS cockpit_creation_intent_key_idx ON cockpit_creation_intent(workspace_id,resource_kind,creation_key);
