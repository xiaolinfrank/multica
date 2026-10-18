BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM cockpit_meeting_work_package w LEFT JOIN cockpit_meeting m ON m.id=w.meeting_id AND m.workspace_id=w.workspace_id WHERE m.id IS NULL) THEN
  RAISE EXCEPTION 'orphan meeting work package prevents lifecycle authority transfer';
 END IF;
END $$;
UPDATE cockpit_meeting m SET ended_at=w.ended_at, ended_source='legacy_confirmation', occurrence_state='ended'
FROM cockpit_meeting_work_package w WHERE w.workspace_id=m.workspace_id AND w.meeting_id=m.id AND w.ended_at IS NOT NULL;
ALTER TABLE cockpit_meeting ADD CONSTRAINT cockpit_meeting_occurrence_check CHECK (
 lifecycle_revision>0 AND agenda_revision>0 AND occurrence_state IN ('unconfirmed','scheduled','in_progress','ended')
 AND (occurrence_state='ended')=(ended_at IS NOT NULL)
 AND (ended_at IS NULL)=(ended_source IS NULL)
 AND (ended_source IS NULL OR ended_source IN ('legacy_confirmation','human_confirmation'))
 AND (actual_ended_at IS NULL OR ended_at IS NOT NULL)
 AND (actual_started_at IS NULL OR actual_ended_at IS NULL OR actual_started_at<=actual_ended_at)
);
ALTER TABLE cockpit_meeting_work_package DROP COLUMN ended_at;
CREATE FUNCTION guard_cockpit_meeting_end_fact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.ended_at IS NOT NULL AND (NEW.ended_at IS DISTINCT FROM OLD.ended_at OR NEW.ended_by IS DISTINCT FROM OLD.ended_by OR NEW.ended_source IS DISTINCT FROM OLD.ended_source) THEN
  RAISE EXCEPTION 'the recorded meeting end confirmation cannot be replaced' USING ERRCODE='23514',CONSTRAINT='cockpit_meeting_lifecycle_integrity';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cockpit_meeting_end_fact_guard BEFORE UPDATE OF ended_at,ended_by,ended_source ON cockpit_meeting
 FOR EACH ROW EXECUTE FUNCTION guard_cockpit_meeting_end_fact();
CREATE FUNCTION guard_cockpit_meeting_release_fact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.released_at IS NOT NULL AND (NOT NEW.materials_ready OR NOT EXISTS(SELECT 1 FROM cockpit_meeting m WHERE m.workspace_id=NEW.workspace_id AND m.id=NEW.meeting_id AND m.ended_at IS NOT NULL)) THEN
  RAISE EXCEPTION 'release requires the canonical meeting end and confirmed materials' USING ERRCODE='23514',CONSTRAINT='cockpit_meeting_lifecycle_integrity';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cockpit_meeting_release_fact_guard BEFORE INSERT OR UPDATE OF released_at,materials_ready ON cockpit_meeting_work_package
 FOR EACH ROW EXECUTE FUNCTION guard_cockpit_meeting_release_fact();
COMMIT;
