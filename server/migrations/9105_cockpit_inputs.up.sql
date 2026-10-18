-- N2 draft: dedicated input facts; no foreign keys or inline indexes.
CREATE TABLE IF NOT EXISTS cockpit_input (
id UUID NOT NULL, workspace_id UUID NOT NULL, creation_key UUID NOT NULL,
request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
creation_receipt JSONB NOT NULL CHECK (jsonb_typeof(creation_receipt)='object' AND octet_length(creation_receipt::text)<=262144),
title TEXT NOT NULL CHECK (octet_length(title) BETWEEN 1 AND 512),
description TEXT NOT NULL DEFAULT '' CHECK (octet_length(description)<=16000),
project_id UUID, origin_issue_id UUID, revision BIGINT NOT NULL DEFAULT 1 CHECK (revision>0),
current_version_id UUID, actor_type TEXT NOT NULL CHECK (actor_type IN ('member','agent')), actor_id UUID NOT NULL,
credential_owner_user_id UUID NOT NULL, authorizing_user_id UUID NOT NULL,
source_agent_id UUID, source_run_id UUID, source_issue_id UUID, source_runtime_id UUID,
archived_at TIMESTAMPTZ, archived_by UUID,
created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
CHECK ((actor_type='member' AND actor_id=credential_owner_user_id AND actor_id=authorizing_user_id AND source_agent_id IS NULL AND source_run_id IS NULL AND source_issue_id IS NULL AND source_runtime_id IS NULL)
OR (actor_type='agent' AND source_agent_id IS NOT NULL AND actor_id=source_agent_id AND source_run_id IS NOT NULL AND source_issue_id IS NOT NULL AND source_runtime_id IS NOT NULL)), CHECK ((archived_at IS NULL)=(archived_by IS NULL))
);

