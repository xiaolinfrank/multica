// @vitest-environment node
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import type { Attachment } from "../types";
import { cockpitArtifactSelectedAttachmentOptions, cockpitArtifactVersionActions, cockpitArtifactsOptions, cockpitAcceptanceOptions } from "./artifact-queries";
import { artifactVersionFixture } from "./artifact-test-fixtures";
import { CockpitUnconfirmedReadError } from "./errors";
import { cockpitScopeMembersOptions, cockpitSelectedMemberOptions, cockpitScopeNodesOptions } from "./scope-selector-queries";

vi.mock("../api", () => ({ api: { getAttachment: vi.fn(), searchCockpitScopeMembers: vi.fn(), searchCockpitScopeNodes: vi.fn(), getCockpitArtifacts: vi.fn(), getCockpitAcceptance: vi.fn() } }));
afterEach(() => vi.clearAllMocks());
const source = (): Attachment => ({ id: "file-1", workspace_id: "ws-1", issue_id: "source-1", filename: "report.pdf", content_type: "application/pdf", size_bytes: 42,
  comment_id: null, chat_session_id: null, chat_message_id: null, uploader_type: "member", uploader_id: "user-1", url: "file-key", download_url: "", markdown_url: "", created_at: "2026-10-10T00:00:00Z" });
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

describe("artifact source and responsibility reads", () => {
  it("recovers one selected attachment without fetching the complete attachment collection", async () => {
    const value = source();
    vi.mocked(api.getAttachment).mockResolvedValue(value);
    const queryClient = client();
    await expect(queryClient.fetchQuery(cockpitArtifactSelectedAttachmentOptions("ws-1", "artifact-1", "source-1", "file-1"))).resolves.toEqual(value);
    expect(api.getAttachment).toHaveBeenCalledExactlyOnceWith("file-1");
    queryClient.clear();
  });

  it("refuses a selected attachment that no longer belongs to the exact workspace or source issue", async () => {
    for (const patch of [{ id: "other" }, { workspace_id: "other" }, { issue_id: "other" }, { size_bytes: -1 }]) {
      vi.mocked(api.getAttachment).mockResolvedValue({ ...source(), ...patch });
      const queryClient = client();
      await expect(queryClient.fetchQuery(cockpitArtifactSelectedAttachmentOptions("ws-1", "artifact-1", "source-1", "file-1"))).rejects.toThrow("selected attachment");
      queryClient.clear();
    }
  });

  it("keeps source identity and selected-member lookup out of generic list caches", () => {
    const chosen = cockpitArtifactSelectedAttachmentOptions("ws-1", "artifact-1", "source-1", "file-1");
    expect(chosen.queryKey).not.toEqual(cockpitArtifactSelectedAttachmentOptions("ws-2", "artifact-1", "source-1", "file-1").queryKey);
    expect(chosen.queryKey).not.toEqual(cockpitArtifactSelectedAttachmentOptions("ws-1", "artifact-1", "source-2", "file-1").queryKey);
    expect(cockpitSelectedMemberOptions("ws-1", "").enabled).toBe(false);
    expect(cockpitSelectedMemberOptions("ws-1", "").queryKey).not.toEqual(cockpitScopeMembersOptions("ws-1").queryKey);
  });

  it("turns unconfirmed API payloads into retryable query errors rather than an empty successful surface", async () => {
    vi.mocked(api.searchCockpitScopeMembers).mockResolvedValue(null);
    vi.mocked(api.searchCockpitScopeNodes).mockResolvedValue(null);
    vi.mocked(api.getCockpitArtifacts).mockResolvedValue(null);
    vi.mocked(api.getCockpitAcceptance).mockResolvedValue(null);
    const queryClient = client();
    const reads = [
      () => queryClient.fetchQuery(cockpitSelectedMemberOptions("ws-1", "user-1")),
      () => queryClient.fetchQuery(cockpitScopeNodesOptions("ws-1")),
      () => queryClient.fetchQuery(cockpitArtifactsOptions("ws-1")),
      () => queryClient.fetchQuery(cockpitAcceptanceOptions("ws-1", "node-1")),
    ];
    for (const read of reads) await expect(read()).rejects.toBeInstanceOf(CockpitUnconfirmedReadError);
    expect(queryClient.getQueryCache().getAll().every((query) => query.state.status === "error")).toBe(true);
    queryClient.clear();
  });

  it("keeps a confirmed empty identity result distinct from a failed membership lookup", async () => {
    const empty = { workspace_id: "ws-1", scope: { q: "", ids: ["departed-user"] }, items: [], total: 0, filtered_total: 0, next_cursor: null };
    vi.mocked(api.searchCockpitScopeMembers).mockResolvedValue(empty);
    const queryClient = client();
    const options = cockpitSelectedMemberOptions("ws-1", "departed-user");
    await expect(queryClient.fetchQuery(options)).resolves.toEqual(empty);
    expect(queryClient.getQueryState(options.queryKey)?.status).toBe("success");
    queryClient.clear();
  });

  it("requires the pinned human reviewer and ready content even if an ordinary review task is reassigned or marked done", () => {
    const version = artifactVersionFixture();
    const changedTask = { ...version, review_issue: { ...version.review_issue!, assignee_id: "another-user", status: "done" } };
    expect(cockpitArtifactVersionActions(changedTask, "another-user").canReview).toBe(false);
    expect(cockpitArtifactVersionActions(changedTask, "reviewer-1").canReview).toBe(true);
    expect(cockpitArtifactVersionActions(version, "reviewer-1", true).canReview).toBe(false);
    expect(cockpitArtifactVersionActions({ ...version, capture_status: "unknown" }, "reviewer-1").canReview).toBe(false);
    expect(cockpitArtifactVersionActions({ ...version, payload_kind: "unknown" }, "reviewer-1").canReview).toBe(false);
  });
});
