import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "@multica/core/api";
import { CockpitBoardSchema } from "@multica/core/api/schemas";
import { I18nProvider } from "@multica/core/i18n/react";
import { useCockpitArtifactCommandStore } from "@multica/core/cockpit";
import type { CockpitArtifactReference } from "@multica/core/types";
import { CockpitArtifactReferences } from "./cockpit-artifact-references";
import { CockpitMeetingAddArtifact } from "./cockpit-meeting-add-artifact";
import { CockpitMeetingArtifactReferences } from "./cockpit-meeting-artifact-references";
import { artifactFixture, artifactVersionDetailFixture, artifactVersionFixture } from "./artifact-test-fixtures";
import { cockpitMeetingDetailFixture } from "./cockpit-read-test-fixture";
import enCockpit from "../../locales/en/cockpit.json";

const navigation = vi.hoisted(() => ({ pathname: "/ws/cockpit", searchParams: new URLSearchParams("artifact=artifact-1"), push: vi.fn() }));
vi.mock("../../navigation", () => ({ useNavigation: () => navigation, AppLink: ({ children, href, ...props }: React.ComponentProps<"a">) => <a href={href} {...props}>{children}</a> }));
vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ cockpit: () => "/ws/cockpit" }) }));
vi.mock("./cockpit-meeting-picker", () => ({ CockpitMeetingPicker: ({ onSelect, label, disabled }: { onSelect: (id: string) => Promise<unknown>; label: string; disabled: boolean }) => <button disabled={disabled} onClick={() => void onSelect("meeting-1")}>{label}</button> }));
vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: {
  getCockpitArtifacts: vi.fn(), getCockpitArtifact: vi.fn(),
  getCockpitArtifactReferences: vi.fn(), getCockpitArtifactVersions: vi.fn(), getCockpitArtifactVersion: vi.fn(), getCockpitMeetingDetail: vi.fn(),
  createCockpitArtifactReference: vi.fn(), removeCockpitArtifactReference: vi.fn(), getCockpitMeetingArtifactReferences: vi.fn(),
} }));
const ref: CockpitArtifactReference = { id: "ref-1", artifact_id: "artifact-1", version_id: "version-1", version_number: 1, content_hash: "a".repeat(64), reference_key: "10000000-0000-4000-8000-000000000001", meeting_id: "meeting-1", target_label: "Planning review", purpose: "reference", created_by: "author-1", created_at: "2026-10-11T01:00:00Z", removed_by: null, removed_at: null };
const artifact = artifactFixture({ current_version: artifactVersionFixture({ id: "version-2", version_number: 2 }), approved_version: artifactVersionFixture({ decision: "approved" }) });
function setup(children: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}>{children}</I18nProvider></QueryClientProvider>);
}
beforeEach(() => {
  vi.clearAllMocks(); useCockpitArtifactCommandStore.getState().clearDraft();
  vi.mocked(api.getCockpitArtifactReferences).mockResolvedValue({ workspace_id: "ws-1", artifact_id: "artifact-1", items: [], total: 0, next_cursor: null });
  vi.mocked(api.getCockpitArtifactVersions).mockResolvedValue({ workspace_id: "ws-1", artifact_id: "artifact-1", artifact_revision: 2, items: [artifactVersionFixture({ decision: "approved" }), artifact.current_version!], total: 2, next_cursor: null });
  vi.mocked(api.getCockpitArtifactVersion).mockResolvedValue(artifactVersionDetailFixture());
  vi.mocked(api.getCockpitMeetingDetail).mockResolvedValue(cockpitMeetingDetailFixture(CockpitBoardSchema.parse({ cockpit: { id: "board-1" }, meetings: [{ id: "meeting-1", title: "Planning review" }] }), "meeting-1"));
});

