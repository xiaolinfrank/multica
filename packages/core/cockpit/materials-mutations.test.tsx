// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { CockpitBoardSchema, CockpitMeetingSchema } from "../api/schemas";
import type { CockpitBoard, CockpitMeeting } from "../types";
import { cockpitKeys } from "./queries";
import { cockpitReadKeys } from "./read-queries";
import { cockpitDirectoryKeys } from "./meeting-directory-queries";
import { CockpitUnconfirmedWriteError } from "./errors";
import { useSaveCockpitMeetingMaterials } from "./mutations";

vi.mock("../api", () => ({ api: { updateCockpitMeeting: vi.fn() } }));
beforeEach(() => { vi.clearAllMocks(); });
afterEach(cleanup);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const a = CockpitMeetingSchema.parse({ id: "meeting-a", cockpit_id: "cp", note: "Original A", nas_dir: "/Volumes/share/A" });
  const b = CockpitMeetingSchema.parse({ id: "meeting-b", cockpit_id: "cp", note: "Original B", nas_dir: "/Volumes/share/B" });
  const board = CockpitBoardSchema.parse({ cockpit: { id: "cp" }, meetings: [a, b] });
  client.setQueryData(cockpitKeys.board("ws-1"), board);
  client.setQueryData(cockpitKeys.board("ws-2"), board);
  for (const [ws, meeting] of [["ws-1", a.id], ["ws-1", b.id], ["ws-2", a.id]]) {
    client.setQueryData(cockpitDirectoryKeys.summary(ws!, meeting!), { binding: "Last confirmed path" });
  }
  function Wrapper({ children }: { children: ReactNode }) { return <QueryClientProvider client={client}>{children}</QueryClientProvider>; }
  const { result } = renderHook(() => useSaveCockpitMeetingMaterials("ws-1"), { wrapper: Wrapper });
  const cached = () => client.getQueryData<CockpitBoard>(cockpitKeys.board("ws-1"))!;
  return { a, b, board, client, result, cached };
}

