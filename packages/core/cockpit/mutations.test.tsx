// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { CockpitBoardSchema, CockpitMeetingSchema } from "../api/schemas";
import type { CockpitBoard } from "../types";
import { cockpitKeys } from "./queries";
import { useSetCockpitMeetingIssueRoles, useSetCockpitNodeBinding, useUpdateCockpitMeeting, useProvisionCockpitMeeting, useImportCockpitMeetingFolders } from "./mutations";
import { CockpitUnconfirmedWriteError } from "./errors";

vi.mock("../api", () => ({ api: { updateCockpitNode: vi.fn(), setCockpitMeetingIssueRoles: vi.fn(), updateCockpitMeeting: vi.fn(), provisionCockpitMeeting: vi.fn(), importCockpitMeetingFolders: vi.fn() } }));
afterEach(cleanup);

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const board = CockpitBoardSchema.parse({ cockpit: { id: "cp" }, nodes: [{ id: "n1" }], meeting_issues: [
    { meeting_id: "m1", issue_id: "i1", roles: ["preparation"] },
    { meeting_id: "m1", issue_id: "i2", roles: ["reference"] },
    { meeting_id: "m2", issue_id: "i3", roles: ["review"] },
  ] });
  client.setQueryData(cockpitKeys.board("ws-1"), board);
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  const cached = () => client.getQueryData<CockpitBoard>(cockpitKeys.board("ws-1"))!;
  return { client, board, wrapper: Wrapper, cached };
}

describe("cockpit structural writes", () => {
  it("does not treat an import receipt as all relationships and refreshes after an unknown outcome", async () => {
    for (const lostResponse of [false, true]) {
      const { board, wrapper, client, cached } = setup();
      const meeting = CockpitMeetingSchema.parse({ id: "m1", nas_dir: "/share/folder" });
      if (lostResponse) vi.mocked(api.importCockpitMeetingFolders).mockRejectedValue(new Error("response lost"));
      else vi.mocked(api.importCockpitMeetingFolders).mockResolvedValue({ meetings: [meeting], issues: [board.meeting_issues[0]!], skipped: [] });
      const { result, unmount } = renderHook(() => useImportCockpitMeetingFolders("ws-1"), { wrapper });
      const body = { items: [{ name: "folder" }], expected_base_dir: "/share" };
      await act(async () => {
        if (lostResponse) await expect(result.current.mutateAsync(body)).rejects.toThrow("response lost");
        else await result.current.mutateAsync(body);
      });
      expect(api.importCockpitMeetingFolders).toHaveBeenLastCalledWith(body, "ws-1");
      expect(cached().meeting_issues).toEqual(board.meeting_issues);
      expect(client.getQueryState(cockpitKeys.board("ws-1"))?.isInvalidated).toBe(true);
      unmount();
    }
  });
  it("refreshes the permitted export destination after editing or provisioning the meeting folder", async () => {
    const { wrapper, client } = setup();
    const meeting = CockpitMeetingSchema.parse({ id: "m1", nas_dir: "/Volumes/team/New" });
    vi.mocked(api.updateCockpitMeeting).mockResolvedValue(meeting);
    vi.mocked(api.provisionCockpitMeeting).mockResolvedValue({ meeting, issues: [], task: null, task_error: "", dir: meeting.nas_dir, dir_created: true, dir_error: "" });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => ({ update: useUpdateCockpitMeeting("ws-1"), provision: useProvisionCockpitMeeting("ws-1") }), { wrapper });
    await act(async () => { await result.current.update.mutateAsync({ id: "m1", patch: { nas_dir: meeting.nas_dir } }); });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: cockpitKeys.workflow("ws-1", "m1"), exact: true });
    invalidate.mockClear();
    await act(async () => { await result.current.provision.mutateAsync({ id: "m1", body: { create_task: false, create_dir: true } }); });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: cockpitKeys.workflow("ws-1", "m1"), exact: true });
  });
  it("rejects an old server's unchanged binding response rather than reporting a confirmed write", async () => {
    const { board, wrapper, cached } = setup();
    vi.mocked(api.updateCockpitNode).mockResolvedValue(board.nodes[0]!);
    const { result } = renderHook(() => useSetCockpitNodeBinding("ws-1"), { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync({ id: "n1", project_id: "p1", module_id: "mod1" }))
        .rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    });
    expect(cached().nodes[0]?.project_id).toBeNull();
  });

  it("does not acknowledge malformed relationship responses or erase the previous set", async () => {
    const { board, wrapper, cached } = setup();
    vi.mocked(api.setCockpitMeetingIssueRoles).mockResolvedValue({ meeting_id: "m1", links: [] });
    const { result } = renderHook(() => useSetCockpitMeetingIssueRoles("ws-1"), { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync({ meetingId: "m1", issueId: "i1", roles: ["review"] }))
        .rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    });
    expect(cached().meeting_issues).toEqual(board.meeting_issues);
  });

  it("does not guess a binding while pending and replaces only the server-accepted node", async () => {
    const { client, board, wrapper, cached } = setup();
    let resolve!: (node: CockpitBoard["nodes"][number]) => void;
    vi.mocked(api.updateCockpitNode).mockImplementation(() => new Promise((done) => { resolve = done; }));
    const { result } = renderHook(() => useSetCockpitNodeBinding("ws-1"), { wrapper });
    let pending!: Promise<unknown>;
    act(() => { pending = result.current.mutateAsync({ id: "n1", project_id: "p1", module_id: "mod1" }); });
    expect(cached().nodes[0]?.module_id).toBeNull();
    await act(async () => {
      await Promise.resolve();
      resolve({ ...board.nodes[0]!, project_id: "p1", module_id: "mod1" });
      await pending;
    });
    expect(cached().nodes[0]).toMatchObject({ project_id: "p1", module_id: "mod1" });
    expect(client.getQueryState(cockpitKeys.board("ws-1"))?.isInvalidated).toBe(true);
  });

  it("keeps other meetings intact when the full relationship set confirms a purpose edit", async () => {
    const { board, wrapper, cached } = setup();
    const links = board.meeting_issues.filter((link) => link.meeting_id === "m1")
      .map((link) => link.issue_id === "i1" ? { ...link, roles: ["preparation", "review"] } : link);
    vi.mocked(api.setCockpitMeetingIssueRoles).mockResolvedValue({ meeting_id: "m1", links });
    const { result } = renderHook(() => useSetCockpitMeetingIssueRoles("ws-1"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ meetingId: "m1", issueId: "i1", roles: ["preparation", "review"] }); });
    expect(cached().meeting_issues).toHaveLength(3);
    expect(cached().meeting_issues.find((link) => link.issue_id === "i1")?.roles).toEqual(["preparation", "review"]);
    expect(cached().meeting_issues.find((link) => link.issue_id === "i3")?.roles).toEqual(["review"]);
  });
});
