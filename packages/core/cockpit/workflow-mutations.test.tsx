// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { EMPTY_COCKPIT_MEETING_WORKFLOW } from "../api/schemas";
import type { CockpitMeetingWorkflow } from "../types";
import { cockpitKeys, cockpitMeetingWorkflowOptions, invalidateCockpitWorkflowsForIssue } from "./queries";
import { useEnableCockpitMeetingWorkflow } from "./workflow-mutations";
import { handoffFixture, workflowFixture, WORKFLOW_MEETING_ID } from "./workflow-test-fixtures";

vi.mock("../api", () => ({ api: { getCockpitMeetingWorkflow: vi.fn(), enableCockpitMeetingWorkflow: vi.fn() } }));
afterEach(cleanup);

describe("workflow cache ownership", () => {
  it("does not let an older disabled read overwrite acknowledged initialization", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    let finishRead!: (data: CockpitMeetingWorkflow) => void;
    vi.mocked(api.getCockpitMeetingWorkflow)
      .mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }))
      .mockResolvedValue(workflowFixture());
    vi.mocked(api.enableCockpitMeetingWorkflow).mockResolvedValue(workflowFixture());
    function Wrapper({ children }: { children: ReactNode }) { return <QueryClientProvider client={client}>{children}</QueryClientProvider>; }
    const { result } = renderHook(() => ({
      query: useQuery(cockpitMeetingWorkflowOptions("ws-1", WORKFLOW_MEETING_ID)),
      enable: useEnableCockpitMeetingWorkflow("ws-1"),
    }), { wrapper: Wrapper });
    await waitFor(() => expect(api.getCockpitMeetingWorkflow).toHaveBeenCalled());
    await act(async () => { await result.current.enable.mutateAsync({ meetingId: WORKFLOW_MEETING_ID, body: { reviewer_id: "reviewer-1" } }); });
    await act(async () => { finishRead({ ...EMPTY_COCKPIT_MEETING_WORKFLOW, meeting_id: WORKFLOW_MEETING_ID }); await Promise.resolve(); });
    expect(client.getQueryData<CockpitMeetingWorkflow>(cockpitKeys.workflow("ws-1", WORKFLOW_MEETING_ID))?.enabled).toBe(true);
  });

  it("refreshes only related workflow facts for ordinary issue edits", () => {
    const client = new QueryClient();
    client.setQueryData(cockpitKeys.workflow("ws-1", "meeting-a"), workflowFixture());
    client.setQueryData(cockpitKeys.workflow("ws-1", "meeting-b"), workflowFixture({ minutes_issue: { ...workflowFixture().minutes_issue!, id: "other-minutes" } }));
    client.setQueryData(cockpitKeys.workflow("ws-2", "meeting-c"), workflowFixture());
    const invalidate = vi.spyOn(client, "invalidateQueries");
    invalidateCockpitWorkflowsForIssue(client, "ws-1", "minutes-1");
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: cockpitKeys.workflow("ws-1", "meeting-a"), exact: true });
  });

  it("refreshes historical review task data after a transfer, scoped to its own workspace", () => {
    const client = new QueryClient();
    const workflow = workflowFixture({ reviewer_handoffs: [handoffFixture()] });
    client.setQueryData(cockpitKeys.workflow("ws-1", "meeting-a"), workflow);
    client.setQueryData(cockpitKeys.workflow("ws-1", "meeting-b"), workflowFixture());
    client.setQueryData(cockpitKeys.workflow("ws-2", "meeting-a"), workflow);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    invalidateCockpitWorkflowsForIssue(client, "ws-1", "review-1");
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: cockpitKeys.workflow("ws-1", "meeting-a"), exact: true });
  });
});
