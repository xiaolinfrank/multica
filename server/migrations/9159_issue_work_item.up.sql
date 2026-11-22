-- Plan-tree unification: a work item must agree with the issue's project and
-- module.
--
-- issue.work_item_id is the single filing authority an issue has into the plan
-- tree: at most one L3 work item (a third-level cockpit_node row), from which
-- the module and project are derived. The existing project_id/module_id columns
-- stay, and the legacy cockpit_issue_primary / cockpit_node_issue tables are
-- left in place; backfill happens in the reconcile command, not here, because
-- it needs human confirmation.
ALTER TABLE issue ADD COLUMN IF NOT EXISTS work_item_id UUID;

-- directory_name mirrors module.directory_name for plan nodes: the stable
-- on-disk folder (number+name), independent of later title edits.
ALTER TABLE cockpit_node ADD COLUMN IF NOT EXISTS directory_name TEXT;

-- plan_reconciled_at gates skeleton backfill and work-item creation. NULL means
-- the legacy tree has not been reconciled with the platform's projects/modules,
-- so creating L1/L2 rows would duplicate them.
ALTER TABLE cockpit ADD COLUMN IF NOT EXISTS plan_reconciled_at TIMESTAMPTZ;
