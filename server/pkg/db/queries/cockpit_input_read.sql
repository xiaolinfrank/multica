-- name: ReadCockpitInputHeaders :many
SELECT id, workspace_id, creation_key, title, description, project_id, origin_issue_id, revision, current_version_id, actor_type, actor_id, credential_owner_user_id, authorizing_user_id, source_agent_id, source_run_id, source_issue_id, source_runtime_id, archived_at, archived_by, created_at, updated_at
FROM cockpit_input WHERE workspace_id=$1 AND id=ANY(sqlc.arg(ids)::uuid[]);

-- name: ReadCockpitInputVersions :many
SELECT id, workspace_id, input_id, version_number, submission_key, revision, actor_type, actor_id, credential_owner_user_id, authorizing_user_id, source_agent_id, source_run_id, source_issue_id, source_runtime_id, source_kind, payload_kind, source_attachment_id, source_attachment_issue_id, source_root_id, source_relative_path, source_root_config_hash, source_root_path, source_artifact_id, source_artifact_version_id, filename, content_type, declared_size_bytes, pinned_size_bytes, content_hash, pinned_at, capture_state, capture_error_code, active_transfer_id, accepted_transfer_id, current_transfer_id, ready_at, (CASE WHEN availability='available' AND (proof_expires_at IS NULL OR proof_expires_at<=now() OR checked_at IS NULL) THEN 'unknown'::text ELSE availability END)::text AS availability, verification_generation, verification_lease_expires_at, verification_due_at, checked_at, proof_expires_at, verification_error_code, created_at, updated_at
FROM cockpit_input_version WHERE workspace_id=$1 AND id=ANY(sqlc.arg(ids)::uuid[]);

-- name: ReadCockpitInputTransfers :many
SELECT id, workspace_id, input_id, version_id, transfer_number, command_key, actor_type, actor_id, credential_owner_user_id, authorizing_user_id, source_agent_id, source_run_id, source_issue_id, source_runtime_id, kind, mode, state, revision, replaces_transfer_id, lease_expires_at, next_attempt_at, expected_bytes, bytes_received, content_pin_at, pinned_size_bytes, content_hash, session_expires_at, io_finished_at, io_outcome, error_code, finalize_key, finalize_hash, abort_key, abort_hash, created_at, updated_at, finished_at, workspace_deleted_at
FROM cockpit_input_transfer WHERE workspace_id=$1 AND id=ANY(sqlc.arg(ids)::uuid[]) AND workspace_deleted_at IS NULL;

-- name: ReadCockpitInputReferences :many
SELECT id, workspace_id, meeting_id, agenda_id, input_id, input_version_id, purpose, creation_key, actor_type, actor_id, credential_owner_user_id, authorizing_user_id, source_agent_id, source_run_id, source_issue_id, source_runtime_id, created_at, removed_at, removed_by, removal_key
FROM cockpit_input_reference WHERE workspace_id=$1 AND id=ANY(sqlc.arg(ids)::uuid[]);

-- name: ReadCockpitInputAgentNames :many
SELECT id,name FROM agent WHERE workspace_id=$1 AND id=ANY(sqlc.arg(ids)::uuid[]);

-- name: ReadCockpitInputSourceArtifacts :many
SELECT a.id,a.title FROM cockpit_artifact a WHERE a.workspace_id=$1 AND a.id=ANY(sqlc.arg(ids)::uuid[]);

-- name: ReadCockpitInputSourceArtifactVersions :many
SELECT id,artifact_id,version_number,decision,capture_status FROM cockpit_artifact_version WHERE workspace_id=$1 AND id=ANY(sqlc.arg(ids)::uuid[]);

-- name: ReadCockpitInputSourceAttachments :many
SELECT id,issue_id FROM attachment WHERE workspace_id=$1 AND id=ANY(sqlc.arg(ids)::uuid[]);

-- name: ReadCockpitInputSourceMeetings :many
SELECT id,title,archived_at,occurrence_state FROM cockpit_meeting WHERE workspace_id=$1 AND id=ANY(sqlc.arg(ids)::uuid[]);

-- name: ReadCockpitInputSourceAgendas :many
SELECT id,meeting_id,title,removed_at FROM cockpit_meeting_agenda WHERE workspace_id=$1 AND id=ANY(sqlc.arg(ids)::uuid[]);

-- name: ReadCockpitInputPinnedVersions :many
SELECT input_version_id FROM cockpit_issue_input_manifest_item WHERE workspace_id=$1 AND manifest_version_id=$2 AND input_version_id=ANY(sqlc.arg(ids)::uuid[]);

