---
name: multica-cockpit
description: "Use when reading or editing the workspace's project cockpit — the project cockpit chat, scoped execution plans, dates, owners, progress, payment records, meetings, linked issues, fixed minutes, human review and NAS copies."
user-invocable: false
allowed-tools: Bash(multica *)
---

# Multica Project Cockpit

## Quick start

```bash
multica cockpit context --output json
multica cockpit overview --as-of 2026-10-14 --output json # use the viewer's actual date
multica cockpit plan --project-id <project-uuid> --output json
multica cockpit node get <stored-code-or-uuid> --output json
```

The cockpit is one shared board per workspace; writes broadcast to open clients.
Its home is a chat with the built-in Mika (`system_key=mika`, even when renamed).
The existing overview, execution plan, meeting register, artifacts and governance remain separate tabs.
A new cockpit chat retains its initial project/module scope in its first visible message; `*` means all.
Scope is context, not authorization. Changing the scope starts a new compose, not a silent retargeting of an existing conversation.

Load this skill for cockpit requests. Read first, explain the target and expected change, then use the commands below.
Simple reads and explicitly requested ordinary field edits can be completed in chat; multi-step preparation, minutes writing and repository work belong on an Issue.
Do not promise a write happened until its server receipt is confirmed. Never use another profile or a human token to bypass a machine permission denial.
Agents may submit minutes for their own issue, but cannot approve or publish them.

## Core model

- **Node** — a work breakdown, commonly project → module → execution task; UUID bindings establish scope, never names or numbering.
  Nodes carry dates, owners, progress (0–100), budget and delivery fields; see the reference.
- **Payment** — one instalment of a node's budget: label, date, amount.
- **Issue relation** — one primary L3 per issue, plus reference links; only primary ownership counts execution once.
- **Milestone** — a committed date with its acceptance `condition`; optionally pinned to a node.
- **Meeting** — the register entry: when, which parties, what was decided, plus the task it opened and the folder holding its material.

**Node addresses** use the stored code or UUID; focused task and relationship commands require UUIDs.
The UI's dotted row number is a projection and can differ from the stored code. Resolve the real ID/code from the scoped plan before writing.
`node next-code <parent-uuid>` previews the next stored code; it does not reserve it. Never invent or reuse spent codes.

**Node status/category are free text**: match existing values such as `进行中`; workflow decisions use fixed vocabulary.
Planning labels and ordinary issue statuses never grant approval.

**Budget amounts retain the board's unit** (for example 万元); never convert silently.

## Reading before writing

Start with `multica cockpit context` and the scoped `plan`/`overview` reads before changing the plan; never guess IDs or values.
Pass the chat's actual `--project-id` and `--module-id` on supported reads; a module requires its project.
Do not repeatedly fetch the complete workspace board when a bounded read suffices.
Use [overview queues](references/overview.md) and focused task/action pages for growing collections; avoid repeatedly downloading the board.

## Editing nodes

Only the flags you pass are written. Everything else is left alone.

```bash
multica cockpit node update L3-01-08 \
  --progress 60 --status 进行中 --current-progress "承接方已选定，合同起草中"

multica cockpit node update L3-01-08 --end-date 2026-10-15    # move a date
multica cockpit node update L3-01-08 --end-date ""            # withdraw it
multica cockpit node update L3-01-08 --clear-budget           # remove the budget line
```

An empty string clears a date; `--clear-budget` clears the budget. Omitted fields stay unchanged.

```bash
multica cockpit node create --code L3-02-11 --parent 02.03 \
  --name "EDC 变量字典定稿" --owner 李青娇 \
  --start-date 2026-09-10 --end-date 2026-09-30 --status 未开始
```

`multica cockpit node delete <code>` removes a leaf. A node with children is
refused — reparent or delete the children first.

## Linking issues

```bash
multica cockpit node link L3-01-08 BIO-314 BIO-320     # add these links
multica cockpit node link L3-01-08 BIO-314 --replace   # make these the only links
multica cockpit node unlink L3-01-08 BIO-320
```

Issue references accept workspace identifiers (`BIO-314`) or UUIDs; unknown IDs
fail the whole request. Links show real issue status, but do not update node
progress: check the plan after execution instead of assuming an automatic roll-up.

For bounded L3 task pages, explicit primary ownership and published-minute actions,
read [actions and ownership](references/actions.md). Those writes require a human credential.

## Payments, milestones and meetings

