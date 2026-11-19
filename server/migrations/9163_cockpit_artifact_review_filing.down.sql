-- Restore the pre-9163 guard: the receipt node_id named the review node.

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