-- name: ReadCockpitInputLatestTransfers :many
SELECT t.version_id,t.id,t.state,t.mode,t.error_code FROM unnest(sqlc.arg(ids)::uuid[]) AS selected(id)
CROSS JOIN LATERAL (
  SELECT version_id,id,state,mode,error_code FROM cockpit_input_transfer
  WHERE workspace_id=sqlc.arg(workspace_id) AND version_id=selected.id AND workspace_deleted_at IS NULL
  ORDER BY transfer_number DESC LIMIT 1
) t;

-- name: ListCockpitInputReadKeys :many
SELECT i.id,i.created_at FROM cockpit_input i WHERE i.workspace_id=sqlc.arg(workspace_id)
AND (sqlc.arg(human)::boolean OR (i.source_agent_id=sqlc.narg(source_agent_id) AND i.source_issue_id=sqlc.narg(source_issue_id) AND i.authorizing_user_id=sqlc.narg(authorizing_user_id)))
AND (cardinality(sqlc.arg(ids)::uuid[])=0 OR i.id=ANY(sqlc.arg(ids)::uuid[]))
AND (sqlc.narg(project_id)::uuid IS NULL OR i.project_id=sqlc.narg(project_id))
AND (sqlc.narg(origin_issue_id)::uuid IS NULL OR i.origin_issue_id=sqlc.narg(origin_issue_id))
AND (sqlc.arg(archive)::text='all' OR (sqlc.arg(archive)='archived' AND i.archived_at IS NOT NULL) OR (sqlc.arg(archive)='active' AND i.archived_at IS NULL))
AND (sqlc.arg(query)::text='' OR lower(i.title) LIKE sqlc.arg(prefix)::text)
AND (sqlc.arg(source_kind)::text='' OR EXISTS(SELECT 1 FROM cockpit_input_version v WHERE v.workspace_id=i.workspace_id AND v.id=i.current_version_id AND v.source_kind=sqlc.arg(source_kind)))
AND (sqlc.narg(meeting_id)::uuid IS NULL OR EXISTS(SELECT 1 FROM cockpit_input_reference r WHERE r.workspace_id=i.workspace_id AND r.input_id=i.id AND r.meeting_id=sqlc.narg(meeting_id) AND r.removed_at IS NULL AND (sqlc.narg(agenda_id)::uuid IS NULL OR r.agenda_id=sqlc.narg(agenda_id))))
AND (sqlc.narg(after_time)::timestamptz IS NULL OR (i.created_at,i.id)<(sqlc.narg(after_time),sqlc.narg(after_id)::uuid))
ORDER BY i.created_at DESC,i.id DESC LIMIT sqlc.arg(page_limit);

-- name: CountCockpitInputReadKeys :one
SELECT count(*) FROM cockpit_input i WHERE i.workspace_id=sqlc.arg(workspace_id)
AND (sqlc.arg(human)::boolean OR (i.source_agent_id=sqlc.narg(source_agent_id) AND i.source_issue_id=sqlc.narg(source_issue_id) AND i.authorizing_user_id=sqlc.narg(authorizing_user_id)))
AND (cardinality(sqlc.arg(ids)::uuid[])=0 OR i.id=ANY(sqlc.arg(ids)::uuid[]))
AND (sqlc.narg(project_id)::uuid IS NULL OR i.project_id=sqlc.narg(project_id))
AND (sqlc.narg(origin_issue_id)::uuid IS NULL OR i.origin_issue_id=sqlc.narg(origin_issue_id))
AND (sqlc.arg(archive)::text='all' OR (sqlc.arg(archive)='archived' AND i.archived_at IS NOT NULL) OR (sqlc.arg(archive)='active' AND i.archived_at IS NULL))
AND (sqlc.arg(query)::text='' OR lower(i.title) LIKE sqlc.arg(prefix)::text)
AND (sqlc.arg(source_kind)::text='' OR EXISTS(SELECT 1 FROM cockpit_input_version v WHERE v.workspace_id=i.workspace_id AND v.id=i.current_version_id AND v.source_kind=sqlc.arg(source_kind)))
AND (sqlc.narg(meeting_id)::uuid IS NULL OR EXISTS(SELECT 1 FROM cockpit_input_reference r WHERE r.workspace_id=i.workspace_id AND r.input_id=i.id AND r.meeting_id=sqlc.narg(meeting_id) AND r.removed_at IS NULL AND (sqlc.narg(agenda_id)::uuid IS NULL OR r.agenda_id=sqlc.narg(agenda_id))));

