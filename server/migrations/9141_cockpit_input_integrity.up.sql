-- N2 draft integrity only. Application transactions own relationship validation and teardown.

CREATE OR REPLACE FUNCTION guard_cockpit_input_header() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.workspace_id,NEW.creation_key,NEW.request_hash,NEW.creation_receipt,NEW.project_id,NEW.origin_issue_id,NEW.created_at,NEW.actor_type,NEW.actor_id,NEW.credential_owner_user_id,NEW.authorizing_user_id,NEW.source_agent_id,NEW.source_run_id,NEW.source_issue_id,NEW.source_runtime_id) IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.creation_key,OLD.request_hash,OLD.creation_receipt,OLD.project_id,OLD.origin_issue_id,OLD.created_at,OLD.actor_type,OLD.actor_id,OLD.credential_owner_user_id,OLD.authorizing_user_id,OLD.source_agent_id,OLD.source_run_id,OLD.source_issue_id,OLD.source_runtime_id) THEN
  RAISE EXCEPTION 'Input identity and registration intent are immutable' USING ERRCODE='23514',CONSTRAINT='cockpit_input_integrity';
 END IF;
 IF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id AND NEW.current_version_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM cockpit_input_version WHERE workspace_id=NEW.workspace_id AND input_id=NEW.id AND id=NEW.current_version_id) THEN
  RAISE EXCEPTION 'Current input version must belong to this input' USING ERRCODE='23514',CONSTRAINT='cockpit_input_integrity';
 END IF;
 RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS cockpit_input_header_guard ON cockpit_input;
CREATE TRIGGER cockpit_input_header_guard BEFORE UPDATE ON cockpit_input FOR EACH ROW EXECUTE FUNCTION guard_cockpit_input_header();

