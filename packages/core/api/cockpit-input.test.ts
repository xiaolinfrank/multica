// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";
import { setApiInstance } from "./index";
import {
  CockpitInputDownloadLinkSchema, CockpitInputNASPageSchema,
  CockpitInputVersionMetadataSchema, CockpitInputTransferDetailSchema,
  CockpitInputVersionBatchSchema, CockpitInputAttachmentPageSchema,
} from "./cockpit-input-schemas";
import { executeCockpitInputCommand } from "../cockpit/input-mutations";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const WS = id(1), INPUT = id(2), VERSION = id(3), TRANSFER = id(4), USER = id(5), KEY = id(6);
const HASH = "a".repeat(64), TIME = "2026-10-11T11:30:00Z";
const principal = { actor_type: "member", actor_id: USER, actor_name: "Coordinator", credential_owner_user_id: USER,
  authorizing_user_id: USER, authorizing_user_name: "Coordinator", agent_id: null, run_id: null, issue_id: null, runtime_id: null };
function version() {
  return { workspace_id: WS, input_id: INPUT, id: VERSION, version_number: 1, submission_key: KEY, revision: 1,
    latest_transfer_id: TRANSFER, allowed_restart_modes: ["upload_matching_bytes"], payload_kind: "file", source: { kind: "upload", issue: null, attachment_id: null, root_id: null, relative_path: null,
      artifact_id: null, artifact_title: "", artifact_version_id: null, artifact_version_number: null, artifact_decision: null,
      source_available: true, source_unavailable_reason: "" }, submitted_by: principal,
    filename: "recording.wav", content_type: "audio/wav", declared_size_bytes: 10, size_bytes: 10, content_hash: HASH,
    capture_state: "ready", capture_error_code: "", availability: "unavailable", checked_at: TIME, unavailable_reason: "storage_offline",
    active_transfer_id: null, current_transfer_id: TRANSFER, accepted_transfer_id: TRANSFER, created_at: TIME, ready_at: TIME,
    can_download: false, can_restart: true, can_reference: true, can_verify: true, blocked_reasons: [] };
}
function transfer() {
  return { workspace_id: WS, input_id: INPUT, version_id: VERSION, id: TRANSFER, transfer_number: 1, command_key: KEY,
    kind: "direct_upload", mode: "initial", state: "awaiting_finalize", revision: 4, principal, received_bytes: 10, expected_bytes: 10,
    pinned_size_bytes: 10, content_hash: HASH, session_expires_at: TIME, lease_expires_at: null, created_at: TIME, finished_at: null,
    error_code: "", error_message: "", can_upload: false, can_restart: false, can_finalize: true, can_abandon: true, blocked_reasons: [] };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("fixed input API boundaries", () => {
  it("separates original fixed content from current availability and converts nested wire names", () => {
    const result = CockpitInputVersionMetadataSchema.parse(version());
    expect(result).toMatchObject({ captureState: "ready", availability: "unavailable", contentHash: HASH, canDownload: false,
      submittedBy: { authorizingUserId: USER }, source: { kind: "upload" } });
    expect(result).not.toHaveProperty("capture_state");
    expect(CockpitInputVersionMetadataSchema.safeParse({ ...version(), content_hash: null }).success).toBe(false);
  });

  it("keeps unknown states readable but disables their actions, including embedded transfer details", () => {
    const result = CockpitInputVersionMetadataSchema.parse({ ...version(), capture_state: "future_state", can_download: true });
    expect(result).toMatchObject({ captureState: "future_state", canDownload: false, canRestart: false, canReference: false, canVerify: false });
    const detail = CockpitInputTransferDetailSchema.parse({ ...transfer(), state: "future_state", can_upload: true });
    expect(detail).toMatchObject({ state: "future_state", canUpload: false, canRestart: false, canFinalize: false, canAbandon: false });
  });

  it("rejects a claimed ready transfer without its content pin", () => {
    expect(CockpitInputTransferDetailSchema.safeParse({ ...transfer(), content_hash: null, pinned_size_bytes: null }).success).toBe(false);
  });

  it("rejects an incomplete NAS continuation receipt", () => {
    const page = { workspace_id: WS, root_id: INPUT, relative_directory: "meetings", q: "", root_config_hash: HASH,
      observation_token: "directory-proof", page_size: 25, items: [], total: null, has_more: true, next_cursor: null };
    expect(CockpitInputNASPageSchema.safeParse(page).success).toBe(false);
    expect(CockpitInputNASPageSchema.safeParse({ ...page, next_cursor: "opaque-cursor" }).success).toBe(true);
  });

  it("accepts only the exact signed input download destination", () => {
    const base = { workspace_id: WS, input_id: INPUT, version_id: VERSION, content_hash: HASH, size_bytes: 10, expires_at: TIME };
    const url = `/api/cockpit/input-files/${VERSION}/download?token=proof`;
    expect(CockpitInputDownloadLinkSchema.safeParse({ ...base, url }).success).toBe(true);
    for (const bad of [`https://other.test${url}`, url.replace(VERSION, INPUT), url.split("?")[0], `${url}#hidden`, `/${url}`, `${url}&redirect=other`, `${url}&token=second`]) {
      expect(CockpitInputDownloadLinkSchema.safeParse({ ...base, url: bad }).success).toBe(false);
    }
  });

  it("bounds metadata requests and rejects valid-looking responses from another workspace", async () => {
    const value = { workspace_id: WS, scope: { ids: [], project_id: null, meeting_id: null, agenda_id: null, origin_issue_id: null, q: "", archive: "active", source_kind: "" },
      page_size: 100, items: [], total: 0, next_cursor: null, can_create: true };
    const fetcher = vi.fn().mockImplementation(async () => Response.json(value));
    vi.stubGlobal("fetch", fetcher);
    const client = new ApiClient("https://api.test");
    expect(await client.getCockpitInputs(WS, { pageSize: 1000, ids: [INPUT, VERSION] })).toMatchObject({ workspaceId: WS, items: [], pageSize: 100 });
    const url = new URL(fetcher.mock.calls[0]![0]);
    expect(url.searchParams.get("page_size")).toBe("100");
    expect(url.searchParams.getAll("ids")).toEqual([INPUT, VERSION]);
    expect(await client.getCockpitInputs(id(9))).toBeNull();
  });

  it("does not resubmit an unknown command when original receipt lookup returns 404", async () => {
    setApiInstance(new ApiClient("https://api.test"));
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ error: "not found" }, { status: 404 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(executeCockpitInputCommand(WS, { kind: "create", body: { commandKey: KEY, title: "Original", description: "  exact note  ", projectId: null, originIssueId: null } }, "lookup")).rejects.toMatchObject({ status: 404 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]).not.toMatchObject({ method: "POST" });
  });

  it("does not automatically replay a durable input intention after the active account changes", async () => {
    const client = new ApiClient("https://api.test"); client.setToken("original-account");
    const fetcher = vi.fn<typeof fetch>(async () => {
      client.setToken("another-account");
      return Response.json({ error: "CSRF validation failed" }, { status: 403 });
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(client.createCockpitInput(WS, { commandKey: KEY, title: "Original intention", description: "", projectId: null, originIssueId: null })).rejects.toMatchObject({ status: 403 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe("Bearer original-account");
  });

  it("restores the exact old version selection and retains explicitly unavailable IDs", () => {
    const batch = { workspace_id: WS, requested_ids: [VERSION, INPUT], items: [version()], unavailable_ids: [INPUT] };
    expect(CockpitInputVersionBatchSchema.parse(batch)).toMatchObject({ requestedIds: [VERSION, INPUT], unavailableIds: [INPUT], items: [{ id: VERSION }] });
    expect(CockpitInputVersionBatchSchema.safeParse({ ...batch, unavailable_ids: [] }).success).toBe(false);
    expect(CockpitInputVersionBatchSchema.safeParse({ ...batch, requested_ids: [VERSION], unavailable_ids: [VERSION] }).success).toBe(false);
    expect(CockpitInputVersionBatchSchema.safeParse({ ...batch, items: [{ ...version(), workspace_id: USER }] }).success).toBe(false);
  });
});


it("lists existing Issue attachments without accepting another Issue or duplicate source rows", async () => {
  const issueId = id(40);
  const item = { id: id(41), issue_id: issueId, filename: "agenda.pdf", content_type: "application/pdf", size_bytes: 0, created_at: TIME };
  const page = { workspace_id: WS, issue_id: issueId, q: "agenda", page_size: 25, items: [item], total: 1,
    next_cursor: null, can_capture: true, blocked_reasons: [] };
  expect(CockpitInputAttachmentPageSchema.parse(page).items[0]).toMatchObject({ issueId, sizeBytes: 0 });
  expect(CockpitInputAttachmentPageSchema.safeParse({ ...page, items: [{ ...item, issue_id: id(42) }] }).success).toBe(false);
  expect(CockpitInputAttachmentPageSchema.safeParse({ ...page, items: [item, item], total: 2 }).success).toBe(false);
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(page), { headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetcher);
  const client = new ApiClient("http://agent3.test");
  expect(await client.getCockpitInputAttachments(WS, id(42))).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("restores an exact attachment label without retaining its signed download URLs or accepting a different Issue", async () => {
  const issueId = id(40), attachmentId = id(41);
  const raw = { id: attachmentId, workspace_id: WS, issue_id: issueId, filename: "Original agenda.pdf", content_type: "application/pdf", size_bytes: 17, created_at: TIME,
    url: "private-object-path", download_url: "https://private.invalid/?signature=temporary", file_path: "/private/source" };
  const fetcher = vi.fn().mockImplementation(async () => Response.json(raw));
  vi.stubGlobal("fetch", fetcher);
  const client = new ApiClient("https://agent3.test");
  const value = await client.getCockpitInputAttachment(WS, issueId, attachmentId);
  expect(value).toMatchObject({ workspaceId: WS, issueId, id: attachmentId, filename: "Original agenda.pdf" });
  for (const field of ["url", "download_url", "file_path"]) expect(value).not.toHaveProperty(field);
  expect(new Headers(fetcher.mock.calls[0]![1].headers).get("X-Workspace-ID")).toBe(WS);
  expect(await client.getCockpitInputAttachment(WS, id(42), attachmentId)).toBeNull();
  expect(await client.getCockpitInputAttachment(id(42), issueId, attachmentId)).toBeNull();
});