-- name: ListCockpitInputVersionReadKeys :many
SELECT id,version_number AS item_number FROM cockpit_input_version WHERE workspace_id=sqlc.arg(workspace_id) AND input_id=sqlc.arg(input_id)
AND (sqlc.narg(after_number)::integer IS NULL OR version_number<sqlc.narg(after_number))
ORDER BY version_number DESC LIMIT sqlc.arg(page_limit);

-- name: CountCockpitInputVersionReadKeys :one
SELECT count(*) FROM cockpit_input_version WHERE workspace_id=sqlc.arg(workspace_id) AND input_id=sqlc.arg(input_id);

-- name: ListCockpitInputTransferReadKeys :many
SELECT id,transfer_number AS item_number FROM cockpit_input_transfer WHERE workspace_id=sqlc.arg(workspace_id) AND version_id=sqlc.arg(version_id) AND workspace_deleted_at IS NULL
AND (sqlc.narg(after_number)::integer IS NULL OR transfer_number<sqlc.narg(after_number))
ORDER BY transfer_number DESC LIMIT sqlc.arg(page_limit);

-- name: CountCockpitInputTransferReadKeys :one
SELECT count(*) FROM cockpit_input_transfer WHERE workspace_id=sqlc.arg(workspace_id) AND version_id=sqlc.arg(version_id) AND workspace_deleted_at IS NULL;

-- name: ListCockpitInputReferenceReadKeys :many
SELECT r.id,r.created_at FROM cockpit_input_reference r JOIN cockpit_input i ON i.workspace_id=r.workspace_id AND i.id=r.input_id
JOIN cockpit_input_version v ON v.workspace_id=r.workspace_id AND v.id=r.input_version_id WHERE r.workspace_id=sqlc.arg(workspace_id) AND r.meeting_id=sqlc.arg(meeting_id)
AND (sqlc.narg(agenda_id)::uuid IS NULL OR r.agenda_id=sqlc.narg(agenda_id))
AND (sqlc.arg(include_removed)::boolean OR r.removed_at IS NULL)
AND (sqlc.arg(purpose)::text='' OR r.purpose=sqlc.arg(purpose))
AND (sqlc.arg(query)::text='' OR lower(i.title) LIKE sqlc.arg(prefix)::text OR lower(v.filename) LIKE sqlc.arg(prefix)::text)
AND (sqlc.narg(after_time)::timestamptz IS NULL OR (r.created_at,r.id)<(sqlc.narg(after_time),sqlc.narg(after_id)::uuid))
ORDER BY r.created_at DESC,r.id DESC LIMIT sqlc.arg(page_limit);

-- name: CountCockpitInputReferenceReadKeys :one
SELECT count(*) FROM cockpit_input_reference r JOIN cockpit_input i ON i.workspace_id=r.workspace_id AND i.id=r.input_id
JOIN cockpit_input_version v ON v.workspace_id=r.workspace_id AND v.id=r.input_version_id WHERE r.workspace_id=sqlc.arg(workspace_id) AND r.meeting_id=sqlc.arg(meeting_id)
AND (sqlc.narg(agenda_id)::uuid IS NULL OR r.agenda_id=sqlc.narg(agenda_id))
AND (sqlc.arg(include_removed)::boolean OR r.removed_at IS NULL)
AND (sqlc.arg(purpose)::text='' OR r.purpose=sqlc.arg(purpose))
AND (sqlc.arg(query)::text='' OR lower(i.title) LIKE sqlc.arg(prefix)::text OR lower(v.filename) LIKE sqlc.arg(prefix)::text);

-- name: ReadCockpitInputReferenceSummary :one
SELECT count(*)::bigint AS total,
count(*) FILTER (WHERE v.capture_state='ready')::bigint AS ready,
count(*) FILTER (WHERE v.capture_state IN ('awaiting_upload','queued','capturing'))::bigint AS pending,
count(*) FILTER (WHERE v.capture_state='needs_attention')::bigint AS needs_attention,
count(*) FILTER (WHERE v.capture_state='ready' AND (CASE WHEN v.availability='available' AND (v.proof_expires_at IS NULL OR v.proof_expires_at<=now() OR v.checked_at IS NULL) THEN 'unknown'::text ELSE v.availability END)='available')::bigint AS available_ready,
count(*) FILTER (WHERE v.capture_state='ready' AND (CASE WHEN v.availability='available' AND (v.proof_expires_at IS NULL OR v.proof_expires_at<=now() OR v.checked_at IS NULL) THEN 'unknown'::text ELSE v.availability END)='unavailable')::bigint AS unavailable_ready,
count(*) FILTER (WHERE v.capture_state='ready' AND (CASE WHEN v.availability='available' AND (v.proof_expires_at IS NULL OR v.proof_expires_at<=now() OR v.checked_at IS NULL) THEN 'unknown'::text ELSE v.availability END) IN ('unknown','checking'))::bigint AS unknown_ready
FROM cockpit_input_reference r JOIN cockpit_input_version v ON v.workspace_id=r.workspace_id AND v.id=r.input_version_id
WHERE r.workspace_id=$1 AND r.meeting_id=$2 AND (sqlc.narg(agenda_id)::uuid IS NULL OR r.agenda_id=sqlc.narg(agenda_id)) AND r.removed_at IS NULL;