CREATE OR REPLACE FUNCTION guard_cockpit_input_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.source_kind='artifact_version' THEN
   PERFORM 1 FROM cockpit_artifact_version a WHERE a.workspace_id=NEW.workspace_id AND a.artifact_id=NEW.source_artifact_id AND a.id=NEW.source_artifact_version_id
    AND a.capture_status='ready' AND a.size_bytes=NEW.pinned_size_bytes AND a.content_hash=NEW.content_hash
    AND ((a.payload_kind='text' AND NEW.payload_kind='text') OR (a.payload_kind='attachment' AND NEW.payload_kind='file')) FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Borrowed input must identify the exact ready artifact bytes' USING ERRCODE='23514',CONSTRAINT='cockpit_input_integrity'; END IF;
  END IF;
  RETURN NEW;
 END IF;
 IF ROW(NEW.id,NEW.workspace_id,NEW.input_id,NEW.version_number,NEW.submission_key,NEW.request_hash,NEW.submission_receipt,NEW.source_kind,NEW.payload_kind,NEW.source_attachment_id,NEW.source_attachment_issue_id,NEW.source_root_id,NEW.source_root_path,NEW.source_relative_path,NEW.source_root_config_hash,NEW.source_root_identity,NEW.source_file_identity,NEW.source_size,NEW.source_mtime_ns,NEW.source_artifact_id,NEW.source_artifact_version_id,NEW.filename,NEW.content_type,NEW.declared_size_bytes,NEW.client_sha256,NEW.created_at,NEW.actor_type,NEW.actor_id,NEW.credential_owner_user_id,NEW.authorizing_user_id,NEW.source_agent_id,NEW.source_run_id,NEW.source_issue_id,NEW.source_runtime_id) IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.input_id,OLD.version_number,OLD.submission_key,OLD.request_hash,OLD.submission_receipt,OLD.source_kind,OLD.payload_kind,OLD.source_attachment_id,OLD.source_attachment_issue_id,OLD.source_root_id,OLD.source_root_path,OLD.source_relative_path,OLD.source_root_config_hash,OLD.source_root_identity,OLD.source_file_identity,OLD.source_size,OLD.source_mtime_ns,OLD.source_artifact_id,OLD.source_artifact_version_id,OLD.filename,OLD.content_type,OLD.declared_size_bytes,OLD.client_sha256,OLD.created_at,OLD.actor_type,OLD.actor_id,OLD.credential_owner_user_id,OLD.authorizing_user_id,OLD.source_agent_id,OLD.source_run_id,OLD.source_issue_id,OLD.source_runtime_id) THEN
  RAISE EXCEPTION 'Input content provenance and submission intent are immutable' USING ERRCODE='23514',CONSTRAINT='cockpit_input_integrity';
 END IF;
 IF OLD.content_hash IS NOT NULL AND ROW(NEW.content_hash,NEW.pinned_size_bytes,NEW.pinned_at) IS DISTINCT FROM ROW(OLD.content_hash,OLD.pinned_size_bytes,OLD.pinned_at) THEN
  RAISE EXCEPTION 'Fixed input bytes cannot change' USING ERRCODE='23514',CONSTRAINT='cockpit_input_integrity';
 END IF;
 IF OLD.ready_at IS NOT NULL AND (NEW.ready_at IS DISTINCT FROM OLD.ready_at OR NEW.capture_state<>'ready' OR NEW.accepted_transfer_id IS DISTINCT FROM OLD.accepted_transfer_id) THEN
  RAISE EXCEPTION 'Original ready time and first accepted transfer are immutable' USING ERRCODE='23514',CONSTRAINT='cockpit_input_integrity';
 END IF;
 IF NEW.current_transfer_id IS DISTINCT FROM OLD.current_transfer_id THEN
  IF NEW.current_transfer_id IS NULL OR OLD.active_transfer_id IS DISTINCT FROM NEW.current_transfer_id OR NOT EXISTS(
   SELECT 1 FROM cockpit_input_transfer t WHERE t.workspace_id=NEW.workspace_id AND t.input_id=NEW.input_id AND t.version_id=NEW.id AND t.id=NEW.current_transfer_id
    AND t.state='verified' AND t.workspace_deleted_at IS NULL AND t.pinned_size_bytes=NEW.pinned_size_bytes AND t.content_hash=NEW.content_hash AND t.finalize_key IS NOT NULL) THEN
   RAISE EXCEPTION 'Only the active verified matching transfer may publish a current copy' USING ERRCODE='23514',CONSTRAINT='cockpit_input_integrity';
  END IF;
 END IF;
 IF NEW.accepted_transfer_id IS DISTINCT FROM OLD.accepted_transfer_id AND (OLD.accepted_transfer_id IS NOT NULL OR NEW.accepted_transfer_id IS NULL OR NEW.accepted_transfer_id IS DISTINCT FROM NEW.current_transfer_id OR OLD.ready_at IS NOT NULL) THEN
  RAISE EXCEPTION 'First accepted transfer may be assigned once at initial readiness' USING ERRCODE='23514',CONSTRAINT='cockpit_input_integrity';
 END IF;
 IF NEW.active_transfer_id IS DISTINCT FROM OLD.active_transfer_id AND NEW.active_transfer_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM cockpit_input_transfer t WHERE t.workspace_id=NEW.workspace_id AND t.input_id=NEW.input_id AND t.version_id=NEW.id AND t.id=NEW.active_transfer_id AND t.workspace_deleted_at IS NULL AND t.finished_at IS NULL) THEN
  RAISE EXCEPTION 'Active transfer must be unfinished and belong to this exact version' USING ERRCODE='23514',CONSTRAINT='cockpit_input_integrity';
 END IF;
 RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS cockpit_input_version_guard ON cockpit_input_version;
CREATE TRIGGER cockpit_input_version_guard BEFORE INSERT OR UPDATE ON cockpit_input_version FOR EACH ROW EXECUTE FUNCTION guard_cockpit_input_version();