describe("confirmed meeting material writes", () => {
  it("refuses an empty material command without sending an unacknowledgeable write", async () => {
    const { a, board, result, cached } = setup();
    await act(async () => {
      await expect(result.current.mutateAsync({ id: a.id, patch: {} })).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    });
    expect(api.updateCockpitMeeting).not.toHaveBeenCalled();
    expect(cached()).toEqual(board);
  });

  it("keeps pending text out of server cache and does not roll back another meeting after a late failure", async () => {
    const { a, b, board, client, result, cached } = setup();
    const first = deferred<CockpitMeeting>();
    vi.mocked(api.updateCockpitMeeting).mockImplementation((id) => id === a.id ? first.promise : Promise.resolve({ ...b, note: "Saved B" }));
    let pending!: Promise<unknown>;
    act(() => { pending = result.current.mutateAsync({ id: a.id, patch: { note: "Unsaved A" } }).catch((cause: unknown) => cause); });
    await waitFor(() => expect(api.updateCockpitMeeting).toHaveBeenCalledWith(a.id, { note: "Unsaved A" }));
    expect(cached().meetings).toEqual([a, b]);
    await act(async () => { await result.current.mutateAsync({ id: b.id, patch: { note: "Saved B" } }); });
    expect(cached().meetings[1]?.note).toBe("Saved B");
    await act(async () => { first.reject(new Error("Connection lost")); expect(await pending).toBeInstanceOf(Error); });
    expect(cached().meetings[0]?.note).toBe("Original A");
    expect(cached().meetings[1]?.note).toBe("Saved B");
    expect(client.getQueryData(cockpitKeys.board("ws-2"))).toEqual(board);
  });

  it.each(["id", "note", "nas_dir"] as const)("rejects a response that does not confirm the submitted %s", async (field) => {
    const { a, board, client, result, cached } = setup();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const response = { ...a, note: "New note", nas_dir: "/Volumes/share/New", [field]: "Unconfirmed value" };
    vi.mocked(api.updateCockpitMeeting).mockResolvedValue(response);
    await act(async () => {
      await expect(result.current.mutateAsync({ id: a.id, patch: { note: "New note", nas_dir: "/Volumes/share/New" } })).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    });
    expect(cached()).toEqual(board);
    expect(invalidate.mock.calls).toEqual([
      [{ queryKey: cockpitReadKeys.all("ws-1") }],
      [{ queryKey: cockpitKeys.board("ws-1"), exact: true }],
      [{ queryKey: cockpitKeys.workflow("ws-1", a.id), exact: true }],
      [{ queryKey: cockpitDirectoryKeys.meeting("ws-1", a.id) }],
    ]);
    expect(client.getQueryState(cockpitDirectoryKeys.summary("ws-1", a.id))?.isInvalidated).toBe(true);
    expect(client.getQueryData(cockpitDirectoryKeys.summary("ws-1", a.id))).toEqual({ binding: "Last confirmed path" });
    expect(client.getQueryState(cockpitDirectoryKeys.summary("ws-1", "meeting-b"))?.isInvalidated).toBe(false);
    expect(client.getQueryState(cockpitDirectoryKeys.summary("ws-2", a.id))?.isInvalidated).toBe(false);
  });

  it("merges only the confirmed fields when note and directory saves settle out of order", async () => {
    const { a, client, result, cached } = setup();
    const noteSave = deferred<CockpitMeeting>();
    const directorySave = deferred<CockpitMeeting>();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    vi.mocked(api.updateCockpitMeeting).mockImplementation((_id, patch) => patch.note !== undefined ? noteSave.promise : directorySave.promise);
    let notePending!: Promise<unknown>;
    let directoryPending!: Promise<unknown>;
    act(() => {
      notePending = result.current.mutateAsync({ id: a.id, patch: { note: "Saved new note" } });
      directoryPending = result.current.mutateAsync({ id: a.id, patch: { nas_dir: "/Volumes/share/Confirmed" } });
    });
    await waitFor(() => expect(api.updateCockpitMeeting).toHaveBeenCalledTimes(2));
    await act(async () => { directorySave.resolve({ ...a, nas_dir: "/Volumes/share/Confirmed" }); await directoryPending; });
    await act(async () => { noteSave.resolve({ ...a, note: "Saved new note" }); await notePending; });
    expect(cached().meetings[0]).toMatchObject({ note: "Saved new note", nas_dir: "/Volumes/share/Confirmed" });
    expect(invalidate.mock.calls).toEqual([
      [{ queryKey: cockpitReadKeys.all("ws-1") }],
      [{ queryKey: cockpitKeys.board("ws-1"), exact: true }],
      [{ queryKey: cockpitKeys.workflow("ws-1", a.id), exact: true }],
      [{ queryKey: cockpitDirectoryKeys.meeting("ws-1", a.id) }],
      [{ queryKey: cockpitReadKeys.all("ws-1") }],
      [{ queryKey: cockpitKeys.board("ws-1"), exact: true }],
    ]);
    expect(client.getQueryState(cockpitDirectoryKeys.summary("ws-1", a.id))?.isInvalidated).toBe(true);
    expect(client.getQueryState(cockpitDirectoryKeys.summary("ws-1", "meeting-b"))?.isInvalidated).toBe(false);
    expect(client.getQueryState(cockpitDirectoryKeys.summary("ws-2", a.id))?.isInvalidated).toBe(false);
  });

  it("does not resurrect a deleted meeting when its earlier save is acknowledged", async () => {
    const { a, b, client, result, cached } = setup();
    const save = deferred<CockpitMeeting>();
    vi.mocked(api.updateCockpitMeeting).mockReturnValue(save.promise);
    let pending!: Promise<unknown>;
    act(() => { pending = result.current.mutateAsync({ id: a.id, patch: { note: "Late reply" } }); });
    await waitFor(() => expect(api.updateCockpitMeeting).toHaveBeenCalled());
    client.setQueryData<CockpitBoard>(cockpitKeys.board("ws-1"), { ...cached(), meetings: [b] });
    await act(async () => { save.resolve({ ...a, note: "Late reply" }); await pending; });
    expect(cached().meetings).toEqual([b]);
  });
});
