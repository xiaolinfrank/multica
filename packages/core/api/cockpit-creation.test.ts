// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";
import { CockpitUnconfirmedWriteError } from "../cockpit/errors";
function reply(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 201, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  return { api: new ApiClient("https://example.test"), fetchMock };
}
afterEach(() => vi.unstubAllGlobals());
describe("cockpit creation receipts", () => {
  it("requires a committed meeting and its requested anchor in one response", async () => {
    const body = { title: "Review", meet_date: "2026-10-10", node_id: "node" };
    const receipt = { id: "meeting", title: "Review", code: "20261010-02", meet_date: body.meet_date,
      node_link: { meeting_id: "meeting", node_id: "node", position: 0 } };
    const { api, fetchMock } = reply(receipt);
    await expect(api.createCockpitMeeting(body)).resolves.toMatchObject(receipt);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST", body: JSON.stringify(body) });
    for (const invalid of [null, {}, { ...receipt, id: "" }, { ...receipt, node_link: undefined },
      { ...receipt, node_link: { ...receipt.node_link, node_id: "other" } },
      { ...receipt, node_link: { ...receipt.node_link, meeting_id: "other" } },
      { ...receipt, title: undefined }, { ...receipt, code: "" }]) {
      await expect(reply(invalid).api.createCockpitMeeting(body)).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    }
  });
  it("requires the exact creation key, workspace and explicit replay flag for keyed writes", async () => {
    const key = "10000000-0000-4000-8000-000000000001";
    const body = { title: "Review", creation_key: key };
    const receipt = { id: "meeting", title: "Review", code: "", meet_date: null, workspace_id: "ws-1", creation_key: key, replayed: true };
    const valid = reply(receipt);
    await expect(valid.api.createCockpitMeeting(body, "ws-1")).resolves.toMatchObject(receipt);
    expect(new Headers(valid.fetchMock.mock.calls[0]![1].headers).get("X-Workspace-ID")).toBe("ws-1");
    for (const patch of [{ creation_key: undefined }, { creation_key: "20000000-0000-4000-8000-000000000001" }, { workspace_id: "other" }, { workspace_id: undefined }, { replayed: undefined }]) {
      await expect(reply({ ...receipt, ...patch }).api.createCockpitMeeting(body, "ws-1")).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    }
    const nodeBody = { code: "L1-01", name: "Initial", creation_key: key };
    const node = { id: "node", cockpit_id: "board", code: "L1-01", name: "Initial", parent_id: null, project_id: null, module_id: null, position: 1, workspace_id: "ws-1", creation_key: key, replayed: false };
    await expect(reply(node).api.createCockpitNode(nodeBody, "ws-1")).resolves.toMatchObject(node);
    await expect(reply({ ...node, creation_key: undefined }).api.createCockpitNode(nodeBody, "ws-1")).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    await expect(reply({ ...node, workspace_id: "other" }).api.createCockpitNode(nodeBody, "ws-1")).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
  });
  it("confirms server-allocated node codes without comparing them to a preview", async () => {
    const key = "10000000-0000-4000-8000-000000000001";
    const body = { auto_code: true as const, creation_key: key, name: "Parallel creation", parent_id: null };
    const receipt = { id: "node", cockpit_id: "board", workspace_id: "ws-1", parent_id: null, project_id: null, module_id: null,
      code: "L1-09", name: "Parallel creation", position: 9, creation_key: key, replayed: false };
    await expect(reply(receipt).api.createCockpitNode(body, "ws-1")).resolves.toMatchObject({ code: "L1-09" });
    await expect(reply({ ...receipt, code: "" }).api.createCockpitNode(body, "ws-1")).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
  });
  it("accepts an unanchored meeting without guessing a link", async () => {
    await expect(reply({ id: "meeting", title: "Unfiled", code: "", meet_date: null }).api.createCockpitMeeting({ title: "Unfiled" })).resolves.toMatchObject({ id: "meeting" });
  });
  it("never closes a node draft on a missing or mismatched binding receipt", async () => {
    const body = { code: "L1-01", name: "Project", project_id: "project", parent_id: null };
    const receipt = { id: "node", cockpit_id: "board", parent_id: null, project_id: "project", module_id: null, code: "L1-01", name: "Project", position: 9 };
    await expect(reply(receipt).api.createCockpitNode(body)).resolves.toMatchObject(receipt);
    for (const invalid of [{}, { ...receipt, id: "" }, { ...receipt, project_id: undefined }, { ...receipt, project_id: "other" }, { ...receipt, code: "L1-02" }, { ...receipt, parent_id: "other" }]) {
      await expect(reply(invalid).api.createCockpitNode(body)).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    }
  });
});
