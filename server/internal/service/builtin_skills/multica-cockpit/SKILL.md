---
name: multica-cockpit
description: "Use when reading or editing the workspace cockpit: 项目总览 / 执行甘特图 / 财务支出 / 待确认 / 会议管理 (`?tab=work|gantt|finance|changes|meetings`), project → module → work item plan, dates, owners, progress, payments, meetings, minutes, formal review and collab copies."
user-invocable: false
allowed-tools: Bash(multica *)
---

# Multica Project Cockpit

## Quick start

```bash
multica cockpit context --output json
multica cockpit overview --as-of 2026-10-14 # use the viewer's actual date
multica cockpit plan --project-id <project-uuid> --output json
multica cockpit node get <code-or-uuid> --output json
```

The cockpit is one shared board per workspace; writes broadcast to open clients. Its home is a chat with the built-in Mika (`system_key=mika`, even when renamed); work overview, execution gantt, meeting register, finance and changes (governance) remain separate tabs.
A new cockpit chat retains its initial project/module scope in its first visible message (`*` means all); scope is context, not authorization — changing it starts a new compose, not a silent retargeting of an existing conversation.

Load this skill for cockpit requests. Read first, explain the target and expected change, then use the commands below.
Simple reads and explicitly requested ordinary field edits can be completed in chat; multi-step preparation, minutes writing and repository work belong on an Issue.
Do not promise a write happened until its server receipt is confirmed. Never use another profile or a human token to bypass a machine permission denial.

## Core model

- **Three levels, fixed.** Project → module → work item (L1/L2/L3). An L1 row *is* a project and an L2 row *is* a module: `name` on those rows comes from `project.title` / `module.title` and is read-only on the board — rename the project or module. Only L3 rows carry their own name. Plan reads return `kind` (`project` / `module` / `work_item`) and L1 rows return `project_status`.
- **An issue is filed on at most one work item** (`issue.work_item_id`), and that filing implies its module and project. Related links never file: `node link` only records interest.
- **Codes are outline numbers** — `04`, `04.01`, `04.01.03` — fixed for the row's life and never reused. Once the plan is reconciled the same number appears in the gantt, the directory name and issue titles; a legacy row such as `L3-01-08` keeps its code until then. `node next-code <parent-uuid>` previews the next free code; it does not reserve it.
- **Payment** — one instalment of a node's budget: label, date, amount; amounts keep the board's unit (for example 万元), never convert silently.
- **Milestone** — a committed date with its acceptance `condition`, optionally pinned to a node. An `actual_date` reads as done whatever the status label says.
- **Meeting** — the register entry: when, which parties, what was decided, plus the task it opened and the folder holding its material.

Row status/category are free text; match existing values such as `进行中`. Workflow decisions use fixed vocabulary. Planning labels and ordinary issue statuses never grant approval.

## Reading before writing

Start with `multica cockpit context` and the scoped `plan`/`overview` reads; never guess IDs or values. Pass the chat's actual `--project-id` and `--module-id` (a module requires its project) to every supporting read.
The workspace tree hides paused, completed and cancelled projects and their subtrees; `--include-closed` shows them. A project- or module-scoped read always names its subject, so its own page keeps working after it closes.
Prefer bounded pages ([overview queues](references/overview.md), `node tasks`, `meeting page`) over repeatedly downloading the whole board. The dotted row number in the UI is a projection of the stored code before reconcile; resolve the real code or UUID before writing.

## Structural changes

A new project or module gets its plan row automatically — do not create one by hand while a row already binds it (duplicate bindings return 409).
`multica cockpit reconcile` previews the one-time plan migration (display structure, bindings, work-item filings, directory names); `--apply` writes it in one transaction after a snapshot, is human-only, and is accepted **once** — after that only a preview runs. Read `--json` before applying: a blocked group means money, milestones or links still sit on a row the merge would delete, and every unfiled issue is listed with its reason for a human to file by hand.

A work item (the row issues are filed under) is created by naming its module — you do not pick a level, a code or a parent:

```bash
multica cockpit work-item create --module 03.02 --name "EDC 变量字典定稿" --creation-key <uuid>
multica cockpit work-item delete 03.02.11   # unfiles its issues, keeps project/module and the directory
```

You may create work items and you may delete one that files nothing (with a `--creation-key`, a retried create returns the row it already made instead of a second one). Deleting a work item that still files issues is refused — a person does it, or you propose the change. Renaming, moving and renumbering are human-only as well:

```bash
multica cockpit work-item rename 03.02.11 --name "EDC 变量字典定稿（v2）"   # human credential
multica cockpit work-item move 03.02.11 --to 04.01          # human; crossing modules renumbers it
multica cockpit work-item renumber 03.02                     # human; renumbers direct children, descendants keep their tail
```

A cross-module move takes the destination's next number (the old one is never reused) and reports how many issues it refiled and how many needed their status mapped. On a reconciled board a code only ever changes through a cross-module move or a renumber: node create accepts a hand-written code only in the parent's `prefix.NN` shape, and a direct code edit is refused. Project rows and module rows are structure, not places issues sit: they cannot be created through `node create`, moved between parents, or deleted through the node endpoint — a module or project delete removes the rows under it through its own endpoint.

`multica cockpit node create --code --parent` still works during the transition, but it is not the way to add work: it lets the caller pick a level and a binding, which is how legacy boards drifted.

## Reporting board drift

Direct field edits (`node update`) are a human prerogative: a machine credential is refused, because a plan the programme runs on must not move on an agent's word alone. What you observe goes through the governance queue instead — a person checks every proposal against the evidence and only their decision moves the board.

