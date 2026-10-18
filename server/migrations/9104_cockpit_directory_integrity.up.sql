CREATE OR REPLACE FUNCTION guard_cockpit_directory_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.nas_dir IS DISTINCT FROM OLD.nas_dir THEN NEW.nas_dir_revision:=OLD.nas_dir_revision+1;
 ELSIF NEW.nas_dir_revision IS DISTINCT FROM OLD.nas_dir_revision THEN RAISE EXCEPTION 'directory binding revision requires a path change' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cockpit_directory_binding_guard BEFORE UPDATE ON cockpit_meeting FOR EACH ROW EXECUTE FUNCTION guard_cockpit_directory_binding();
CREATE OR REPLACE FUNCTION guard_cockpit_directory_meeting() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM cockpit_meeting_directory_operation WHERE workspace_id=OLD.workspace_id AND meeting_id=OLD.id)
 OR EXISTS(SELECT 1 FROM cockpit_meeting_directory_step WHERE workspace_id=OLD.workspace_id AND meeting_id=OLD.id)
 OR EXISTS(SELECT 1 FROM cockpit_meeting_directory_attempt WHERE workspace_id=OLD.workspace_id AND meeting_id=OLD.id) THEN
  RAISE EXCEPTION 'directory history retains this meeting' USING ERRCODE='23514';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER cockpit_directory_meeting_guard BEFORE DELETE ON cockpit_meeting FOR EACH ROW EXECUTE FUNCTION guard_cockpit_directory_meeting();
CREATE OR REPLACE FUNCTION guard_cockpit_directory_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.workspace_id,NEW.meeting_id,NEW.creation_command_key,NEW.request_hash,NEW.plan_hash,NEW.root_id,NEW.root_path,NEW.prepare_subpath,NEW.relative_directory,NEW.directory,NEW.target_hash,NEW.root_config_hash,NEW.observed_nas_dir,NEW.observed_binding_revision,NEW.bind_after_base,NEW.created_by_type,NEW.created_by,NEW.credential_owner_user_id,NEW.authorizing_user_id,NEW.source_run_id,NEW.source_issue_id,NEW.source_agent_id,NEW.source_runtime_id,NEW.source_task_token_id,NEW.source_relation_kind,NEW.source_agenda_reference_id,NEW.source_principal,NEW.input,NEW.receipt,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.meeting_id,OLD.creation_command_key,OLD.request_hash,OLD.plan_hash,OLD.root_id,OLD.root_path,OLD.prepare_subpath,OLD.relative_directory,OLD.directory,OLD.target_hash,OLD.root_config_hash,OLD.observed_nas_dir,OLD.observed_binding_revision,OLD.bind_after_base,OLD.created_by_type,OLD.created_by,OLD.credential_owner_user_id,OLD.authorizing_user_id,OLD.source_run_id,OLD.source_issue_id,OLD.source_agent_id,OLD.source_runtime_id,OLD.source_task_token_id,OLD.source_relation_kind,OLD.source_agenda_reference_id,OLD.source_principal,OLD.input,OLD.receipt,OLD.created_at) THEN
  RAISE EXCEPTION 'directory operation intent is immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.accepted_binding_revision IS DISTINCT FROM OLD.accepted_binding_revision THEN
  IF OLD.accepted_binding_revision IS NOT NULL OR NEW.accepted_binding_revision IS NULL
   OR NOT NEW.bind_after_base THEN
   RAISE EXCEPTION 'only the fixed base binding CAS may be accepted once' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(
   SELECT 1 FROM cockpit_meeting_directory_step b
   JOIN cockpit_meeting_directory_attempt a ON a.workspace_id=b.workspace_id AND a.operation_id=b.operation_id AND a.step_id=b.id AND a.id=b.last_attempt_id AND a.state='succeeded' AND a.grant_command_key=b.grant_command_key AND a.grant_revision=b.grant_revision
   JOIN cockpit_meeting_lifecycle_command c ON c.workspace_id=b.workspace_id AND c.meeting_id=b.meeting_id AND c.directory_operation_id=b.operation_id AND c.command_key=a.grant_command_key
   WHERE b.workspace_id=NEW.workspace_id AND b.meeting_id=NEW.meeting_id AND b.operation_id=NEW.id AND b.kind='base' AND b.state='satisfied'
   AND (c.receipt->'directory'->'grant'->>'target_hash')=NEW.target_hash
   AND (c.receipt->'directory'->'grant'->'observed_binding'->>'nas_dir')<>NEW.directory
   AND (c.receipt->'directory'->'grant'->'observed_binding'->>'revision')::bigint+1=NEW.accepted_binding_revision
  ) THEN RAISE EXCEPTION 'accepted binding requires the fixed base successful grant' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM cockpit_meeting m WHERE m.workspace_id=NEW.workspace_id AND m.id=NEW.meeting_id AND m.nas_dir=NEW.directory AND m.nas_dir_revision=NEW.accepted_binding_revision) THEN
   RAISE EXCEPTION 'accepted directory binding must identify the current base CAS' USING ERRCODE='23514';
  END IF;
 END IF;
 IF OLD.finished_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'finished directory operation is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cockpit_directory_operation_guard BEFORE UPDATE ON cockpit_meeting_directory_operation FOR EACH ROW EXECUTE FUNCTION guard_cockpit_directory_operation();