CREATE TABLE IF NOT EXISTS cockpit_input_version (
id UUID NOT NULL, workspace_id UUID NOT NULL, input_id UUID NOT NULL,
version_number INTEGER NOT NULL CHECK (version_number>0), submission_key UUID NOT NULL,
request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
submission_receipt JSONB NOT NULL CHECK (jsonb_typeof(submission_receipt)='object' AND octet_length(submission_receipt::text)<=262144), revision BIGINT NOT NULL DEFAULT 1 CHECK (revision>0),
actor_type TEXT NOT NULL CHECK (actor_type IN ('member','agent')), actor_id UUID NOT NULL,
credential_owner_user_id UUID NOT NULL, authorizing_user_id UUID NOT NULL,
source_agent_id UUID, source_run_id UUID, source_issue_id UUID, source_runtime_id UUID, CHECK ((actor_type='member' AND actor_id=credential_owner_user_id AND actor_id=authorizing_user_id AND source_agent_id IS NULL AND source_run_id IS NULL AND source_issue_id IS NULL AND source_runtime_id IS NULL)
OR (actor_type='agent' AND source_agent_id IS NOT NULL AND actor_id=source_agent_id AND source_run_id IS NOT NULL AND source_issue_id IS NOT NULL AND source_runtime_id IS NOT NULL)),
source_kind TEXT NOT NULL CHECK (source_kind IN ('upload','nas_file','attachment','artifact_version')),
payload_kind TEXT NOT NULL CHECK (payload_kind IN ('file','text')),
source_attachment_id UUID, source_attachment_issue_id UUID,
source_root_id UUID, source_root_path TEXT, source_relative_path TEXT, source_root_config_hash TEXT,
source_root_identity TEXT, source_file_identity TEXT, source_size BIGINT, source_mtime_ns BIGINT,
source_artifact_id UUID, source_artifact_version_id UUID,
filename TEXT NOT NULL CHECK (octet_length(filename) BETWEEN 1 AND 255),
content_type TEXT NOT NULL CHECK (octet_length(content_type) BETWEEN 1 AND 255),
declared_size_bytes BIGINT CHECK (declared_size_bytes BETWEEN 0 AND 524288000),
client_sha256 TEXT CHECK (client_sha256 ~ '^[0-9a-f]{64}$'),
pinned_size_bytes BIGINT CHECK (pinned_size_bytes BETWEEN 0 AND 524288000),
content_hash TEXT CHECK (content_hash ~ '^[0-9a-f]{64}$'), pinned_at TIMESTAMPTZ,
capture_state TEXT NOT NULL CHECK (capture_state IN ('awaiting_upload','queued','capturing','ready','needs_attention')),
capture_error_code TEXT NOT NULL DEFAULT '', capture_error TEXT NOT NULL DEFAULT '' CHECK (octet_length(capture_error)<=16000),
active_transfer_id UUID, accepted_transfer_id UUID, current_transfer_id UUID, ready_at TIMESTAMPTZ,
availability TEXT NOT NULL DEFAULT 'unknown' CHECK (availability IN ('unknown','checking','available','unavailable')),
verification_generation BIGINT NOT NULL DEFAULT 0 CHECK (verification_generation>=0),
verification_lease_token UUID, verification_lease_expires_at TIMESTAMPTZ,
verification_due_at TIMESTAMPTZ, checked_at TIMESTAMPTZ, proof_expires_at TIMESTAMPTZ,
provider_object_identity TEXT, verification_error_code TEXT NOT NULL DEFAULT '',
created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
CHECK ((pinned_size_bytes IS NULL)=(content_hash IS NULL) AND (content_hash IS NULL)=(pinned_at IS NULL)),
CHECK ((verification_lease_token IS NULL)=(verification_lease_expires_at IS NULL)),
CHECK ((capture_state='ready')=(ready_at IS NOT NULL)),
CHECK (ready_at IS NULL OR (content_hash IS NOT NULL AND (current_transfer_id IS NOT NULL OR source_kind='artifact_version'))),
CHECK (payload_kind='file' OR source_kind='artifact_version'),
CHECK (source_kind='nas_file' OR num_nonnulls(source_root_id,source_root_path,source_relative_path,source_root_config_hash,source_root_identity,source_file_identity,source_size,source_mtime_ns)=0),
CHECK (source_kind<>'artifact_version' OR capture_state='ready'),
CHECK ((source_kind='upload' AND declared_size_bytes IS NOT NULL AND source_attachment_id IS NULL AND source_attachment_issue_id IS NULL AND source_root_id IS NULL AND source_artifact_id IS NULL AND source_artifact_version_id IS NULL)
OR (source_kind='attachment' AND source_attachment_id IS NOT NULL AND source_attachment_issue_id IS NOT NULL AND source_root_id IS NULL AND source_artifact_id IS NULL AND source_artifact_version_id IS NULL)
OR (source_kind='nas_file' AND source_root_id IS NOT NULL AND source_root_path IS NOT NULL AND source_relative_path IS NOT NULL AND source_root_config_hash IS NOT NULL AND source_root_identity IS NOT NULL AND source_file_identity IS NOT NULL AND source_size IS NOT NULL AND source_mtime_ns IS NOT NULL AND source_attachment_id IS NULL AND source_attachment_issue_id IS NULL AND source_artifact_id IS NULL AND source_artifact_version_id IS NULL)
OR (source_kind='artifact_version' AND source_artifact_id IS NOT NULL AND source_artifact_version_id IS NOT NULL AND source_attachment_id IS NULL AND source_attachment_issue_id IS NULL AND source_root_id IS NULL AND accepted_transfer_id IS NULL))
);

