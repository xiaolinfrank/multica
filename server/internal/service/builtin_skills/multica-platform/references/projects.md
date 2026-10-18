# Projects and resources

A project groups work and carries durable resources. A resource is not just
display metadata; it is context later injected into task briefs and
`.multica/project/resources.json`.

- [Core model](#core-model)
- [Modules](#modules)
- [Collaboration space](#collaboration-space)
- [CLI](#cli)
- [local_directory execution modes](#local_directory-execution-modes)
- [Referring to a project in a comment](#referring-to-a-project-in-a-comment)
- [When to add a resource](#when-to-add-a-resource)
- [Debugging wrong context](#debugging-wrong-context)
- [Side effects](#side-effects)

## Core model

Projects are durable context containers. Resources attached to a project can
affect future agent tasks.

```bash
multica project list --output json
multica project get <project-id> --output json
multica project resource list <project-id> --output json
```

Project resources are mutated through project resource commands/endpoints. Issue
comments do not create durable project resources.

A project's `description` is also durable context: when an issue (or a
quick-create task) is bound to a project, the project description is injected
into the agent's brief under `## Project Context` and written to
`.multica/project/resources.json` as `project_description`. Use it for
project-wide rules/context that should apply to every task in the project.

Common resource types:

- `github_repo` — durable GitHub repo context, with `resource_ref.url`, optional
  checkout `ref`, and optional prompt-only `default_branch_hint`;
- `local_directory` — daemon-local path context, with `resource_ref.local_path`,
  `daemon_id`, optional label, and optional `execution_mode` (`in_place`, the
  default, or `worktree`).

## Modules

A module subdivides one project: Project → Module → Issue. Modules carry a title, description, order and a stable relative delivery folder (`directory_name`). They have no independent resources or absolute collaboration root. An issue belongs to at most one module, always a module of
its own project.

```json
{
  "id": "uuid",
  "workspace_id": "uuid",
  "project_id": "uuid",
  "title": "Parser rewrite",
  "description": "",
  "position": 0,
  "created_at": "2026-01-01T00:00:00Z",
  "updated_at": "2026-01-01T00:00:00Z",
  "issue_count": 12,
  "done_count": 4
}
```

Endpoints (reads and writes are open to any workspace member; deletion is
owner/admin gated, like project deletion):

- `GET /api/modules?project_id=<uuid>` → `{ "modules": [...], "total": n }`
  ordered by `position` ascending.
- `POST /api/modules` with `{ "project_id": "...", "title": "...",
  "description": "..." }` → `201` with the module.
- `GET /api/modules/{id}` and `PUT /api/modules/{id}` with
  `{ "title": "...", "description": "...", "position": 1 }`. `description`
  follows the presence contract: a key absent from the body keeps the stored
  value, a key present with `null` clears it.
- `PUT /api/modules/reorder` with `{ "module_ids": [...] }` — the full
  ordered id list for one project.
- `DELETE /api/modules/{id}` → `204`. The module is removed and its issues
  keep their project with `module_id` null (filed directly under it).

Deleting a project first detaches its issues, then deletes its modules.

Modules are managed from the CLI with `multica module`, documented under
[CLI](#cli) below.

## Collaboration space

`collab_path` — 人机协作空间路径 — binds a **project** to a directory on the
execution host where people and agents exchange finished work. The standard
single-owner macOS deployment uses its internal disk; shared storage is an
explicit alternative, not a prerequisite. A task workdir is private scratch
on the executing machine and does not replace this persistent project root.

Inside it, the layout is derived rather than configured:

```text
<project collab_path>/                  ← the unique project root
└── <module directory_name>/             ← stable relative module binding
    └── <task or deliverable directory>/ ← required task/result layer
```

Only the project carries the absolute `collab_path`. A module's nullable
`directory_name` is one safe relative folder within that project, not another
absolute root. New modules receive a readable unique binding. Safe unique
legacy title folders retain their names; ambiguous or unsafe legacy names need
an explicit binding. A title edit does not change the bound folder or move files.

Use `multica module update <id> --directory-name "<relative-folder>"` to bind
or explicitly rename a folder reference. This changes metadata only; review and
move actual files separately. No slash, backslash, colon, control character,
`.` or `..` is accepted, and names cannot collide within one project.
The claim and `.multica/project/resources.json` carry `module_directory`.
An unresolved binding must be reported rather than replaced with a guessed path.

In the opt-in single-owner macOS deployment, all project paths use the internal
disk. Missing `collab_path` on project creation gets a directory under the
instance's configured projects home. Internal task scratch and Git checkouts
remain under the daemon workspaces root; they are distinct from these files.

Validation (HTTP 400 on failure): the value is trimmed, must be absolute, at
most 1024 characters, and must not contain control characters. Absolute means
POSIX (`/Volumes/...`), UNC (`\\nas\share\...`), or a Windows drive
(`Z:/...`, `Z:\...`) — daemons run on macOS, Linux and Windows, so no single
separator is assumed. A blank value stores NULL. The server never stats the
path: it is resolved on whichever daemon host claims the task, so availability
and permissions must be checked on that host.
A missing path alone does not establish that a NAS is unmounted.

Presence semantics on update: a key absent from the request body keeps the
stored value, and the key present with `null` or `""` clears it to NULL.
`POST /api/projects` accepts the same field.

A task whose project has one is told about it. The brief's `## Project Context`
gains a `### Collaboration Space` subsection naming the project directory and,
when the task has a module, naming the stable bound module folder inside it.
A changed title never changes that binding. `.multica/project/resources.json` carries
`project_collab_path` plus module identity (`module_id`, `module_title`,
`module_description`) and `module_directory` for tooling that would rather read JSON than prose — the
module's directory is `project_collab_path` joined with its stable `module_directory`.

### Delivering into it

- Always write finished files in a task or deliverable subdirectory below the
  bound module folder. A task with no module uses a task/result subdirectory
  directly below the project root; do not invent a module. Never put files flat
  in the project or module root. Preserve `directory_name` after title edits;
  an unresolved or unsafe binding needs owner action, not a title-based guess.
- The collaboration copy is additional archival storage. Follow `## Output`
  for delivery; issue files still require `--attachment <path>`. Respect user
  authorization, including waiting for confirmation before large uploads when
  requested. Saving a file does not authorize its upload.
- Report the full path only where `## Output` permits it, as plain text, never
  a clickable link or a `file://` URL. Quick-create and other constrained output
  surfaces must not gain extra path commentary.
- Keep process files, notes and checkouts in the private task workdir.
- Before creating a missing project root, verify that the exact configured
  binding is on this host's writable internal disk and check ownership and
  containment. Only then create that bound root and its module/task children.
  If the root is unconfigured, inaccessible or lacks permission, report the
  actual problem, keep the result in workdir and do not claim persistent
  delivery. Do not infer an unmounted NAS, silently remount storage, change the
  binding or substitute a nearby directory.

New workspaces receive the versioned collaboration context automatically.
Upgrades fill only empty workspace context; non-empty user
context remains unchanged. The context is editable workspace data thereafter.

## CLI

```bash
multica project list --output json
multica project get <project-id> --output json
multica project create --title "<title>" --repo <github-url> --output json
multica project create --title "<title>" --start-date 2026-03-01 --due-date 2026-03-31 --output json
multica project create --title "<title>" --collab-path "<absolute-local-project-directory>" --output json
multica project update <project-id> --title "<title>" --output json
multica project update <project-id> --due-date 2026-04-15 --output json
multica project update <project-id> --start-date "" --output json   # clear the start date
multica project update <project-id> --collab-path "<absolute-local-project-directory>" --output json
multica project update <project-id> --collab-path "" --output json  # clear the collaboration space
multica project status <project-id> in_progress --output json
multica project resource list <project-id> --output json
multica project resource add <project-id> --type github_repo --url <github-url> --output json
multica project resource add <project-id> --type github_repo --url <github-url> --ref <branch-or-sha> --output json
multica project resource add <project-id> --type local_directory --local-path <abs-path> --daemon-id <daemon-id> --output json
multica project resource add <project-id> --type local_directory --local-path <abs-path> --daemon-id <daemon-id> --execution-mode worktree --output json
multica project resource update <project-id> <resource-id> --execution-mode in_place --output json
multica project resource update <project-id> <resource-id> --url <new-github-url> --output json
multica project resource update <project-id> <resource-id> --ref <branch-or-sha> --output json
multica project resource remove <project-id> <resource-id> --output json
```

For `github_repo`, non-JSON `--ref` sets `resource_ref.ref`, the default
checkout branch/tag/SHA for future tasks in that project. JSON `--ref '<json>'`
remains the escape hatch for full payloads or resource types not covered by
shortcuts. `project resource update` merges shortcut edits with the existing
`resource_ref`, so a partial edit does not clobber required fields.

`--start-date` / `--due-date` are optional calendar days (`YYYY-MM-DD`, like
issue dates). On `project update`, pass an empty string (`--start-date ""`) to
clear a date; an unset flag leaves it untouched. `--collab-path` takes an
absolute path and clears the same way.

### Modules

`--project` takes a project UUID from `multica project list --output json`;
every other argument is the module's own id.

```bash
multica module list --project <project-id> --output json
multica module get <module-id> --output json
multica module create --project <project-id> --title "<title>" --output json
multica module create --project <project-id> --title "<title>" --description "<text>" --output json
multica module update <module-id> --title "<title>" --output json
multica module update <module-id> --description "" --output json   # clear the description
multica module update <module-id> --position 3 --output json
multica module delete <module-id>
```

`list` returns the project's modules ordered by `position` ascending, with
`issue_count` / `done_count` on each. On `update`, an unset flag leaves its
field untouched. `--position` moves one module; reordering a whole project's
list in one call stays `PUT /api/modules/reorder`, which has no CLI surface.
`delete` is owner/admin gated and leaves the module's issues in the project
with `module_id` null.

There is no `--collab-path` here: the collaboration space is set once on the
project and each module's folder is found by name inside it — see
[Collaboration space](#collaboration-space).

To file an issue into a module, use `multica issue create --module` /
`multica issue update --module` — see
[modules.md](modules.md).

## local_directory execution modes

`--execution-mode` decides how tasks share a `local_directory`.

`in_place` (default) runs the agent in the user's directory, one task at a time;
a second task waits in `waiting_local_directory`.

`worktree` gives each task its own git worktree of that repo, so tasks run
concurrently and each delivers its work as a branch in the user's repo instead
of editing the working copy. Every task of one conversation shares that branch —
`agent/<agent>/<issue>` for an issue, `agent/<agent>/chat-<session>` for a chat
— and each turn's worktree starts from the previous turn's work rather than from
`HEAD`; a task with no conversation behind it gets `agent/<agent>/<task>`.

Continuation is decided by an ownership record
(`refs/multica/local-state/<branch>`, which holds the owning conversation, the
snapshot of the user's directory the branch already carries, and the branch tip
it was recorded at), never by the branch name. A same-named branch the user
created — or one that no longer contains the recorded commit, i.e. deleted and
recreated or force-moved — is left alone and the task falls back to
`agent/<agent>/<issue>-<id>`.

A turn replays only what the user changed since that snapshot; when those edits
conflict with the branch's own work the worktree is handed to the agent
mid-merge and the run delivers nothing until the agent resolves it.

`worktree` requires the path to be a git repository with at least one commit;
tasks fail with an explicit error otherwise. The gate is the `local-worktree-v1`
capability the daemon advertises — not its version string — and it is checked
twice: at save time, and again against the daemon that claims each task, so a
machine whose runtime cannot do worktrees gets its tasks cancelled rather than
run in place. Saving `worktree` is refused (HTTP 422, code
`daemon_version_unsupported`) while the daemon on that machine does not
advertise the capability — the fix is updating the Multica app there, then
retrying. Pass an empty value to clear it back to the default.

## Referring to a project in a comment

A project has no `MUL-123`-style identifier, so writing its title as prose
produces dead text — there is nothing for the reader's client to autolink. Use
the mention-link form instead, with the project UUID from
`multica project list --output json`:

    [Roadmap](mention://project/<project-id>)

Every client makes it navigable, with different presentation: web and desktop
render a chip carrying the project's icon and current title, while mobile
renders an ordinary link that opens the project on tap. Unlike `@agent` /
`@squad`, it is a pure link: the mention parser does not recognize `project` at
all, so it enqueues nothing and notifies nobody — the same no-side-effect
contract as an `issue` mention.

Prefer this form over pasting the project's URL. Web and desktop do unfurl a
bare in-app project URL into that same chip, but mobile does not — there a
pasted URL is handed to the system browser and takes the reader out of the app.

## When to add a resource

Add/update a project resource when the user asks for durable project context:
"把这个 GitHub repo 绑到项目上", "以后都用这个 repo", "agent 总是拿不到这个项目的
仓库", or "这个项目要在我的本地目录里跑".

Project resources are durable and affect future tasks. `multica repo checkout`
is task-local checkout state.

## Debugging wrong context

1. `multica project get <project-id> --output json`.
2. `multica project resource list <project-id> --output json`.
3. Check `github_repo.resource_ref.url`, optional `ref`, `default_branch_hint`,
   and `local_directory.resource_ref.daemon_id`.
4. Updating resources is a durable mutation. After an update, listing the
   resource is the verification path.
5. If resources match the expected task context, inspect runtime/repo checkout
   path next.

## Side effects

Project create/update/delete/status and project resource add/update/remove
mutate durable workspace state and affect future tasks. Ask before changing
`local_directory` unless the user explicitly requested that exact local path.
