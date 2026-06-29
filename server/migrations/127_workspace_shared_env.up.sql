-- Workspace-level shared environment variables, injected into every agent's
-- task subprocess as a base layer beneath each agent's own custom_env (agent
-- custom_env keys override workspace shared_env keys with the same name). Lets
-- an admin set a key once for the whole workspace (e.g. TAVILY_API_KEY) instead
-- of repeating it on every agent. Plaintext JSONB like agent.custom_env;
-- owner/admin-gated and audited at the handler, and never serialized into the
-- generic workspace resource response.
ALTER TABLE workspace ADD COLUMN shared_env JSONB NOT NULL DEFAULT '{}';
