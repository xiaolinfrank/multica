-- name: LockCockpitTemplateCommand :exec
SELECT pg_advisory_xact_lock(hashtextextended(sqlc.arg(workspace_id)::text||':meeting-template:'||sqlc.arg(command_key)::text,0));

-- name: GetCockpitMeetingTemplateVersionByKey :one
SELECT * FROM cockpit_meeting_template_version WHERE cockpit_meeting_template_version.workspace_id=$1 AND command_key=$2;

-- name: LockCockpitMeetingTemplate :one
SELECT * FROM cockpit_meeting_template WHERE cockpit_meeting_template.workspace_id=$1 AND id=$2 FOR UPDATE;

-- name: CreateCockpitMeetingTemplate :one
INSERT INTO cockpit_meeting_template(id,workspace_id,current_version_id,title,description,is_active,created_by)
VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *;

-- name: UpdateCockpitMeetingTemplate :one
UPDATE cockpit_meeting_template SET current_version_id=$3,title=$4,description=$5,is_active=$6,revision=revision+1,updated_at=now()
WHERE workspace_id=$1 AND id=$2 AND revision=$7 RETURNING *;

-- name: CreateCockpitMeetingTemplateVersion :one
INSERT INTO cockpit_meeting_template_version(id,workspace_id,template_id,number,title,description,is_active,config_schema,config,config_hash,slot_count,command_key,request_hash,receipt,created_by,created_at)
VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *;

-- name: GetCockpitMeetingTemplateHeader :one
SELECT sqlc.embed(t),v.number,v.config_hash,v.slot_count,v.command_key,v.created_by AS version_created_by,v.created_at AS version_created_at,COALESCE(u.name,'')::text AS version_created_by_name
FROM cockpit_meeting_template t
JOIN cockpit_meeting_template_version v ON v.workspace_id=t.workspace_id AND v.template_id=t.id AND v.id=t.current_version_id
LEFT JOIN "user" u ON u.id=v.created_by
WHERE t.workspace_id=$1 AND t.id=$2;

-- name: ListCockpitMeetingTemplates :many
SELECT sqlc.embed(t),v.number,v.config_hash,v.slot_count,v.command_key,v.created_by AS version_created_by,v.created_at AS version_created_at,COALESCE(u.name,'')::text AS version_created_by_name
FROM cockpit_meeting_template t
JOIN cockpit_meeting_template_version v ON v.workspace_id=t.workspace_id AND v.template_id=t.id AND v.id=t.current_version_id
LEFT JOIN "user" u ON u.id=v.created_by
WHERE t.workspace_id=sqlc.arg(workspace_id) AND (sqlc.arg(include_inactive)::boolean OR t.is_active)
AND (sqlc.arg(query)::text='' OR t.title ILIKE '%'||sqlc.arg(query)||'%')
AND (sqlc.narg(after_id)::uuid IS NULL OR t.id<sqlc.narg(after_id))
ORDER BY t.id DESC LIMIT sqlc.arg(page_limit);

-- name: CountCockpitMeetingTemplates :one
SELECT count(*) FROM cockpit_meeting_template WHERE cockpit_meeting_template.workspace_id=sqlc.arg(workspace_id)
AND (sqlc.arg(include_inactive)::boolean OR is_active)
AND (sqlc.arg(query)::text='' OR title ILIKE '%'||sqlc.arg(query)||'%');

-- name: GetCockpitMeetingTemplateVersion :one
SELECT * FROM cockpit_meeting_template_version WHERE cockpit_meeting_template_version.workspace_id=$1 AND template_id=$2 AND id=$3;

-- name: ListCockpitMeetingTemplateVersions :many
SELECT v.id,v.workspace_id,v.template_id,v.number,v.title,v.is_active,v.config_hash,v.slot_count,v.command_key,v.created_by,v.created_at,COALESCE(u.name,'')::text AS created_by_name
FROM cockpit_meeting_template_version v LEFT JOIN "user" u ON u.id=v.created_by
WHERE v.workspace_id=sqlc.arg(workspace_id) AND v.template_id=sqlc.arg(template_id)
AND (sqlc.narg(after_id)::uuid IS NULL OR (v.number,v.id)<(sqlc.arg(after_number)::integer,sqlc.narg(after_id)))
ORDER BY v.number DESC,v.id DESC LIMIT sqlc.arg(page_limit);

-- name: CountCockpitMeetingTemplateVersions :one
SELECT count(*) FROM cockpit_meeting_template_version WHERE cockpit_meeting_template_version.workspace_id=$1 AND template_id=$2;

-- name: DeleteCockpitMeetingPreparationByWorkspace :exec
WITH effects AS(DELETE FROM cockpit_meeting_preparation_effect WHERE cockpit_meeting_preparation_effect.workspace_id=$1),
operations AS(DELETE FROM cockpit_meeting_preparation_operation WHERE cockpit_meeting_preparation_operation.workspace_id=$1),
versions AS(DELETE FROM cockpit_meeting_template_version WHERE cockpit_meeting_template_version.workspace_id=$1)
DELETE FROM cockpit_meeting_template WHERE cockpit_meeting_template.workspace_id=$1;

-- name: HasCockpitMeetingPreparation :one
SELECT EXISTS(
 SELECT 1 FROM cockpit_meeting_preparation_operation WHERE cockpit_meeting_preparation_operation.workspace_id=$1
 UNION ALL SELECT 1 FROM cockpit_meeting WHERE cockpit_meeting.workspace_id=$1 AND (cancelled_at IS NOT NULL OR archived_at IS NOT NULL)
 UNION ALL SELECT 1 FROM cockpit_meeting_lifecycle_command WHERE cockpit_meeting_lifecycle_command.workspace_id=$1 AND (operation_id IS NOT NULL OR kind IN ('cancel','reinstate','archive','unarchive'))
);

-- name: GetCockpitMeetingTemplateVersionByID :one
SELECT * FROM cockpit_meeting_template_version WHERE workspace_id=$1 AND id=$2;