CREATE OR REPLACE FUNCTION guard_cockpit_input_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.workspace_id,NEW.input_id,NEW.version_id,NEW.transfer_number,NEW.command_key,NEW.request_hash,NEW.kind,NEW.mode,NEW.replaces_transfer_id,NEW.owned_storage_key,NEW.expected_bytes,NEW.session_expires_at,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.input_id,OLD.version_id,OLD.transfer_number,OLD.command_key,OLD.request_hash,OLD.kind,OLD.mode,OLD.replaces_transfer_id,OLD.owned_storage_key,OLD.expected_bytes,OLD.session_expires_at,OLD.created_at) THEN
  RAISE EXCEPTION 'Transfer identity and destination are immutable' USING ERRCODE='23514',CONSTRAINT='cockpit_input_integrity';
 END IF;
 IF OLD.workspace_deleted_at IS NOT NULL AND NEW.workspace_deleted_at IS DISTINCT FROM OLD.workspace_deleted_at THEN
  RAISE EXCEPTION 'Deleted workspace intent cannot be revived' USING ERRCODE='23514',CONSTRAINT='cockpit_input_integrity';
 END IF;
 IF OLD.workspace_deleted_at IS NULL AND NEW.workspace_deleted_at IS NOT NULL THEN
  IF current_setting('multica.workspace_teardown',true) IS DISTINCT FROM 'on' OR current_setting('multica.input_teardown_workspace',true) IS DISTINCT FROM OLD.workspace_id::text THEN
   RAISE EXCEPTION 'Only exact workspace teardown may sanitize a retained object intent' USING ERRCODE='23514',CONSTRAINT='cockpit_input_integrity';
  END IF;
  IF NEW.command_receipt<>'{}'::jsonb OR NEW.finalize_receipt IS NOT NULL OR NEW.abort_receipt IS NOT NULL OR NEW.error_message<>'' OR NEW.source_before_root_identity IS NOT NULL OR NEW.source_before_file_identity IS NOT NULL OR NEW.source_after_file_identity IS NOT NULL THEN
   RAISE EXCEPTION 'A cleanup tombstone cannot retain user source or command body' USING ERRCODE='23514',CONSTRAINT='cockpit_input_integrity';
  END IF;
 ELSIF ROW(NEW.actor_type,NEW.actor_id,NEW.credential_owner_user_id,NEW.authorizing_user_id,NEW.source_agent_id,NEW.source_run_id,NEW.source_issue_id,NEW.source_runtime_id,NEW.command_receipt)
  IS DISTINCT FROM ROW(OLD.actor_type,OLD.actor_id,OLD.credential_owner_user_id,OLD.authorizing_user_id,OLD.source_agent_id,OLD.source_run_id,OLD.source_issue_id,OLD.source_runtime_id,OLD.command_receipt) THEN
  RAISE EXCEPTION 'Transfer command and principal are immutable' USING ERRCODE='23514',CONSTRAINT='cockpit_input_integrity';
 END IF;
 IF OLD.workspace_deleted_at IS NULL AND NEW.workspace_deleted_at IS NULL THEN
  IF OLD.finalize_key IS NOT NULL AND ROW(NEW.finalize_key,NEW.finalize_hash,NEW.finalize_receipt) IS DISTINCT FROM ROW(OLD.finalize_key,OLD.finalize_hash,OLD.finalize_receipt) THEN
   RAISE EXCEPTION 'Finalize receipt is immutable' USING ERRCODE='23514',CONSTRAINT='cockpit_input_integrity';
  END IF;
  IF OLD.abort_key IS NOT NULL AND ROW(NEW.abort_key,NEW.abort_hash,NEW.abort_receipt) IS DISTINCT FROM ROW(OLD.abort_key,OLD.abort_hash,OLD.abort_receipt) THEN
   RAISE EXCEPTION 'Abandon receipt is immutable' USING ERRCODE='23514',CONSTRAINT='cockpit_input_integrity';
  END IF;
 END IF;
 IF OLD.content_hash IS NOT NULL AND ROW(NEW.content_hash,NEW.pinned_size_bytes,NEW.content_pin_at) IS DISTINCT FROM ROW(OLD.content_hash,OLD.pinned_size_bytes,OLD.content_pin_at) THEN
  RAISE EXCEPTION 'Transfer content checkpoint is immutable' USING ERRCODE='23514',CONSTRAINT='cockpit_input_integrity';
 END IF;
 IF OLD.finished_at IS NOT NULL AND ROW(NEW.state,NEW.finished_at,NEW.error_code) IS DISTINCT FROM ROW(OLD.state,OLD.finished_at,OLD.error_code) THEN
  RAISE EXCEPTION 'Terminal transfer outcome cannot be revived or replaced' USING ERRCODE='23514',CONSTRAINT='cockpit_input_integrity';
 END IF;
 IF OLD.io_finished_at IS NOT NULL AND ROW(NEW.io_finished_at,NEW.io_outcome) IS DISTINCT FROM ROW(OLD.io_finished_at,OLD.io_outcome) THEN
  RAISE EXCEPTION 'Late I/O completion can be recorded only once' USING ERRCODE='23514',CONSTRAINT='cockpit_input_integrity';
 END IF;
 RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS cockpit_input_transfer_guard ON cockpit_input_transfer;
