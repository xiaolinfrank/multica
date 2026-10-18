DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM cockpit_meeting_lifecycle_command) OR EXISTS(SELECT 1 FROM cockpit_meeting_agenda) OR EXISTS(SELECT 1 FROM cockpit_meeting_agenda_reference) THEN
  RAISE EXCEPTION 'meeting lifecycle data must be restored or explicitly cleared before rollback';
 END IF;
END $$;
DROP TABLE cockpit_meeting_lifecycle_command;
DROP TABLE cockpit_meeting_agenda_reference;
DROP TABLE cockpit_meeting_agenda;
ALTER TABLE cockpit_meeting_work_package DROP COLUMN materials_confirmed_at, DROP COLUMN materials_confirmed_by;
ALTER TABLE cockpit_meeting DROP COLUMN lifecycle_revision, DROP COLUMN agenda_revision, DROP COLUMN occurrence_state,
 DROP COLUMN started_confirmed_at, DROP COLUMN started_confirmed_by, DROP COLUMN ended_at, DROP COLUMN ended_by,
 DROP COLUMN ended_source, DROP COLUMN actual_started_at, DROP COLUMN actual_ended_at,
 DROP COLUMN lifecycle_updated_at, DROP COLUMN lifecycle_updated_by;
