# Fixed input materials

`multica cockpit input` uses the same input records as the meeting workspace and Issue material manifest. Availability depends on the deployed server capabilities; a missing endpoint is not permission to upload through another resource or invent a source URL.

## Read the exact scope

```bash
multica cockpit input capabilities
multica cockpit input list --page-size 25 --query agenda
multica cockpit input show INPUT_UUID
multica cockpit input versions INPUT_UUID --page-size 25
multica cockpit input version INPUT_UUID VERSION_UUID
multica cockpit input references MEETING_UUID --agenda-id AGENDA_UUID --page-size 25
multica cockpit input attachments ISSUE_UUID --page-size 25
multica cockpit input manifest ISSUE_UUID
multica cockpit input manifest-versions ISSUE_UUID --page-size 25
multica cockpit input manifest-items ISSUE_UUID MANIFEST_VERSION_UUID --page-size 25
multica cockpit input run-manifest TASK_UUID
```

Every growing list returns one page, its exact total, and an optional `next_cursor`. Continue with `--cursor` and the same scope, prefix and page size. Input catalog filters include `--project-id`, `--origin-issue-id`, `--meeting-id`, `--agenda-id`, `--archive active|archived|all`, `--source-kind`, and repeated `--id UUID` (at most 100). Meeting reference pages optionally include `--purpose material|recording|supporting` and `--include-removed`. Do not infer an empty collection from an error.

A task token can register materials within its own authorized Issue and read the exact fixed inputs selected for its Run. It cannot browse arbitrary collaboration directories, edit human manifests, or add independent meeting references. A terminal task token may retain permitted historical reads; it cannot start a new transfer. Runtime credentials do not become human credentials.

## Upload a new fixed version

Each write takes an explicit UTF-8 JSON `--request-file` (at most 256 KiB). Generate a command UUID once and retain the exact file until its result is known. Never place authorization, actor identity, storage keys or arbitrary source URLs in the file.

1. `input create --request-file register.json` registers a material header. The body contains `command_key`, `title`, optional `description`, `project_id` and `origin_issue_id`. Registration does not create an Issue or start an Agent.
2. `input submit INPUT_UUID --request-file version.json` declares the exact version and first upload session. Use the header's observed `expected_revision` and a source such as:

```json
{
  "command_key": "VERSION_COMMAND_UUID",
  "expected_revision": 1,
  "source": {
    "kind": "upload",
    "upload": {
      "filename": "agenda.pdf",
      "content_type": "application/pdf",
      "size_bytes": 12345,
      "client_sha256": null
    }
  }
}
```

Replace the placeholder UUID and byte count with the actual values. Zero-byte files require the explicit numeric value `0`. Maximum file size is reported by capabilities, at most 500 MiB.

3. Read the accepted version and transfer IDs. Send one complete local regular file with `input upload-bytes INPUT_UUID VERSION_UUID TRANSFER_UUID --revision OBSERVED_TRANSFER_REVISION --file /absolute/path/agenda.pdf`. This streams bytes, keeps a bounded deadline, and never follows redirects or automatically resends the stream.
4. `input finalize INPUT_UUID VERSION_UUID TRANSFER_UUID --request-file finalize.json` requires a new retained `command_key`, the current transfer `expected_revision`, and its verified `expected_content_hash`. Only the fixed finalize receipt confirms readiness. A completed HTTP upload alone does not.

After an uncertain result, query its exact original command or transfer:

```bash
multica cockpit input create-command COMMAND_UUID
multica cockpit input version-command INPUT_UUID COMMAND_UUID
multica cockpit input transfer INPUT_UUID VERSION_UUID TRANSFER_UUID
multica cockpit input transfer-command INPUT_UUID VERSION_UUID RESTART_COMMAND_UUID
multica cockpit input session-command INPUT_UUID VERSION_UUID TRANSFER_UUID FINALIZE_OR_ABANDON_COMMAND_UUID
```

