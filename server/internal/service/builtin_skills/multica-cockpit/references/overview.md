# Work overview and attention queues

Use bounded overview reads to find current work before opening a specific issue,
meeting, or L3 node. The existing full board command remains for plan editing.

```bash
multica cockpit overview --as-of 2026-10-10 --view mine
multica cockpit overview --as-of 2026-10-10 --project-id <uuid> --view team
multica cockpit overview --as-of 2026-10-10 --project-id <uuid> --module-id <uuid> --view team
multica cockpit overview attention --as-of 2026-10-10 --view team --kind action --page-size 25
multica cockpit overview execution --as-of 2026-10-10 --page-size 25
multica cockpit overview meetings --as-of 2026-10-10 --days 30 --page-size 25
```

`--as-of` is required: pass the viewer's calendar date, not a guessed server date.
`--module-id` requires the actual `--project-id`; the CLI verifies module scope
on the overview and each nested preview, rather than accepting project-wide data.
It defines overdue/window calculations, not a historical snapshot. All calls are
read-only and issue one GET. They do not create a board, dispatch work, approve
minutes, confirm an action, retry NAS, or change issue status.

## HTTP and paging

Every endpoint requires workspace membership and `X-Workspace-ID`. All four
endpoints also accept `module_id` with its actual `project_id`; responses echo
both IDs and titles. Invalid module/project pairs fail rather than broadening the
scope. Changing a module invalidates an earlier cursor.

| GET endpoint | Query |
| --- | --- |
| `/api/cockpit/overview` | `as_of`, optional `project_id`, `attention_view=mine|team` |
| `/api/cockpit/overview/attention` | `as_of`, optional `project_id`, `view=mine|team`, `kind=workflow|action|nas|issue`, `cursor`, `page_size` |
| `/api/cockpit/overview/execution` | `as_of`, optional `project_id`, `cursor`, `page_size` |
| `/api/cockpit/overview/meetings` | `as_of`, optional `project_id`, `days`, `cursor`, `page_size` |

Overview returns `board` (nullable), `actor`, `summary`, and three previews:
`attention` (8), `execution_nodes` (6), `recent_meetings` (6). Each page includes
scope, `items`, full-scope `total`, and nullable `next_cursor`. Standalone pages
default to 25, maximum 100. `days` defaults to 30 and allows 1–90. The meeting
window is `[as_of - days + 1, as_of + 7]`, inclusive; exact boundaries are echoed.

Pass the cursor unchanged with the same workspace, actor, project, date, section,
filter and page size. A preview's 8/6 cursor is not a 25-row cursor: either continue
with its original size or start a standalone page without a cursor. Changed scope
starts a new first page. Missing/foreign projects return errors, not workspace-wide
data. CLI validates scope echoes, list bounds, counts and cursor receipts.

## Meanings

- Counts use valid primary L3 issue ownership, not reference-link multiplicity.
  Unowned issues are outside this execution summary. Node progress/acceptance is
  independent of issue completion.
- Active excludes done and closed, retaining unknown old states. Closed is not
  done. Overdue, blocked and unassigned counts refer to active issues.
- `mine` is explicit personal responsibility: assigned member issues, current
  minutes writer, or formally designated current reviewer. Admin capability does
  not make every team item personal. `can_act` is separate; machine credentials
  cannot perform human approvals using the credential owner's identity.
- Workflow projects one current next step, using readiness and fixed-version
  review/publication facts. Editing a review issue to done is still not approval.
  Future/today meetings do not get a past-meeting readiness reminder.
- Draft actions remain visible when old; superseded sources require disposition
  and cannot be used for new dispatch. NAS retry/attention remains independent of
  platform publication. Neither is silently assigned to every admin.
- Ordinary issue attention includes all active primary issues; managed minutes
  and review issues are represented by workflow instead of duplicated there.
- Order is workflow, action, NAS, issue; within each kind overdue then blocked then
  other, followed by stable ID. This is not a global risk or due-date ranking.

Use `target` UUIDs to open the existing object-specific workflow. The overview is
not an approval endpoint. Read current object state and revision before a write;
an overview may become stale. `version_number` gives provenance, not authority to
approve a newer version. Unresolved history is not truncated by the meeting window.

The cockpit root opens the chat home; `?tab=work` (legacy `?tab=overview`) opens
this overview. `?view=operations` preserves
the original business overview; `?tab=gantt|meetings|changes|finance` selects an
existing area. `?node=<uuid>` opens L3 and `?meeting=<uuid>&action=<uuid>` opens an
action in its meeting. A meeting target takes precedence over a conflicting node.

The new overview omits full issue/minutes bodies and legacy relationship arrays.
Exact statistics still scan scoped facts; bounded payload does not certify a
constant-cost query at arbitrary scale. Existing board/workflow reads keep their
documented limits. No-board GET is empty and does not create a board.
