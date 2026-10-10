// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";
const scope = { projectId: "project", moduleId: "module" };
function reply(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock); return { api: new ApiClient("https://example.test"), fetchMock };
}
afterEach(() => vi.unstubAllGlobals());
describe("bounded cockpit governance reads", () => {
  it("requires authoritative project/status/counts rather than fabricating an empty queue", async () => {
    const page = { workspace_id: "ws", scope: { project_id: "project", module_id: "module", project_title: "P", module_title: "M" }, q: "budget", status: "pending", items: [{ id: "change" }], total: 1, next_cursor: null, counts: { pending: 1, decided: 125 } };
    const { api, fetchMock } = reply(page);
    await expect(api.listCockpitChangePage("ws", scope, { q: "budget", status: "pending" })).resolves.toMatchObject(page);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("project_id=project");
    for (const invalid of [{ ...page, workspace_id: "elsewhere" }, { ...page, status: "all" }, { ...page, scope: { ...page.scope, module_id: null } }, { ...page, counts: undefined }, { ...page, total: 0 }, { ...page, items: [], next_cursor: "keep-going" }]) {
      await expect(reply(invalid).api.listCockpitChangePage("ws", scope, { q: "budget", status: "pending" })).resolves.toBeNull();
    }
  });
  it("identifies saved board history as workspace-wide and rejects a malformed page", async () => {
    const page = { workspace_id: "ws", scope: "workspace", q: "baseline", items: [{ id: "snapshot" }], total: 27, next_cursor: "next" };
    await expect(reply(page).api.listCockpitSnapshotPage("ws", { q: "baseline" })).resolves.toMatchObject(page);
    for (const invalid of [{ ...page, scope: "project" }, { ...page, q: "else" }, [], {}, { ...page, workspace_id: "else" }, { ...page, total: 0 }]) {
      await expect(reply(invalid).api.listCockpitSnapshotPage("ws", { q: "baseline" })).resolves.toBeNull();
    }
  });
});

describe("fixed proposal review", () => {
  const preview = { workspace_id: "ws", context: { project_id: "project", module_id: "module", project_title: "Project", module_title: "Module" }, change: { id: "change", node_id: "node", field: "progress", old_value: "40", new_value: "80", status: "pending", updated_at: "2026-10-10T00:00:00Z" }, current_value: "50", conflict: true, review_token: `"${"a".repeat(64)}"` };
  it("requires actual current value, conflict evidence and a resource-specific token", async () => {
    await expect(reply(preview).api.getCockpitChangePreview("ws", "change")).resolves.toMatchObject(preview);
    for (const invalid of [{ ...preview, context: undefined }, { ...preview, context: { ...preview.context, project_id: null } }, { ...preview, current_value: undefined }, { ...preview, conflict: false }, { ...preview, review_token: "" }, { ...preview, workspace_id: "other" }, { ...preview, change: { ...preview.change, id: "other" } }]) {
      await expect(reply(invalid).api.getCockpitChangePreview("ws", "change")).resolves.toBeNull();
    }
  });
  it("submits the displayed token and rejects an acknowledgement of a different edit", async () => {
    const parsed = await reply(preview).api.getCockpitChangePreview("ws", "change");
    if (!parsed) throw new Error("invalid preview fixture");
    const response = { change: { ...preview.change, old_value: "50", status: "applied" }, node: { id: "node", progress: 80 } };
    const { api, fetchMock } = reply(response);
    await expect(api.applyReviewedCockpitChange("ws", parsed)).resolves.toMatchObject(response);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST", headers: { "X-Workspace-ID": "ws", "If-Match": preview.review_token } });
    for (const invalid of [{ ...response, change: { ...response.change, new_value: "90" } }, { ...response, change: { ...response.change, old_value: "40" } }, { ...response, change: { ...response.change, old_value: undefined } }, { ...response, node: { id: "other" } }]) {
      await expect(reply(invalid).api.applyReviewedCockpitChange("ws", parsed)).rejects.toThrow("cockpit_write_not_confirmed");
    }
  });
});