CREATE TRIGGER cockpit_input_transfer_guard BEFORE UPDATE ON cockpit_input_transfer FOR EACH ROW EXECUTE FUNCTION guard_cockpit_input_transfer();

CREATE OR REPLACE FUNCTION guard_cockpit_input_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.workspace_id,NEW.meeting_id,NEW.agenda_id,NEW.input_id,NEW.input_version_id,NEW.purpose,NEW.creation_key,NEW.request_hash,NEW.creation_receipt,NEW.created_at,NEW.actor_type,NEW.actor_id,NEW.credential_owner_user_id,NEW.authorizing_user_id,NEW.source_agent_id,NEW.source_run_id,NEW.source_issue_id,NEW.source_runtime_id) IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.meeting_id,OLD.agenda_id,OLD.input_id,OLD.input_version_id,OLD.purpose,OLD.creation_key,OLD.request_hash,OLD.creation_receipt,OLD.created_at,OLD.actor_type,OLD.actor_id,OLD.credential_owner_user_id,OLD.authorizing_user_id,OLD.source_agent_id,OLD.source_run_id,OLD.source_issue_id,OLD.source_runtime_id) THEN
  RAISE EXCEPTION 'Input reference intent is immutable' USING ERRCODE='23514',CONSTRAINT='cockpit_input_integrity';
 END IF;
 IF OLD.removed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
  RAISE EXCEPTION 'Removed input reference cannot be rewritten or revived' USING ERRCODE='23514',CONSTRAINT='cockpit_input_integrity';
 END IF;
 RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS cockpit_input_reference_guard ON cockpit_input_reference;
CREATE TRIGGER cockpit_input_reference_guard BEFORE UPDATE ON cockpit_input_reference FOR EACH ROW EXECUTE FUNCTION guard_cockpit_input_reference();

CREATE OR REPLACE FUNCTION guard_cockpit_input_manifest_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW IS DISTINCT FROM OLD THEN
  RAISE EXCEPTION 'Fixed input manifest facts are immutable' USING ERRCODE='23514',CONSTRAINT='cockpit_input_integrity';
 END IF;
 RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS cockpit_input_manifest_version_guard ON cockpit_issue_input_manifest_version;
CREATE TRIGGER cockpit_input_manifest_version_guard BEFORE UPDATE ON cockpit_issue_input_manifest_version FOR EACH ROW EXECUTE FUNCTION guard_cockpit_input_manifest_immutable();

