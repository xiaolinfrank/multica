# Meeting tasks and the cockpit chat

The cockpit home reuses platform chat: transcripts, attachments, queueing, stopping,
retry, project context and permission/offline banners are shared. Built-in Mika is
selected by `system_key=mika`, not its display name. A renamed Mika remains the
same default; missing/inaccessible Mika must not silently route to another agent.
The initial project/module context is visible in the first user message. Existing
sessions retain their own context; choosing a different cockpit scope starts a
new compose. Drafts and server-side sessions are not duplicated in a cockpit store.

## Three stages, ordinary Issues

The meeting window is three stacked regions: a highlighted stage timeline
(preparation / recording / minutes confirmation), linked Issues and execution
nodes, then meeting metadata and directory maintenance history.

Create preparation/minutes Issues through the existing platform Issue command,
with `status=backlog`, the intended project/module and an explicit assignee.
Do not dispatch an agent just by creating or linking the Issue. The platform UI
uses the same Issue creation dialog as everywhere else.

For preparation, resolve the actual created Issue UUID, append one association,
then set its purpose. Commands never replace a partially loaded collection:

```sh
multica cockpit meeting issue list <meeting-uuid> --page-size 25
multica cockpit meeting issue link <meeting-uuid> <issue-uuid>
multica cockpit meeting issue roles <meeting-uuid> <issue-uuid> --role preparation
multica cockpit meeting node list <meeting-uuid> --page-size 25
multica cockpit meeting node link <meeting-uuid> <execution-node-uuid>
```

The link and purpose writes are separate receipts. If the second write fails,
the Issue and link still exist; report that partial result and correct purposes,
not create a duplicate Issue. `--role` is repeatable and replaces the purpose set;
read current purposes first. `--clear` explicitly removes optional purposes.
Workflow-owned purposes cannot be removed. Association removal is reversible;
it does not delete or cancel the Issue:

```sh
multica cockpit meeting issue unlink <meeting-uuid> <issue-uuid>
multica cockpit meeting node unlink <meeting-uuid> <execution-node-uuid>
```

For minutes, an authorized human adopts the new, unstarted backlog Issue directly:

```sh
multica cockpit meeting workflow enable <meeting-uuid> --reviewer-id <member-uuid> --existing-issue-id <issue-uuid>
multica cockpit meeting workflow summary <meeting-uuid>
multica cockpit meeting workflow submit <meeting-uuid> --revision <observed-revision> --submission-key <uuid> --content-file ./minutes.md --compact
```

Do **not** first add a `minutes` purpose: adoption itself establishes that link
and workflow ownership. Machine credentials cannot enable/adopt, formally review
or publish. An Issue-scoped minutes writer can submit its own version after reading
current workflow state and evidence. End confirmation, material-readiness confirmation
and release are not prerequisites. Review/publication remain explicit human acts.

## Plan editing and review proposals

Use stored UUID/code from the scoped plan, not a projected dotted row label:

```sh
multica cockpit plan --project-id <project-uuid> --module-id <module-uuid> --output json
multica cockpit node next-code <parent-uuid>
multica cockpit change list --project-id <project-uuid> --page-size 25
multica cockpit change propose --node <stored-code-or-uuid> --field end_date --value 2026-11-30 --reason 'Updated delivery evidence'
multica cockpit change preview <change-uuid>
multica cockpit change withdraw <change-uuid>
```

An explicit ordinary field-edit request can use `node update`; an agent observation
that needs judgment should use `change propose`. A queued proposal is not a plan
edit. Applying/rejecting review proposals remains a human action in Governance.
`withdraw` is limited to the proposer's authority as enforced by the server.
Budget/payment amounts stay in the board unit (e.g. 万元), preserving fen precision.
Structural nodes show aggregate progress and historical payments; create new
payment records on execution tasks, not structural rows.

## Maintenance

Any cockpit API, CLI, permission or product-flow change updates this skill and the
relevant reference in the same commit. CLI contract tests resolve documented
command examples against the registered command tree and forbid retired meeting
agenda/template commands. Built-in skill delivery is compiled into the server and
provided on native task claims; updating the workspace's copy alone is not enough.
Do not install another skill namespace or write an independent cockpit chatbot.
