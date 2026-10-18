-- These triggers reject invalid writes only. Relationship cleanup remains in
-- application transactions, including workspace teardown and stored objects.
CREATE OR REPLACE FUNCTION cockpit_artifact_is_review_issue(issue_uuid UUID) RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
 WITH owner AS (SELECT workspace_id FROM issue WHERE id=issue_uuid)
 SELECT EXISTS(SELECT 1 FROM cockpit_artifact_version v,owner o WHERE v.workspace_id=o.workspace_id AND v.review_issue_id=issue_uuid)
 OR EXISTS(SELECT 1 FROM cockpit_artifact_reviewer_handoff h,owner o WHERE h.workspace_id=o.workspace_id AND h.from_review_issue_id=issue_uuid)
 OR EXISTS(SELECT 1 FROM cockpit_acceptance_request r,owner o WHERE r.workspace_id=o.workspace_id AND r.review_issue_id=issue_uuid)
 OR EXISTS(SELECT 1 FROM cockpit_acceptance_reviewer_handoff h,owner o WHERE h.workspace_id=o.workspace_id AND h.from_review_issue_id=issue_uuid)
$$;

CREATE OR REPLACE FUNCTION cockpit_artifact_references_issue(ws UUID,issue_uuid UUID) RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM cockpit_artifact WHERE workspace_id=ws AND (source_issue_id=issue_uuid OR authorized_producer_issue_id=issue_uuid))
 OR EXISTS(SELECT 1 FROM cockpit_artifact_version WHERE workspace_id=ws AND (producer_issue_id=issue_uuid OR review_issue_id=issue_uuid))
 OR EXISTS(SELECT 1 FROM cockpit_artifact_producer_assignment WHERE workspace_id=ws AND (from_issue_id=issue_uuid OR to_issue_id=issue_uuid))
 OR EXISTS(SELECT 1 FROM cockpit_artifact_reviewer_handoff WHERE workspace_id=ws AND from_review_issue_id=issue_uuid)
 OR EXISTS(SELECT 1 FROM cockpit_acceptance_request WHERE workspace_id=ws AND review_issue_id=issue_uuid)
 OR EXISTS(SELECT 1 FROM cockpit_acceptance_reviewer_handoff WHERE workspace_id=ws AND from_review_issue_id=issue_uuid)
$$;

CREATE OR REPLACE FUNCTION cockpit_artifact_references_node(ws UUID,node_uuid UUID) RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM cockpit_artifact WHERE workspace_id=ws AND owner_node_id=node_uuid)
 OR EXISTS(SELECT 1 FROM cockpit_artifact_node_reference WHERE workspace_id=ws AND node_id=node_uuid AND removed_at IS NULL)
 OR EXISTS(SELECT 1 FROM cockpit_acceptance_definition WHERE workspace_id=ws AND node_id=node_uuid)
$$;

CREATE OR REPLACE FUNCTION cockpit_artifact_review_stage(ws UUID,issue_uuid UUID) RETURNS TEXT LANGUAGE SQL STABLE AS $$
 SELECT CASE
 WHEN EXISTS(SELECT 1 FROM cockpit_artifact_reviewer_handoff WHERE workspace_id=ws AND from_review_issue_id=issue_uuid)
   OR EXISTS(SELECT 1 FROM cockpit_acceptance_reviewer_handoff WHERE workspace_id=ws AND from_review_issue_id=issue_uuid)
   OR EXISTS(SELECT 1 FROM cockpit_acceptance_request WHERE workspace_id=ws AND review_issue_id=issue_uuid AND superseded_at IS NOT NULL) THEN 'closed'
 WHEN EXISTS(SELECT 1 FROM cockpit_artifact_version WHERE workspace_id=ws AND review_issue_id=issue_uuid AND decision='pending')
   OR EXISTS(SELECT 1 FROM cockpit_acceptance_request WHERE workspace_id=ws AND review_issue_id=issue_uuid AND decision='pending') THEN 'pending'
 WHEN cockpit_artifact_is_review_issue(issue_uuid) THEN 'done'
 ELSE '' END
$$;

