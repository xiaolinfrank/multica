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

A module subdivides one project: Project → Module → Issue. Modules are a
grouping layer only — they carry a title, an optional description, and a
stable order; they have no resources, dates, or status of their own. An
issue belongs to at most one module, always a module of its own project.

```json
{
  "id": "uuid",
  "workspace_id": "uuid",
  "project_id": "uuid",
  "title": "Parser rewrite",
  "description": "",
  "position": 0,
  "collab_path": null,
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
  "description": "...", "collab_path": "..." }` → `201` with the module.
- `GET /api/modules/{id}` and `PUT /api/modules/{id}` with
  `{ "title": "...", "description": "...", "position": 1,
  "collab_path": "..." }`. `description` and `collab_path` follow the
  presence contract: a key absent from the body keeps the stored value, a
  key present with `null` clears it, and `collab_path` also clears on `""`.
- `PUT /api/modules/reorder` with `{ "module_ids": [...] }` — the full
  ordered id list for one project.
- `DELETE /api/modules/{id}` → `204`. The module is removed and its issues
  keep their project with `module_id` null (filed directly under it).

Deleting a project first detaches its issues, then deletes its modules.

Modules are managed from the CLI with `multica module`, documented under
[CLI](#cli) below.

## Collaboration space

`collab_path` — 人机协作空间路径 — binds a project, and optionally each of its
modules, to a directory on the shared NAS where people and agents exchange
finished work. It is the team's drop point, not a runtime path: a task's
working directory exists only on the machine running that task, while this
directory is mounted on the daemon hosts and is where a person goes to read
what an agent produced.

```text
/Volumes/人机协作空间/AI医药联合创新平台/01高质量数据集/01.01回顾性队列数据集（JIA）
```

Both entities carry it — `project.collab_path` and `module.collab_path`, each
`string | null` on the API. A module path narrows the project's rather than
replacing it; the project keeps its own. **When both are set, use the module
path** — it is the narrower one, pointing at this task's slice of the work.
With only a project path, use that.

Validation (HTTP 400 on failure): the value is trimmed, must be absolute, at
most 1024 characters, and must not contain control characters. Absolute means
POSIX (`/Volumes/...`), UNC (`\\nas\share\...`), or a Windows drive
(`Z:/...`, `Z:\...`) — daemons run on macOS, Linux and Windows, so no single
separator is assumed. A blank value stores NULL. The server never stats the
path: it is resolved on whichever daemon host claims the task, so a host that
has not mounted the share fails at the agent rather than at write time, and a
path that is correct on every other host is never rejected on that host's
behalf.

Presence semantics on update, identical for both entities: a key absent from
the request body keeps the stored value, and the key present with `null` or
`""` clears it to NULL. `POST /api/projects` and `POST /api/modules` accept
the same field.

A task that has one is told about it. The brief's `## Project Context` gains a
`### Collaboration Space` subsection listing the project path and the module
path, and `.multica/project/resources.json` carries `project_collab_path`,
`module_collab_path`, and the module identity (`module_id`, `module_title`,
`module_description`) for tooling that would rather read JSON than prose.

### Delivering into it

The standing rule in every brief is that runtime-local paths are never
deliverables. The collaboration space is the exception, and the only one:

- Write the finished file into the collaboration-space directory — the
  module's when the task has one — in a subdirectory when the work warrants
  one. This is in addition to the surface's own delivery mechanism, not
  instead of it: an issue comment still carries the file with
  `--attachment <path>`.
- Name that path in your comment as **plain text**. Never a clickable link,
  never a `file://` URL. The rule against linking filesystem paths is
  unchanged; what is different about this directory is that the reader can
  actually open it.
- Keep scratch work in your working directory — notes, intermediate output,
  checkouts. Only what is being handed over goes to the share.
- If the directory does not exist, the share is not mounted on this machine.
  Say that in your comment and leave the file in the working directory. Do
  not pick a nearby path that does exist: a deliverable written somewhere
  else is a deliverable nobody finds.

## CLI

```bash
multica project list --output json
multica project get <project-id> --output json
multica project create --title "<title>" --repo <github-url> --output json
multica project create --title "<title>" --start-date 2026-03-01 --due-date 2026-03-31 --output json
multica project create --title "<title>" --collab-path "/Volumes/人机协作空间/<项目>" --output json
multica project update <project-id> --title "<title>" --output json
multica project update <project-id> --due-date 2026-04-15 --output json
multica project update <project-id> --start-date "" --output json   # clear the start date
multica project update <project-id> --collab-path "/Volumes/人机协作空间/<项目>" --output json
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
multica module create --project <project-id> --title "<title>" --description "<text>" --collab-path "/Volumes/人机协作空间/<项目>/<模块>" --output json
multica module update <module-id> --title "<title>" --output json
multica module update <module-id> --collab-path "/Volumes/人机协作空间/<项目>/<模块>" --output json
multica module update <module-id> --collab-path "" --output json   # clear the collaboration space
multica module update <module-id> --position 3 --output json
multica module delete <module-id>
```

`list` returns the project's modules ordered by `position` ascending, with
`issue_count` / `done_count` on each. On `update`, an unset flag leaves its
field untouched. `--position` moves one module; reordering a whole project's
list in one call stays `PUT /api/modules/reorder`, which has no CLI surface.
`delete` is owner/admin gated and leaves the module's issues in the project
with `module_id` null.

To file an issue into a module, use `multica issue create --module` /
`multica issue update --module` — see
[issues.md](issues.md#modules-grouping-issues-inside-a-project).

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