describe("fixed artifact references", () => {
  it("selects a bounded artifact source from meeting resources and fixes the current meeting target before explicit reference confirmation", async () => {
    vi.mocked(api.getCockpitArtifacts).mockResolvedValue({ workspace_id: "ws-1", scope: { project_id: null, module_id: null, node_id: null, source_issue_id: null, ids: [], q: "", status: "", relation: "owned" }, items: [artifact], total: 1, filtered_total: 1, next_cursor: null, can_create: true });
    vi.mocked(api.getCockpitArtifact).mockResolvedValue(artifact);
    vi.mocked(api.createCockpitArtifactReference).mockImplementationOnce(async (_ws, _artifact, _kind, body) => ({ workspace_id: "ws-1", reference: { ...ref, reference_key: body.reference_key } }));
    setup(<CockpitMeetingAddArtifact wsId="ws-1" meetingId="meeting-1" />); expect(api.getCockpitArtifacts).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Add a fixed artifact" }));
    expect(screen.getByRole("link", { name: "Open artifact workspace (new tab)" })).toHaveAttribute("href", "/ws/cockpit?tab=artifacts");
    expect(screen.getByRole("link", { name: "Open artifact workspace (new tab)" })).toHaveAttribute("target", "_blank");
    fireEvent.click(await screen.findByRole("button", { name: artifact.title }));
    expect(await screen.findByRole("link", { name: `${artifact.title} (new tab)` })).toHaveAttribute("href", "/ws/cockpit?tab=artifacts&artifact=artifact-1");
    fireEvent.click(await screen.findByRole("button", { name: "Reference a version from a meeting" }));
    expect(await screen.findByText("Planning review")).toBeVisible(); expect(screen.queryByRole("button", { name: "Choose source meeting" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Choose fixed version" })); fireEvent.click(await screen.findByRole("button", { name: "Version 1" }));
    fireEvent.click(screen.getByRole("checkbox", { name: enCockpit.artifact_runtime.confirm_reference }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Create reference" })).toBeEnabled()); fireEvent.click(screen.getByRole("button", { name: "Create reference" }));
    await waitFor(() => expect(api.createCockpitArtifactReference).toHaveBeenCalledWith("ws-1", "artifact-1", "meeting", expect.objectContaining({ meeting_id: "meeting-1", version_id: "version-1" })));
    expect(vi.mocked(api.getCockpitArtifacts).mock.calls[0]?.[1]).toMatchObject({ page_size: 25 }); await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps the chosen version and original intent after throttling instead of replacing it with the current version", async () => {
    setup(<CockpitArtifactReferences wsId="ws-1" artifact={artifact} scope={{ projectId: "project-1", moduleId: "module-1" }} disabled={false} />);
    expect(api.getCockpitArtifactReferences).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Fixed version references" }));
    fireEvent.click(screen.getByRole("button", { name: "Meeting references" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reference a version from a meeting" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose fixed version" }));
    fireEvent.click(await screen.findByRole("button", { name: "Version 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose source meeting" }));
    fireEvent.click(screen.getByRole("checkbox", { name: enCockpit.artifact_runtime.confirm_reference }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Create reference" })).toBeEnabled());
    vi.mocked(api.createCockpitArtifactReference).mockRejectedValueOnce(new ApiError("Throttled", 429, "Too Many Requests"));
    fireEvent.click(screen.getByRole("button", { name: "Create reference" }));
    const retry = await screen.findByRole("button", { name: "Retry original command" }); await waitFor(() => expect(retry).toBeEnabled());
    const body = vi.mocked(api.createCockpitArtifactReference).mock.calls[0]![3];
    expect(body).toMatchObject({ version_id: "version-1", meeting_id: "meeting-1", purpose: "reference" });
    vi.mocked(api.createCockpitArtifactReference).mockResolvedValueOnce({ workspace_id: "ws-1", reference: { ...ref, reference_key: body.reference_key } });
    fireEvent.click(retry); await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(vi.mocked(api.createCockpitArtifactReference).mock.calls[1]![3]).toEqual(body);
    expect(useCockpitArtifactCommandStore.getState().draft.pending).toEqual({});
  });

  it("reads meeting references lazily in pages and links the recorded historical version without replacing it", async () => {
    const items = Array.from({ length: 26 }, (_, index) => ({ ...ref, id: `ref-${index}`, artifact_title: `Report ${index + 1}`, version_decision: "pending", removed_at: index === 25 ? "2026-10-11T02:00:00Z" : null }));
    vi.mocked(api.getCockpitMeetingArtifactReferences).mockImplementation(async (_ws, _meeting, query = {}) => ({ workspace_id: "ws-1", meeting_id: "meeting-1", include_removed: query.include_removed === true,
      items: query.cursor ? items.slice(25) : items.slice(0, 25), total: 26, next_cursor: query.cursor ? null : "page-2" }));
    setup(<CockpitMeetingArtifactReferences wsId="ws-1" meetingId="meeting-1" />); expect(api.getCockpitMeetingArtifactReferences).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Fixed artifact versions" }));
    const first = await screen.findByRole("link", { name: /Report 1 · Version 1/ }); expect(first).toHaveAttribute("href", expect.stringContaining("version=version-1")); expect(first).toHaveAttribute("target", "_blank");
    expect(screen.queryByText("Report 26")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Include removed references" }));
    await waitFor(() => expect(api.getCockpitMeetingArtifactReferences).toHaveBeenLastCalledWith("ws-1", "meeting-1", { include_removed: true, cursor: undefined, page_size: 25 }, expect.anything()));
    const nextPage = await screen.findByRole("button", { name: "Next page" });
    await waitFor(() => expect(nextPage).toBeEnabled()); fireEvent.click(nextPage);
    expect(await screen.findByText(enCockpit.artifact_runtime.reference_removed)).toBeVisible();
    expect(screen.getByRole("link", { name: /Report 26/ })).toHaveAttribute("href", expect.stringContaining("version=version-1"));
    expect(api.getCockpitArtifactVersion).not.toHaveBeenCalled(); expect(api.removeCockpitArtifactReference).not.toHaveBeenCalled();
  });
});
