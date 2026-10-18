// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";
function reply(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock); return { api: new ApiClient("https://example.test"), fetchMock };
}
afterEach(() => vi.unstubAllGlobals());
const receipt = { meeting: { id: "meeting", nas_dir: "/share/meeting" }, issues: [], task: null, task_error: "", dir: "/share/meeting", dir_created: false, dir_error: "" };
describe("captured meeting workspace and provisioning evidence", () => {
  it("carries the original workspace through destination, scan, import and provision", async () => {
    const destination = reply({ project_id: "project", module_id: "module", node_id: "", base_dir: "/share/module" });
    await destination.api.getCockpitMeetingDestination({ projectId: "project", moduleId: "module", nodeId: "" }, "original-workspace");
    expect(destination.fetchMock.mock.calls[0]?.[1]).toMatchObject({ headers: { "X-Workspace-ID": "original-workspace" } });
    const scan = reply({ base_dir: "/share/module", base_dir_exists: true, entries: [], matched: 0, truncated: false, error: "" }); await scan.api.scanCockpitMeetingFolders({}, "original-workspace");
    expect(scan.fetchMock.mock.calls[0]?.[1]).toMatchObject({ headers: { "X-Workspace-ID": "original-workspace" } });
    const imported = reply({ meetings: [], issues: [], skipped: [] }); await imported.api.importCockpitMeetingFolders({ items: [] }, "original-workspace");
    expect(imported.fetchMock.mock.calls[0]?.[1]).toMatchObject({ headers: { "X-Workspace-ID": "original-workspace" } });
    const prepared = reply(receipt);
    await expect(prepared.api.provisionCockpitMeeting("meeting", { create_task: false }, "original-workspace")).resolves.toMatchObject(receipt);
    expect(prepared.fetchMock.mock.calls[0]?.[1]).toMatchObject({ headers: { "X-Workspace-ID": "original-workspace" } });
  });
  it("distinguishes confirmed per-step failure from a malformed or wrong-object write receipt", async () => {
    const failed = { ...receipt, meeting: { id: "meeting", nas_dir: "" }, dir: "", dir_error: "NAS unavailable", task_error: "Choose an assignee" };
    await expect(reply(failed).api.provisionCockpitMeeting("meeting", {})).resolves.toMatchObject(failed);
    for (const invalid of [{}, { ...receipt, meeting: { ...receipt.meeting, id: "other" } }, { ...receipt, dir_error: undefined }, { ...receipt, dir: "" }]) {
      await expect(reply(invalid).api.provisionCockpitMeeting("meeting", { create_task: false })).rejects.toThrow("cockpit_write_not_confirmed");
    }
  });
  it("rejects unconfirmed task creation and malformed import or scan receipts", async () => {
    await expect(reply(receipt).api.provisionCockpitMeeting("meeting", {})).rejects.toThrow("cockpit_write_not_confirmed");
    await expect(reply({}).api.scanCockpitMeetingFolders()).rejects.toThrow("cockpit_read_not_confirmed");
    await expect(reply({}).api.importCockpitMeetingFolders({ items: [] })).rejects.toThrow("cockpit_write_not_confirmed");
    const partial = { meetings: [{ id: "meeting", nas_dir: "/share/module/folder" }], issues: [], skipped: [{ name: "folder", reason: "task failed" }] };
    const request = reply(partial);
    await expect(request.api.importCockpitMeetingFolders({ items: [{ name: "folder" }], expected_base_dir: "/share/module" }, "workspace")).resolves.toMatchObject(partial);
    expect(JSON.parse(request.fetchMock.mock.calls[0]?.[1].body)).toMatchObject({ expected_base_dir: "/share/module" });
  });
  it("keeps imported meetings separate from unfinished directory plans and task creation errors", async () => {
    const directory = { name: "folder", meeting_id: "meeting", directory_operation_id: "10000000-0000-4000-8000-000000000009", directory_state: "needs_attention", dir_created: true, dir_error: "A partition needs review", dir_error_code: "path_is_file" };
    const value = { meetings: [{ id: "meeting", nas_dir: "/share/module/folder" }], issues: [], skipped: [], directory_results: [directory], task_errors: [{ name: "folder", meeting_id: "meeting", error: "Choose an assignee" }] };
    const body = { items: [{ name: "folder" }], create_task: true };
    await expect(reply(value).api.importCockpitMeetingFolders(body, "workspace")).resolves.toMatchObject(value);
    for (const changed of [{ ...value, directory_results: [] }, { ...value, directory_results: [directory, directory] },
      { ...value, directory_results: [{ ...directory, meeting_id: "other" }] }, { ...value, directory_results: [{ ...directory, name: "unselected" }] },
      { ...value, directory_results: [{ ...directory, dir_error: "" }] }, { ...value, task_errors: [{ ...value.task_errors[0], meeting_id: "other" }] }]) {
      await expect(reply(changed).api.importCockpitMeetingFolders(body, "workspace")).rejects.toThrow("cockpit_write_not_confirmed");
    }
    await expect(reply(value).api.importCockpitMeetingFolders({ ...body, create_task: false }, "workspace")).rejects.toThrow("cockpit_write_not_confirmed");
    const older = { meetings: value.meetings, issues: [], skipped: [] };
    await expect(reply(older).api.importCockpitMeetingFolders(body, "workspace")).resolves.toMatchObject({ directory_results: null, task_errors: [] });
  });
  it("acknowledges a registered background directory plan without pretending its partitions are ready", async () => {
    const value = { ...receipt, directory_operation_id: "10000000-0000-4000-8000-000000000009", directory_state: "active", dir_error: "Directory preparation is continuing", dir_error_code: "preparation_pending" };
    await expect(reply(value).api.provisionCockpitMeeting("meeting", { create_task: false }, "workspace")).resolves.toMatchObject(value);
    for (const changed of [{ ...value, directory_state: "" }, { ...value, directory_operation_id: "not-an-operation" }, { ...value, dir_error: "" }]) {
      await expect(reply(changed).api.provisionCockpitMeeting("meeting", { create_task: false }, "workspace")).rejects.toThrow("cockpit_write_not_confirmed");
    }
  });
  it("does not turn an invalid destination response into an unconfigured directory", async () => {
    const valid = { project_id: "project", module_id: "module", base_dir: "/share" };
    for (const invalid of [{}, { ...valid, project_id: "other" }, { ...valid, module_id: "other" }]) {
      await expect(reply(invalid).api.getCockpitMeetingDestination({ projectId: "project", moduleId: "module" }, "workspace")).rejects.toThrow("cockpit_read_not_confirmed");
    }
  });
});
