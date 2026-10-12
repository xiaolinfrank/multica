-- Best-effort reverse of 9145: rebuild the work package row from the
-- meeting columns and the focus binding. Bindings beyond the focus pointer
-- cannot be represented in the old single-binding model.
BEGIN;

DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM cockpit_meeting_issue l
   WHERE 'minutes' = ANY(l.roles)
     AND l.issue_id <> (SELECT m.minutes_focus_issue_id FROM cockpit_meeting m
                        WHERE m.workspace_id = l.workspace_id AND m.id = l.meeting_id)) THEN
  RAISE EXCEPTION 'multiple minutes bindings prevent rollback to the single-binding model';
 END IF;
END $$;

CREATE TABLE cockpit_meeting_work_package (
 workspace_id UUID NOT NULL,
 meeting_id UUID NOT NULL,
 revision BIGINT NOT NULL DEFAULT 1,
 minutes_issue_id UUID NOT NULL,
 reviewer_id UUID NOT NULL,
 materials_ready BOOLEAN NOT NULL DEFAULT false,
 materials_confirmed_at TIMESTAMPTZ,
 materials_confirmed_by UUID,
 release_task_id UUID,
 current_version_id UUID,
 published_version_id UUID,
 created_by UUID NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO cockpit_meeting_work_package(
 workspace_id, meeting_id, revision, minutes_issue_id, reviewer_id,
 materials_ready, materials_confirmed_at, materials_confirmed_by,
 current_version_id, published_version_id, created_by)
SELECT m.workspace_id, m.id, m.minutes_revision, m.minutes_focus_issue_id,
 COALESCE(m.minutes_reviewer_id, m.minutes_configured_by), m.minutes_materials_ready,
 m.minutes_materials_confirmed_at, m.minutes_materials_confirmed_by,
 m.minutes_current_version_id, m.minutes_published_version_id, m.minutes_configured_by
FROM cockpit_meeting m
WHERE m.minutes_focus_issue_id IS NOT NULL AND m.minutes_reviewer_id IS NOT NULL
  AND m.minutes_configured_by IS NOT NULL;

CREATE UNIQUE INDEX cockpit_work_package_pkey_idx ON cockpit_meeting_work_package (workspace_id, meeting_id);
CREATE UNIQUE INDEX cockpit_work_package_issue_idx ON cockpit_meeting_work_package (minutes_issue_id);

UPDATE cockpit_meeting_issue l SET roles = array_remove(l.roles, 'minutes')
FROM cockpit_meeting m
WHERE m.workspace_id = l.workspace_id AND m.id = l.meeting_id
  AND m.minutes_focus_issue_id = l.issue_id AND 'minutes' = ANY(l.roles);

COMMIT;
