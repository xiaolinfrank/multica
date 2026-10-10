-- Dedicated domain facts; application code validates relationships and cleanup.
CREATE TABLE IF NOT EXISTS cockpit_acceptance_criterion (
id UUID NOT NULL, workspace_id UUID NOT NULL, node_id UUID NOT NULL, title TEXT NOT NULL,
description TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL, revision BIGINT NOT NULL DEFAULT 1,
removed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
