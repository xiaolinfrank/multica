BEGIN;
ALTER TABLE cockpit_meeting DROP CONSTRAINT cockpit_meeting_occurrence_check;
ALTER TABLE cockpit_meeting ADD CONSTRAINT cockpit_meeting_occurrence_check CHECK (
 lifecycle_revision>0 AND agenda_revision>0 AND occurrence_state IN ('unconfirmed','scheduled','in_progress','ended','cancelled')
 AND (occurrence_state='ended')=(ended_at IS NOT NULL)
 AND (occurrence_state='cancelled')=(cancelled_at IS NOT NULL)
 AND (cancelled_at IS NULL)=(cancelled_by IS NULL)
 AND (cancelled_at IS NULL OR length(btrim(cancelled_reason))>0)
 AND (archived_at IS NULL)=(archived_by IS NULL)
 AND (archived_at IS NULL OR length(btrim(archived_reason))>0)
 AND (ended_at IS NULL)=(ended_source IS NULL)
 AND (ended_source IS NULL OR ended_source IN ('legacy_confirmation','human_confirmation'))
 AND (actual_ended_at IS NULL OR ended_at IS NOT NULL)
 AND (actual_started_at IS NULL OR actual_ended_at IS NULL OR actual_started_at<=actual_ended_at)
);

CREATE FUNCTION guard_cockpit_meeting_preparation_fact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM cockpit_meeting_preparation_operation WHERE workspace_id=OLD.workspace_id AND meeting_id=OLD.id) THEN
   RAISE EXCEPTION 'Meeting preparation history must be retained; archive this meeting instead' USING ERRCODE='23514',CONSTRAINT='cockpit_meeting_preparation_integrity';
  END IF;
  RETURN OLD;
 END IF;
 IF NEW.occurrence_state='cancelled' AND OLD.occurrence_state NOT IN ('unconfirmed','scheduled','cancelled') THEN
  RAISE EXCEPTION 'A started or ended meeting cannot become a meeting that did not occur' USING ERRCODE='23514',CONSTRAINT='cockpit_meeting_preparation_integrity';
 END IF;
 IF OLD.occurrence_state='cancelled' AND NEW.occurrence_state NOT IN ('cancelled','scheduled') THEN
  RAISE EXCEPTION 'Cancelled meetings must be explicitly rescheduled first' USING ERRCODE='23514',CONSTRAINT='cockpit_meeting_preparation_integrity';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cockpit_meeting_preparation_fact_guard BEFORE DELETE OR UPDATE OF occurrence_state ON cockpit_meeting
 FOR EACH ROW EXECUTE FUNCTION guard_cockpit_meeting_preparation_fact();
CREATE FUNCTION guard_cockpit_preparation_immutable_fact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='cockpit_meeting_template_version' THEN
  RAISE EXCEPTION 'Published template configurations are immutable; save a new version' USING ERRCODE='23514',CONSTRAINT='cockpit_meeting_preparation_integrity';
 END IF;
 IF (NEW.authorization_key IS DISTINCT FROM OLD.authorization_key OR NEW.authorization_hash IS DISTINCT FROM OLD.authorization_hash OR NEW.authorization_snapshot IS DISTINCT FROM OLD.authorization_snapshot OR NEW.authorization_revision IS DISTINCT FROM OLD.authorization_revision)
 AND (OLD.state<>'needs_attention' OR OLD.receipt IS NOT NULL OR NEW.authorization_revision<>OLD.authorization_revision+1 OR NEW.authorization_key=OLD.authorization_key) THEN
  RAISE EXCEPTION 'A new explicit grant is required to change a failed effect authorization_snapshot' USING ERRCODE='23514',CONSTRAINT='cockpit_meeting_preparation_integrity';
 END IF;
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.label IS DISTINCT FROM OLD.label
 OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.meeting_id IS DISTINCT FROM OLD.meeting_id
 OR NEW.operation_id IS DISTINCT FROM OLD.operation_id OR NEW.slot_id IS DISTINCT FROM OLD.slot_id
 OR NEW.command_key IS DISTINCT FROM OLD.command_key OR NEW.input IS DISTINCT FROM OLD.input
 OR NEW.request_hash IS DISTINCT FROM OLD.request_hash OR NEW.kind IS DISTINCT FROM OLD.kind
 OR NEW.dependency_id IS DISTINCT FROM OLD.dependency_id OR NEW.position IS DISTINCT FROM OLD.position
 OR (NEW.agenda_id IS DISTINCT FROM OLD.agenda_id AND (OLD.agenda_id IS NOT NULL OR NEW.state<>'applied'))
 OR (NEW.reference_id IS DISTINCT FROM OLD.reference_id AND (OLD.reference_id IS NOT NULL OR NEW.state<>'applied'))
 OR (NEW.issue_id IS DISTINCT FROM OLD.issue_id AND (OLD.issue_id IS NOT NULL OR NEW.state<>'applied'))
 OR (OLD.run_id IS NOT NULL AND NEW.run_id IS DISTINCT FROM OLD.run_id)
 OR NEW.target_meeting_id IS DISTINCT FROM OLD.target_meeting_id
 OR (OLD.state='applied' AND NEW IS DISTINCT FROM OLD) THEN
  RAISE EXCEPTION 'Confirmed effect intent and applied receipts are immutable' USING ERRCODE='23514',CONSTRAINT='cockpit_meeting_preparation_integrity';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cockpit_template_version_immutable_guard BEFORE UPDATE ON cockpit_meeting_template_version
 FOR EACH ROW EXECUTE FUNCTION guard_cockpit_preparation_immutable_fact();
CREATE TRIGGER cockpit_preparation_effect_immutable_guard BEFORE UPDATE ON cockpit_meeting_preparation_effect
 FOR EACH ROW EXECUTE FUNCTION guard_cockpit_preparation_immutable_fact();
CREATE FUNCTION guard_cockpit_preparation_operation_fact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
 OR NEW.meeting_id IS DISTINCT FROM OLD.meeting_id OR NEW.kind IS DISTINCT FROM OLD.kind
 OR NEW.command_key IS DISTINCT FROM OLD.command_key OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
 OR NEW.context_token IS DISTINCT FROM OLD.context_token OR NEW.template_id IS DISTINCT FROM OLD.template_id
 OR NEW.template_version_id IS DISTINCT FROM OLD.template_version_id OR NEW.input IS DISTINCT FROM OLD.input
 OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
 OR NEW.authorized_lifecycle_revision IS DISTINCT FROM OLD.authorized_lifecycle_revision
 OR NEW.authorized_agenda_revision IS DISTINCT FROM OLD.authorized_agenda_revision
 OR (OLD.state='completed' AND NEW IS DISTINCT FROM OLD) THEN
  RAISE EXCEPTION 'Confirmed preparation operation intent is immutable' USING ERRCODE='23514',CONSTRAINT='cockpit_meeting_preparation_integrity';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cockpit_preparation_operation_immutable_guard BEFORE UPDATE ON cockpit_meeting_preparation_operation
 FOR EACH ROW EXECUTE FUNCTION guard_cockpit_preparation_operation_fact();
COMMIT;
