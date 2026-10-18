# Modules: grouping issues inside a project

How issues are filed into a project's modules: the `module_id` contract,
sub-issue inheritance, filtering and grouping. Module CRUD (`multica
module`) lives in [projects.md](projects.md#modules).

Issues carry a nullable `module_id`; a module belongs to exactly one
project, so the two fields move together:

- An issue update validates `module_id` against the issue's *resulting*
  project. Moving an issue into another project's module is rejected.
- Changing `project_id` without a new `module_id` clears the module: the
  issue lands directly under the new project.
- `multica issue create --module <module-id>` files a new issue into a
  module; `multica issue update <issue-id> --module <module-id>` moves an
  existing one, and `--module ""` files it directly under its project. On
  create, `--project` may be omitted — the module's project is adopted.
- Modules themselves are created and edited with `multica module` — see
  [projects.md](projects.md#modules).

Parent relationships determine inherited filing; creation and reparenting
have distinct, preserved contracts:

- Creating an issue inherits an omitted project and module from its parent.
  Existing API behavior permits an explicit other project when both parent and
  child have no module. A different parent module remains invalid; a
  same-project mismatch returns 400 `child_module_mismatch`. Do not reject a
  valid existing child based on labels.
- Moving an issue that has a parent — `module_id`, or a `project_id` that
  re-files it — fails the same way, unless the same request also sends
  `parent_issue_id: null`. That pair is how the UI's confirmation applies a
  move the user insisted on: it detaches and moves in one write.
- Moving a parent carries its complete subtree in the same transaction.
  Retained scope on any descendant rejects the move before anything commits.
  Each changed descendant emits a versioned `issue:updated` field patch; the
  operation does not load or overwrite unchanged descriptions.
- Attaching an existing issue to a parent (`parent_issue_id: <id>` with no
  project or module in the same request) re-files it under that parent.
  Same-scope attachment only needs parent-edit eligibility; cross-scope
  attachment also needs scope-edit eligibility. Explicit detachment preserves
  the current project/module. Full UUID ancestry is checked without a depth
  cutoff, and concurrent hierarchy writes are serialized per workspace.

Issue queries filter with `module_id` (single) or `module_ids` (any of),
plus `include_no_module=true` for issues filed directly under their
project. These compile to one OR predicate, so `module_id` together with
`include_no_module` reads as "this module or no module". Table grouping
exposes a `module` kind whose group keys are `module:<uuid>` and
`module:none`. With `include_empty: true` that grouping also returns a
zero-count group for every module the query could name, so a project's empty
modules stay visible as their own level; the set is bounded by the query's own
project and module narrowing, and `module:none` is not part of it. The same
flag applies to a compound group whose `primary` is `module`, where it adds the
empty lanes; other primaries ignore it.

A module stores no collaboration space of its own; only its project carries
`collab_path` (人机协作空间路径). When this issue has a module, the claim and
the brief provide the project's path plus stable `module_directory`. Files go
in a required task/result subdirectory below that bound relative folder, never
flat in the module or project root; title edits do not rename it — see
[projects.md](projects.md#collaboration-space).

