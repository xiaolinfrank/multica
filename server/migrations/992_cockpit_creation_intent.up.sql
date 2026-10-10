-- Successful keyed node/meeting creation receipts survive object deletion and
-- board replacement. Only workspace teardown removes the intent ledger.
CREATE TABLE IF NOT EXISTS cockpit_creation_intent (
 workspace_id UUID NOT NULL,
 resource_kind TEXT NOT NULL CHECK (resource_kind IN ('node','meeting')),
 creation_key UUID NOT NULL,
 request_hash TEXT NOT NULL,
 actor_id UUID NOT NULL,
 resource_id UUID NOT NULL,
 receipt JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
