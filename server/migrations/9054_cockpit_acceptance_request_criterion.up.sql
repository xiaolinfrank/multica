-- Dedicated domain facts; application code validates relationships and cleanup.
CREATE TABLE IF NOT EXISTS cockpit_acceptance_request_criterion (
workspace_id UUID NOT NULL, request_id UUID NOT NULL, criterion_id UUID NOT NULL,
title TEXT NOT NULL, description TEXT NOT NULL, position INTEGER NOT NULL, revision BIGINT NOT NULL
);
