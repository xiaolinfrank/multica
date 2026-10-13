import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { api } from "@multica/core/api";
import { cockpitLifecycleKeys, useCockpitScopeViewStore, useCockpitMeetingAgendaDraftStore } from "@multica/core/cockpit";
import { CockpitMeetingAgenda } from "./cockpit-meeting-agenda";
import { agendaFixture, agendaMetadataFixture, lifecycleFixture, lifecycleResultFixture } from "./meeting-lifecycle-test-fixtures";
import type { CockpitAgendaDetail } from "@multica/core/types";
import enCockpit from "../../locales/en/cockpit.json";
import enIssues from "../../locales/en/issues.json";

const navigation = vi.hoisted(() => ({ pathname: "/ws/cockpit", searchParams: new URLSearchParams("meeting=meeting-1&meeting_view=agenda&project=project-1"), push: vi.fn() }));
vi.mock("../../navigation", () => ({ useNavigation: () => navigation, AppLink: ({ children, href, newTabTitle: _newTabTitle, ...props }: React.ComponentProps<"a"> & { newTabTitle?: string }) => <a href={href} {...props}>{children}</a> }));
vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ cockpit: () => "/ws/cockpit", issueDetail: (id: string) => `/ws/issues/${id}` }) }));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("../../issues/utils/status-label", () => ({ useStatusLabel: () => (status: string) => status }));
vi.mock("./cockpit-reviewer-select", () => ({ CockpitReviewerSelect: () => null }));
vi.mock("./cockpit-node-issue-picker", () => ({ CockpitNodeIssuePicker: () => null, useCockpitSelectedNodeIssueOption: () => ({ option: null, isPending: false, isFetching: false, isError: false, refetch: vi.fn() }) }));
vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: {
  getCockpitLifecycleCommand: vi.fn(), getCockpitMeetingLifecycle: vi.fn(), getCockpitMeetingAgenda: vi.fn(), getCockpitAgendaDetail: vi.fn(), getCockpitAgendaReferences: vi.fn(),
  updateCockpitAgenda: vi.fn(), createCockpitAgenda: vi.fn(), createCockpitPreparationIssue: vi.fn(), confirmCockpitMaterials: vi.fn(),
  searchCockpitScopeMembers: vi.fn(), getCockpitMeetingArtifactReferences: vi.fn(), getCockpitArtifactVersion: vi.fn(), attachCockpitAgendaReference: vi.fn(),
} }));
let current: CockpitAgendaDetail;
const makeClient = () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
function shell(cache: QueryClient) { return <QueryClientProvider client={cache}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit, issues: enIssues } }}><CockpitMeetingAgenda wsId="ws-1" meetingId="meeting-1" /></I18nProvider></QueryClientProvider>; }
beforeEach(() => {
  vi.clearAllMocks(); useCockpitScopeViewStore.getState().reset(); useCockpitMeetingAgendaDraftStore.getState().clearDraft(); navigation.searchParams = new URLSearchParams("meeting=meeting-1&meeting_view=agenda&project=project-1"); current = agendaFixture();
  vi.mocked(api.getCockpitMeetingLifecycle).mockResolvedValue(lifecycleFixture({ agenda_total: 26 }));
  vi.mocked(api.getCockpitMeetingAgenda).mockImplementation(async (_ws, _meeting, query = {}) => ({ workspace_id: "ws-1", meeting_id: "meeting-1", agenda_revision: 1, q: query.q ?? "", include_removed: query.include_removed ?? false, page_size: query.page_size ?? 25,
    items: query.cursor ? [agendaMetadataFixture(agendaFixture({ id: "agenda-26", title: "Final agenda item" }))] : Array.from({ length: 25 }, (_, i) => agendaMetadataFixture(agendaFixture({ id: `agenda-${i + 1}`, title: `Agenda item ${i + 1}` }))), total: 26, next_cursor: query.cursor ? null : "page-two" }));
  vi.mocked(api.getCockpitAgendaDetail).mockImplementation(async () => structuredClone(current));
  vi.mocked(api.getCockpitAgendaReferences).mockResolvedValue({ workspace_id: "ws-1", meeting_id: "meeting-1", agenda_id: "agenda-1", agenda_revision: 1, include_removed: false, page_size: 25, items: [], total: 0, next_cursor: null });
  vi.mocked(api.getCockpitMeetingArtifactReferences).mockResolvedValue({ workspace_id: "ws-1", meeting_id: "meeting-1", include_removed: false, items: [], total: 0, next_cursor: null });
  vi.mocked(api.updateCockpitAgenda).mockImplementation(async (_ws, _meeting, _agenda, body) => {
    current = { ...current, title: body.title ?? current.title, notes: body.notes ?? current.notes, revision: current.revision + 1 };
    return lifecycleResultFixture(lifecycleFixture({ agenda_revision: 2 }), body.command_key, "agenda_update", { agenda_id: current.id, agenda: current });
  });
});

