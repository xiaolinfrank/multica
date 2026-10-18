BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM cockpit_meeting_template) OR EXISTS(SELECT 1 FROM cockpit_meeting_template_version)
 OR EXISTS(SELECT 1 FROM cockpit_meeting_preparation_operation) OR EXISTS(SELECT 1 FROM cockpit_meeting_preparation_effect)
 OR EXISTS(SELECT 1 FROM cockpit_meeting WHERE cancelled_at IS NOT NULL OR archived_at IS NOT NULL)
 OR EXISTS(SELECT 1 FROM cockpit_meeting_lifecycle_command WHERE operation_id IS NOT NULL OR kind IN ('cancel','reinstate','archive','unarchive')) THEN
  RAISE EXCEPTION 'meeting preparation facts prevent rollback; preserve the schema or restore a consistent backup';
 END IF;
END $$;
DROP TRIGGER cockpit_preparation_operation_immutable_guard ON cockpit_meeting_preparation_operation;
DROP FUNCTION guard_cockpit_preparation_operation_fact();
DROP TRIGGER cockpit_preparation_effect_immutable_guard ON cockpit_meeting_preparation_effect;
DROP TRIGGER cockpit_template_version_immutable_guard ON cockpit_meeting_template_version;
DROP FUNCTION guard_cockpit_preparation_immutable_fact();
DROP TRIGGER cockpit_meeting_preparation_fact_guard ON cockpit_meeting;
DROP FUNCTION guard_cockpit_meeting_preparation_fact();
ALTER TABLE cockpit_meeting DROP CONSTRAINT cockpit_meeting_occurrence_check;
ALTER TABLE cockpit_meeting ADD CONSTRAINT cockpit_meeting_occurrence_check CHECK (
 lifecycle_revision>0 AND agenda_revision>0 AND occurrence_state IN ('unconfirmed','scheduled','in_progress','ended')
 AND (occurrence_state='ended')=(ended_at IS NOT NULL)
 AND (ended_at IS NULL)=(ended_source IS NULL)
 AND (ended_source IS NULL OR ended_source IN ('legacy_confirmation','human_confirmation'))
 AND (actual_ended_at IS NULL OR ended_at IS NOT NULL)
 AND (actual_started_at IS NULL OR actual_ended_at IS NULL OR actual_started_at<=actual_ended_at)
);
COMMIT;