-- name: ReadCockpitInputManifestCounts :one
SELECT count(*)::bigint AS total,count(*) FILTER (WHERE i.required)::bigint AS required,
count(*) FILTER (WHERE i.required AND (CASE WHEN v.availability='available' AND (v.proof_expires_at IS NULL OR v.proof_expires_at<=now() OR v.checked_at IS NULL) THEN 'unknown'::text ELSE v.availability END)='available')::bigint AS available_required,
count(*) FILTER (WHERE i.required AND (CASE WHEN v.availability='available' AND (v.proof_expires_at IS NULL OR v.proof_expires_at<=now() OR v.checked_at IS NULL) THEN 'unknown'::text ELSE v.availability END)='unavailable')::bigint AS unavailable_required,
count(*) FILTER (WHERE i.required AND (CASE WHEN v.availability='available' AND (v.proof_expires_at IS NULL OR v.proof_expires_at<=now() OR v.checked_at IS NULL) THEN 'unknown'::text ELSE v.availability END) IN ('unknown','checking'))::bigint AS unknown_required
FROM cockpit_issue_input_manifest_item i JOIN cockpit_input_version v ON v.workspace_id=i.workspace_id AND v.id=i.input_version_id
WHERE i.workspace_id=$1 AND i.manifest_version_id=$2;

-- name: ListCockpitInputManifestReadKeys :many
SELECT id,version_number AS item_number FROM cockpit_issue_input_manifest_version WHERE workspace_id=$1 AND issue_id=$2
AND (sqlc.narg(after_number)::integer IS NULL OR version_number<sqlc.narg(after_number))
ORDER BY version_number DESC LIMIT sqlc.arg(page_limit);

-- name: CountCockpitInputManifestReadKeys :one
SELECT count(*) FROM cockpit_issue_input_manifest_version WHERE workspace_id=$1 AND issue_id=$2;

-- name: ListCockpitInputManifestReadItems :many
SELECT i.position,i.input_version_id,i.purpose,i.required,v.input_id,h.title AS input_title,v.version_number,
v.payload_kind,v.filename,v.content_type,v.pinned_size_bytes,v.content_hash,(CASE WHEN v.availability='available' AND (v.proof_expires_at IS NULL OR v.proof_expires_at<=now() OR v.checked_at IS NULL) THEN 'unknown'::text ELSE v.availability END)::text AS availability,v.verification_error_code
FROM cockpit_issue_input_manifest_item i JOIN cockpit_input_version v ON v.workspace_id=i.workspace_id AND v.id=i.input_version_id
JOIN cockpit_input h ON h.workspace_id=v.workspace_id AND h.id=v.input_id
WHERE i.workspace_id=$1 AND i.manifest_version_id=$2 AND i.position>=sqlc.arg(after_position)::integer
ORDER BY i.position LIMIT sqlc.arg(page_limit);

-- name: ListCockpitInputAttachmentReadRows :many
SELECT id,issue_id,filename,content_type,size_bytes,created_at FROM attachment
WHERE workspace_id=$1 AND issue_id=$2 AND (sqlc.arg(query)::text='' OR lower(filename) LIKE sqlc.arg(prefix)::text)
AND (sqlc.narg(after_time)::timestamptz IS NULL OR (created_at,id)<(sqlc.narg(after_time),sqlc.narg(after_id)::uuid))
ORDER BY created_at DESC,id DESC LIMIT sqlc.arg(page_limit);

-- name: CountCockpitInputAttachmentReadRows :one
SELECT count(*) FROM attachment
WHERE workspace_id=$1 AND issue_id=$2 AND (sqlc.arg(query)::text='' OR lower(filename) LIKE sqlc.arg(prefix)::text);
