BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM cockpit_meeting_lifecycle_command) OR EXISTS(SELECT 1 FROM cockpit_meeting_agenda) OR EXISTS(SELECT 1 FROM cockpit_meeting_agenda_reference)
 OR EXISTS(SELECT 1 FROM cockpit_meeting WHERE lifecycle_revision>1 OR ended_source='human_confirmation' OR actual_started_at IS NOT NULL OR actual_ended_at IS NOT NULL) THEN
  RAISE EXCEPTION 'new meeting lifecycle facts prevent rollback; use a compatible binary or consistent backup';
 END IF;
END $$;
DROP TRIGGER cockpit_meeting_release_fact_guard ON cockpit_meeting_work_package;
DROP FUNCTION guard_cockpit_meeting_release_fact();
DROP TRIGGER cockpit_meeting_end_fact_guard ON cockpit_meeting;
DROP FUNCTION guard_cockpit_meeting_end_fact();
ALTER TABLE cockpit_meeting_work_package ADD COLUMN ended_at TIMESTAMPTZ;
UPDATE cockpit_meeting_work_package w SET ended_at=m.ended_at FROM cockpit_meeting m WHERE m.workspace_id=w.workspace_id AND m.id=w.meeting_id;
ALTER TABLE cockpit_meeting DROP CONSTRAINT cockpit_meeting_occurrence_check;
COMMIT;
