import { useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { copyText } from "@multica/ui/lib/clipboard";
import { api } from "@multica/core/api";
import { cockpitKeys, cockpitMeetingWorkflowOptions, cockpitHistoryViewKey, useCockpitHistoryViewStore } from "@multica/core/cockpit";
import type { CockpitMeetingWorkflow, CockpitNasExport } from "@multica/core/types";
import { workflowFixture, versionFixture, workflowSummary, compactWorkflow, historyNasJobs, WORKFLOW_MEETING_ID } from "./workflow-test-fixtures";
import enCockpit from "../../locales/en/cockpit.json";
import { CockpitMeetingHistory } from "./cockpit-meeting-history";
import { CockpitMinutesNasCopies, CockpitMinutesPublishControl } from "./cockpit-minutes-nas";

vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: {
  getCockpitMeetingWorkflowSummary: vi.fn(), commandCockpitMeetingWorkflow: vi.fn(), getCockpitNasExports: vi.fn(), getCockpitMinutesVersions: vi.fn(), getCockpitReviewerHandoffs: vi.fn(),
  getCockpitMeetingWorkflow: vi.fn(), exportCockpitMinutesToNas: vi.fn(), retryCockpitNasExport: vi.fn(),
  getCockpitNasExportAttempts: vi.fn(),
} }));
vi.mock("../../common/local-path-link", () => ({ LocalPathLink: ({ path, children }: { path: string; children?: React.ReactNode }) => <button type="button" data-path={path}>{children ?? path}</button> }));
vi.mock("../../navigation", () => ({ AppLink: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
vi.mock("@multica/ui/lib/clipboard", () => ({ copyText: vi.fn() }));

const resourcesHref = `/ws/cockpit?meeting=${WORKFLOW_MEETING_ID}&meeting_view=resources`;
const destination = { root_id: "root-1", directory: "/Volumes/team/Meeting" };
function job(overrides: Partial<CockpitNasExport> = {}): CockpitNasExport {
  return { id: "export-1", version_id: "version-1", version_number: 1, source_issue_id: "minutes-1", content_hash: "hash-of-fixed-text",
    ...destination, target_path: "/Volumes/team/Meeting/已发布纪要/fixed.md", status: "queued", attempts: 0, revision: 1,
    size_bytes: null, next_retry_at: null, created_at: "2026-10-09T12:00:00Z", updated_at: "2026-10-09T12:00:00Z", completed_at: null,
    last_error_code: "", last_error: "", can_retry: false, ...overrides };
}
function published(): CockpitMeetingWorkflow {
  const version = versionFixture({ decision: "approved", published_at: "2026-10-09T12:00:00Z" });
  return workflowFixture({ current_version_id: version.id, published_version_id: version.id, versions: [version],
    nas_destination: destination, can_export_nas: true });
}
const shell = (children: React.ReactNode) => <I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}>{children}</I18nProvider>;
let server: CockpitMeetingWorkflow;
function setupCopies(readOnly = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  function Harness() {
    const query = useQuery(cockpitMeetingWorkflowOptions("ws-1", WORKFLOW_MEETING_ID));
    const [history, setHistory] = useState(false);
    return query.data ? <><CockpitMinutesNasCopies resourcesHref={resourcesHref} wsId="ws-1" workflow={query.data} userId="reviewer-1" readOnly={readOnly}
      disabled={false} onReload={() => void query.refetch()} onOpenHistory={() => { useCockpitHistoryViewStore.getState().update(cockpitHistoryViewKey("ws-1", WORKFLOW_MEETING_ID), { section: "exports" }); setHistory(true); }} />
      <CockpitMeetingHistory wsId="ws-1" workflow={query.data} members={[]} userId="reviewer-1" readOnly={readOnly} disabled={false} open={history} onOpenChange={setHistory} onRead={vi.fn()} /></> : null;
  }
  return { ...render(<QueryClientProvider client={client}>{shell(<Harness />)}</QueryClientProvider>), client };
}

beforeEach(() => {
  vi.clearAllMocks(); useCockpitHistoryViewStore.getState().reset();
  server = published();
  vi.mocked(copyText).mockResolvedValue(true);
  vi.mocked(api.getCockpitMeetingWorkflow).mockImplementation(async () => structuredClone(server));
  vi.mocked(api.getCockpitMeetingWorkflowSummary).mockImplementation(async () => workflowSummary(await api.getCockpitMeetingWorkflow(WORKFLOW_MEETING_ID)));
  vi.mocked(api.getCockpitNasExports).mockImplementation(async () => ({ workspace_id: "ws-1", meeting_id: server.meeting_id, workflow_revision: server.revision,
    version_id: null, status: "", items: historyNasJobs(server), total: server.nas_exports.length, next_cursor: null }));
  vi.mocked(api.commandCockpitMeetingWorkflow).mockImplementation(async (_ws, meetingId, command) => {
    if (command.action === "unpublished") {
      // Feed back the settled row: the pointer is gone and the revision moved.
      server = { ...server, revision: server.revision + 1, published_version_id: null };
      return compactWorkflow(server, command);
    }
    const result = command.action === "nas_export_queued" ? await api.exportCockpitMinutesToNas(meetingId, command.version_id, command.body)
      : command.action === "nas_export_retried" ? await api.retryCockpitNasExport(meetingId, command.operation) : null;
    if (!result) throw new Error("Unexpected command");
    return compactWorkflow(result, command);
  });
  vi.mocked(api.exportCockpitMinutesToNas).mockImplementation(async (_meetingId, versionId, target) => {
    server = { ...server, nas_exports: [...server.nas_exports, job({ ...target, version_id: versionId })] };
    return structuredClone(server);
  });
  vi.mocked(api.retryCockpitNasExport).mockImplementation(async (_meetingId, operation) => {
    server = { ...server, nas_exports: server.nas_exports.map((entry) => entry.id === operation.id
      ? { ...entry, status: "queued", revision: entry.revision + 1, can_retry: false } : entry) };
    return structuredClone(server);
  });
});

describe("minutes NAS publishing and recovery", () => {
  it("requires confirmation when the same destination changes write mode", () => {
    const onPublish = vi.fn();
    const view = render(shell(<CockpitMinutesPublishControl resourcesHref={resourcesHref} workflow={workflowSummary(server)} disabled={false} pending={false} onPublish={onPublish} />));
    server.nas_destination = { ...destination, write_mode: "create_only" };
    view.rerender(shell(<CockpitMinutesPublishControl resourcesHref={resourcesHref} workflow={workflowSummary(server)} disabled={false} pending={false} onPublish={onPublish} />));
    expect(screen.getByRole("button", { name: enCockpit.workflow.publish })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: enCockpit.nas.use_updated_destination }));
    expect(screen.getByText(enCockpit.nas.mode_create_only)).toBeVisible();
    expect(screen.getByText(enCockpit.nas.create_only_visibility)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: enCockpit.workflow.publish }));
    expect(onPublish).toHaveBeenCalledWith(server.nas_destination);
  });

  it("keeps verified copy actions visible while loading technical details and attempts only when requested", async () => {
    const id = "70000000-0000-4000-8000-000000000001", attempt = "80000000-0000-4000-8000-000000000001";
    const base = `${destination.directory}/已发布纪要/创建式副本`;
    server.nas_destination = { ...destination, write_mode: "create_only" };
    server.nas_exports = [job({ id, write_mode: "create_only", target_path: `${base}/minutes.md`, status: "succeeded", completed_at: "2026-10-10T00:00:00Z",
      size_bytes: 18, verified_attempt_id: attempt, verified_path: `${base}/${id}/${attempt}/minutes.md`, receipt_path: `${base}/${id}/${attempt}/.multica-complete.json`, receipt_hash: "a".repeat(64) })];
    const { client } = setupCopies();
    expect(await screen.findByRole("button", { name: "Open verified copy" })).toHaveAttribute("data-path", server.nas_exports[0]!.verified_path);
    expect(screen.getAllByText("Official minutes · version 1")).toHaveLength(1);
    expect(screen.queryByText(server.nas_exports[0]!.verified_path!)).toBeNull();
    expect(screen.queryByText(server.nas_exports[0]!.target_path)).toBeNull();
    expect(screen.queryByRole("button", { name: "Open completion record" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Export attempts" })).toBeNull();
    expect(screen.getByRole("button", { name: "Copy & verification details" })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", { name: "Copy verified path" }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(server.nas_exports[0]!.verified_path));
    fireEvent.click(screen.getByRole("button", { name: "Copy & verification details" }));
    expect(screen.getByRole("button", { name: "Open completion record" })).toHaveAttribute("data-path", server.nas_exports[0]!.receipt_path);
    expect(screen.getByText(server.nas_exports[0]!.verified_path!)).toBeVisible();
    expect(screen.getByText(server.nas_exports[0]!.target_path)).toBeVisible();
    expect(screen.queryByRole("button", { name: `${base}/minutes.md` })).toBeNull();
    expect(api.getCockpitNasExportAttempts).not.toHaveBeenCalled();
    vi.mocked(api.getCockpitNasExportAttempts).mockResolvedValue({ workspace_id: "ws-1", meeting_id: WORKFLOW_MEETING_ID, export_id: id, items: [], total: 0, next_cursor: null });
    fireEvent.click(screen.getByRole("button", { name: "Export attempts" }));
    await screen.findByText(enCockpit.nas.no_attempts);
    expect(api.getCockpitNasExportAttempts).toHaveBeenCalledWith("ws-1", WORKFLOW_MEETING_ID, id, { cursor: undefined, page_size: 25 }, expect.anything());
    server.nas_exports = [{ ...server.nas_exports[0]!, receipt_hash: null }];
    await act(async () => { await client.invalidateQueries({ queryKey: cockpitKeys.workflow("ws-1", WORKFLOW_MEETING_ID) }); });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Open verified copy" })).toBeNull());
    expect(screen.getByText(enCockpit.nas.incomplete)).toBeVisible();
  });

  it("reads attempts only when opened, pages by 25, and recovers a failed continuation", async () => {
    const id = "70000000-0000-4000-8000-000000000001";
    server.nas_destination = { ...destination, write_mode: "create_only" };
    server.nas_exports = [job({ id, write_mode: "create_only", status: "retry_wait", attempts: 27, last_error_code: "storage_unavailable" })];
    const rows = Array.from({ length: 27 }, (_, i) => ({ id: `80000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, attempt_number: i + 1, status: "failed",
      target_path: `/recorded/attempt-${i + 1}/minutes.md`, receipt_path: `/recorded/attempt-${i + 1}/.multica-complete.json`, content_hash: "a".repeat(64),
      verified_path: null, verified_receipt_path: null, verified_attempt_id: null, receipt_hash: null, size_bytes: null,
      last_error_code: "storage_unavailable", last_error: "Share unavailable", created_at: "2026-10-10T00:00:00Z", updated_at: "2026-10-10T00:00:00Z", verified_at: null }));
    let fail = true;
    vi.mocked(api.getCockpitNasExportAttempts).mockImplementation(async (_ws, _meeting, _export, query) => {
      if (query?.cursor && fail) throw new Error("Cursor expired");
      return { workspace_id: "ws-1", meeting_id: WORKFLOW_MEETING_ID, export_id: id, items: query?.cursor ? rows.slice(25) : rows.slice(0, 25), total: 27, next_cursor: query?.cursor ? null : "page-2" };
    });
    setupCopies();
    fireEvent.click(await screen.findByRole("button", { name: "Export attempts" }));
    const region = await screen.findByRole("region", { name: "Export attempts" });
    expect(await within(region).findByText("Attempt 25")).toBeVisible();
    expect(within(region).queryByText("Attempt 26")).toBeNull();
    expect(api.getCockpitNasExportAttempts).toHaveBeenLastCalledWith("ws-1", WORKFLOW_MEETING_ID, id, { cursor: undefined, page_size: 25 }, expect.anything());
    fireEvent.click(within(region).getByRole("button", { name: "Next page" }));
    fireEvent.click(await within(region).findByRole("button", { name: "Return to first page" }));
    expect(await within(region).findByText("Attempt 1")).toBeVisible();
    fail = false;
    await waitFor(() => expect(within(region).getByRole("button", { name: "Next page" })).toBeEnabled());
    fireEvent.click(within(region).getByRole("button", { name: "Next page" }));
    expect(await within(region).findByText("Attempt 27")).toBeVisible();
    expect(within(region).queryByText("Attempt 1")).toBeNull();
  });

  it("shows the configured-destination recovery message instead of the server's internal reason code", async () => {
    server = { ...server, nas_destination: null, nas_unavailable_reason: "not_configured" };
    setupCopies();
    expect(await screen.findByText(/No permitted NAS destination is configured/)).toBeVisible();
    expect(screen.queryByText("not_configured")).toBeNull();
    fireEvent.click(screen.getByText("Deployment administrator instructions"));
    expect(screen.getByText(/COCKPIT_NAS_EXPORT_ROOTS=\[/)).toBeVisible();
    expect(screen.getByText(/\.multica-root-id/)).toBeVisible();
    expect(screen.queryByRole("link", { name: "Configure meeting materials" })).toBeNull();
  });

  it.each(["directory_missing", "outside_root"])("provides a real material configuration link for %s without pretending deployment is configured", async (reason) => {
    server = { ...server, nas_destination: null, nas_unavailable_reason: reason };
    setupCopies();
    const link = await screen.findByRole("link", { name: "Configure meeting materials" });
    expect(link).toHaveAttribute("href", resourcesHref);
    expect(screen.queryByText(reason)).toBeNull();
    expect(api.exportCockpitMinutesToNas).not.toHaveBeenCalled();
  });

  it("keeps an unfamiliar destination reason visible beside the material entry point", async () => {
    server = { ...server, nas_destination: null, nas_unavailable_reason: "Future storage policy requires attention" };
    setupCopies();
    expect(await screen.findByText("Future storage policy requires attention")).toBeVisible();
    expect(screen.getByRole("link", { name: "Configure meeting materials" })).toHaveAttribute("href", resourcesHref);
  });

  it("exposes the frozen failed destination and full error while unsupported storage is awaiting an administrator", async () => {
    const original = job({ status: "needs_attention", can_retry: true, last_error_code: "unsupported_commit", last_error: "The network filesystem rejected the exclusive file commit." });
    server = { ...server, nas_destination: { ...destination, directory: "/Volumes/team/New destination" }, nas_exports: [original] };
    setupCopies();
    fireEvent.click(await screen.findByRole("button", { name: "View NAS history (1)" }));
    await screen.findByText("Needs attention");
    expect(screen.getByText(enCockpit.nas.unsupported_storage)).toBeVisible();
    expect(screen.getByRole("button", { name: "Open original export folder" })).toHaveAttribute("data-path", original.directory);
    expect(screen.queryByRole("button", { name: "Retry NAS export" })).toBeNull();
    expect(screen.getByRole("button", { name: "Retry after storage support is fixed" })).toBeVisible();
    fireEvent.click(screen.getByText("Full error details"));
    expect(screen.getByText(original.last_error)).toBeVisible();
    expect(screen.getByText("unsupported_commit")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Copy target path" }));
    expect(await screen.findByText("Target path copied.")).toBeVisible();
    expect(copyText).toHaveBeenCalledWith(original.target_path);
    expect(api.retryCockpitNasExport).not.toHaveBeenCalled();
    expect(api.exportCockpitMinutesToNas).not.toHaveBeenCalled();
  });

  it("keeps the full target available when clipboard access fails", async () => {
    vi.mocked(copyText).mockResolvedValue(false);
    server.nas_exports = [job({ status: "needs_attention", last_error_code: "permission_denied", last_error: "Permission denied" })];
    setupCopies();
    fireEvent.click(await screen.findByRole("button", { name: "Copy target path" }));
    expect(await screen.findByText(enCockpit.nas.copy_failed)).toBeVisible();
    expect(screen.getByText(job().target_path)).toBeVisible();
    expect(screen.getByText(enCockpit.nas.permission_recovery)).toBeVisible();
  });

  it("defaults sync on for a configured destination, while publishing without NAS remains explicit", () => {
    const onPublish = vi.fn();
    render(shell(<CockpitMinutesPublishControl resourcesHref={resourcesHref} workflow={workflowSummary(server)} disabled={false} pending={false} onPublish={onPublish} />));
    const checkbox = screen.getByRole("checkbox", { name: "Sync published minutes to NAS" });
    expect(checkbox).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Publish version" }));
    expect(onPublish).toHaveBeenLastCalledWith(destination);
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button", { name: "Publish version" }));
    expect(onPublish).toHaveBeenLastCalledWith(undefined);
  });

  it("allows unconfigured publication and does not auto-select a destination that appears later", () => {
    const onPublish = vi.fn();
    const first = { ...server, nas_destination: null, nas_unavailable_reason: "not_configured" };
    const view = render(shell(<CockpitMinutesPublishControl resourcesHref={resourcesHref} workflow={workflowSummary(first)} disabled={false} pending={false} onPublish={onPublish} />));
    expect(screen.getByText(/No permitted NAS destination is configured/)).toBeVisible();
    expect(screen.queryByText("not_configured")).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Sync published minutes to NAS" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Publish version" })).toBeEnabled();
    view.rerender(shell(<CockpitMinutesPublishControl resourcesHref={resourcesHref} workflow={workflowSummary(server)} disabled={false} pending={false} onPublish={onPublish} />));
    expect(screen.getByRole("checkbox", { name: "Sync published minutes to NAS" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Publish version" }));
    expect(onPublish).toHaveBeenCalledWith(undefined);
  });

  it("does not silently redirect an already selected publication target", () => {
    const onPublish = vi.fn();
    const view = render(shell(<CockpitMinutesPublishControl resourcesHref={resourcesHref} workflow={workflowSummary(server)} disabled={false} pending={false} onPublish={onPublish} />));
    const changed = { ...server, nas_destination: { ...destination, directory: "/Volumes/team/Changed" } };
    view.rerender(shell(<CockpitMinutesPublishControl resourcesHref={resourcesHref} workflow={workflowSummary(changed)} disabled={false} pending={false} onPublish={onPublish} />));
    expect(screen.getByRole("alert")).toHaveTextContent("The NAS destination changed");
    expect(screen.getByRole("button", { name: "Publish version" })).toBeDisabled();
    expect(screen.getByText(destination.directory)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use updated destination" }));
    fireEvent.click(screen.getByRole("button", { name: "Publish version" }));
    expect(onPublish).toHaveBeenCalledWith(changed.nas_destination);
  });

  it("exports the official minutes while a newer candidate is pending and shows queued rather than file success", async () => {
    server = { ...server, current_version_id: "version-2", versions: [...server.versions, versionFixture({ id: "version-2", version_number: 2 })] };
    setupCopies();
    expect(await screen.findByText("Official minutes · version 1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Export published minutes to NAS" }));
    await screen.findByText("Queued for NAS");
    expect(api.exportCockpitMinutesToNas).toHaveBeenCalledWith(WORKFLOW_MEETING_ID, "version-1", destination);
    expect(screen.queryByRole("button", { name: job().target_path })).toBeNull();
    expect(screen.queryByText("Exported to NAS")).toBeNull();
    expect(screen.queryByRole("button", { name: "Export published minutes to NAS" })).toBeNull();
  });

  it("retries a failed frozen location after the meeting directory changes, without changing the operation", async () => {
    const original = job({ status: "retry_wait", revision: 3, can_retry: true, last_error_code: "root_unavailable", last_error: "NAS share offline" });
    server = { ...server, nas_destination: { ...destination, directory: "/Volumes/team/New destination" }, nas_exports: [original] };
    vi.mocked(api.retryCockpitNasExport).mockRejectedValueOnce(new Error("Connection lost"));
    setupCopies();
    fireEvent.click(await screen.findByRole("button", { name: "View NAS history (1)" }));
    await screen.findByText("Waiting to retry");
    expect(screen.getByText(original.target_path)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Export published minutes to NAS" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry NAS export" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Connection lost");
    fireEvent.click(screen.getByRole("button", { name: "Retry NAS export" }));
    await screen.findByText("Queued for NAS");
    expect(vi.mocked(api.retryCockpitNasExport).mock.calls[0]?.[1]).toMatchObject(original);
    expect(vi.mocked(api.retryCockpitNasExport).mock.calls[1]?.[1]).toMatchObject(original);
    expect(api.exportCockpitMinutesToNas).not.toHaveBeenCalled();
  });

  it("keeps publication intact across failed exports and exposes the exact verified success path only after completion", async () => {
    server.nas_exports = [job({ status: "needs_attention", can_retry: true, last_error: "Existing file has different content" })];
    const { client } = setupCopies();
    await screen.findByText("Needs attention");
    expect(screen.getByText("Official minutes · version 1")).toBeTruthy();
    expect(screen.getByText(/Existing file has different content/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: job().target_path })).toBeNull();
    server = { ...server, nas_exports: [job({ status: "succeeded", revision: 5, size_bytes: 42, completed_at: "2026-10-09T12:10:00Z" })] };
    await act(async () => { client.setQueryData(cockpitKeys.workflow("ws-1", WORKFLOW_MEETING_ID), workflowSummary(server)); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Open NAS copy" })).toHaveAttribute("data-path", job().target_path));
    expect(screen.queryByText(job().target_path)).toBeNull();
    expect(screen.getByText("Exported to NAS")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry NAS export" })).toBeNull();
  });

  it("reveals the actual verified path for manual copy if the compact success action cannot access the clipboard", async () => {
    vi.mocked(copyText).mockResolvedValue(false);
    server.nas_exports = [job({ status: "succeeded", size_bytes: 42, completed_at: "2026-10-09T12:10:00Z" })];
    setupCopies();
    fireEvent.click(await screen.findByRole("button", { name: "Copy target path" }));
    expect(await screen.findByText(enCockpit.nas.copy_failed)).toBeVisible();
    expect(screen.getByText(job().target_path)).toBeVisible();
    expect(screen.getByRole("button", { name: "Copy & verification details" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Open NAS copy" })).toHaveAttribute("data-path", job().target_path);
    expect(api.exportCockpitMinutesToNas).not.toHaveBeenCalled();
  });

  it("keeps unknown operation states visible and read-only even when an unfamiliar server sets can_retry", async () => {
    server.nas_exports = [job({ status: "future-state", can_retry: true })];
    setupCopies();
    const region = await screen.findByRole("region", { name: "NAS copies" });
    expect(within(region).getByText("Unrecognized NAS status: future-state")).toBeTruthy();
    expect(within(region).queryByRole("button", { name: "Retry NAS export" })).toBeNull();
    expect(within(region).queryByRole("button", { name: "Export published minutes to NAS" })).toBeNull();
  });

  it("withholds mutations in a read-only meeting while preserving its reported file state", async () => {
    server.nas_exports = [job({ status: "retry_wait", can_retry: true })];
    setupCopies(true);
    await screen.findByText("Waiting to retry");
    expect(screen.queryByRole("button", { name: "Retry NAS export" })).toBeNull();
  });

  // The unpublish copy is not yet in the shared locale file; i18next echoes the key.
  const unpublishKeys = { trigger: enCockpit.workflow.unpublish, reason: enCockpit.workflow.unpublish_reason, confirm: enCockpit.workflow.unpublish_confirm };

  it("withdraws the official minutes with a trimmed required reason and confirms through the workflow state", async () => {
    setupCopies();
    fireEvent.click(await screen.findByRole("button", { name: unpublishKeys.trigger }));
    const field = await screen.findByLabelText(unpublishKeys.reason);
    expect(screen.getByRole("button", { name: unpublishKeys.confirm })).toBeDisabled();
    fireEvent.change(field, { target: { value: "  Superseded by a corrected circulation.  " } });
    const revision = server.revision;
    fireEvent.click(screen.getByRole("button", { name: unpublishKeys.confirm }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.commandCockpitMeetingWorkflow).toHaveBeenCalledWith("ws-1", WORKFLOW_MEETING_ID,
      { action: "unpublished", version_id: "version-1", body: { expected_revision: revision, reason: "Superseded by a corrected circulation." } });
    // The official pointer is gone and no NAS export history keeps the section.
    await waitFor(() => expect(screen.queryByRole("region", { name: enCockpit.nas.title })).toBeNull());
    expect(api.exportCockpitMinutesToNas).not.toHaveBeenCalled();
  });

  it("keeps the reason and the error visible when the withdrawal is not acknowledged", async () => {
    const { client } = setupCopies();
    vi.mocked(api.commandCockpitMeetingWorkflow).mockRejectedValueOnce(new Error("Meeting workflow changed; refresh and retry"));
    fireEvent.click(await screen.findByRole("button", { name: unpublishKeys.trigger }));
    fireEvent.change(await screen.findByLabelText(unpublishKeys.reason), { target: { value: "Retry me" } });
    fireEvent.click(screen.getByRole("button", { name: unpublishKeys.confirm }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Meeting workflow changed; refresh and retry");
    expect(screen.getByRole("button", { name: unpublishKeys.confirm })).toBeEnabled();
    // The workflow reload keeps the official version; the dialog stays usable.
    await act(async () => { await client.invalidateQueries({ queryKey: cockpitKeys.workflow("ws-1", WORKFLOW_MEETING_ID) }); });
    expect(await screen.findByText("Official minutes · version 1")).toBeVisible();
    expect(api.commandCockpitMeetingWorkflow).toHaveBeenCalledTimes(1);
  });

  it("hides the withdrawal control in read-only meetings and from non-managers", async () => {
    setupCopies(true);
    await screen.findByRole("region", { name: enCockpit.nas.title });
    expect(screen.queryByRole("button", { name: unpublishKeys.trigger })).toBeNull();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Managerless() {
      const query = useQuery(cockpitMeetingWorkflowOptions("ws-1", WORKFLOW_MEETING_ID));
      return query.data ? <CockpitMinutesNasCopies resourcesHref={resourcesHref} wsId="ws-1" workflow={query.data} userId="reviewer-1"
        disabled={false} onReload={() => void query.refetch()} onOpenHistory={vi.fn()} /> : null;
    }
    server = { ...server, can_manage: false };
    render(<QueryClientProvider client={client}>{shell(<Managerless />)}</QueryClientProvider>);
    await screen.findAllByRole("region", { name: enCockpit.nas.title });
    expect(screen.queryByRole("button", { name: unpublishKeys.trigger })).toBeNull();
  });
});
