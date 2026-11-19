-- Restore the pre-9162 guards: project/module changes and structural edits
-- were refused while a primary receipt named a node.

CREATE OR REPLACE FUNCTION guard_cockpit_primary_issue_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM cockpit_meeting_action WHERE workspace_id=OLD.workspace_id AND issue_id=OLD.id) THEN
   RAISE EXCEPTION 'Issue is retained by a confirmed meeting action' USING ERRCODE='23514',CONSTRAINT='cockpit_primary_integrity';
  END IF;
  IF EXISTS(SELECT 1 FROM cockpit_issue_primary WHERE issue_id=OLD.id AND workspace_id=OLD.workspace_id AND issue_deleted_at IS NULL) THEN
   RAISE EXCEPTION 'Issue deletion must retain its primary creation receipt in the application transaction' USING ERRCODE='23514',CONSTRAINT='cockpit_primary_integrity';
  END IF;
  RETURN OLD;
 END IF;
 IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.module_id IS DISTINCT FROM OLD.module_id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
  IF EXISTS(WITH RECURSIVE descendants(id) AS (
   SELECT OLD.id UNION SELECT i.id FROM issue i JOIN descendants d ON i.parent_issue_id=d.id WHERE i.workspace_id=OLD.workspace_id
  ) SELECT 1 FROM descendants d JOIN cockpit_issue_primary p ON p.issue_id=d.id
    WHERE p.workspace_id=OLD.workspace_id AND p.node_id IS NOT NULL) THEN
   RAISE EXCEPTION 'Clear L3 primary ownership on this issue and its descendants before changing project/module' USING ERRCODE='23514',CONSTRAINT='cockpit_primary_integrity';
  END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_cockpit_primary_node_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' OR (TG_OP='UPDATE' AND NEW.parent_id IS DISTINCT FROM OLD.parent_id) THEN
  IF EXISTS(SELECT 1 FROM cockpit_issue_primary WHERE workspace_id=NEW.workspace_id AND node_id=NEW.parent_id) THEN
   RAISE EXCEPTION 'Clear L3 primary ownership before turning an execution leaf into a group' USING ERRCODE='23514',CONSTRAINT='cockpit_primary_integrity';
  END IF;
 END IF;
 IF TG_OP='INSERT' THEN RETURN NEW; END IF;
 IF TG_OP='DELETE' OR NEW.parent_id IS DISTINCT FROM OLD.parent_id OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.module_id IS DISTINCT FROM OLD.module_id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
  IF EXISTS(WITH RECURSIVE descendants(id) AS (
   SELECT OLD.id UNION SELECT n.id FROM cockpit_node n JOIN descendants d ON n.parent_id=d.id WHERE n.workspace_id=OLD.workspace_id
  ) SELECT 1 FROM descendants d JOIN cockpit_issue_primary p ON p.node_id=d.id WHERE p.workspace_id=OLD.workspace_id) THEN
   RAISE EXCEPTION 'Clear descendant L3 primary ownership before changing this planning structure' USING ERRCODE='23514',CONSTRAINT='cockpit_primary_integrity';
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM cockpit_meeting_action WHERE workspace_id=OLD.workspace_id AND node_id=OLD.id) THEN
   RAISE EXCEPTION 'Execution node is retained by a confirmed meeting action' USING ERRCODE='23514',CONSTRAINT='cockpit_primary_integrity';
  END IF;
  RETURN OLD;
 END IF;
 RETURN NEW;
END $$;
