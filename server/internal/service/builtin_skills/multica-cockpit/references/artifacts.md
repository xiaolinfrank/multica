# Fixed artifacts and L3 acceptance

Artifacts connect an owning L3, an immutable original Issue, the current production
Issue, fixed versions, human reviews and explicit references. They do not replace
Issues or create another Agent scheduler. Availability depends on the server's
artifact capability; the existing cockpit remains usable while it is disabled.

## Bounded reads

```bash
multica cockpit artifact list --node-id <l3-uuid> --relation owned
multica cockpit artifact list --node-id <l3-uuid> --relation all --page-size 25
multica cockpit artifact show <artifact-uuid>
multica cockpit artifact versions <artifact-uuid> --page-size 25
multica cockpit artifact version <artifact-uuid> <version-uuid>
multica cockpit artifact attachments <artifact-uuid> --query report
multica cockpit artifact producer-history <artifact-uuid>
multica cockpit artifact reviewer-history <artifact-uuid>
multica cockpit artifact node-references <artifact-uuid>
multica cockpit issue artifacts <issue-identifier-or-uuid>
```

All commands return confirmed JSON. Pages default to 25, cap at 100 and retain
`next_cursor`; no command automatically downloads every page or all document
bodies. A cursor belongs to the same scope, filters and page size.

Issue context carries a `formal_review` header independent of the requested page.
Use its fixed target to reach a review; do not infer ordinary Issue editing
permissions from the first page's rows.

`list` also accepts `--project-id`, `--module-id` (requires project),
`--source-issue-id`, `--query` and `--status`. Non-owned relations require an
explicit `--node-id`. Header project/module/node fields always describe ownership,
including when a different L3 references the artifact.

For selected evidence, use `--node-id <l3> --relation all --ids <uuid,uuid>`
with up to 100 artifact IDs and `--page-size 100`. IDs are deduplicated and sorted;
they cannot be combined with query/status. `show --node-id <l3>` can check one
artifact in the same context. Only `evidence_version` denotes a version currently
eligible for this L3. Never replace it with `approved_version`: an explicit v1
reference does not authorize v2 merely because the owner approved v2 later.

## Explicit commands

Writes accept `--request-file <path.json>`. Write a UTF-8 JSON object with actual
IDs from prior reads. Retain the exact file, key and revision until the response
is confirmed. A timeout or malformed receipt is an unknown result, not permission
to generate another key. Keys are UUIDs chosen once per intended operation.

| Command | JSON fields |
| --- | --- |
| `artifact create` | `creation_key,node_id,source_issue_id,title,description,reviewer_id` |
| `artifact edit <artifact>` | `expected_revision,title,description` |
| `artifact submit <artifact>` | `expected_revision,submission_key,producer_issue_id,payload`; optional `source_meeting_id,source_minutes_version_id` |
| `artifact review <artifact> <version>` | `expected_revision,decision,feedback` |
| `artifact retry-capture <artifact> <version>` | `expected_revision` |
| `artifact assign-producer <artifact>` | `expected_revision,command_key,reason`, plus exactly one of `issue_id` or `new_issue` |
| `artifact reassign-reviewer <artifact>` | `expected_revision,handoff_key,reviewer_id,reason` |
| `artifact archive <artifact>` / `unarchive` | `expected_revision` |
| `artifact reference-node <artifact>` | `reference_key,version_id,node_id,purpose` |

Artifact edit, submit, producer/reviewer changes and archive use the **header**
revision. Version review and capture retry use the **version** revision. The two
clocks are independent. Always read the object whose revision the command uses.

A text payload is `{"kind":"text","content":"# Report\n...\n"}`. Text must be
nonempty UTF-8, at most 128 KiB; its whitespace is part of the fixed version.
A file payload is `{"kind":"attachment","attachment_id":"<uuid>"}`; choose a
platform attachment belonging to the **current producer Issue**. A NAS path or a
web URL is not an attachment ID. The optional minutes origin must identify a
published fixed version belonging to the specified meeting. Run identity is
server-derived from trusted task credentials, never supplied by the caller.

An HTTP 202 receipt for a file confirms durable submission, not a verified copy
or formal review. Check its capture state. Retry a failed capture with the same
version rather than resubmitting different content under an old key.