describe("bounded meeting agenda workbench", () => {
  it("opens the exact newly created agenda after a lost write response is confirmed through the read-only receipt", async () => {
    vi.mocked(api.createCockpitAgenda).mockRejectedValueOnce(new Error("Creation response lost")); render(shell(makeClient()));
    fireEvent.click(await screen.findByRole("button", { name: "Add agenda item" })); const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByRole("textbox", { name: "Agenda title" }), { target: { value: "Recover one agenda only" } }); fireEvent.click(dialog.getByRole("button", { name: "Save agenda item" }));
    await screen.findByText("Creation response lost"); const body = vi.mocked(api.createCockpitAgenda).mock.calls[0]![2];
    const created = agendaFixture({ id: "new-agenda", title: body.title!, purposes: body.purposes!, desired_outcome: "", notes: "" });
    const receipt = lifecycleResultFixture(lifecycleFixture({ agenda_revision: 2 }), body.command_key, "agenda_create", { agenda_id: created.id, agenda: created }).receipt;
    vi.mocked(api.getCockpitLifecycleCommand).mockResolvedValueOnce({ workspace_id: "ws-1", meeting_id: "meeting-1", command_key: body.command_key, action: "agenda_create", actor_id: "user-1", actor_name: "Member", created_at: "2026-10-11T01:00:00Z", revision: 2, agenda_id: created.id, reference_id: null, issue_id: null, receipt });
    fireEvent.click(dialog.getByRole("button", { name: "Check the previous request" })); await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(navigation.push).toHaveBeenCalledWith(expect.stringContaining("agenda=new-agenda")); expect(api.createCockpitAgenda).toHaveBeenCalledTimes(1);
  });

  it("shows a fixed material's pending decision without probing every version or implying approval", async () => {
    navigation.searchParams.set("agenda", "agenda-1");
    vi.mocked(api.getCockpitAgendaReferences).mockResolvedValue({ workspace_id: "ws-1", meeting_id: "meeting-1", agenda_id: "agenda-1", agenda_revision: 1, include_removed: false, page_size: 25, total: 1, next_cursor: null,
      items: [{ id: "ref-1", workspace_id: "ws-1", meeting_id: "meeting-1", agenda_id: "agenda-1", kind: "artifact_reference", target_id: "meeting-reference-1", purpose: "material", available: true, label: "Fixed discussion input", issue: null, artifact_id: "artifact-1", version_id: "version-1", version_number: 1, content_hash: "a".repeat(64), version_decision: "pending", created_at: "2026-10-11T01:00:00Z", removed_at: null, can_remove: true }] });
    render(shell(makeClient())); const region = within(await screen.findByRole("region", { name: "Preparation & materials" }));
    expect(await region.findByText("Pending review")).toBeVisible(); expect(region.queryByText("Approved")).toBeNull();
    expect(region.getByRole("link", { name: /Fixed discussion input/ })).toHaveAttribute("href", expect.stringContaining("artifact_version=version-1")); expect(api.getCockpitArtifactVersion).not.toHaveBeenCalled();
  });

  it("reads metadata in pages of 25, never loads all topic bodies, and keeps filters in exact topic links", async () => {
    const cache = makeClient(); const view = render(shell(cache)); await screen.findByRole("link", { name: "Open agenda: Agenda item 25" });
    expect(api.getCockpitAgendaDetail).not.toHaveBeenCalled(); expect(api.getCockpitAgendaReferences).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Open agenda: Agenda item 1" })).toHaveAttribute("href", expect.stringContaining("agenda=agenda-1"));
    expect(screen.getByRole("link", { name: "Open agenda: Agenda item 1" })).toHaveAttribute("href", expect.stringContaining("project=project-1"));
    fireEvent.click(screen.getByRole("button", { name: "Next page" })); await screen.findByRole("link", { name: "Open agenda: Final agenda item" });
    expect(vi.mocked(api.getCockpitMeetingAgenda).mock.calls.at(-1)?.[2]).toMatchObject({ cursor: "page-two", page_size: 25 }); expect(api.getCockpitAgendaDetail).not.toHaveBeenCalled();
    view.unmount(); render(shell(cache)); expect(await screen.findByRole("link", { name: "Open agenda: Final agenda item" })).toBeVisible(); expect(screen.queryByRole("link", { name: "Open agenda: Agenda item 1" })).toBeNull();
  });
  it("preserves exact discussion text after a concurrent edit and requires explicit review before a new revision can be submitted", async () => {
    navigation.searchParams.set("agenda", "agenda-1"); const cache = makeClient(); render(shell(cache));
    fireEvent.change(await screen.findByRole("textbox", { name: "Discussion notes" }), { target: { value: "  My unsaved notes\n" } });
    current = { ...current, revision: 2, notes: "Colleague's newer facts" };
    await act(async () => { cache.setQueryData(cockpitLifecycleKeys.agenda("ws-1", "meeting-1", "agenda-1"), structuredClone(current)); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Save agenda item" })).toBeDisabled());
    expect(screen.getByRole("textbox", { name: "Discussion notes" })).toHaveValue("  My unsaved notes\n");
    fireEvent.click(screen.getByText("Reload latest record", { selector: "summary" })); expect(screen.getByText("Colleague's newer facts")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Use latest revision, keep my draft" })); fireEvent.click(screen.getByRole("button", { name: "Save agenda item" }));
    await waitFor(() => expect(api.updateCockpitAgenda).toHaveBeenCalled()); expect(vi.mocked(api.updateCockpitAgenda).mock.calls[0]![3]).toMatchObject({ expected_revision: 2, notes: "  My unsaved notes\n" });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Discussion notes" })).toHaveValue("  My unsaved notes\n"));
  });
  it("retains the first-page recovery after an expired cursor without erasing the selected topic's draft", async () => {
    const cache = makeClient(); const view = render(shell(cache)); await screen.findByRole("link", { name: "Open agenda: Agenda item 25" });
    vi.mocked(api.getCockpitMeetingAgenda).mockRejectedValueOnce(new Error("Agenda changed")); fireEvent.click(screen.getByRole("button", { name: "Next page" })); await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Refresh agenda from the first page" })); await screen.findByRole("link", { name: "Open agenda: Agenda item 1" });
    navigation.searchParams.set("agenda", "agenda-1"); view.rerender(shell(cache)); fireEvent.change(await screen.findByRole("textbox", { name: "Discussion notes" }), { target: { value: "Keep while opening materials" } });
    view.unmount(); render(shell(cache)); expect(await screen.findByRole("textbox", { name: "Discussion notes" })).toHaveValue("Keep while opening materials");
  });
  it("creates an unassigned preparation issue only on confirmation and preserves the original key after reopening", async () => {
    navigation.searchParams.set("agenda", "agenda-1"); vi.mocked(api.createCockpitPreparationIssue).mockRejectedValueOnce(new Error("Unknown response")); const cache = makeClient(); const first = render(shell(cache));
    await screen.findByRole("textbox", { name: "Discussion notes" }); fireEvent.click(screen.getByRole("button", { name: "Create preparation issue" }));
    let form = within(screen.getByRole("dialog")); fireEvent.change(form.getByRole("textbox", { name: enCockpit.task_flow.title }), { target: { value: "Prepare the boundary evidence" } });
    fireEvent.change(form.getByRole("textbox", { name: enCockpit.task_flow.description }), { target: { value: "Keep this preparation description" } }); expect(api.createCockpitPreparationIssue).not.toHaveBeenCalled();
    fireEvent.click(form.getByRole("button", { name: "Cancel" })); fireEvent.click(screen.getByRole("button", { name: "Create preparation issue" })); form = within(screen.getByRole("dialog"));
    expect(form.getByRole("textbox", { name: enCockpit.task_flow.description })).toHaveValue("Keep this preparation description");
    fireEvent.click(form.getByRole("button", { name: "Create preparation issue" })); await screen.findByText("Unknown response"); const body = vi.mocked(api.createCockpitPreparationIssue).mock.calls[0]![3];
    expect(body).toMatchObject({ primary_node_id: null, new_issue: { title: "Prepare the boundary evidence", assignee_type: null, assignee_id: null, project_id: null, module_id: null } });
    first.unmount(); current = { ...current, revision: 7, can_edit: false, node_id: "new-node", node_code: "03", node_title: "New execution binding" }; cache.setQueryData(cockpitLifecycleKeys.agenda("ws-1", "meeting-1", "agenda-1"), current);
    vi.mocked(api.createCockpitPreparationIssue).mockRejectedValueOnce(new Error("Still unconfirmed")); render(shell(cache)); await screen.findByRole("textbox", { name: "Discussion notes" });
    fireEvent.click(screen.getByRole("button", { name: "Create preparation issue" })); const retry = within(screen.getByRole("dialog")); expect(retry.getByRole("textbox", { name: enCockpit.task_flow.title })).toHaveValue(body.new_issue.title); expect(retry.queryByText("New execution binding")).toBeNull(); expect(retry.getByRole("button", { name: "Project" })).toBeVisible(); fireEvent.click(retry.getByRole("button", { name: "Retry the same request" }));
    await screen.findByText("Still unconfirmed"); expect(vi.mocked(api.createCockpitPreparationIssue).mock.calls[1]![3]).toEqual(body); expect(api.confirmCockpitMaterials).not.toHaveBeenCalled();
  });
  it("keeps unknown agenda purposes read-only even if a newer backend grants edit capability", async () => {
    current = { ...current, purposes: ["future-purpose"], can_edit: true }; navigation.searchParams.set("agenda", "agenda-1"); render(shell(makeClient()));
    expect(await screen.findByRole("textbox", { name: "Discussion notes" })).toBeDisabled(); expect(screen.getByRole("button", { name: "Save agenda item" })).toBeDisabled(); expect(screen.getByText("Unrecognized purpose: future-purpose")).toBeVisible();
  });

  it("keeps the topic list beside the current topic on the recording workbench without its preparation machinery", async () => {
    navigation.searchParams = new URLSearchParams("meeting=meeting-1&meeting_view=recording&meeting_focus=1&agenda=agenda-1");
    render(<QueryClientProvider client={makeClient()}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit, issues: enIssues } }}><CockpitMeetingAgenda wsId="ws-1" meetingId="meeting-1" stage="recording" focused /></I18nProvider></QueryClientProvider>);
    await screen.findByRole("textbox", { name: "Discussion notes" });
    expect(await screen.findByRole("link", { name: "Open agenda: Agenda item 1" })).toBeVisible();
    // Related context mounts twice: the inline copy for containers below @7xl
    // and the dedicated column — container queries decide which displays.
    expect(screen.getAllByRole("region", { name: "Preparation & materials" })).toHaveLength(2);
    expect(screen.getByRole("link", { name: "Back to agenda" })).toBeVisible();
    expect(screen.getByText(enCockpit.meeting_lifecycle.recording_hint)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Add agenda item" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Search agenda" })).toBeNull();
    // The record surface keeps the goal readable and the notes editable; the
    // preparation editors and machinery step back.
    expect(screen.getByRole("heading", { level: 4 })).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Agenda title" })).toBeNull();
    expect(screen.queryByText("Discussion purposes")).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove agenda item" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create preparation issue" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Discussion notes" }), { target: { value: "Facts captured mid-session" } });
    expect(screen.getByText(enCockpit.meeting_lifecycle.draft_unsaved)).toBeVisible();
  });

  it("names the empty workbench center until a topic is selected", async () => {
    navigation.searchParams = new URLSearchParams("meeting=meeting-1&meeting_view=recording&meeting_focus=1");
    render(<QueryClientProvider client={makeClient()}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit, issues: enIssues } }}><CockpitMeetingAgenda wsId="ws-1" meetingId="meeting-1" stage="recording" focused /></I18nProvider></QueryClientProvider>);
    await screen.findByRole("link", { name: "Open agenda: Agenda item 1" });
    expect(screen.getByText(enCockpit.meeting_lifecycle.select)).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Discussion notes" })).toBeNull();
  });
});
