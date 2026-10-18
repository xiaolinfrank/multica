ALTER TABLE cockpit_minutes_export
 ADD COLUMN IF NOT EXISTS write_mode TEXT NOT NULL DEFAULT 'atomic' CHECK (write_mode IN ('atomic','create_only')),
 ADD COLUMN IF NOT EXISTS verified_path TEXT,
 ADD COLUMN IF NOT EXISTS receipt_path TEXT,
 ADD COLUMN IF NOT EXISTS verified_attempt_id UUID,
 ADD COLUMN IF NOT EXISTS receipt_hash TEXT;

-- Each lease records its intent before filesystem access. No filesystem cleanup
-- is implied by deleting these rows or their workspace.
CREATE TABLE IF NOT EXISTS cockpit_minutes_export_attempt (
 id UUID NOT NULL,
 workspace_id UUID NOT NULL,
 meeting_id UUID NOT NULL,
 export_id UUID NOT NULL,
 attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
 target_path TEXT NOT NULL,
 receipt_path TEXT NOT NULL,
 content_hash TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','failed','verified','recovered')),
 verified_path TEXT,
 verified_receipt_path TEXT,
 verified_attempt_id UUID,
 receipt_hash TEXT,
 size_bytes BIGINT,
 last_error_code TEXT NOT NULL DEFAULT '',
 last_error TEXT NOT NULL DEFAULT '',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 verified_at TIMESTAMPTZ
);
