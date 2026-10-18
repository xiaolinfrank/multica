-- Dedicated domain facts; application code validates relationships and cleanup.
CREATE TABLE IF NOT EXISTS cockpit_artifact_capture_attempt (
id UUID NOT NULL, workspace_id UUID NOT NULL, artifact_id UUID NOT NULL, version_id UUID NOT NULL,
attempt_number INTEGER NOT NULL, lease_token UUID NOT NULL, lease_expires_at TIMESTAMPTZ NOT NULL,
storage_key TEXT NOT NULL, object_url TEXT NOT NULL,
state TEXT NOT NULL DEFAULT 'created' CHECK (state IN ('created','verified','failed','abandoned')),
content_hash TEXT, size_bytes BIGINT, last_error TEXT NOT NULL DEFAULT '', io_finished_at TIMESTAMPTZ,
cleanup_status TEXT NOT NULL DEFAULT 'live' CHECK (cleanup_status IN ('live','pending','deleting','deleted')),
cleanup_token UUID, cleanup_lease_expires_at TIMESTAMPTZ, cleanup_next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
cleanup_attempts INTEGER NOT NULL DEFAULT 0, cleanup_error TEXT NOT NULL DEFAULT '',
created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
