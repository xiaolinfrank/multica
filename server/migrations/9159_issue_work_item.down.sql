ALTER TABLE cockpit DROP COLUMN IF EXISTS plan_reconciled_at;
ALTER TABLE cockpit_node DROP COLUMN IF EXISTS directory_name;
ALTER TABLE issue DROP COLUMN IF EXISTS work_item_id;
