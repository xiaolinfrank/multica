import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { api } from "@multica/core/api";
import { cockpitKeys, cockpitMeetingWorkflowOptions } from "@multica/core/cockpit";
import type { CockpitMeetingWorkflow, CockpitNasExport } from "@multica/core/types";
import { workflowFixture, versionFixture, WORKFLOW_MEETING_ID } from "./workflow-test-fixtures";
import enCockpit from "../../locales/en/cockpit.json";
import { CockpitMinutesNasCopies, CockpitMinutesPublishControl } from "./cockpit-minutes-nas";

vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: {
  getCockpitMeetingWorkflow: vi.fn(), exportCockpitMinutesToNas: vi.fn(), retryCockpitNasExport: vi.fn(),
} }));
vi.mock("../../common/local-path-link", () => ({ LocalPathLink: ({ path }: { path: string }) => <button type="button">{path}</button> }));

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
    return query.data ? <CockpitMinutesNasCopies wsId="ws-1" workflow={query.data} userId="reviewer-1" readOnly={readOnly}
      disabled={false} onReload={() => void query.refetch()} /> : null;
  }
  return { ...render(<QueryClientProvider client={client}>{shell(<Harness />)}</QueryClientProvider>), client };
}

beforeEach(() => {
  vi.clearAllMocks();
  server = published();
  vi.mocked(api.getCockpitMeetingWorkflow).mockImplementation(async () => structuredClone(server));
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
  it("defaults sync on for a configured destination, while publishing without NAS remains explicit", () => {
    const onPublish = vi.fn();
    render(shell(<CockpitMinutesPublishControl workflow={server} disabled={false} pending={false} onPublish={onPublish} />));
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
    const first = { ...server, nas_destination: null };
    const view = render(shell(<CockpitMinutesPublishControl workflow={first} disabled={false} pending={false} onPublish={onPublish} />));
    expect(screen.getByRole("checkbox", { name: "Sync published minutes to NAS" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Publish version" })).toBeEnabled();
    view.rerender(shell(<CockpitMinutesPublishControl workflow={server} disabled={false} pending={false} onPublish={onPublish} />));
    expect(screen.getByRole("checkbox", { name: "Sync published minutes to NAS" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Publish version" }));
    expect(onPublish).toHaveBeenCalledWith(undefined);
  });

  it("does not silently redirect an already selected publication target", () => {
    const onPublish = vi.fn();
    const view = render(shell(<CockpitMinutesPublishControl workflow={server} disabled={false} pending={false} onPublish={onPublish} />));
    const changed = { ...server, nas_destination: { ...destination, directory: "/Volumes/team/Changed" } };
    view.rerender(shell(<CockpitMinutesPublishControl workflow={changed} disabled={false} pending={false} onPublish={onPublish} />));
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
    await screen.findByText("Waiting to retry");
    expect(screen.getByText(original.target_path)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Export published minutes to NAS" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry NAS export" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Connection lost");
    fireEvent.click(screen.getByRole("button", { name: "Retry NAS export" }));
    await screen.findByText("Queued for NAS");
    expect(vi.mocked(api.retryCockpitNasExport).mock.calls[0]?.[1]).toEqual(original);
    expect(vi.mocked(api.retryCockpitNasExport).mock.calls[1]?.[1]).toEqual(original);
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
    await act(async () => { client.setQueryData(cockpitKeys.workflow("ws-1", WORKFLOW_MEETING_ID), server); });
    await waitFor(() => expect(screen.getByRole("button", { name: job().target_path })).toBeTruthy());
    expect(screen.getByText("Exported to NAS")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry NAS export" })).toBeNull();
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
});
