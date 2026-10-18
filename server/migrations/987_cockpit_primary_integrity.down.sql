DROP TRIGGER IF EXISTS cockpit_primary_binding_guard ON cockpit_issue_primary;
DROP FUNCTION IF EXISTS guard_cockpit_primary_binding();
DROP TRIGGER IF EXISTS cockpit_primary_node_scope_guard ON cockpit_node;
DROP FUNCTION IF EXISTS guard_cockpit_primary_node_scope();
DROP TRIGGER IF EXISTS cockpit_primary_issue_scope_guard ON issue;
DROP FUNCTION IF EXISTS guard_cockpit_primary_issue_scope();
DROP FUNCTION IF EXISTS cockpit_issue_category(TEXT,TEXT);