A 404, timeout, or malformed response does not authorize creating another key. `awaiting_finalize` means the verified bytes may be finalized without uploading again. Expired or failed attempts remain historical facts. Use `input restart` with the version revision, exact `previous_transfer_id` (nullable only when no attempt exists), a new retained command key, and an explicitly allowed mode. `retry_source` retains the original source intent. `upload_matching_bytes` is an explicit human recovery of the same pinned size and hash into a new owned copy. Changed bytes require a new version. No command deletes, renames or overwrites the original collaboration file.

`input abandon` requires the exact transfer, its revision, a command key and a reason. It abandons that attempt only; it does not undo a ready version or remove references. Disconnecting the CLI does not issue abandon.

## Reuse sources without inventing provenance

Other `submit` sources are:

- `kind: "attachment"`, `attachment: {issue_id, attachment_id}` selected from actual existing Issue attachments.
- `kind: "artifact_version"`, `artifact_version: {artifact_id, version_id}` identifying an exact ready deliverable version. Borrowing it preserves its original review decision; readiness is not approval and does not create a duplicate attachment.
- `kind: "nas_file"`, `nas_file: {root_id, relative_path, observation_token}` selected by a human from `input spaces` and `input browse ROOT_UUID --request-file browse.json`. The browse request has `relative_directory`, `q`, `cursor`, `page_size`. It searches only the configured current directory, not recursively. Preserve each returned file observation; a changed file needs a new explicit selection.

The configured collaboration root may be a local directory or mounted NAS. A path string alone does not prove that the server can read it. A stored location reference remains a location; do not claim it is a fixed input file.

## References, manifests and execution

`input reference MEETING_UUID --request-file reference.json` takes `command_key`, optional `agenda_id`, `input_version_id`, and `purpose`. A ready historical version remains reusable even when its input header is archived. The target meeting/agenda must accept new preparation work. New version submission may explicitly include `initial_reference: {reference_key, meeting_id, agenda_id, purpose}` in the same transaction; an authorized preparation task can use this narrow delegation for its own version.

`input remove-reference MEETING_UUID REFERENCE_UUID --request-file remove.json` takes a retained `command_key`. It removes only that exact meeting/agenda relation. Current human members can clean existing references after meeting cancellation or archive. Query either original create or remove receipt with `input reference-command MEETING_UUID COMMAND_UUID`. Replaying a creation receipt never revives a removed relation.

`input save-manifest ISSUE_UUID --request-file manifest.json` is a human action. Supply `command_key`, observed `expected_revision` (0 only before any manifest), optional `note`, and the **complete ordered** `items` array, at most 200. Each item has `input_version_id`, `purpose`, `required`. Purpose is one of `material`, `recording`, or `supporting`; it is not free text. Use `note` to explain the selection, and put execution instructions in the Issue description. Load all pages of the saved version before editing; never replace a full manifest with its first visible page. An empty array explicitly saves an empty selection. Read a lost save result with `input manifest-command ISSUE_UUID COMMAND_UUID`.

Saving, referencing, or fixing a file does not dispatch an Agent. A separate explicit execution selects one saved immutable manifest. Historical Run retries retain the original pin; new runs may select the current saved manifest. Required files must actually be prepared before the Agent starts. `required_ready` confirms the fixed required byte set, not that a model read or understood every item. Old runs without recorded material remain `not_recorded`; do not backfill them from today's Issue manifest.

`input verify INPUT_UUID VERSION_UUID` schedules background availability verification of the same fixed content. A successful request acknowledges scheduling; read the exact version for `checking`, the final observation, and `checked_at`. An expired or absent content proof is shown as `unknown`, not fresh availability. Verification never rereads a changed original source to replace the pinned bytes. `input download-link` returns a short-lived relative authorized route. An unavailable source, an unavailable fixed copy, and a changed source are separate conditions; consult the exact version and transfer before choosing recovery.

A same-claim local execution retry must verify its own prepared files while preserving an existing `required_ready` historical acknowledgement. A newly dispatched or reclaimed attempt prepares again. Neither acknowledgement proves that the model read all files.
