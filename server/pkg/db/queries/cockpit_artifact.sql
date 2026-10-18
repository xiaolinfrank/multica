-- name: GetCockpitArtifact :one
SELECT * FROM cockpit_artifact WHERE workspace_id=$1 AND id=$2;

-- name: LockCockpitArtifact :one
SELECT * FROM cockpit_artifact WHERE workspace_id=$1 AND id=$2 FOR UPDATE;

-- name: GetCockpitArtifactByKey :one
SELECT * FROM cockpit_artifact WHERE workspace_id=$1 AND creation_key=$2;

-- name: CreateCockpitArtifact :one
INSERT INTO cockpit_artifact(id,workspace_id,owner_node_id,project_id,module_id,source_issue_id,authorized_producer_issue_id,creation_key,request_hash,created_by,title,description,reviewer_id)
VALUES(sqlc.arg(id),sqlc.arg(workspace_id),sqlc.arg(owner_node_id),sqlc.arg(project_id),sqlc.arg(module_id),sqlc.arg(source_issue_id),sqlc.arg(source_issue_id),sqlc.arg(creation_key),sqlc.arg(request_hash),sqlc.arg(created_by),sqlc.arg(title),sqlc.arg(description),sqlc.arg(reviewer_id)) RETURNING *;

-- name: EditCockpitArtifact :one
UPDATE cockpit_artifact SET title=$3,description=$4,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING *;

-- name: ArchiveCockpitArtifact :one
UPDATE cockpit_artifact SET archived_at=CASE WHEN sqlc.arg(archived)::boolean THEN now() ELSE NULL END, archived_by=CASE WHEN sqlc.arg(archived)::boolean THEN sqlc.arg(actor_id)::uuid ELSE NULL END,revision=revision+1,updated_at=now() WHERE workspace_id=sqlc.arg(workspace_id) AND id=sqlc.arg(id) RETURNING *;

-- name: SetCockpitArtifactCurrentVersion :one
UPDATE cockpit_artifact SET current_version_id=$3,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING *;

-- name: SetCockpitArtifactApprovedVersion :one
UPDATE cockpit_artifact SET approved_version_id=$3,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING *;

-- name: SetCockpitArtifactProducer :one
UPDATE cockpit_artifact SET authorized_producer_issue_id=$3,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING *;

-- name: SetCockpitArtifactReviewer :one
UPDATE cockpit_artifact SET reviewer_id=$3,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING *;

-- name: GetCockpitArtifactVersion :one
SELECT * FROM cockpit_artifact_version WHERE workspace_id=$1 AND artifact_id=$2 AND id=$3;

-- name: LockCockpitArtifactVersion :one
SELECT * FROM cockpit_artifact_version WHERE workspace_id=$1 AND artifact_id=$2 AND id=$3 FOR UPDATE;

-- name: GetCockpitArtifactVersionByKey :one
SELECT * FROM cockpit_artifact_version WHERE workspace_id=$1 AND artifact_id=$2 AND submission_key=$3;

-- name: ReadCockpitArtifactFile :one
SELECT v.id,v.workspace_id,v.artifact_id,v.storage_key,v.content_hash,v.filename,v.content_type,v.size_bytes,v.revision
FROM cockpit_artifact_version v JOIN cockpit_artifact a ON a.workspace_id=v.workspace_id AND a.id=v.artifact_id
WHERE v.workspace_id=$1 AND v.artifact_id=$2 AND v.id=$3 AND v.payload_kind='attachment' AND v.capture_status='ready';

