-- Fork-only (900-999 range): one row per element of the cockpit's work
-- breakdown. The tree is self-referential through parent_id and is deliberately
-- depth-agnostic in the schema — the source board runs L1 > L2 > L3, but a
-- programme that needs a fourth level should not need a migration.
--
-- `code` is the human identifier shown on the board ("L1-01", "01.02",
-- "L3-01-08"). It is unique per cockpit so imports and CLI edits can address a
-- node the way the people running the programme name it.
--
-- Financial columns live here rather than in a separate ledger because the
-- source of truth for a budget line is the task that spends it; the finance
-- view is a projection over these columns plus cockpit_payment.
CREATE TABLE cockpit_node (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID NOT NULL,
    cockpit_id      UUID NOT NULL,
    parent_id       UUID,
    code            TEXT NOT NULL,
    name            TEXT NOT NULL DEFAULT '',
    -- Sort key among siblings. Fractional so a node can be inserted between
    -- two others without renumbering the branch.
    position        DOUBLE PRECISION NOT NULL DEFAULT 0,
    -- Presentation colour for the branch, inherited from the ancestor that
    -- defines it when empty.
    color           TEXT NOT NULL DEFAULT '',
    owner           TEXT NOT NULL DEFAULT '',
    collaborators   TEXT NOT NULL DEFAULT '',
    start_date      DATE,
    end_date        DATE,
    status          TEXT NOT NULL DEFAULT '',
    progress        DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
    deliverable     TEXT NOT NULL DEFAULT '',
    dependencies    TEXT NOT NULL DEFAULT '',
    note            TEXT NOT NULL DEFAULT '',
    -- Free-text one-line progress, shown on cards and in the weekly panel.
    current_progress TEXT NOT NULL DEFAULT '',
    vendor          TEXT NOT NULL DEFAULT '',
    budget_category TEXT NOT NULL DEFAULT '',
    -- Annual budget in the board's own unit (万元 for the source programme).
    -- NULL means "this node carries no budget line", which is different from 0.
    budget_amount   NUMERIC(14, 4),
    exec_status     TEXT NOT NULL DEFAULT '',
    contract        TEXT NOT NULL DEFAULT '',
    -- Provenance of the row, e.g. the spreadsheet an import came from.
    source          TEXT NOT NULL DEFAULT '',
    -- Who last wrote the row, so the board can attribute an agent's edit.
    updated_by_type TEXT NOT NULL DEFAULT '',
    updated_by_id   UUID,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
