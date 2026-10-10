-- Dedicated domain facts; application code validates relationships and cleanup.
CREATE TABLE IF NOT EXISTS cockpit_artifact_capture (
version_id UUID NOT NULL, workspace_id UUID NOT NULL, artifact_id UUID NOT NULL,
source_attachment_id UUID NOT NULL, source_storage_key TEXT NOT NULL, source_object_url TEXT NOT NULL,
source_filename TEXT NOT NULL, source_content_type TEXT NOT NULL, source_size_bytes BIGINT NOT NULL CHECK (source_size_bytes >= 0), expected_hash TEXT,
status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','retry_wait','succeeded','needs_attention')),
lease_token UUID, lease_expires_at TIMESTAMPTZ, current_attempt_id UUID,
attempts INTEGER NOT NULL DEFAULT 0, cycle_attempts INTEGER NOT NULL DEFAULT 0,
next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_error_code TEXT NOT NULL DEFAULT '', last_error TEXT NOT NULL DEFAULT '',
created_by UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
