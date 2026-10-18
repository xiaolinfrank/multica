-- R1 part 2: carry work-package rows onto the meeting and the roles array,
-- then drop the table. The runner does not wrap files in a transaction, so
-- the backfill is atomic in an explicit one.
BEGIN;

UPDATE cockpit_meeting m SET
    minutes_reviewer_id = w.reviewer_id,
    minutes_focus_issue_id = w.minutes_issue_id,
    minutes_current_version_id = w.current_version_id,
    minutes_published_version_id = w.published_version_id,
    minutes_revision = w.revision,
    minutes_materials_ready = w.materials_ready,
    minutes_materials_confirmed_at = w.materials_confirmed_at,
    minutes_materials_confirmed_by = w.materials_confirmed_by,
    minutes_configured_by = w.created_by
FROM cockpit_meeting_work_package w
WHERE w.workspace_id = m.workspace_id AND w.meeting_id = m.id;

-- Re-establish the minutes binding as a roles-array entry. Existing links
-- keep their provisioning marker; 'minutes' rides in roles (956 design).
UPDATE cockpit_meeting_issue l SET roles = array_append(l.roles, 'minutes')
FROM cockpit_meeting_work_package w
WHERE w.workspace_id = l.workspace_id AND w.meeting_id = l.meeting_id
  AND w.minutes_issue_id = l.issue_id
  AND NOT ('minutes' = ANY(l.roles));

INSERT INTO cockpit_meeting_issue(workspace_id, meeting_id, issue_id, role, roles)
SELECT w.workspace_id, w.meeting_id, w.minutes_issue_id, '', ARRAY['minutes']
FROM cockpit_meeting_work_package w
WHERE NOT EXISTS (
    SELECT 1 FROM cockpit_meeting_issue l
    WHERE l.workspace_id = w.workspace_id AND l.meeting_id = w.meeting_id
      AND l.issue_id = w.minutes_issue_id);

DROP TRIGGER IF EXISTS cockpit_meeting_release_fact_guard ON cockpit_meeting_work_package;
DROP FUNCTION IF EXISTS guard_cockpit_meeting_release_fact();
DROP TABLE cockpit_meeting_work_package;

COMMIT;
