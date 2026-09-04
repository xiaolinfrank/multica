---
name: multica-cockpit
description: "Use when reading or editing the workspace's project cockpit — the programme board of work-breakdown nodes, dates, owners, budget, instalments, milestones, meetings, and the issues each work item is linked to."
user-invocable: false
allowed-tools: Bash(multica *)
---

# Multica Project Cockpit

## Quick start

```bash
multica cockpit show --output json          # the whole board in one read
multica cockpit node list --owner 李青娇
multica cockpit node get L3-01-08 --output json
multica cockpit node update L3-01-08 --progress 60 --status 进行中
```

The cockpit is one shared board per workspace. Everything the browser UI can
change, these commands change — and every write is broadcast, so a person with
the board open sees your edit land without reloading.

## Core model

A board is a tree of **nodes** plus four things hanging off it.

- **Node** — one element of the work breakdown. The tree is arbitrary-depth;
  the usual shape is module (`L1-02`) > group (`02.03`) > task (`L3-01-08`).
  Every node carries `code`, `name`, `owner`, `collaborators`, `start_date`,
  `end_date`, `status`, `progress` (0-100), `deliverable`, `dependencies`,
  `note`, `current_progress`, `vendor`, `budget_category`, `budget_amount`,
  `exec_status`, `contract` and `source`.
- **Payment** — one instalment of a node's budget: label, date, amount.
- **Issue link** — the issues that carry the work out. Many per node.
- **Milestone** — a date the programme commits to, with the acceptance
  `condition` and the `guard` that protects it. Optionally pinned to a node.
- **Meeting** — the decision record: date, time span, attendees, conference
  number, link, note.

**`code` is the address.** Every node command accepts the human code the plan
uses (`L1-02`, `L3-01-08`) as well as a UUID. Prefer the code — it is what the
issue text, the meeting note and the person asking will all say.

**Status and category values are free text.** The board is a planning surface,
not a workflow engine: `进行中`, `未开始`, `受阻`, `已完成` are whatever the
programme already uses. Read the board first and match what is there rather
than introducing a new vocabulary.

**Budget amounts are in the board's own unit** (万元 for a board authored that
way). Never convert; write the number the plan writes.

## Reading before writing

Always `multica cockpit show --output json` first. It returns `cockpit`,
`nodes`, `payments`, `issue_links`, `milestones` and `meetings` in one call, so
there is no reason to guess a code, a status value or an id.

`multica cockpit node get <code>` narrows that to one node plus its payments and
linked issues — the right call when a task says "update L3-01-08".

## Editing nodes

Only the flags you pass are written. Everything else is left alone.

```bash
multica cockpit node update L3-01-08 \
  --progress 60 --status 进行中 --current-progress "承接方已选定，合同起草中"

multica cockpit node update L3-01-08 --end-date 2026-10-15    # move a date
multica cockpit node update L3-01-08 --end-date ""            # withdraw it
multica cockpit node update L3-01-08 --clear-budget           # remove the budget line
```

An empty string clears a date; `--clear-budget` clears the budget. This matters:
passing nothing leaves the old value, which is not the same as withdrawing it.

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

Issue references accept the workspace identifier (`BIO-314`) or a UUID. An
unknown reference fails the whole call rather than linking half of it, so a typo
never leaves a partially wired node.

Linking is how the board stays honest: a work item with a live issue shows that
issue's real title and status on the board. When you finish work on an issue
that a cockpit node names, check whether the node's `progress` and `status`
still match — the board does not infer them from the issue.

## Payments, milestones and meetings

```bash
multica cockpit payment add L3-01-08 --label 第1笔 --pay-date 2026-09-05 --amount 15
multica cockpit payment update <payment-id> --amount 18
multica cockpit payment remove <payment-id>

multica cockpit milestone list
multica cockpit milestone add --name "高质量数据集验收" \
  --plan-date 2026-11-30 --status 前置准备 --node L1-01 \
  --condition "三个临床队列治理完成，通过数据质量验收"
multica cockpit milestone update <milestone-id> --actual-date 2026-11-28 --status 已完成

multica cockpit meeting add --title "工作组周例会" --date 2026-09-08 \
  --time-range "10:00–11:00" --attendees "项目组全体"
```

A milestone with an `actual_date` reads as done on the board regardless of its
status label — set the date when it actually lands.

## Board-level fields

```bash
multica cockpit update --goal-title "端到端技术贯通 Demo" --goal-date 2026-12-31
multica cockpit update --summary-overall "本周完成 …"
```

The three summary cards (`--summary-overall`, `--summary-next`,
`--summary-support`) override the board's automatic roll-up. Leave them empty
unless asked to write one: an empty card means "derive it from the tasks", which
stays correct on its own.

## Import

`multica cockpit import <file.json>` **replaces the entire board** and needs
workspace owner or admin. Use it to load a plan authored elsewhere, never to
edit a few fields. Nodes name their parent by `parent_code`, so the document
does not need to be sorted; issue references that do not resolve are reported on
stderr and skipped rather than failing the import.

See `references/cockpit.md` for the document shape and the API endpoints
behind each command.

## Boundaries

- The cockpit is programme planning. Day-to-day execution lives on issues —
  use the issue commands for those, and link the issue to the node.
- Do not mirror an issue's whole description into a node's `note`. The link is
  the connection; duplicating text guarantees the two drift.
- Do not invent codes to fill gaps in the numbering. A plan's codes are its own;
  add a node only when the work is real.
