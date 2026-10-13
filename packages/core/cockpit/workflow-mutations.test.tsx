// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import type { CockpitMeetingWorkflowSummary } from "../types";
import { cockpitKeys, cockpitMeetingWorkflowOptions, invalidateCockpitWorkflowsForIssue } from "./queries";
import { useEnableCockpitMeetingWorkflow } from "./workflow-mutations";
import { cockpitArtifactKeys } from "./artifact-queries";
import { workflowFixture, WORKFLOW_MEETING_ID } from "./workflow-test-fixtures";
import { compactFixture, workflowSummaryFixture } from "./workflow-history-test-fixtures";

vi.mock("../api", () => ({ api: { getCockpitMeetingWorkflowSummary: vi.fn(), commandCockpitMeetingWorkflow: vi.fn() } }));
afterEach(cleanup);

describe("workflow cache ownership", () => {
  it("does not let an older disabled read overwrite acknowledged initialization", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    let finishRead!: (data: CockpitMeetingWorkflowSummary) => void;
    vi.mocked(api.getCockpitMeetingWorkflowSummary)
      .mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }))
      .mockResolvedValue(workflowSummaryFixture());
    vi.mocked(api.commandCockpitMeetingWorkflow).mockResolvedValue(compactFixture(workflowSummaryFixture(), { action: "enabled" }));
    function Wrapper({ children }: { children: ReactNode }) { return <QueryClientProvider client={client}>{children}</QueryClientProvider>; }
    const { result } = renderHook(() => ({
      query: useQuery(cockpitMeetingWorkflowOptions("ws-1", WORKFLOW_MEETING_ID)),
      enable: useEnableCockpitMeetingWorkflow("ws-1"),
    }), { wrapper: Wrapper });
    await waitFor(() => expect(api.getCockpitMeetingWorkflowSummary).toHaveBeenCalled());
    await act(async () => { await result.current.enable.mutateAsync({ meetingId: WORKFLOW_MEETING_ID, body: { reviewer_id: "reviewer-1" } }); });
    await act(async () => { finishRead(workflowSummaryFixture(workflowFixture({ enabled: false, revision: 0, minutes_issue: null, reviewer_id: null }))); await Promise.resolve(); });
    expect(client.getQueryData<CockpitMeetingWorkflowSummary>(cockpitKeys.workflow("ws-1", WORKFLOW_MEETING_ID))?.enabled).toBe(true);
  });

  it("refreshes only related workflow facts for ordinary issue edits", () => {
    const client = new QueryClient();
    client.setQueryData(cockpitKeys.workflow("ws-1", "meeting-a"), workflowSummaryFixture());
    client.setQueryData(cockpitKeys.workflow("ws-1", "meeting-b"), workflowSummaryFixture(workflowFixture({ minutes_issue: { ...workflowFixture().minutes_issue!, id: "other-minutes" } })));
    client.setQueryData(cockpitKeys.workflow("ws-2", "meeting-c"), workflowSummaryFixture());
    const invalidate = vi.spyOn(client, "invalidateQueries");
    invalidateCockpitWorkflowsForIssue(client, "ws-1", "minutes-1");
    expect(invalidate.mock.calls).toEqual([
      [{ queryKey: ["issue-operation-basis", "ws-1"] }, { cancelRefetch: false }],
      [{ queryKey: cockpitKeys.surfaces("ws-1") }],
      [{ queryKey: cockpitKeys.dashboard("ws-1") }],
      [{ queryKey: cockpitKeys.tasks("ws-1") }], [{ queryKey: cockpitKeys.actions("ws-1") }], [{ queryKey: cockpitKeys.primaryNodes("ws-1") }],
      [{ queryKey: cockpitKeys.issueActions("ws-1") }],
      [{ queryKey: cockpitArtifactKeys.all("ws-1"), predicate: expect.any(Function) }],
      [{ queryKey: cockpitArtifactKeys.acceptances("ws-1"), predicate: expect.any(Function) }],
      [{ queryKey: [...cockpitArtifactKeys.issueContexts("ws-1"), "minutes-1"] }],
      [{ queryKey: cockpitKeys.workflowHistories("ws-1") }],
      [{ queryKey: cockpitKeys.workflow("ws-1", "meeting-a"), exact: true }],
    ]);
  });

  it("refreshes historical review task data after a transfer, scoped to its own workspace", () => {
    const client = new QueryClient();
    const workflow = workflowSummaryFixture();
    client.setQueryData(cockpitKeys.workflow("ws-1", "meeting-a"), workflow);
    client.setQueryData(cockpitKeys.workflow("ws-1", "meeting-b"), workflowSummaryFixture());
    client.setQueryData(cockpitKeys.workflow("ws-2", "meeting-a"), workflow);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    invalidateCockpitWorkflowsForIssue(client, "ws-1", "review-1");
    expect(invalidate.mock.calls).toEqual([
      [{ queryKey: ["issue-operation-basis", "ws-1"] }, { cancelRefetch: false }],
      [{ queryKey: cockpitKeys.surfaces("ws-1") }],
      [{ queryKey: cockpitKeys.dashboard("ws-1") }],
      [{ queryKey: cockpitKeys.tasks("ws-1") }], [{ queryKey: cockpitKeys.actions("ws-1") }], [{ queryKey: cockpitKeys.primaryNodes("ws-1") }],
      [{ queryKey: cockpitKeys.issueActions("ws-1") }],
      [{ queryKey: cockpitArtifactKeys.all("ws-1"), predicate: expect.any(Function) }],
      [{ queryKey: cockpitArtifactKeys.acceptances("ws-1"), predicate: expect.any(Function) }],
      [{ queryKey: [...cockpitArtifactKeys.issueContexts("ws-1"), "review-1"] }],
      [{ queryKey: cockpitKeys.workflowHistories("ws-1") }],
    ]);
  });
});