-- name: CreateCockpitArtifactVersion :one
INSERT INTO cockpit_artifact_version(id,workspace_id,artifact_id,version_number,submission_key,request_hash,producer_issue_id,producer_issue_identifier,producer_issue_title,producer_run_id,source_meeting_id,source_meeting_title,source_minutes_version_id,source_minutes_version_number,payload_kind,content,source_attachment_id,filename,content_type,size_bytes,content_hash,storage_key,object_url,capture_status,decision,reviewer_id,review_issue_id,submitted_by_type,submitted_by_id,submitted_by_user_id,input_manifest_version_id)
VALUES(sqlc.arg(id),sqlc.arg(workspace_id),sqlc.arg(artifact_id),sqlc.arg(version_number),sqlc.arg(submission_key),sqlc.arg(request_hash),sqlc.arg(producer_issue_id),sqlc.arg(producer_issue_identifier),sqlc.arg(producer_issue_title),sqlc.narg(producer_run_id),sqlc.narg(source_meeting_id),sqlc.arg(source_meeting_title),sqlc.narg(source_minutes_version_id),sqlc.narg(source_minutes_version_number),sqlc.arg(payload_kind),sqlc.narg(content),sqlc.narg(source_attachment_id),sqlc.arg(filename),sqlc.arg(content_type),sqlc.narg(size_bytes),sqlc.narg(content_hash),sqlc.narg(storage_key),sqlc.narg(object_url),sqlc.arg(capture_status),sqlc.arg(decision),sqlc.arg(reviewer_id),sqlc.narg(review_issue_id),sqlc.arg(submitted_by_type),sqlc.arg(submitted_by_id),sqlc.arg(submitted_by_user_id),sqlc.narg(input_manifest_version_id)) RETURNING *;

-- name: ReviewCockpitArtifactVersion :one
UPDATE cockpit_artifact_version SET decision=$4,feedback=$5,reviewed_by=$6,reviewed_at=now(),revision=revision+1,updated_at=now()
WHERE workspace_id=$1 AND artifact_id=$2 AND id=$3 RETURNING *;

-- name: SetCockpitArtifactVersionReviewer :one
UPDATE cockpit_artifact_version SET reviewer_id=$4,review_issue_id=$5,revision=revision+1,updated_at=now()
WHERE workspace_id=$1 AND artifact_id=$2 AND id=$3 RETURNING *;

-- name: SetCockpitArtifactVersionCapture :one
UPDATE cockpit_artifact_version SET capture_status=$4,capture_error_code=$5,capture_error=$6,revision=revision+1,updated_at=now()
WHERE workspace_id=$1 AND artifact_id=$2 AND id=$3 RETURNING *;

-- name: CompleteCockpitArtifactVersionCapture :one
UPDATE cockpit_artifact_version SET capture_status='ready',capture_error_code='',capture_error='',storage_key=$4,object_url=$5,content_hash=$6,size_bytes=$7,decision='pending',review_issue_id=$8,revision=revision+1,updated_at=now()
WHERE workspace_id=$1 AND artifact_id=$2 AND id=$3 RETURNING *;

-- name: ListCockpitArtifactVersionMetadata :many
SELECT v.id,v.workspace_id,v.artifact_id,v.version_number,v.submission_key,v.revision,
v.producer_issue_id,v.producer_issue_identifier,v.producer_issue_title,v.producer_run_id,
v.source_meeting_id,v.source_meeting_title,v.source_minutes_version_id,v.source_minutes_version_number,
v.payload_kind,v.source_attachment_id,v.filename,v.content_type,v.size_bytes,v.content_hash,
v.capture_status,v.capture_error_code,v.capture_error,v.decision,v.reviewer_id,v.review_issue_id,
v.submitted_by_type,v.submitted_by_id,v.created_at,v.reviewed_at,(v.feedback<>'')::boolean AS has_feedback,v.input_manifest_version_id,m.issue_id AS input_manifest_issue_id,m.version_number AS input_manifest_version_number,m.manifest_hash AS input_manifest_hash FROM cockpit_artifact_version v LEFT JOIN cockpit_issue_input_manifest_version m ON m.workspace_id=v.workspace_id AND m.id=v.input_manifest_version_id WHERE v.workspace_id=sqlc.arg(workspace_id) AND v.artifact_id=sqlc.arg(artifact_id) AND (sqlc.narg(before_number)::integer IS NULL OR v.version_number<sqlc.narg(before_number)) ORDER BY v.version_number DESC LIMIT sqlc.arg(page_limit);