Read `file_capture_available` and `file_capture_unavailable_reason` before a new
file submission. `private_storage_required` requires an operator to configure a
provider that protects the artifact namespace; retrying does not repair it.
Text submissions remain available. The current local backend denies anonymous
`/uploads/workspaces/*/artifact-versions/*` reads; fixed files require the checked
download API. Do not publish that directory through a separate web server.
The existing S3/CDN configuration cannot confirm a private namespace, so file
capture and download are disabled there until a private provider is supported.

`new_issue` accepts `title,description`, optional `assignee_type,assignee_id`,
`priority,due_date`. Omit both assignee fields, or set both null, to assign the
current human; an explicit assignment requires member/agent/squad and a UUID.
Priority is none/urgent/high/medium/low, default none. Due date is YYYY-MM-DD or
null; an empty string is invalid. The command creates a backlog Issue and grants
future production responsibility atomically, without starting an Agent. Existing
Issue reassignment preserves that Issue's project, module, assignee and status.

Source provenance and old versions remain unchanged after a handoff. Replayed
commands return their original ledger outcome even if the current producer or
reviewer has changed again. Read the receipt's assignment/handoff and `to_issue`,
not the latest header pointer, to confirm the earlier operation.

References pin one fixed version. Purpose is input/output/evidence/reference.
Remove only the explicit reference, preserving the artifact and its history:

```bash
multica cockpit artifact remove-node-reference <artifact> <reference-id>
multica cockpit artifact download-link <artifact> <version>
```

Download links expire after 60 seconds; request a fresh link when needed. They
serve the owned fixed object, not the mutable original attachment or NAS copy.

## Human reviews and acceptance

Registration and management require human workspace authority. Trusted Agent task
credentials may submit only for their current authorized production Issue. Formal
reviews use the designated human's credential; a normal Issue assignee change or
completion cannot approve a version, transfer formal responsibility, or reopen a
retired review. The current formal Review Issue is primary-linked to its L3.

`decision` is approved/changes_requested/rejected. Non-approval requires feedback.
`can_review` denotes the designated human's decision authority. It does not assert
that the content is available: `content_available` and `evidence_available` gate
approval. Missing content or outdated evidence can still be returned/rejected
with feedback, ending the round so the producer can revise. Never fabricate a
passing decision or rewrite earlier approval history because storage is offline.

```bash
multica cockpit acceptance show <l3-uuid>
multica cockpit acceptance criteria <l3-uuid>
multica cockpit acceptance requests <l3-uuid> --page-size 25
multica cockpit acceptance request <l3-uuid> <request-uuid>
multica cockpit acceptance reviewer-history <l3-uuid>
```

| Command with `--request-file` | JSON fields |
| --- | --- |
| `acceptance save-criteria <l3>` | `expected_revision,criteria:[{id,title,description}]` |
| `acceptance submit <l3>` | `request_key,expected_criteria_revision,reviewer_id,evidence:[{criterion_id,version_ids}],note`; optional `supersedes_request_id` |
| `acceptance review <l3> <request>` | `expected_revision,decision,feedback` |
| `acceptance reassign-reviewer <l3> <request>` | `expected_revision,handoff_key,reviewer_id,reason` |

Criteria use their definition revision (0 only for an absent initial definition).
Each request freezes their IDs/text/order and the exact approved evidence versions.
Limits: 50 criteria, 20 versions per criterion, 200 distinct versions per request.
Changing definitions or evidence does not mutate the frozen request. Superseding
an outdated pending request is explicit; reviewing and handing off use that
request's own revision. Initial definition management requires owner/admin;
subsequent management follows the definition creator or current owner/admin.

Acceptance decisions do not change ordinary L3 progress, finish arbitrary Issues,
launch Agents or automatically approve downstream work.

## Fixed input provenance

A human version submission may explicitly include `input_manifest_version_id`
for a readable fixed manifest in the same workspace, including another Issue.
Omitting it preserves an unknown source; the server never substitutes the current
Issue manifest. A producer task cannot submit this field: its version inherits
the exact manifest pinned to its producing Run. Version metadata returns the
source manifest's actual Issue ID, version number and hash, so follow that fixed
source rather than guessing from the producer Issue. A recorded input manifest
states what was authorized for the Run; it does not claim every file was read.
