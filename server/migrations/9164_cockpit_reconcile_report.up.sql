-- Fork-only (9xxx range): persist the reconcile report. The pre-apply
-- snapshot only freezes the plan structure; the issue filings it rewrote,
-- the project/module titles it split and the projects/modules it created
-- existed nowhere but the returned report. Keeping the last applied report
-- on the board makes the migration auditable after the fact.
ALTER TABLE cockpit ADD COLUMN IF NOT EXISTS reconcile_report JSONB;