CREATE OR REPLACE FUNCTION cockpit_artifact_review_node(ws UUID,issue_uuid UUID) RETURNS UUID LANGUAGE SQL STABLE AS $$
 SELECT node_id FROM (
  SELECT a.owner_node_id AS node_id FROM cockpit_artifact_version v JOIN cockpit_artifact a ON a.id=v.artifact_id AND a.workspace_id=v.workspace_id
   WHERE v.workspace_id=ws AND v.review_issue_id=issue_uuid
  UNION SELECT a.owner_node_id FROM cockpit_artifact_reviewer_handoff h JOIN cockpit_artifact a ON a.id=h.artifact_id AND a.workspace_id=h.workspace_id
   WHERE h.workspace_id=ws AND h.from_review_issue_id=issue_uuid
  UNION SELECT node_id FROM cockpit_acceptance_request WHERE workspace_id=ws AND review_issue_id=issue_uuid
  UNION SELECT node_id FROM cockpit_acceptance_reviewer_handoff WHERE workspace_id=ws AND from_review_issue_id=issue_uuid
 ) owner LIMIT 1
$$;

CREATE OR REPLACE FUNCTION enforce_cockpit_workflow_execution_gate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.issue_id IS NOT NULL AND NEW.status IN ('queued','deferred','dispatched','running','waiting_local_directory') THEN
  PERFORM 1 FROM issue WHERE id=NEW.issue_id FOR KEY SHARE;
  IF EXISTS(SELECT 1 FROM cockpit_meeting_work_package WHERE minutes_issue_id=NEW.issue_id AND released_at IS NULL)
    OR EXISTS(SELECT 1 FROM cockpit_minutes_version WHERE review_issue_id=NEW.issue_id)
    OR EXISTS(SELECT 1 FROM cockpit_reviewer_handoff WHERE from_review_issue_id=NEW.issue_id OR to_review_issue_id=NEW.issue_id)
    OR cockpit_artifact_is_review_issue(NEW.issue_id) THEN
   RAISE EXCEPTION 'cockpit workflow issue is not available for agent execution' USING ERRCODE='23514', CONSTRAINT='cockpit_workflow_execution_gate';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_cockpit_artifact_issue() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE formal_stage TEXT; new_category TEXT;
BEGIN
 IF TG_OP='DELETE' THEN
  IF cockpit_artifact_references_issue(OLD.workspace_id,OLD.id) THEN
   RAISE EXCEPTION 'Issue is retained by fixed artifact or acceptance facts' USING ERRCODE='23514',CONSTRAINT='cockpit_artifact_integrity';
  END IF;
  RETURN OLD;
 END IF;
 IF cockpit_artifact_is_review_issue(OLD.id) THEN
  IF NEW.assignee_type IS DISTINCT FROM OLD.assignee_type OR NEW.assignee_id IS DISTINCT FROM OLD.assignee_id THEN
   RAISE EXCEPTION 'Use formal artifact or acceptance reviewer handoff instead of ordinary Issue reassignment' USING ERRCODE='23514',CONSTRAINT='cockpit_artifact_integrity';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
   formal_stage:=cockpit_artifact_review_stage(OLD.workspace_id,OLD.id);
   SELECT cockpit_issue_category(NEW.status,(SELECT category FROM issue_status WHERE workspace_id=OLD.workspace_id AND key=NEW.status)) INTO new_category;
   IF (formal_stage='pending' AND new_category IN ('done','closed')) OR (formal_stage='done' AND new_category<>'done') OR (formal_stage='closed' AND new_category<>'closed') THEN
    RAISE EXCEPTION 'Use the artifact or acceptance review entry; ordinary Issue status cannot finish or reopen formal review' USING ERRCODE='23514',CONSTRAINT='cockpit_artifact_integrity';
   END IF;
  END IF;
 END IF;
 IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.module_id IS DISTINCT FROM OLD.module_id THEN
  IF EXISTS(WITH RECURSIVE children(id) AS (
   SELECT OLD.id UNION SELECT i.id FROM issue i JOIN children c ON i.parent_issue_id=c.id WHERE i.workspace_id=OLD.workspace_id
  ) SELECT 1 FROM children WHERE cockpit_artifact_references_issue(OLD.workspace_id,id)) THEN
   RAISE EXCEPTION 'Artifact production and formal review tasks retain their project and module scope' USING ERRCODE='23514',CONSTRAINT='cockpit_artifact_integrity';
  END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS cockpit_artifact_issue_guard ON issue;