DROP TRIGGER IF EXISTS cockpit_input_manifest_item_guard ON cockpit_issue_input_manifest_item;
CREATE TRIGGER cockpit_input_manifest_item_guard BEFORE UPDATE ON cockpit_issue_input_manifest_item FOR EACH ROW EXECUTE FUNCTION guard_cockpit_input_manifest_immutable();

CREATE OR REPLACE FUNCTION guard_cockpit_input_task_pin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.input_manifest_version_id IS DISTINCT FROM OLD.input_manifest_version_id THEN
  RAISE EXCEPTION 'A Run retains its original fixed input manifest' USING ERRCODE='23514',CONSTRAINT='cockpit_input_integrity';
 END IF;
 IF NEW.input_manifest_version_id IS NULL THEN
  IF NEW.input_preparation_state<>'not_recorded' OR NEW.input_preparation_hash IS NOT NULL OR NEW.input_prepared_at IS NOT NULL OR NEW.input_prepared_dispatched_at IS NOT NULL THEN
   RAISE EXCEPTION 'A Run without a recorded input manifest cannot claim preparation' USING ERRCODE='23514',CONSTRAINT='cockpit_input_integrity';
  END IF;
 ELSE
  IF NEW.issue_id IS NULL OR NOT EXISTS(
   SELECT 1 FROM cockpit_issue_input_manifest_version v JOIN issue i ON i.id=v.issue_id AND i.workspace_id=v.workspace_id
   WHERE v.id=NEW.input_manifest_version_id AND v.issue_id=NEW.issue_id) THEN
   RAISE EXCEPTION 'Run manifest must belong to the exact Issue and workspace' USING ERRCODE='23514',CONSTRAINT='cockpit_input_integrity';
  END IF;
  IF NEW.input_preparation_state NOT IN ('pending','preparing','required_ready','failed') THEN
   RAISE EXCEPTION 'A recorded Run manifest requires an explicit preparation state' USING ERRCODE='23514',CONSTRAINT='cockpit_input_integrity';
  END IF;
  IF NEW.input_preparation_state='required_ready' AND (NEW.input_prepared_at IS NULL OR NEW.input_prepared_dispatched_at IS NULL OR NEW.input_prepared_dispatched_at IS DISTINCT FROM NEW.dispatched_at OR NEW.input_preparation_hash IS DISTINCT FROM (SELECT manifest_hash FROM cockpit_issue_input_manifest_version WHERE id=NEW.input_manifest_version_id)) THEN
   RAISE EXCEPTION 'Preparation must confirm this exact manifest and dispatch claim' USING ERRCODE='23514',CONSTRAINT='cockpit_input_integrity';
  END IF;
  IF NEW.status='running' AND NEW.input_preparation_state<>'required_ready' THEN
   RAISE EXCEPTION 'Fixed required inputs must be prepared before starting this Run' USING ERRCODE='23514',CONSTRAINT='cockpit_input_integrity';
  END IF;
 END IF;
 RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS cockpit_input_task_pin_guard ON agent_task_queue;
CREATE TRIGGER cockpit_input_task_pin_guard BEFORE INSERT OR UPDATE ON agent_task_queue FOR EACH ROW EXECUTE FUNCTION guard_cockpit_input_task_pin();

