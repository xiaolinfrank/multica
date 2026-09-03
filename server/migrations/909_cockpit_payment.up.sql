-- Fork-only (900-999 range): the instalments a cockpit node pays out. Split
-- from cockpit_node because the board edits instalments individually — add a
-- row, move a date, correct one amount — and a JSONB array would make every
-- such edit a read-modify-write that silently loses a concurrent one.
CREATE TABLE cockpit_payment (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    node_id      UUID NOT NULL,
    label        TEXT NOT NULL DEFAULT '',
    pay_date     DATE,
    amount       NUMERIC(14, 4) NOT NULL DEFAULT 0,
    position     DOUBLE PRECISION NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