CREATE TABLE IF NOT EXISTS cockpit_input_transfer (
id UUID NOT NULL, workspace_id UUID NOT NULL, input_id UUID NOT NULL, version_id UUID NOT NULL,
transfer_number INTEGER NOT NULL CHECK (transfer_number>0), command_key UUID NOT NULL,
request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
command_receipt JSONB NOT NULL CHECK (jsonb_typeof(command_receipt)='object' AND octet_length(command_receipt::text)<=262144),
actor_type TEXT, actor_id UUID, credential_owner_user_id UUID, authorizing_user_id UUID,
source_agent_id UUID, source_run_id UUID, source_issue_id UUID, source_runtime_id UUID,
kind TEXT NOT NULL CHECK (kind IN ('direct_upload','source_capture')),
mode TEXT NOT NULL CHECK (mode IN ('initial','retry_source','upload_matching_bytes')),
state TEXT NOT NULL CHECK (state IN ('awaiting_bytes','queued','reading','pinned','writing','verifying','awaiting_finalize','verified','failed','abandoned','expired')),
revision BIGINT NOT NULL DEFAULT 1 CHECK (revision>0), replaces_transfer_id UUID,
owned_storage_key TEXT NOT NULL,
lease_token UUID, lease_expires_at TIMESTAMPTZ, next_attempt_at TIMESTAMPTZ,
expected_bytes BIGINT NOT NULL CHECK (expected_bytes BETWEEN 0 AND 524288000),
bytes_received BIGINT CHECK (bytes_received>=0 AND bytes_received<=expected_bytes),
content_pin_at TIMESTAMPTZ, pinned_size_bytes BIGINT CHECK (pinned_size_bytes BETWEEN 0 AND 524288000), content_hash TEXT CHECK (content_hash ~ '^[0-9a-f]{64}$'),
source_before_root_identity TEXT, source_before_file_identity TEXT, source_before_size BIGINT, source_before_mtime_ns BIGINT,
source_after_file_identity TEXT, source_after_size BIGINT, source_after_mtime_ns BIGINT,
session_expires_at TIMESTAMPTZ, io_finished_at TIMESTAMPTZ, io_outcome TEXT,
error_code TEXT NOT NULL DEFAULT '', error_message TEXT NOT NULL DEFAULT '' CHECK (octet_length(error_message)<=16000),
finalize_key UUID, finalize_hash TEXT, finalize_receipt JSONB,
abort_key UUID, abort_hash TEXT, abort_receipt JSONB,
created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ,
workspace_deleted_at TIMESTAMPTZ,
cleanup_state TEXT NOT NULL DEFAULT 'retained' CHECK (cleanup_state IN ('retained','pending','running','retry_wait','deleted')),
cleanup_due_at TIMESTAMPTZ, cleanup_lease_token UUID, cleanup_lease_expires_at TIMESTAMPTZ, cleanup_verified_at TIMESTAMPTZ,
CHECK ((lease_token IS NULL)=(lease_expires_at IS NULL)),
CHECK ((cleanup_lease_token IS NULL)=(cleanup_lease_expires_at IS NULL)),
CHECK ((pinned_size_bytes IS NULL)=(content_hash IS NULL) AND (content_hash IS NULL)=(content_pin_at IS NULL)),
CHECK ((kind='direct_upload' AND session_expires_at IS NOT NULL AND state<>'queued') OR (kind='source_capture' AND session_expires_at IS NULL AND state<>'awaiting_bytes')),
CHECK (mode<>'upload_matching_bytes' OR kind='direct_upload'),
CHECK ((finalize_key IS NULL AND finalize_hash IS NULL AND finalize_receipt IS NULL) OR (finalize_key IS NOT NULL AND finalize_hash IS NOT NULL AND finalize_hash ~ '^[0-9a-f]{64}$' AND finalize_receipt IS NOT NULL AND jsonb_typeof(finalize_receipt)='object' AND octet_length(finalize_receipt::text)<=262144)),
CHECK ((abort_key IS NULL AND abort_hash IS NULL AND abort_receipt IS NULL) OR (abort_key IS NOT NULL AND abort_hash IS NOT NULL AND abort_hash ~ '^[0-9a-f]{64}$' AND abort_receipt IS NOT NULL AND jsonb_typeof(abort_receipt)='object' AND octet_length(abort_receipt::text)<=262144)),
CHECK ((workspace_deleted_at IS NOT NULL AND actor_type IS NULL AND actor_id IS NULL AND credential_owner_user_id IS NULL AND authorizing_user_id IS NULL AND source_agent_id IS NULL AND source_run_id IS NULL AND source_issue_id IS NULL AND source_runtime_id IS NULL)
OR (workspace_deleted_at IS NULL AND actor_type IS NOT NULL AND actor_id IS NOT NULL AND credential_owner_user_id IS NOT NULL AND authorizing_user_id IS NOT NULL AND
((actor_type='member' AND actor_id=credential_owner_user_id AND actor_id=authorizing_user_id AND source_agent_id IS NULL AND source_run_id IS NULL AND source_issue_id IS NULL AND source_runtime_id IS NULL)
OR (actor_type='agent' AND source_agent_id IS NOT NULL AND actor_id=source_agent_id AND source_run_id IS NOT NULL AND source_issue_id IS NOT NULL AND source_runtime_id IS NOT NULL))))
);

