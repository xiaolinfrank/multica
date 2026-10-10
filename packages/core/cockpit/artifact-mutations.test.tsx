// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { CockpitUnconfirmedWriteError } from "./errors";
import { cockpitArtifactKeys } from "./artifact-queries";
import { artifactFixture, artifactVersionDetailFixture, artifactVersionFixture, acceptanceFixture, ARTIFACT_CREATION_KEY, ARTIFACT_SUBMISSION_KEY, ACCEPTANCE_REQUEST_KEY } from "./artifact-test-fixtures";
import { useCreateCockpitArtifact, useSubmitCockpitArtifactVersion, useCreateCockpitAcceptanceRequest } from "./artifact-mutations";

vi.mock("../api", () => ({ api: { createCockpitArtifact: vi.fn(), submitCockpitArtifactVersion: vi.fn(), createCockpitAcceptanceRequest: vi.fn() } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) { return <QueryClientProvider client={client}>{children}</QueryClientProvider>; }
  return { client, wrapper: Wrapper };
}

describe("confirmed artifact commands", () => {
  it("accepts the stable creation receipt after a later rename without copying server state into drafts", async () => {
    const state = setup();
    const body = { creation_key: ARTIFACT_CREATION_KEY, node_id: "node-1", source_issue_id: "source-1", title: "Initial title", description: "", reviewer_id: "reviewer-1" };
    const receipt = artifactFixture({ title: "A later rename", reviewer_id: "new-reviewer" });
    vi.mocked(api.createCockpitArtifact).mockResolvedValue(receipt);
    const { result } = renderHook(() => useCreateCockpitArtifact("ws-1"), { wrapper: state.wrapper });
    await act(async () => { await expect(result.current.mutateAsync(body)).resolves.toEqual(receipt); });
    expect(state.client.getQueryData(cockpitArtifactKeys.artifact("ws-1", "artifact-1"))).toBeUndefined();
    vi.mocked(api.createCockpitArtifact).mockResolvedValue({ ...receipt, creation_key: "another-key" });
    await act(async () => { await expect(result.current.mutateAsync(body)).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError); });
  });

  it("confirms an exact historical text submission while a newer version is current", async () => {
    const state = setup();
    const content = "# Evidence\r\nExact ending  \n";
    const receipt = { workspace_id: "ws-1", artifact: artifactFixture({ current_version: artifactVersionFixture({ id: "new-version", version_number: 2 }), version_count: 2 }), version: artifactVersionDetailFixture({ content }) };
    vi.mocked(api.submitCockpitArtifactVersion).mockResolvedValue(receipt);
    const { result } = renderHook(() => useSubmitCockpitArtifactVersion("ws-1"), { wrapper: state.wrapper });
    const command = { artifactId: "artifact-1", body: { expected_revision: 1, submission_key: ARTIFACT_SUBMISSION_KEY, payload: { kind: "text" as const, content } } };
    await act(async () => { await expect(result.current.mutateAsync(command)).resolves.toEqual(receipt); });
    expect(api.submitCockpitArtifactVersion).toHaveBeenLastCalledWith("ws-1", "artifact-1", command.body);
    vi.mocked(api.submitCockpitArtifactVersion).mockResolvedValue({ ...receipt, version: { ...receipt.version, content: content.trim() } });
    await act(async () => { await expect(result.current.mutateAsync(command)).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError); });
  });

  it("rejects a file receipt for another attachment and invalidates uncertain facts only in its workspace", async () => {
    const state = setup();
    const localKey = cockpitArtifactKeys.artifact("ws-1", "artifact-1");
    const otherKey = cockpitArtifactKeys.artifact("ws-2", "artifact-1");
    state.client.setQueryData(localKey, artifactFixture());
    state.client.setQueryData(otherKey, artifactFixture({ workspace_id: "ws-2" }));
    const version = artifactVersionFixture({ payload_kind: "attachment", source_attachment_id: "wrong-file", capture_status: "queued", decision: "not_requested", content_hash: null, size_bytes: null, review_issue: null });
    vi.mocked(api.submitCockpitArtifactVersion).mockResolvedValue({ workspace_id: "ws-1", artifact: artifactFixture(), version: artifactVersionDetailFixture({ version, content: null }) });
    const { result } = renderHook(() => useSubmitCockpitArtifactVersion("ws-1"), { wrapper: state.wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync({ artifactId: "artifact-1", body: { expected_revision: 2, submission_key: ARTIFACT_SUBMISSION_KEY, payload: { kind: "attachment", attachment_id: "selected-file" } } })).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    });
    expect(state.client.getQueryState(localKey)?.isInvalidated).toBe(true);
    expect(state.client.getQueryState(otherKey)?.isInvalidated).toBe(false);
  });

  it("requires the acceptance receipt to freeze the exact replacement and evidence identities", async () => {
    const state = setup();
    const original = acceptanceFixture();
    const receipt = { ...original, request: { ...original.request, supersedes_request_id: "old-request" } };
    const body = { request_key: ACCEPTANCE_REQUEST_KEY, expected_criteria_revision: 1, reviewer_id: "reviewer-1", evidence: [{ criterion_id: "criterion-1", version_ids: ["version-1"] }], note: original.note, supersedes_request_id: "old-request" };
    const { result } = renderHook(() => useCreateCockpitAcceptanceRequest("ws-1"), { wrapper: state.wrapper });
    vi.mocked(api.createCockpitAcceptanceRequest).mockResolvedValue(receipt);
    await act(async () => { await expect(result.current.mutateAsync({ nodeId: "node-1", body })).resolves.toEqual(receipt); });
    for (const wrong of [original, { ...receipt, evidence: [{ ...receipt.evidence[0]!, versions: [artifactVersionFixture({ id: "newer-version", decision: "approved" })] }] }]) {
      vi.mocked(api.createCockpitAcceptanceRequest).mockResolvedValue(wrong);
      await act(async () => { await expect(result.current.mutateAsync({ nodeId: "node-1", body })).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError); });
    }
  });
});
