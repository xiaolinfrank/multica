CREATE TABLE single_owner_account (
    singleton smallint NOT NULL CHECK (singleton = 1),
    user_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    login_name text NOT NULL,
    password_hash text NOT NULL,
    recovery_hash text NOT NULL,
    credential_version text NOT NULL,
    failed_attempts integer NOT NULL DEFAULT 0,
    blocked_until timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
