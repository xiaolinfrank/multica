# Cockpit reference

The board's HTTP surface, the field rules every write obeys, what a write
broadcasts, and the shape of an import document.

## API

Every route is workspace-scoped through the `X-Workspace-ID` header.
For bounded work overview, personal/team attention and recent meetings, see [overview.md](overview.md).
For paginated L3 tasks, primary ownership and meeting-action commands, see
[actions.md](actions.md); new primary tasks are not added to the full board's link array.

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/api/cockpit` | the whole board in one read |
| PATCH | `/api/cockpit` | board title, goal, goal date, basis, meeting destination |
| PUT | `/api/cockpit/import` | replace the board (owner/admin only) |
| GET | `/api/cockpit/nodes/next-code?parent_id={id}` | preview the code the next task under a direction would wear (codes are spent once used) |
| POST | `/api/cockpit/nodes` | add a work-breakdown node |
| PATCH | `/api/cockpit/nodes/{id}` | edit a node |
| DELETE | `/api/cockpit/nodes/{id}` | delete a leaf node |
| PUT | `/api/cockpit/nodes/{id}/issues` | replace a node's issue links |
| DELETE | `/api/cockpit/nodes/{id}/issues/{issueId}` | unlink one issue |
| POST | `/api/cockpit/nodes/{id}/payments` | add an instalment |
| PATCH | `/api/cockpit/payments/{paymentId}` | edit an instalment |
| DELETE | `/api/cockpit/payments/{paymentId}` | delete an instalment |
| POST | `/api/cockpit/milestones` | add a milestone |
| PATCH | `/api/cockpit/milestones/{milestoneId}` | edit a milestone |
| DELETE | `/api/cockpit/milestones/{milestoneId}` | delete a milestone |
| POST | `/api/cockpit/meetings` | add a meeting |
| GET | `/api/cockpit/meetings/destination` | where a new meeting would be filed; `project_id`/`module_id`/`node_id` override the board's stored choice |
| GET | `/api/cockpit/meetings/scan` | archive folders no meeting records, with what their names give up |
| POST | `/api/cockpit/meetings/import` | turn chosen archive folders into meeting rows |
| POST | `/api/cockpit/meetings/{meetingId}/provision` | open the meeting's task and create its folder |
| GET | `/api/cockpit/meetings/{meetingId}/workflow` | read the meeting work package and fixed minutes versions |
| POST | `/api/cockpit/meetings/{meetingId}/workflow` | enable a work package or explicitly adopt an unstarted issue (human) |
| PATCH | `/api/cockpit/meetings/{meetingId}/workflow` | record ended/materials-ready facts (human manager) |
| POST | `/api/cockpit/meetings/{meetingId}/workflow/release` | explicitly release ready minutes work (human manager) |
| POST | `/api/cockpit/meetings/{meetingId}/workflow/reviewer` | explicitly transfer review responsibility with an immutable handover record (human manager) |
| POST | `/api/cockpit/meetings/{meetingId}/workflow/versions` | submit a fixed text version and create its human review issue |
| POST | `/api/cockpit/meetings/{meetingId}/workflow/versions/{versionId}/review` | approve, request changes or reject (designated human reviewer) |
| POST | `/api/cockpit/meetings/{meetingId}/workflow/versions/{versionId}/publish` | publish the approved current version (human manager/reviewer) |
| PUT | `/api/cockpit/meetings/{meetingId}/issues` | add issue links, or replace them with `replace: true` |
| PUT | `/api/cockpit/meetings/{meetingId}/issues/{issueId}/roles` | set the workflow purposes of an existing issue link |
| DELETE | `/api/cockpit/meetings/{meetingId}/issues/{issueId}` | unlink one issue |
| PUT | `/api/cockpit/meetings/{meetingId}/nodes` | replace a meeting's work-item links |
| DELETE | `/api/cockpit/meetings/{meetingId}/nodes/{nodeId}` | unlink one work item |
| GET | `/api/cockpit/directory` | the contact book: every `party`/`name`/`position` the workspace knows |
| PUT | `/api/cockpit/directory` | upsert contacts as a batch (`{entries}`); an empty `position` never erases a known one |
| DELETE | `/api/cockpit/directory` | remove one contact by `{party, name}`; a `seed` (roster) entry answers 400 |
| GET | `/api/cockpit/changes` | the review queue: open proposals first, then decision history |
| POST | `/api/cockpit/changes` | file one proposed field edit for review |
| POST | `/api/cockpit/changes/ingest` | file a batch of proposals (the agent write-back funnel) |
| POST | `/api/cockpit/changes/{changeId}/apply` | apply one: write the proposed value onto the node |
| POST | `/api/cockpit/changes/{changeId}/reject` | close one without touching the board |
| POST | `/api/cockpit/changes/{changeId}/withdraw` | the proposer takes an open change back |
| GET | `/api/cockpit/snapshots` | list version history (metadata only) |
| POST | `/api/cockpit/snapshots` | save the current board as a version; body `{label}` optional |
| POST | `/api/cockpit/snapshots/{id}/restore` | put a frozen board back (owner/admin) |
| DELETE | `/api/cockpit/snapshots/{id}` | remove one version (owner/admin) |
| PATCH | `/api/cockpit/meetings/{meetingId}` | edit a meeting |
| DELETE | `/api/cockpit/meetings/{meetingId}` | delete a meeting |

`{id}` on a node route accepts either a UUID or the node's own `code`, so
`L3-01-08` works everywhere a UUID does. `{issueId}` accepts either a UUID or
the workspace issue identifier such as `BIO-314`. `{nodeId}` on a meeting's
work-item routes takes the same two forms as `{id}`.

## Meetings

A meeting carries what it WAS (`meet_date`, `start_time`/`end_time` as `HH:MM`,
`time_range` for the free text older rows were logged with, `title`, `code`,
`kind`, `status`, `track`, `parties`, `organizer`, `location`, `attendees`,
`meet_no`, `link`) and what it LEFT BEHIND (`note` for the agenda and remarks,
`minutes`, `decisions`, `actions`, `nas_dir`). `detected` marks a row the
scan read off the share rather than one somebody typed.

`track` names the line of the programme the meeting advances ("高质量数据集",
"AI平台", "合规和质量体系", "项目管理" — free text, the board's own words).
The meetings tab's timeline view lanes on it and the search filters by it;
an empty track lands the meeting in the unfiled lane.

`code` is the platform's own number — the date plus that day's sequence,
`20260921-01`. `meet_no` is the conferencing system's dial-in number and is a
different thing. `parties` lists the organisations at the table; `attendees`
lists people.

Who those people ARE lives in the contact book (`GET/PUT
/api/cockpit/directory`), not on the meeting: a person's `position` is
resolved from the book by (`party`, `name`) when the register renders, so
correcting a title is one upsert rather than a sweep across every row the
name appears on. The book grows by being used — a person or position typed
into the meeting form is upserted when the meeting is saved (the edit panel's
commit is a save; the create form files its batch once the create lands, so
an abandoned draft teaches the book nothing), attributed to the meeting's
unit only when exactly one party is at the table — with two there is no
telling who sits where. A name the book already knows is never duplicated
under a second unit by that path; a genuine namesake is filed explicitly
through `PUT`. Seeded once per board from the programme's roster.

Every entry carries a `source` — `seed` for the planted roster, `user` for
anything the meeting form filed — and only `user` entries can be removed:
`DELETE /api/cockpit/directory` takes a `{party, name}` pair and answers 400
for the roster (a wrong title there is corrected with `PUT`, not deleted).
Deleting a contact rewrites no meeting — `attendees` stays as typed, so a
name that left the book still reads on every meeting that recorded it.

Two link sets hang off a meeting and ride on the board read as
`meeting_issues` and `meeting_nodes`. Neither has a surrogate key: the pair
(`meeting_id`, `issue_id`) or (`meeting_id`, `node_id`) IS the row. An issue
link carries a `role`: `task` marks the issue the platform opened WITH the
meeting, `""` is one someone attached by hand.

Issue links also carry `roles: []`, a set of explicit workflow purposes:
`preparation`, `support`, `minutes`, `review`, `action`, `delivery`, `reference`.
One issue can serve several purposes in the same meeting. Existing links start
unclassified; `role: "task"` does not imply `roles: ["minutes"]`. Purposes do
not assign, start, complete or approve work, and never move an issue between
projects/modules. The old `role` remains the provisioning marker.

Use `PUT .../issues/{issueId}/roles` with `{ "roles": ["preparation", "review"] }`.
The link must already exist (404 otherwise); an explicit empty array clears
purposes, while omitted/null roles are invalid. The response is
`{ "meeting_id": "...", "links": [...] }` containing the whole meeting's link
set. Values are deduplicated and sorted. Unknown newly added values are refused;
unknown values already on the link can be preserved by an older client.
Work-package-owned minutes/review links cannot be removed or lose their required
purpose. Additional purposes remain editable, and an ordinary reference from
another meeting does not acquire this protection. Ordinary link replacement retains purposes and the provisioning marker for
surviving pairs. Snapshots and import documents preserve purposes in
`issue_roles`, keyed by the corresponding `issue_ids` reference.

`POST .../provision` is the compound step and reports each part on its own
(`task`, `task_error`, `dir`, `dir_created`, `dir_error`). It never fails the
meeting: a share that is not mounted on the server must not cost the record of
a meeting that happened, so re-running it is safe and an existing folder is
accepted as-is. The task is assigned to the member filing the meeting unless
`assignee_type`/`assignee_id` say otherwise — leaving it unassigned would hand
a diary entry to the workspace's fallback agent and start a run.

Task provisioning serializes on the board and meeting and reuses an existing
live `role: "task"` issue. A new issue, its meeting relation and optional archive
node relation commit atomically. Repeating a request does not create a second
issue or reassign/reclassify the existing one. Directory work is still a
separate outcome: this is not yet a durable NAS synchronization workflow or a
meeting-readiness scheduler. A user-assigned `minutes` purpose on an ordinary
link does not automatically promote it to the provisioned task.

For meetings with a work package, `create_task: true` is rejected. Use
`create_task: false` for the existing independent directory operation. New UI
meeting creation uses the work-package workflow for minutes tasks; a folder
failure remains separately retryable without creating another meeting or issue.

## Meeting work packages and fixed minutes

Enable a package with `{reviewer_id}` to create one ordinary backlog issue,
assigned to the current human member by default. Optional `project_id`,
`module_id`, `node_id`, `assignee_type` and `assignee_id` choose the destination
and executor. Project/module use workspace UUIDs; node accepts a UUID or code.
Its explicit inherited project/module binding must agree with the issue.
The executor type and UUID must be supplied together. Alternatively supply
`existing_issue_id` (UUID or issue identifier) to explicitly adopt a backlog
issue with no active/deferred task and no existing workflow ownership. Adoption
preserves assignment and scope; do not supply assignee fields. Initialization
retries must describe the same executor, scope, reviewer and explicit node
relationship; conflicting intent returns 409 instead of silently changing work.

The normal lifecycle is:

1. A human manager records `ended: true` and `materials_ready: true`. Ending is
   irreversible here; material readiness can change until release.
2. A human manager explicitly releases the backlog issue. Both facts are
   required. The issue becomes todo; agent/squad execution uses the native run
   queue, member execution creates no run. Queue and release commit together.
   Unreleased minutes work cannot execute through ordinary status edits,
   mentions, wakeups, reruns or queue claims. Review issues are always blocked
   from agent execution even if their ordinary assignee is edited.
   The native run handoff names the exact meeting and tells its executor to
   fetch current board/source-directory and workflow data before writing and
   submitting minutes. It does not replace the adopted issue's description or
   treat a stale directory snapshot as current evidence.
3. The writer submits `{expected_revision, submission_key, content}`. Content
   is non-empty text, trimmed, at most 128 KiB. A UUID submission key identifies
   one immutable version; retries with the same key and text reuse it. Each new
   version creates one ordinary human-assigned Review Issue. Finish a pending
   review before submitting another version.
4. The designated reviewer submits `approved`, `changes_requested` or
   `rejected`; the latter two require feedback. This ends that review issue.
   Changes requested returns the original minutes issue to todo; another agent
   run is not silently dispatched. New submission starts a new version/review.
5. Explicitly publish the approved **current** version. An older approval
   cannot publish a superseded version. Completing/reassigning a Review Issue
   in the ordinary issue interface never approves or publishes anything.

All successful commands return the complete workflow JSON directly. GET before
enable returns 200 with `enabled: false`. Read `revision`, then send a positive
`expected_revision` for readiness, release, submission, review and publication.
Do not blindly retry 409 with a fresh revision: reread and reconcile intent.
Exact idempotent retries may return the already completed result.

The package creator or a workspace owner/admin manages readiness and release.
A human manager or the current member writer may submit. An agent authenticated
with an issue-scoped `mat_` task token may submit only when that authenticated
task belongs to the minutes issue and matches its agent; authorship records the
agent, not the credential owner's member ID. Cloud-node `mcn_` credentials cannot
submit. All enable/readiness/release/review/publish/NAS-export/retry commands reject machine
credentials. Do not change credentials to bypass 403; ask the authorized human
to act through their own interface. Review authority follows the version's
`reviewer_id`, independently of the Review Issue's mutable assignee. Only that
reviewer may decide; that reviewer or a manager may publish. Only an explicit
human-manager handover may replace a pending version's review assignment.

The response includes `minutes_issue`, `versions[].review_issue`, fixed content
and hash, submission key, author, review feedback, review/publication times and
actors, `current_version_id`, `published_version_id`, readiness and release
facts, and `can_manage/can_submit/can_review/can_publish` hints. Every command
rechecks authorization. Realtime changes use `cockpit:changed` with scope
`meeting_workflow` and the meeting ID; clients refetch the workflow and affected
issue/board projections.

Formal workflow history prevents individual meeting/issue deletion, unlinking
owned work and whole-board import/restore. The board read exposes
`has_meeting_workflows` for restore UI. Deleting the entire owned workspace
explicitly removes this history. Enabling a package makes legacy meeting
`minutes/decisions/actions` text read-only historical material; it does not turn
those strings into published versions. There is currently no package cancellation
command. Text versions are stored in the database. A configured server can
export a fixed published version to NAS as described below; general file
synchronization, NAS watching, transcription, automatic action extraction and
automatic release are not implemented by this workflow.

For fixed NAS exports and retry semantics, read [nas-export.md](nas-export.md).

### Reviewer handover

If the designated reviewer leaves, a human package creator or workspace
owner/admin can POST `.../workflow/reviewer` with `expected_revision`, a UUID
`handoff_key`, the replacement's `reviewer_id`, and a nonempty `reason` (trimmed,
at most 16000 bytes). The replacement must be a different current member.
Machine credentials and ordinary members cannot transfer formal authority.

For a pending current version, the command creates a new human Review Issue,
cancels the previous Review Issue and changes the version's current reviewer
and review-issue pointers in one transaction. The version ID, number, text,
hash, submission key, author and pending decision stay intact. The old issue
continues to be protected against deletion, unlinking, purpose removal,
adoption and agent execution, even if someone edits its ordinary status.
The previous reviewer loses formal authority; ordinary reassignment cannot
restore it. Handover never fabricates approval, rejection or publication.

Before the first submission, or after the current review has a conclusion,
handover only changes the default reviewer for future submissions. It creates
no review issue and leaves the historical reviewer, decision and publication
unchanged. Distinguish the package default from the current version's reviewer.

The read model adds `can_reassign_reviewer` and `reviewer_handoffs`. Each history
entry preserves `handoff_key`, `from_reviewer_id`, `to_reviewer_id`, `reason`,
`created_by`, `created_at`, resulting `revision`, and nullable `version_id`,
`from_review_issue`, `to_review_issue` cards. The latter three are all null for
a future-default change. Actor IDs remain stable when people leave. Optional
`from_reviewer_name`, `to_reviewer_name`, `created_by_name` come from a batched
lookup of these recorded identities, including departed members. They reflect
current profile display names, not historical name snapshots or authority.

Reuse the exact key, observed revision, target and reason after an uncertain
network result. A matching historical record confirms the command even if a
later handover has already changed the reviewer again; it does not move the
reviewer back. Conflicting reuse returns 409. Never rotate the key and blindly
retry an uncertain command. Approval racing with handover must reconcile the
new revision/authority before another write. This command does not change
workspace removal/leave permissions or invite former members back.

### Workflow CLI

All commands return JSON and use the configured workspace. Meeting and version
arguments are UUIDs. Start with `multica cockpit meeting workflow show <meeting-id>`.

```sh
multica cockpit meeting workflow enable <meeting-id> --reviewer-id <user-uuid>
multica cockpit meeting workflow ready <meeting-id> --revision <n> --ended --materials-ready
multica cockpit meeting workflow release <meeting-id> --revision <n>
multica cockpit meeting workflow submit <meeting-id> --revision <n> --submission-key <uuid> --content-file ./minutes.md
multica cockpit meeting workflow review <meeting-id> <version-id> --revision <n> --decision changes_requested --feedback 'Add the acceptance boundary.'
multica cockpit meeting workflow publish <meeting-id> <version-id> --revision <n>
multica cockpit meeting workflow reassign-reviewer <meeting-id> --revision <n> --handoff-key <uuid> --reviewer-id <user-uuid> --reason 'Review responsibility changed.'
```

Fetch the new revision between commands. `ready` requires at least one fact;
`--materials-ready=false` withdraws readiness before release, while
`--ended=false` is refused. `enable` accepts optional `--project-id`,
`--module-id`, `--node-id`, and the paired `--assignee-type/--assignee-id`.
Explicitly empty project/module flags clear the board defaults. To adopt, use
`--existing-issue-id` instead of project/module/assignee flags; an explicit
`--node-id` remains allowed. Enable has no revision flag. For submission, keep
the UUID and exact UTF-8 file for a network retry. Review accepts
`approved|changes_requested|rejected`; feedback is required for the last two.
NAS command flags and receipts are documented in [nas-export.md](nas-export.md).

Where the task and the folder go is board configuration, not code:
`meeting_project_id`, `meeting_module_id`, `meeting_node_id` and `meeting_dir`
on the cockpit row, set through `PATCH /api/cockpit` or remembered by a
provision. `meeting_node_id` is the archive sub-item — a node on this board's
tree, one level below the module ("06.06.03 会议纪要与素材"): its folder holds
the material and its `code` opens the meeting task's title. The folder chain
below the project's collaboration space is created if it is missing, one level
at a time; the collaboration space itself never is, because an unmounted share
must fail rather than be rebuilt as local directories.

`GET .../meetings/scan` reads the archive folder and reports each sub-folder
with the meeting already recording it (`meeting_id`, empty when none) and what
its NAME gives up — `code`, `meet_date`, `parties`, `title`, all guesses. The
folder is always the board's own; the endpoint takes no path. `POST
.../meetings/import` turns chosen folders into rows with `detected: true` and
`nas_dir` set to the folder; a folder that has gone, is already recorded, or
resolves outside the archive folder is reported in `skipped` rather than
failing the batch. `create_task` defaults to false there: those meetings have
already been held.

## Stable project/module bindings

A node may explicitly bind an existing workspace project (`project_id`) or
module (`module_id`). These nullable UUID fields travel on nodes, authored
imports and saved snapshots. A module binding also stores and returns the
module's real `project_id`; unrelated titles, folder names, numbering and tree
depth never establish a binding. Unbound descendants keep both fields null and
resolve their scope through the parent UUID chain.

For node create/update, an omitted field keeps its value on update; null or an
empty string clears it. Setting `module_id` without `project_id` resolves the
module's project. An explicitly supplied project must match. To remove a
module binding, clear BOTH fields. Clearing only the module leaves an explicit
project binding and may conflict with the project's existing bound row.

Within a board, one project-only row may bind each project, and one module row
may bind each module. Duplicate bindings return 409. A module must belong to
the inherited project, and an explicit project/module binding cannot sit below
another module binding. Reparenting checks all bound descendants through any
unbound grouping rows; conflicting ancestry returns 400 and rolls back the
whole edit. Existing issue links remain references: binding a node does not
move an issue or change its project/module.

CLI node create/update accept `--project-id <uuid>` and `--module-id <uuid>`;
`--project-id "" --module-id ""` removes the explicit binding. Project/module
deletion clears affected bindings in that workspace, retaining the plan nodes
and their UUIDs. Names and ordering can change without changing the binding.

Once a board has bound nodes, whole-board import and snapshot restore return
409: those operations rebuild node UUIDs and would break stable references.
Edit existing nodes instead; snapshots can still be saved and inspected.
Importing a binding document into a currently unbound board validates the
resources and final tree before committing. There is no name-based migration.

## Field semantics

- A write is a partial update: only the keys present in the JSON body are
  written, and every other column keeps its value.
- Sending a date key as `null` or `""` clears it; leaving the key out entirely
  leaves it unchanged. `budget_amount` behaves the same way with `null`.
- `progress` is a number 0-100; fractional values such as `62.5` are accepted.
  Anything outside that range is rejected with 400 rather than clamped.
- A `code` is spent the moment it is handed out: creating a node records it
  in the board's ledger, and so does renaming one. The ledger is never
  cleared — deleting a row does not free its number — and a spent code
  handed to `POST /nodes` or to a rename comes back as 409. Imports and
  snapshot restores are the one exception: rebuilding a board replays its
  own codes, so the gate stays open there (the replayed codes still join
  the ledger). `GET /nodes/next-code` previews the number a direction would
  hand out next, ledger included.
- Amounts keep four decimal places server-side and travel as plain JSON
  numbers, so a value read back may carry more precision than it was sent with.

## Versions

An import and a restore each freeze the outgoing board into a version snapshot
inside the same transaction, then replace it. A manual `POST /snapshots` does
the same without replacing anything. Ordinary edits (a node field, a payment,
a milestone, a meeting, board-level fields) do NOT snapshot one per edit —
instead, once the board has version history, an edit landing more than
5 minutes after the newest snapshot (and actually changing the board) leaves
an `auto` checkpoint, so field-level churn cannot evict the milestone
snapshots from the keep window. A board with no history stays snapshot-free
until an import or a manual save creates the first entry. The list keeps the newest 50 per board; the
UI collapses consecutive `auto` snapshots by the same actor into one row.

A snapshot payload is an import document (the shape above), with issue links
serialized as issue UUIDs. Restoring is an import of that payload: the same
single-transaction semantics, the same unknown-parent rejection, the same
"unresolvable issue references are skipped and reported" behaviour. The three
summary cards are carried by the payload — absent on an authored import
document (which leaves the board's cards alone), always present on a snapshot
(so a restore brings back exactly what was frozen).

## Pending changes

The review queue between an observation and an edit. A proposal is one field
of one node carrying a new value; nothing on the board moves until a human
applies it. This is how an agent should report board drift it observed: never
PATCH the node directly on the programme's behalf — file the change and let
the programme decide.

A proposal body is `{node, field, new_value, reason?}`, where `node` accepts
a UUID or a `code` like every other route, and `new_value` is text (numbers
and dates canonicalised server-side; an empty string is a real edit meaning
"clear the field", except for `progress` which must be a number 0-100).
Proposable fields: `name`, `owner`, `collaborators`, `status`, `progress`,
`start_date`, `end_date`, `current_progress`, `deliverable`, `dependencies`,
`note`, `vendor`, `budget_category`, `budget_amount`, `exec_status`,
`contract`, `color`, `source`. Tree shape (`code`, `parent_id`, `position`)
is not proposable.

The server judges each proposal before it queues anything:

- value identical to the board's current one → skipped (`no_change`);
- an open proposal for the same (node, field) already exists → its value is
  replaced when different (`updated`, latest intent wins) or returned as-is
  when identical (`duplicate`);
- bad field, unparseable value, or unknown node → rejected; on the batch
  endpoint this is one item's outcome, never the whole request's.

Batch ingest answers one result per proposal, machine-readable:
`{node, field, status, reason, id}` with `status` one of `queued`, `updated`,
`skipped`, `rejected`. The `source` a queued change carries (`manual` or
`agent`) is derived from the authenticated caller, never from the body.

Decisions are one-way: apply, reject and withdraw all answer 409 on a change
that is no longer open. Apply re-reads the live column it overwrites and
records that as `old_value`, so the history stays true even when the board
moved between filing and deciding. Deleting a node clears its change rows;
an import clears the whole queue with the board it replaces.

## Realtime

Every write broadcasts a `cockpit:changed` event carrying
`{scope, action, entity}`. A client patches the changed row into its cached
board; a `board` scope (`imported`, `restored`) means the board changed
wholesale and has to be re-read; a `snapshots` scope means only the version
history moved — an edit past the auto-checkpoint interval also lands here
with action `created`; a `changes` scope (`queued`, `ingested`, `applied`,
`rejected`, `withdrawn`) means only the review queue moved — an apply also
carries its own `node` scope frame with the row it wrote; a `directory` scope
(`upserted`, `deleted`) means the contact book moved, and it lives outside the board
read, so the frame just has clients re-fetch it.

## Import document

```json
{
  "title": "AI+医药数据平台驾驶舱",
  "goal_title": "端到端技术贯通 Demo",
  "goal_date": "2026-12-31",
  "basis": "BIO-314《六模块项目管理总表》",
  "nodes": [
    {
      "code": "L1-01", "name": "高质量数据集", "color": "#2563eb",
      "owner": "李青娇", "position": 0
    },
    {
      "code": "L3-01-08", "parent_code": "L1-01", "name": "协议签署",
      "start_date": "2026-09-05", "end_date": "2026-09-20",
      "status": "未开始", "progress": 0, "budget_amount": 30,
      "payments": [{"label": "第1笔", "pay_date": "2026-09-05", "amount": 15}],
      "issue_ids": ["BIO-314"]
    }
  ],
  "milestones": [
    {"name": "验收", "plan_date": "2026-11-30", "status": "前置准备", "node_code": "L1-01"}
  ],
  "meetings": [
    {
      "title": "20260901-01 复星医药×华大基因 周例会", "code": "20260901-01",
      "meet_date": "2026-09-01", "start_time": "10:00", "end_time": "11:00",
      "kind": "例会", "parties": "复星医药、华大基因", "organizer": "杨涛",
      "issue_ids": ["BIO-314"], "task_issue_id": "BIO-314", "detected": false,
      "issue_roles": {"BIO-314": ["minutes", "review"]},
      "node_codes": ["L3-01-08"]
    }
  ]
}
```

The whole document commits in one transaction: a bad `parent_code`, a duplicate
`code` or an unparseable date rejects it entirely and leaves the previous board
untouched.

## Storage

The board is one record per workspace with seven collections hanging off it:
nodes, instalments, node-to-issue links, milestones, meetings, meeting-to-issue
links and meeting-to-work-item links. Deleting a node clears its own
instalments, its own issue links and its meeting links; deleting a meeting
clears both of its link sets. A node that still has children is refused with
409 rather than cascaded, so delete or reparent the children first.

A meeting's folder on the shared storage is NEVER deleted with the meeting: it
may hold the only copy of the minutes.