```bash
multica cockpit payment add L3-01-08 --label 第1笔 --pay-date 2026-09-05 --amount 15
multica cockpit milestone add --name "高质量数据集验收" --plan-date 2026-11-30 --node L1-01
multica cockpit meeting add --title "20260908-01 工作组周例会" --code 20260908-01 --date 2026-09-08 --start 10:00 --end 11:00 --parties "复星医药、华大基因"
```

Each kind also has `list`, `update <id> --flag value` and `remove <id>`. A
milestone with an `actual_date` reads as done whatever its status label says;
meeting associations now have focused CLI commands — see [meeting tasks](references/meeting-tasks.md).
Folder preparation/recovery uses `meeting directory`, not an invented shell copy operation.

## Meeting minutes workflow

```bash
multica cockpit meeting workflow summary <meeting-id>
multica cockpit meeting workflow submit <meeting-id> --revision <observed-revision> --submission-key <uuid> --content-file ./minutes.md --compact
```

The meeting panel has three stages: preparation → recording → minutes confirmation.
Preparation offers one ordinary task creation action; recording offers one ordinary minutes task creation action.
Both reuse platform Issue creation (backlog, without auto-start), not a special meeting-task form.
There is no agenda tab, standalone directory tab, template application or separate follow-up stage.
Linked issues/execution tasks and metadata remain visible outside the stage tabs.

Read [meeting tasks](references/meeting-tasks.md), [meeting records and occurrence](references/meeting-lifecycle.md), the shared directory and workflow state before drafting evidence-grounded minutes.
Use [meeting disposition](references/meeting-preparation.md) for explicit cancellation effects, impact and archive recovery. Preparation and minutes use linked Issues and the meeting’s shared directory. These commands do not grant permission to start an agent or provision NAS directories. For authorized directory preparation and recovery, use [meeting directories](references/meeting-directory.md).
Submit using the minutes issue's task credential; retain the submission UUID/file for retries.
Missing evidence is a blocker to report, not permission to invent outcomes.
Submitting creates a fixed version and human Review Issue; completing/reassigning it is not approval.
Enable/adoption, formal review and publication require authorized humans.
Submission and ordinary minutes-issue execution are not gated on confirming meeting end, materials readiness or a release ceremony.
Legacy fact/release commands remain for installed clients and recorded history; they are not steps in the current UI or prerequisites to submission.
A human manager may `workflow reassign-reviewer` with a reason and idempotency key:
it preserves fixed evidence and records responsibility. Machine credentials cannot transfer it.
See [history](references/history.md) for bounded reads/receipts and `references/cockpit.md` for command permissions.
Authorized humans can `workflow export-nas` or `retry-nas`; export needs a configured root.
See `references/nas-export.md` for fixed copies, receipts and operation retries; failures never undo approval.

## Versions

Allowed imports/restores save the displaced board first. Once history exists,
ordinary edits can leave an `auto` checkpoint after five minutes. Bound nodes or
meeting work packages block whole-board replacement to preserve stable history.

```bash
multica cockpit version list                 # newest first, with ids
multica cockpit version save --label "评审前"
multica cockpit version restore <snapshot-id>   # owner/admin; saves the current board first
```

## Board-level fields

```bash
multica cockpit update --goal-title "端到端技术贯通 Demo" --goal-date 2026-12-31
multica cockpit update --summary-overall "本周完成 …"
```

The three summary cards (`--summary-overall`, `--summary-next`,
`--summary-support`) override the board's automatic roll-up. Leave them empty
unless asked: an empty card derives from the tasks and stays correct on its own.

## Import

`multica cockpit import <file.json>` **replaces the board** and requires owner/admin.
Use it for an authored plan, not a few field edits. It is refused on protected boards.
Parents use `parent_code`; document order is irrelevant. Unresolvable issue references
are reported on stderr and skipped. See the reference for the import shape.

## Boundaries

- [Fixed input materials](references/inputs.md) covers uploads, source selection and fixed Issue/Run manifests; capture is not approval, and saving does not start an Agent.
- Fixed deliverables, handoffs and L3 acceptance use [artifacts and acceptance](references/artifacts.md); Issue completion alone does not approve them.
- The cockpit is programme planning. Day-to-day execution lives on issues —
  use the issue commands for those, and link the issue to the node.
- Do not mirror an issue's whole description into a node's `note`. The link is
  the connection; duplicating text guarantees the two drift.
- Do not invent codes to fill gaps in the numbering. A plan's codes are its own;
  add a node only when the work is real.
- Deleted node codes cannot be reused (409), except when replaying an allowed import or snapshot.