CREATE OR REPLACE FUNCTION guard_cockpit_directory_step() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.workspace_id,NEW.meeting_id,NEW.operation_id,NEW.position,NEW.parent_step_id,NEW.kind,NEW.label,NEW.relative_path,NEW.path_hash,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.meeting_id,OLD.operation_id,OLD.position,OLD.parent_step_id,OLD.kind,OLD.label,OLD.relative_path,OLD.path_hash,OLD.created_at) THEN
  RAISE EXCEPTION 'directory step intent is immutable' USING ERRCODE='23514';
 END IF;
 IF OLD.state IN ('satisfied','abandoned') AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'terminal directory step is immutable' USING ERRCODE='23514'; END IF;
 IF ROW(NEW.grant_command_key,NEW.grant_revision) IS DISTINCT FROM ROW(OLD.grant_command_key,OLD.grant_revision)
 AND (NEW.grant_command_key=OLD.grant_command_key OR NEW.grant_revision<=OLD.grant_revision) THEN RAISE EXCEPTION 'directory grant requires a fresh command and increasing revision' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cockpit_directory_step_guard BEFORE UPDATE ON cockpit_meeting_directory_step FOR EACH ROW EXECUTE FUNCTION guard_cockpit_directory_step();
CREATE OR REPLACE FUNCTION guard_cockpit_directory_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.workspace_id,NEW.meeting_id,NEW.operation_id,NEW.step_id,NEW.attempt_number,NEW.grant_command_key,NEW.grant_revision,NEW.lease_token,NEW.started_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.meeting_id,OLD.operation_id,OLD.step_id,OLD.attempt_number,OLD.grant_command_key,OLD.grant_revision,OLD.lease_token,OLD.started_at) THEN
  RAISE EXCEPTION 'directory attempt identity is immutable' USING ERRCODE='23514';
 END IF;
 IF OLD.finished_at IS NOT NULL AND ROW(NEW.state,NEW.finished_at,NEW.outcome,NEW.observed_at,NEW.error_code,NEW.error_message,NEW.receipt)
 IS DISTINCT FROM ROW(OLD.state,OLD.finished_at,OLD.outcome,OLD.observed_at,OLD.error_code,OLD.error_message,OLD.receipt) THEN
  RAISE EXCEPTION 'directory attempt result is immutable' USING ERRCODE='23514';
 END IF;
 IF OLD.late_receipt IS NOT NULL AND ROW(NEW.late_receipt,NEW.late_observed_at) IS DISTINCT FROM ROW(OLD.late_receipt,OLD.late_observed_at) THEN
  RAISE EXCEPTION 'late directory observation is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cockpit_directory_attempt_guard BEFORE UPDATE ON cockpit_meeting_directory_attempt FOR EACH ROW EXECUTE FUNCTION guard_cockpit_directory_attempt();
CREATE OR REPLACE FUNCTION guard_cockpit_directory_command() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (OLD.directory_operation_id IS NOT NULL OR NEW.directory_operation_id IS NOT NULL) AND NEW IS DISTINCT FROM OLD THEN
  RAISE EXCEPTION 'directory command identity and receipt are immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cockpit_directory_command_guard BEFORE UPDATE ON cockpit_meeting_lifecycle_command FOR EACH ROW EXECUTE FUNCTION guard_cockpit_directory_command();