CREATE TABLE IF NOT EXISTS cockpit_input_reference (
id UUID NOT NULL, workspace_id UUID NOT NULL, meeting_id UUID NOT NULL, agenda_id UUID,
input_id UUID NOT NULL, input_version_id UUID NOT NULL,
purpose TEXT NOT NULL CHECK (purpose IN ('material','recording','supporting')),
creation_key UUID NOT NULL, request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
creation_receipt JSONB NOT NULL CHECK (jsonb_typeof(creation_receipt)='object' AND octet_length(creation_receipt::text)<=262144),
actor_type TEXT NOT NULL CHECK (actor_type IN ('member','agent')), actor_id UUID NOT NULL,
credential_owner_user_id UUID NOT NULL, authorizing_user_id UUID NOT NULL,
source_agent_id UUID, source_run_id UUID, source_issue_id UUID, source_runtime_id UUID, CHECK ((actor_type='member' AND actor_id=credential_owner_user_id AND actor_id=authorizing_user_id AND source_agent_id IS NULL AND source_run_id IS NULL AND source_issue_id IS NULL AND source_runtime_id IS NULL)
OR (actor_type='agent' AND source_agent_id IS NOT NULL AND actor_id=source_agent_id AND source_run_id IS NOT NULL AND source_issue_id IS NOT NULL AND source_runtime_id IS NOT NULL)),
created_at TIMESTAMPTZ NOT NULL DEFAULT now(), removed_at TIMESTAMPTZ, removed_by UUID,
removal_key UUID, removal_hash TEXT, removal_receipt JSONB,
CHECK ((removed_at IS NULL AND removed_by IS NULL AND removal_key IS NULL AND removal_hash IS NULL AND removal_receipt IS NULL)
OR (removed_at IS NOT NULL AND removed_by IS NOT NULL AND removal_key IS NOT NULL AND removal_hash IS NOT NULL AND removal_hash ~ '^[0-9a-f]{64}$' AND removal_receipt IS NOT NULL AND jsonb_typeof(removal_receipt)='object' AND octet_length(removal_receipt::text)<=262144))
);

CREATE TABLE IF NOT EXISTS cockpit_issue_input_manifest (
workspace_id UUID NOT NULL, issue_id UUID NOT NULL, revision BIGINT NOT NULL CHECK (revision>0),
current_version_id UUID NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_by UUID NOT NULL
);
CREATE TABLE IF NOT EXISTS cockpit_issue_input_manifest_version (
id UUID NOT NULL, workspace_id UUID NOT NULL, issue_id UUID NOT NULL,
version_number INTEGER NOT NULL CHECK (version_number>0), command_key UUID NOT NULL,
request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
receipt JSONB NOT NULL CHECK (jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<=262144),
manifest_hash TEXT NOT NULL CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
note TEXT NOT NULL DEFAULT '' CHECK (octet_length(note)<=16000),
item_total INTEGER NOT NULL CHECK (item_total BETWEEN 0 AND 200),
required_total INTEGER NOT NULL CHECK (required_total BETWEEN 0 AND item_total),
created_by UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cockpit_issue_input_manifest_item (
workspace_id UUID NOT NULL, manifest_version_id UUID NOT NULL, position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 199),
input_version_id UUID NOT NULL,
purpose TEXT NOT NULL CHECK (purpose IN ('material','recording','supporting')), required BOOLEAN NOT NULL
);

ALTER TABLE agent_task_queue ADD COLUMN IF NOT EXISTS input_manifest_version_id UUID,
ADD COLUMN IF NOT EXISTS input_preparation_state TEXT NOT NULL DEFAULT 'not_recorded',
ADD COLUMN IF NOT EXISTS input_preparation_hash TEXT,
ADD COLUMN IF NOT EXISTS input_prepared_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS input_prepared_dispatched_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS input_preparation_error_code TEXT NOT NULL DEFAULT '';
ALTER TABLE cockpit_artifact_version ADD COLUMN IF NOT EXISTS input_manifest_version_id UUID;