-- name: ListCockpitArtifactVersionMetadataByIDs :many
SELECT v.id,v.workspace_id,v.artifact_id,v.version_number,v.submission_key,v.revision,
v.producer_issue_id,v.producer_issue_identifier,v.producer_issue_title,v.producer_run_id,
v.source_meeting_id,v.source_meeting_title,v.source_minutes_version_id,v.source_minutes_version_number,
v.payload_kind,v.source_attachment_id,v.filename,v.content_type,v.size_bytes,v.content_hash,
v.capture_status,v.capture_error_code,v.capture_error,v.decision,v.reviewer_id,v.review_issue_id,
v.submitted_by_type,v.submitted_by_id,v.created_at,v.reviewed_at,(v.feedback<>'')::boolean AS has_feedback,v.input_manifest_version_id,m.issue_id AS input_manifest_issue_id,m.version_number AS input_manifest_version_number,m.manifest_hash AS input_manifest_hash FROM cockpit_artifact_version v LEFT JOIN cockpit_issue_input_manifest_version m ON m.workspace_id=v.workspace_id AND m.id=v.input_manifest_version_id WHERE v.workspace_id=sqlc.arg(workspace_id) AND v.id=ANY(sqlc.arg(version_ids)::uuid[]) ORDER BY v.id;

-- name: CountCockpitArtifactVersions :one
SELECT count(*) FROM cockpit_artifact_version WHERE workspace_id=$1 AND artifact_id=$2;

-- name: CockpitArtifactEvidenceEligible :one
SELECT EXISTS(SELECT 1 FROM cockpit_artifact a WHERE a.workspace_id=$1 AND a.id=$2 AND a.approved_version_id=$3
 AND (a.owner_node_id=$4 OR EXISTS(SELECT 1 FROM cockpit_artifact_node_reference r WHERE r.workspace_id=a.workspace_id AND r.artifact_id=a.id AND r.version_id=a.approved_version_id AND r.node_id=$4 AND r.removed_at IS NULL)));

-- name: ListCockpitArtifactSourceAttachments :many
SELECT id,issue_id,filename,content_type,size_bytes,created_at FROM attachment
WHERE workspace_id=sqlc.arg(workspace_id) AND issue_id=sqlc.arg(issue_id)
AND (sqlc.arg(query)::text='' OR filename ILIKE '%'||sqlc.arg(query)||'%')
AND (sqlc.narg(after_id)::uuid IS NULL OR id>sqlc.narg(after_id)) ORDER BY id LIMIT sqlc.arg(page_limit);

-- name: CountCockpitArtifactSourceAttachments :one
SELECT count(*) AS total,count(*) FILTER(WHERE sqlc.arg(query)::text='' OR filename ILIKE '%'||sqlc.arg(query)||'%') AS filtered_total
FROM attachment WHERE workspace_id=sqlc.arg(workspace_id) AND issue_id=sqlc.arg(issue_id);