CREATE TRIGGER cockpit_artifact_issue_guard BEFORE UPDATE OF workspace_id,project_id,module_id,status,assignee_type,assignee_id OR DELETE ON issue
 FOR EACH ROW EXECUTE FUNCTION guard_cockpit_artifact_issue();

CREATE OR REPLACE FUNCTION guard_cockpit_artifact_node() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' OR (TG_OP='UPDATE' AND NEW.parent_id IS DISTINCT FROM OLD.parent_id) THEN
  IF cockpit_artifact_references_node(NEW.workspace_id,NEW.parent_id) THEN
   RAISE EXCEPTION 'An artifact or acceptance execution leaf cannot become a display group' USING ERRCODE='23514',CONSTRAINT='cockpit_artifact_integrity';
  END IF;
 END IF;
 IF TG_OP='INSERT' THEN RETURN NEW; END IF;
 IF TG_OP='DELETE' OR NEW.parent_id IS DISTINCT FROM OLD.parent_id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.module_id IS DISTINCT FROM OLD.module_id THEN
  IF EXISTS(WITH RECURSIVE descendants(id) AS (
   SELECT OLD.id UNION SELECT n.id FROM cockpit_node n JOIN descendants d ON n.parent_id=d.id WHERE n.workspace_id=OLD.workspace_id
  ) SELECT 1 FROM descendants WHERE cockpit_artifact_references_node(OLD.workspace_id,id)) THEN
   RAISE EXCEPTION 'This planning structure is retained by artifact or acceptance facts' USING ERRCODE='23514',CONSTRAINT='cockpit_artifact_integrity';
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS cockpit_artifact_node_guard ON cockpit_node;
CREATE TRIGGER cockpit_artifact_node_guard BEFORE INSERT OR UPDATE OR DELETE ON cockpit_node
 FOR EACH ROW EXECUTE FUNCTION guard_cockpit_artifact_node();

CREATE OR REPLACE FUNCTION guard_cockpit_artifact_meeting() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM cockpit_artifact_version WHERE workspace_id=OLD.workspace_id AND source_meeting_id=OLD.id)
 OR EXISTS(SELECT 1 FROM cockpit_artifact_meeting_reference WHERE workspace_id=OLD.workspace_id AND meeting_id=OLD.id AND removed_at IS NULL) THEN
  RAISE EXCEPTION 'Meeting is retained by fixed artifact provenance or references' USING ERRCODE='23514',CONSTRAINT='cockpit_artifact_integrity';
 END IF;
 RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS cockpit_artifact_meeting_guard ON cockpit_meeting;
CREATE TRIGGER cockpit_artifact_meeting_guard BEFORE DELETE ON cockpit_meeting
 FOR EACH ROW EXECUTE FUNCTION guard_cockpit_artifact_meeting();

CREATE OR REPLACE FUNCTION guard_cockpit_artifact_review_primary() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target UUID;
BEGIN
 IF TG_OP='DELETE' THEN
  IF cockpit_artifact_review_node(OLD.workspace_id,OLD.issue_id) IS NOT NULL THEN
   RAISE EXCEPTION 'Formal review retains its primary execution context' USING ERRCODE='23514',CONSTRAINT='cockpit_artifact_integrity';
  END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND (NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.issue_id IS DISTINCT FROM OLD.issue_id)
    AND cockpit_artifact_review_node(OLD.workspace_id,OLD.issue_id) IS NOT NULL THEN
  RAISE EXCEPTION 'Formal review retains its Issue identity and workspace' USING ERRCODE='23514',CONSTRAINT='cockpit_artifact_integrity';
 END IF;
 target:=cockpit_artifact_review_node(NEW.workspace_id,NEW.issue_id);
 IF target IS NOT NULL AND (NEW.node_id IS DISTINCT FROM target OR NEW.issue_deleted_at IS NOT NULL) THEN
  RAISE EXCEPTION 'Formal review retains its primary execution context' USING ERRCODE='23514',CONSTRAINT='cockpit_artifact_integrity';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS cockpit_artifact_review_primary_guard ON cockpit_issue_primary;
CREATE TRIGGER cockpit_artifact_review_primary_guard BEFORE INSERT OR UPDATE OR DELETE ON cockpit_issue_primary
 FOR EACH ROW EXECUTE FUNCTION guard_cockpit_artifact_review_primary();