CREATE OR REPLACE FUNCTION guard_cockpit_input_artifact_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM cockpit_input_version WHERE workspace_id=OLD.workspace_id AND source_artifact_id=OLD.artifact_id AND source_artifact_version_id=OLD.id) THEN
   RAISE EXCEPTION 'This fixed artifact version is retained as an input source' USING ERRCODE='23514',CONSTRAINT='cockpit_input_integrity';
  END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF NEW.input_manifest_version_id IS DISTINCT FROM OLD.input_manifest_version_id THEN
   RAISE EXCEPTION 'Artifact input-manifest provenance is immutable' USING ERRCODE='23514',CONSTRAINT='cockpit_input_integrity';
  END IF;
  IF ROW(NEW.id,NEW.workspace_id,NEW.artifact_id,NEW.payload_kind,NEW.content,NEW.storage_key,NEW.content_hash,NEW.size_bytes,NEW.capture_status) IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.artifact_id,OLD.payload_kind,OLD.content,OLD.storage_key,OLD.content_hash,OLD.size_bytes,OLD.capture_status)
   AND EXISTS(SELECT 1 FROM cockpit_input_version WHERE workspace_id=OLD.workspace_id AND source_artifact_id=OLD.artifact_id AND source_artifact_version_id=OLD.id) THEN
   RAISE EXCEPTION 'Borrowed artifact input bytes retain their fixed source' USING ERRCODE='23514',CONSTRAINT='cockpit_input_integrity';
  END IF;
 END IF;
 IF NEW.input_manifest_version_id IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM cockpit_issue_input_manifest_version WHERE workspace_id=NEW.workspace_id AND id=NEW.input_manifest_version_id) OR (NEW.producer_run_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM agent_task_queue WHERE id=NEW.producer_run_id AND issue_id=NEW.producer_issue_id AND input_manifest_version_id=NEW.input_manifest_version_id))) THEN
  RAISE EXCEPTION 'Artifact input manifest must retain the authorized workspace or exact producer Run pin' USING ERRCODE='23514',CONSTRAINT='cockpit_input_integrity';
 END IF;
 RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS cockpit_input_artifact_source_guard ON cockpit_artifact_version;
CREATE TRIGGER cockpit_input_artifact_source_guard BEFORE INSERT OR UPDATE OR DELETE ON cockpit_artifact_version FOR EACH ROW EXECUTE FUNCTION guard_cockpit_input_artifact_source();

CREATE OR REPLACE FUNCTION guard_cockpit_input_artifact_header() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM cockpit_input_version WHERE workspace_id=OLD.workspace_id AND source_artifact_id=OLD.id) THEN
  RAISE EXCEPTION 'This artifact is retained by fixed input provenance' USING ERRCODE='23514',CONSTRAINT='cockpit_input_integrity';
 END IF;
 RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS cockpit_input_artifact_header_guard ON cockpit_artifact;
CREATE TRIGGER cockpit_input_artifact_header_guard BEFORE DELETE ON cockpit_artifact FOR EACH ROW EXECUTE FUNCTION guard_cockpit_input_artifact_header();

CREATE OR REPLACE FUNCTION guard_cockpit_input_meeting() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM cockpit_input_reference WHERE workspace_id=OLD.workspace_id AND meeting_id=OLD.id AND removed_at IS NULL) THEN
  RAISE EXCEPTION 'This meeting has active input references; use its input references or archive entry' USING ERRCODE='23514',CONSTRAINT='cockpit_input_integrity';
 END IF;
 RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS cockpit_input_meeting_guard ON cockpit_meeting;
CREATE TRIGGER cockpit_input_meeting_guard BEFORE DELETE ON cockpit_meeting FOR EACH ROW EXECUTE FUNCTION guard_cockpit_input_meeting();

CREATE OR REPLACE FUNCTION guard_cockpit_input_retained_issue() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(
  SELECT 1 FROM cockpit_issue_input_manifest_version v WHERE v.workspace_id=OLD.workspace_id AND v.issue_id=OLD.id
   AND (EXISTS(SELECT 1 FROM agent_task_queue t WHERE t.input_manifest_version_id=v.id)
    OR EXISTS(SELECT 1 FROM cockpit_artifact_version a WHERE a.workspace_id=OLD.workspace_id AND a.input_manifest_version_id=v.id))) THEN
  RAISE EXCEPTION 'This Issue retains fixed Run or artifact input provenance' USING ERRCODE='23514',CONSTRAINT='cockpit_input_integrity';
 END IF;
 RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS cockpit_input_retained_issue_guard ON issue;
CREATE TRIGGER cockpit_input_retained_issue_guard BEFORE DELETE ON issue FOR EACH ROW EXECUTE FUNCTION guard_cockpit_input_retained_issue();
