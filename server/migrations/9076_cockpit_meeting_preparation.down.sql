BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM cockpit_meeting_template) OR EXISTS(SELECT 1 FROM cockpit_meeting_template_version)
 OR EXISTS(SELECT 1 FROM cockpit_meeting_preparation_operation) OR EXISTS(SELECT 1 FROM cockpit_meeting_preparation_effect)
 OR EXISTS(SELECT 1 FROM cockpit_meeting WHERE cancelled_at IS NOT NULL OR archived_at IS NOT NULL)
 OR EXISTS(SELECT 1 FROM cockpit_meeting_lifecycle_command WHERE operation_id IS NOT NULL OR kind IN ('cancel','reinstate','archive','unarchive')) THEN
  RAISE EXCEPTION 'meeting preparation facts require a consistent backup or explicit application cleanup before rollback';
 END IF;
END $$;
DROP TABLE cockpit_meeting_preparation_effect;
DROP TABLE cockpit_meeting_preparation_operation;
DROP TABLE cockpit_meeting_template_version;
DROP TABLE cockpit_meeting_template;
ALTER TABLE cockpit_meeting_lifecycle_command DROP COLUMN operation_id, DROP COLUMN effect_id;
ALTER TABLE cockpit_meeting DROP COLUMN cancelled_at, DROP COLUMN cancelled_by, DROP COLUMN cancelled_reason,
 DROP COLUMN archived_at, DROP COLUMN archived_by, DROP COLUMN archived_reason;
COMMIT;
