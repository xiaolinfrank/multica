-- Fork-only (9xxx range): relax the primary-ownership guards to the new filing
-- model. issue.work_item_id is now the single filing authority and the legacy
-- cockpit_issue_primary row is only a creation receipt (node_id stays NULL), so
-- the guards that forbade changing an issue's project/module while it had a
-- primary node, and that forbade reparenting/unbinding an owned plan node, no
-- longer describe the invariant. They would instead block the refile that
-- naming a work item performs.
--
-- The retained deletion guard is unchanged: a receipt still has to survive its
-- issue (creation-key idempotency), and a node referenced by a confirmed
-- meeting action still cannot be deleted.
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
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_cockpit_primary_node_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM cockpit_meeting_action WHERE workspace_id=OLD.workspace_id AND node_id=OLD.id) THEN
   RAISE EXCEPTION 'Execution node is retained by a confirmed meeting action' USING ERRCODE='23514',CONSTRAINT='cockpit_primary_integrity';
  END IF;
  RETURN OLD;
 END IF;
 RETURN NEW;
END $$;