```bash
multica cockpit change propose --node 03.02.11 --field progress --value 60 \
  --reason "会议纪要 2026-10-15 确认 60%；板载 40%"
multica cockpit change list --status pending
multica cockpit change preview <change-id>
multica cockpit change withdraw <change-id>
multica cockpit change ingest --file drift.json   # batch write-back from a report run
```

`--reason` is required from a task credential: name what disagrees with the board and why the update is necessary. An explicitly empty `--value ""` proposes clearing the field. `ingest` takes at most 500 proposals and judges each alone: `no_change` or `duplicate` means nothing was filed — do not re-send it or loop a rejected row. Decisions arrive as a system comment on this task's issue; a silent queue means re-read it, not assume acceptance. Withdraw only what your own task filed.

## Keeping the board current

The board is the programme's memory of dates, owners and progress; keeping it current is part of the job. Four moments obligate a check:

- **After verified delivery** — re-read the work item; if progress/status/dates no longer match the evidence, propose a change, and if they do match, say so briefly. Never assume an automatic roll-up.
- **After project/module creation or rename** — the plan row already exists; check its placement and say what you see instead of adding a row.
- **After a meeting ends or its minutes land** — compare `meeting list` with the archive folders (`GET /api/cockpit/meetings/scan`); propose missing register rows with `meeting add`, or hand over the folder list for the cockpit's own import (`POST /api/cockpit/meetings/import`). `multica cockpit import` replaces the whole board — never use it for this.
- **When an overview card looks stale** — say so against the facts you verified and offer one dated replacement via `cockpit update --summary-overall|next|support` (see [versions](references/versions.md)); on confirmation only.

## Filing and linking issues

```bash
multica cockpit issue primary MUL-123                                   # current work item + revision
multica cockpit issue primary MUL-123 --work-item <uuid> --revision 0   # refile (moves module/project too)
multica cockpit issue primary MUL-123 --clear --revision 1              # clear the filing
multica cockpit node create-task <work-item> --creation-key <uuid> --title "..."   # new issue filed there
multica cockpit node link 03.02.11 BIO-314 BIO-320                      # related only, never files
```

`--revision` is the observed filing revision (`0` only when the issue has none). Refiling rewrites the issue's module and project and keeps the old work item as a related link; it requires a human credential.
Related links show real issue status but do not move progress. For bounded issue pages per work item and published-minute actions, read [actions and filing](references/actions.md) — those writes require a human credential.

## Payments, milestones and meetings

```bash
multica cockpit payment add 03.02.11 --label 第1笔 --pay-date 2026-09-05 --amount 15
multica cockpit milestone add --name "高质量数据集验收" --plan-date 2026-11-30 --node 01
multica cockpit meeting add --title "20260908-01 工作组周例会" --code 20260908-01 --date 2026-09-08 --start 10:00 --end 11:00 --parties "复星医药、华大基因"
```

Each kind has `update <id> --flag value` and `remove <id>`; milestones and meetings also have `list`. A payment has no `list` — read it from its node. Meeting associations have focused commands — see [meeting tasks](references/meeting-tasks.md); folder preparation and recovery use `meeting directory`, never an invented shell copy.

## Meeting minutes workflow

```bash
multica cockpit meeting workflow summary <meeting-id>
multica cockpit meeting workflow submit <meeting-id> --revision <observed-revision> --submission-key <uuid> --content-file ./minutes.md --compact
```

The meeting panel runs preparation → recording → minutes confirmation; each stage offers one ordinary task creation that reuses platform Issue creation (backlog, no auto-start). There is no agenda tab, directory tab, template application or separate follow-up stage.
Read [meeting tasks](references/meeting-tasks.md) and [meeting records](references/meeting-lifecycle.md) before drafting evidence-grounded minutes: missing evidence is a blocker to report, not permission to invent outcomes. Submit with the minutes issue's task credential and keep the submission UUID/file for retries; submitting creates a fixed version and a human Review Issue, and completing or reassigning it is not approval.
Enablement, formal review and publication require authorized humans; submission is not gated on confirming meeting end or materials readiness. Use [meeting disposition](references/meeting-preparation.md) for cancellation effects and archive recovery, and [meeting directories](references/meeting-directory.md) for authorized directory preparation. See [history](references/history.md) for bounded reads, [nas-export](references/nas-export.md) for fixed NAS copies, and [cockpit](references/cockpit.md) for command permissions.

## Import

`multica cockpit import <file.json>` **replaces the board** and requires owner/admin. Use it for an authored plan, not a few field edits; it is refused on protected boards (work-item filings or meeting actions). Parents use `parent_code`; document order is irrelevant; unresolvable issue references are reported on stderr and skipped.

## Boundaries

- [Fixed input materials](references/inputs.md) covers uploads, source selection and fixed Issue/Run manifests; capture is not approval, and saving does not start an Agent.
- Fixed deliverables, handoffs and L3 acceptance use [artifacts and acceptance](references/artifacts.md); Issue completion alone does not approve them.
- Persistent files follow `collab_path` → stable `directory_name` → required task/result subdirectory (no module: task/result directly below the project). Read [artifact delivery](references/artifacts.md) before delivering files.
- Agents may submit minutes for their own issue but cannot approve or publish them.
- Day-to-day execution lives on issues — use the issue commands and file the issue on its work item. Do not mirror an issue's description into a node's `note`; the filing is the connection, and duplicated text drifts.
- Do not invent codes to fill gaps. A plan's codes are its own; add a row only when the work is real. Deleted codes cannot be reused (409), except when replaying an allowed import or snapshot.
