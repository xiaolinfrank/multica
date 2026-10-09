CREATE FUNCTION cockpit_issue_category(status_key TEXT, catalog_category TEXT) RETURNS TEXT
LANGUAGE SQL IMMUTABLE AS $$
 SELECT CASE COALESCE(NULLIF(catalog_category,''),status_key)
  WHEN 'unstarted' THEN 'unstarted' WHEN 'backlog' THEN 'unstarted' WHEN 'todo' THEN 'unstarted'
  WHEN 'started' THEN 'started' WHEN 'in_progress' THEN 'started' WHEN 'in_review' THEN 'started' WHEN 'blocked' THEN 'started'
  WHEN 'done' THEN 'done' WHEN 'closed' THEN 'closed' WHEN 'cancelled' THEN 'closed' ELSE 'unknown' END
$$;

CREATE FUNCTION guard_cockpit_primary_issue_scope() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER cockpit_primary_issue_scope_guard BEFORE UPDATE OF project_id,module_id,workspace_id OR DELETE ON issue
 FOR EACH ROW EXECUTE FUNCTION guard_cockpit_primary_issue_scope();

CREATE FUNCTION guard_cockpit_primary_node_scope() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER cockpit_primary_node_scope_guard BEFORE INSERT OR UPDATE OR DELETE ON cockpit_node
 FOR EACH ROW EXECUTE FUNCTION guard_cockpit_primary_node_scope();

CREATE FUNCTION guard_cockpit_primary_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
 target cockpit_node%ROWTYPE;
 ancestor cockpit_node%ROWTYPE;
 item issue%ROWTYPE;
 seen UUID[];
 bound_project UUID;
 bound_module UUID;
 actual_project UUID;
BEGIN
 IF NEW.node_id IS NULL THEN RETURN NEW; END IF;
 PERFORM 1 FROM cockpit WHERE workspace_id=NEW.workspace_id FOR UPDATE;
 SELECT * INTO item FROM issue WHERE id=NEW.issue_id AND workspace_id=NEW.workspace_id FOR SHARE;
 IF NOT FOUND OR NEW.issue_deleted_at IS NOT NULL THEN
  RAISE EXCEPTION 'Primary ownership requires an existing issue in this workspace' USING ERRCODE='23514',CONSTRAINT='cockpit_primary_integrity';
 END IF;
 SELECT * INTO target FROM cockpit_node WHERE id=NEW.node_id AND workspace_id=NEW.workspace_id;
 IF NOT FOUND OR target.project_id IS NOT NULL OR target.module_id IS NOT NULL
    OR EXISTS(SELECT 1 FROM cockpit_node WHERE parent_id=target.id AND workspace_id=NEW.workspace_id) THEN
  RAISE EXCEPTION 'Primary ownership requires an execution leaf below a bound module' USING ERRCODE='23514',CONSTRAINT='cockpit_primary_integrity';
 END IF;
 ancestor := target;
 seen := ARRAY[target.id];
 WHILE ancestor.parent_id IS NOT NULL LOOP
  IF ancestor.parent_id=ANY(seen) THEN
   RAISE EXCEPTION 'Execution ancestry contains a cycle' USING ERRCODE='23514',CONSTRAINT='cockpit_primary_integrity';
  END IF;
  SELECT * INTO ancestor FROM cockpit_node WHERE id=ancestor.parent_id AND workspace_id=NEW.workspace_id;
  IF NOT FOUND THEN
   RAISE EXCEPTION 'Execution ancestry is incomplete' USING ERRCODE='23514',CONSTRAINT='cockpit_primary_integrity';
  END IF;
  seen := array_append(seen,ancestor.id);
  IF ancestor.module_id IS NOT NULL THEN
   IF bound_module IS NOT NULL OR ancestor.project_id IS NULL THEN
    RAISE EXCEPTION 'Execution module binding is ambiguous' USING ERRCODE='23514',CONSTRAINT='cockpit_primary_integrity';
   END IF;
   bound_module := ancestor.module_id;
  END IF;
  IF ancestor.project_id IS NOT NULL THEN
   IF bound_project IS NOT NULL AND bound_project <> ancestor.project_id THEN
    RAISE EXCEPTION 'Execution project binding is ambiguous' USING ERRCODE='23514',CONSTRAINT='cockpit_primary_integrity';
   END IF;
   bound_project := ancestor.project_id;
  END IF;
 END LOOP;
 SELECT project_id INTO actual_project FROM module WHERE id=bound_module AND workspace_id=NEW.workspace_id;
 IF NOT FOUND OR actual_project IS DISTINCT FROM bound_project OR item.project_id IS DISTINCT FROM bound_project OR item.module_id IS DISTINCT FROM bound_module THEN
  RAISE EXCEPTION 'Issue project/module must match the execution leaf without automatic refiling' USING ERRCODE='23514',CONSTRAINT='cockpit_primary_integrity';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cockpit_primary_binding_guard BEFORE INSERT OR UPDATE ON cockpit_issue_primary
 FOR EACH ROW EXECUTE FUNCTION guard_cockpit_primary_binding();
