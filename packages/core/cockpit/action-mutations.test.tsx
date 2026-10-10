// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import type { CockpitMeetingAction, CockpitPrimaryNode } from "../types";
import { cockpitKeys } from "./queries";
import { useResolveCockpitMeetingAction, useSetCockpitPrimaryNode } from "./action-mutations";
import { actionFixture, actionTaskFixture, DECISION_KEY } from "./action-test-fixtures";

vi.mock("../api", () => ({ api: { setCockpitPrimaryNode: vi.fn(), resolveCockpitMeetingAction: vi.fn() } }));
afterEach(cleanup);
function setup() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) { return <QueryClientProvider client={client}>{children}</QueryClientProvider>; }
  return { client, wrapper: Wrapper };
}

describe("action projection cache ordering", () => {
  it("does not roll a newer primary ownership revision back with a delayed write response", async () => {
    const { client, wrapper } = setup();
    const newer: CockpitPrimaryNode = { issue_id: "issue-1", node_id: "node-2", revision: 5, project_id: "p1", module_id: "m1", node_code: "", node_name: "" };
    client.setQueryData(cockpitKeys.primaryNode("ws-1", "issue-1"), newer);
    vi.mocked(api.setCockpitPrimaryNode).mockResolvedValue({ ...newer, node_id: "node-1", revision: 2 });
    const { result } = renderHook(() => useSetCockpitPrimaryNode("ws-1"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ issueId: "issue-1", nodeId: "node-1", revision: 1 }); });
    expect(api.setCockpitPrimaryNode).toHaveBeenCalledWith("ws-1", "issue-1", { node_id: "node-1", expected_revision: 1 });
    expect(client.getQueryData(cockpitKeys.primaryNode("ws-1", "issue-1"))).toEqual(newer);
  });

  it("invalidates action reads rather than overwriting newer live issue facts sharing the same action revision", async () => {
    const { client, wrapper } = setup();
    const action = actionFixture({ revision: 2, status: "accepted", issue: actionTaskFixture({ status: "done" }) });
    const key = cockpitKeys.meetingAction("ws-1", action.meeting_id, action.id);
    client.setQueryData(key, action);
    vi.mocked(api.resolveCockpitMeetingAction).mockResolvedValue({ ...action, issue: actionTaskFixture({ status: "backlog" }) });
    const { result } = renderHook(() => useResolveCockpitMeetingAction("ws-1"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ meetingId: action.meeting_id, action, body: { expected_revision: 1, decision_key: DECISION_KEY, outcome: "create", node_id: "node-1" } }); });
    expect(client.getQueryData<CockpitMeetingAction>(key)?.issue?.status).toBe("done");
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  });
});
