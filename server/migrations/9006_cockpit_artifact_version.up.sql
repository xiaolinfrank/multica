-- Dedicated domain facts; application code validates relationships and cleanup.
CREATE TABLE IF NOT EXISTS cockpit_artifact_version (
id UUID NOT NULL, workspace_id UUID NOT NULL, artifact_id UUID NOT NULL,
version_number INTEGER NOT NULL CHECK (version_number > 0), submission_key UUID NOT NULL, request_hash TEXT NOT NULL,
revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0), producer_issue_id UUID NOT NULL,
producer_issue_identifier TEXT NOT NULL, producer_issue_title TEXT NOT NULL, producer_run_id UUID,
source_meeting_id UUID, source_meeting_title TEXT NOT NULL DEFAULT '', source_minutes_version_id UUID, source_minutes_version_number INTEGER,
payload_kind TEXT NOT NULL CHECK (payload_kind IN ('text','attachment')), content TEXT, source_attachment_id UUID,
filename TEXT NOT NULL DEFAULT '', content_type TEXT NOT NULL DEFAULT '', size_bytes BIGINT, content_hash TEXT,
storage_key TEXT, object_url TEXT,
capture_status TEXT NOT NULL CHECK (capture_status IN ('queued','running','retry_wait','ready','needs_attention')),
capture_error_code TEXT NOT NULL DEFAULT '', capture_error TEXT NOT NULL DEFAULT '',
decision TEXT NOT NULL DEFAULT 'not_requested' CHECK (decision IN ('not_requested','pending','approved','changes_requested','rejected')),
reviewer_id UUID NOT NULL, review_issue_id UUID, reviewed_by UUID, feedback TEXT NOT NULL DEFAULT '', reviewed_at TIMESTAMPTZ,
submitted_by_type TEXT NOT NULL CHECK (submitted_by_type IN ('member','agent')), submitted_by_id UUID NOT NULL, submitted_by_user_id UUID NOT NULL,
created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
CHECK ((payload_kind='text' AND content IS NOT NULL AND source_attachment_id IS NULL) OR (payload_kind='attachment' AND content IS NULL AND source_attachment_id IS NOT NULL)),
CHECK (source_minutes_version_id IS NULL OR source_meeting_id IS NOT NULL),
CHECK (content_hash IS NULL OR content_hash ~ '^[a-f0-9]{64}$'), CHECK (size_bytes IS NULL OR size_bytes >= 0),
CHECK (decision='not_requested' OR (capture_status='ready' AND review_issue_id IS NOT NULL AND content_hash IS NOT NULL)),
CHECK (capture_status<>'ready' OR (content_hash IS NOT NULL AND size_bytes IS NOT NULL AND (payload_kind='text' OR (storage_key IS NOT NULL AND object_url IS NOT NULL))))
);