-- name: ListCockpitArtifacts :many
WITH candidates AS MATERIALIZED (
SELECT a.id,a.title,a.archived_at,a.current_version_id FROM cockpit_artifact a
WHERE a.workspace_id=sqlc.arg(workspace_id)
AND (sqlc.narg(node_id)::uuid IS NOT NULL OR sqlc.narg(project_id)::uuid IS NULL OR a.project_id=sqlc.narg(project_id))
AND (sqlc.narg(node_id)::uuid IS NOT NULL OR sqlc.narg(module_id)::uuid IS NULL OR a.module_id=sqlc.narg(module_id))
AND (sqlc.narg(source_issue_id)::uuid IS NULL OR a.source_issue_id=sqlc.narg(source_issue_id))
AND (cardinality(sqlc.arg(ids)::uuid[])=0 OR a.id=ANY(sqlc.arg(ids)::uuid[]))
AND (sqlc.narg(node_id)::uuid IS NULL OR
 (sqlc.arg(relation)::text IN ('owned','all') AND a.owner_node_id=sqlc.narg(node_id)) OR
 (sqlc.arg(relation)::text IN ('referenced','all') AND EXISTS(SELECT 1 FROM cockpit_artifact_node_reference r WHERE r.workspace_id=a.workspace_id AND r.artifact_id=a.id AND r.node_id=sqlc.narg(node_id) AND r.removed_at IS NULL)))
), filtered AS MATERIALIZED (
SELECT a.id FROM candidates a LEFT JOIN cockpit_artifact_version v ON v.workspace_id=sqlc.arg(workspace_id) AND v.id=a.current_version_id
WHERE (sqlc.arg(query)::text='' OR a.title ILIKE '%'||sqlc.arg(query)||'%')
AND (sqlc.arg(status)::text='' OR CASE WHEN a.archived_at IS NOT NULL THEN 'archived' WHEN a.current_version_id IS NULL THEN 'draft' WHEN v.capture_status IN ('queued','running','retry_wait') THEN 'capturing' WHEN v.capture_status='needs_attention' THEN 'needs_attention' WHEN v.capture_status='ready' AND v.decision IN ('pending','approved','changes_requested','rejected') THEN v.decision ELSE 'unknown' END=sqlc.arg(status))
)
SELECT a.* FROM filtered f JOIN cockpit_artifact a ON a.workspace_id=sqlc.arg(workspace_id) AND a.id=f.id
WHERE sqlc.narg(after_id)::uuid IS NULL OR a.id>sqlc.narg(after_id) ORDER BY a.id LIMIT sqlc.arg(page_limit);

-- name: CountCockpitArtifacts :one
WITH candidates AS MATERIALIZED (
SELECT a.id,a.title,a.archived_at,a.current_version_id FROM cockpit_artifact a
WHERE a.workspace_id=sqlc.arg(workspace_id)
AND (sqlc.narg(node_id)::uuid IS NOT NULL OR sqlc.narg(project_id)::uuid IS NULL OR a.project_id=sqlc.narg(project_id))
AND (sqlc.narg(node_id)::uuid IS NOT NULL OR sqlc.narg(module_id)::uuid IS NULL OR a.module_id=sqlc.narg(module_id))
AND (sqlc.narg(source_issue_id)::uuid IS NULL OR a.source_issue_id=sqlc.narg(source_issue_id))
AND (cardinality(sqlc.arg(ids)::uuid[])=0 OR a.id=ANY(sqlc.arg(ids)::uuid[]))
AND (sqlc.narg(node_id)::uuid IS NULL OR
 (sqlc.arg(relation)::text IN ('owned','all') AND a.owner_node_id=sqlc.narg(node_id)) OR
 (sqlc.arg(relation)::text IN ('referenced','all') AND EXISTS(SELECT 1 FROM cockpit_artifact_node_reference r WHERE r.workspace_id=a.workspace_id AND r.artifact_id=a.id AND r.node_id=sqlc.narg(node_id) AND r.removed_at IS NULL)))
), filtered AS MATERIALIZED (
SELECT a.id FROM candidates a LEFT JOIN cockpit_artifact_version v ON v.workspace_id=sqlc.arg(workspace_id) AND v.id=a.current_version_id
WHERE (sqlc.arg(query)::text='' OR a.title ILIKE '%'||sqlc.arg(query)||'%')
AND (sqlc.arg(status)::text='' OR CASE WHEN a.archived_at IS NOT NULL THEN 'archived' WHEN a.current_version_id IS NULL THEN 'draft' WHEN v.capture_status IN ('queued','running','retry_wait') THEN 'capturing' WHEN v.capture_status='needs_attention' THEN 'needs_attention' WHEN v.capture_status='ready' AND v.decision IN ('pending','approved','changes_requested','rejected') THEN v.decision ELSE 'unknown' END=sqlc.arg(status))
)
SELECT (SELECT count(*) FROM candidates)::bigint AS total,(SELECT count(*) FROM filtered)::bigint AS filtered_total;
