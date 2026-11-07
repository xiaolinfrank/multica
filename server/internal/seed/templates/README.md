# Workspace seed templates

This directory is embedded into the server binary at build time. **It ships no
presets on purpose.** A preset is a deployment asset: a curated roster of
agents, squads and skills that belongs to one installation, not to the generic
product.

## How a preset is selected

The seeder runs once per workspace, the first time that workspace brings a
runtime online, and only when `DEFAULT_WORKSPACE_SEED_TEMPLATE` is non-empty:

| Variable | Meaning |
| --- | --- |
| `DEFAULT_WORKSPACE_SEED_TEMPLATE` | Template **name** (lowercase letters, digits, dashes). Empty disables seeding entirely — the default. |
| `WORKSPACE_SEED_DIR` | Directory holding `<name>.json`. Defaults to `./presets` next to the server's working directory. |

Lookup order for a name:

1. `<WORKSPACE_SEED_DIR>/<name>.json` — the deployment's own file, so a
   deployment can override a pinned template without rebuilding the server.
2. `templates/<name>.json` embedded in this binary — the fallback for a build
   that deliberately pins one preset.

A name that resolves nowhere logs a warning listing the paths it tried and
seeding is skipped; it never fails the daemon registration.

## Writing one

A complete worked example ships under `presets/` in the repository root: one
deployment's full roster, kept there rather than here precisely so the generic
binary carries no team. Point `WORKSPACE_SEED_DIR` at that directory (or copy
the file into your own) to use it. The schema is:

```json
{
  "preset": "kebab-case-identity",
  "title": "Human title",
  "description": "One paragraph, user-facing",
  "skills_import": [{ "name": "docx", "source_url": "https://github.com/owner/repo/tree/main/skills/docx" }],
  "skills_inline": [{ "name": "my-skill", "description": "...", "content": "# ...", "files": [] }],
  "agents": [{
    "name": "Display name",
    "description": "One line",
    "instructions": "The agent's standing instructions",
    "avatar_url": "/uploads/agent-avatars/research-lead.png",
    "mcp_config": { "mcpServers": {} },
    "max_concurrent_tasks": 1,
    "skill_names": ["docx"]
  }],
  "squads": [{ "name": "Team", "description": "...", "leader_name": "Display name", "member_names": [] }]
}
```

Validation at load time rejects: no agents, duplicate agent or squad names,
missing names, a squad leader or member that is not an agent in the same
preset, an agent bound to a skill the preset never declares, invalid
`mcp_config` JSON, and an `avatar_url` that is neither an existing embedded
avatar (`/uploads/agent-avatars/<slug>.png`), a site-relative path, nor an
absolute `http(s)` URL.

Seeding is idempotent: skills and agents are reused by name, and squads are
only written once everything they reference exists, which makes "this workspace
has a squad" the reliable "fully seeded" marker.
