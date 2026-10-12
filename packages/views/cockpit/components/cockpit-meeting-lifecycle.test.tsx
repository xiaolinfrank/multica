import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { api } from "@multica/core/api";
import { useCockpitMeetingAgendaDraftStore } from "@multica/core/cockpit";
import { CockpitMeetingOccurrence, CockpitMeetingMaterialsConfirmation } from "./cockpit-meeting-lifecycle";
import { artifactFixture } from "./artifact-test-fixtures";
import { agendaFixture, lifecycleFixture, lifecycleResultFixture } from "./meeting-lifecycle-test-fixtures";
import enCockpit from "../../locales/en/cockpit.json";

const navigation = vi.hoisted(() => ({ pathname: "/ws/cockpit", searchParams: new URLSearchParams("meeting=meeting-1&meeting_view=agenda"), push: vi.fn() }));
vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ cockpit: () => "/ws/cockpit", issueDetail: (id: string) => `/ws/issues/${id}` }) }));
vi.mock("../../navigation", () => ({ useNavigation: () => navigation, AppLink: ({ children, href, ...props }: React.ComponentProps<"a">) => <a href={href} {...props}>{children}</a> }));
vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: { recordCockpitOccurrence: vi.fn(), confirmCockpitMaterials: vi.fn(), getCockpitLifecycleCommands: vi.fn(), getCockpitLifecycleCommand: vi.fn() } }));
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
// Reopen copy is pending in packages/views/locales (reported separately); the
// test injects the exact strings so assertions survive the final wording.
const reopenCockpitCopy = { ...enCockpit, meeting_lifecycle: { ...enCockpit.meeting_lifecycle, reopen: "Correct end confirmation", reopen_hint: "Withdraw the end confirmation: the meeting returns to scheduled and can still be cancelled or rescheduled. The original confirmation and your reason stay in the confirmation history." } };
function shell(children: React.ReactNode, cache = client(), copy: typeof enCockpit = enCockpit) { return <QueryClientProvider client={cache}><I18nProvider locale="en" resources={{ en: { cockpit: copy } }}>{children}</I18nProvider></QueryClientProvider>; }
beforeEach(() => { vi.clearAllMocks(); useCockpitMeetingAgendaDraftStore.getState().clearDraft(); navigation.searchParams = new URLSearchParams("meeting=meeting-1&meeting_view=agenda"); });

describe("meeting occurrence and material confirmation", () => {
  it("names each recorded operation and shows its agenda, preparation issue or material conclusion without loading every receipt", async () => {
    const header = lifecycleFixture(); const agenda = agendaFixture(); const issue = artifactFixture().source_issue;
    const metadata = ["agenda_update", "preparation_issue_create", "materials"].map((action) => ({ command_key: action, action, actor_id: "user-1", actor_name: "Recorder", created_at: "2026-10-11T01:00:00Z", revision: 2, agenda_id: action === "materials" ? null : agenda.id, reference_id: action === "preparation_issue_create" ? "reference-1" : null, issue_id: action === "preparation_issue_create" ? issue.id : null }));
    vi.mocked(api.getCockpitLifecycleCommands).mockResolvedValue({ workspace_id: "ws-1", meeting_id: "meeting-1", page_size: 25, total: 3, next_cursor: null, items: metadata });
    vi.mocked(api.getCockpitLifecycleCommand).mockImplementation(async (_ws, _meeting, commandKey) => {
      const item = metadata.find((row) => row.command_key === commandKey)!;
      const receipt = lifecycleResultFixture(header, commandKey, "agenda_update", commandKey === "materials" ? { materials: { workflow_revision: 2, ready: true, confirmed_at: "2026-10-11T01:00:00Z", confirmed_by: "user-1", released: false } }
        : commandKey === "agenda_update" ? { agenda_id: agenda.id, agenda: { ...agenda, notes: "Large historical body remains outside the metadata list" } }
          : { agenda_id: agenda.id, issue_id: issue.id, reference: { id: "reference-1", workspace_id: "ws-1", meeting_id: "meeting-1", agenda_id: agenda.id, kind: "issue", target_id: issue.id, purpose: "preparation", available: true, label: issue.title, issue, artifact_id: null, version_id: null, version_number: null, content_hash: null, created_at: "2026-10-11T01:00:00Z", removed_at: null, can_remove: true } }).receipt;
      return { ...item, workspace_id: "ws-1", meeting_id: "meeting-1", receipt };
    });
    render(shell(<CockpitMeetingOccurrence wsId="ws-1" header={header} refresh={vi.fn()} />)); fireEvent.click(screen.getByText("Actual times & confirmation history")); fireEvent.click(screen.getByRole("button", { name: "Confirmation history" }));
    await screen.findByRole("button", { name: "Save agenda item" }); expect(api.getCockpitLifecycleCommand).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save agenda item" })); expect(await screen.findByText(agenda.title)).toBeVisible();
    expect(screen.getByRole("link", { name: "Open the current agenda item (new tab)" })).toHaveAttribute("href", "/ws/cockpit?meeting=meeting-1&agenda=agenda-1&meeting_view=agenda");
    expect(screen.queryByText("Large historical body remains outside the metadata list")).toBeNull();
    await userEvent.keyboard("{Escape}"); fireEvent.click(screen.getByRole("button", { name: "Create preparation issue" }));
    expect(await screen.findByRole("link", { name: `${issue.identifier} ${issue.title} (new tab)` })).toHaveAttribute("href", `/ws/issues/${issue.identifier}`);
    await userEvent.keyboard("{Escape}"); fireEvent.click(screen.getByRole("button", { name: "Materials confirmation" }));
    expect(await screen.findByText("Materials were confirmed ready.")).toBeVisible(); expect(api.getCockpitLifecycleCommand).toHaveBeenCalledTimes(3);
  });

  it("records the end without a workflow or inventing actual times, and retries the same frozen command after an ambiguous response", async () => {
    const header = lifecycleFixture(); vi.mocked(api.recordCockpitOccurrence).mockRejectedValueOnce(new Error("Connection lost"));
    const first = render(shell(<CockpitMeetingOccurrence wsId="ws-1" header={header} refresh={vi.fn()} />));
    fireEvent.click(screen.getByRole("button", { name: "Confirm meeting ended" }));
    const dialog = within(screen.getByRole("dialog")); expect(dialog.getByLabelText("Actual start (optional)")).toHaveValue(""); expect(dialog.getByLabelText("Actual end (optional)")).toHaveValue("");
    fireEvent.click(dialog.getByRole("button", { name: "Confirm" })); await screen.findByText("Connection lost");
    const body = vi.mocked(api.recordCockpitOccurrence).mock.calls[0]![2]; expect(body).toMatchObject({ transition: "end", expected_revision: 1, actual_started_at: null, actual_ended_at: null });
    first.unmount(); const after = lifecycleFixture({ lifecycle_revision: 2, can_end: false, can_start: false, can_schedule: false, occurrence: { ...header.occurrence, state: "ended", ended_at: "2026-10-11T02:00:00Z", ended_source: "human_confirmation" } });
    vi.mocked(api.recordCockpitOccurrence).mockResolvedValueOnce(lifecycleResultFixture(after, body.command_key, "end", { occurrence: after.occurrence }));
    render(shell(<CockpitMeetingOccurrence wsId="ws-1" header={after} refresh={vi.fn()} />)); fireEvent.click(screen.getByRole("button", { name: "Retry the same request" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Retry the same request" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull()); expect(vi.mocked(api.recordCockpitOccurrence).mock.calls[1]![2]).toEqual(body);
    expect(api.confirmCockpitMaterials).not.toHaveBeenCalled();
  });
  it("corrects a mistaken end confirmation through reopen with a mandatory reason and no actual times", async () => {
    const plain = render(shell(<CockpitMeetingOccurrence wsId="ws-1" header={lifecycleFixture()} refresh={vi.fn()} />));
    expect(plain.queryByRole("button", { name: "Correct end confirmation" })).toBeNull();
    plain.unmount();
    const before = lifecycleFixture({ can_end: false, can_start: false, can_schedule: false, occurrence: { ...lifecycleFixture().occurrence, state: "ended", started_confirmed_at: "2026-10-11T01:00:00Z", started_confirmed_by: "user-1", ended_at: "2026-10-11T02:00:00Z", ended_by: "user-1", ended_source: "human_confirmation", actual_started_at: "2026-10-11T01:00:00Z", actual_ended_at: "2026-10-11T02:00:00Z" } });
    const after = lifecycleFixture({ lifecycle_revision: 2, can_end: true, occurrence: { ...lifecycleFixture().occurrence, state: "scheduled", actual_started_at: "2026-10-11T01:00:00Z" } });
    vi.mocked(api.recordCockpitOccurrence).mockResolvedValueOnce(lifecycleResultFixture(after, "reopen-1", "reopen", { reason: "The meeting continues tomorrow.", occurrence: after.occurrence, previous_occurrence: before.occurrence }));
    render(shell(<CockpitMeetingOccurrence wsId="ws-1" header={before} refresh={vi.fn()} />, client(), reopenCockpitCopy));
    fireEvent.click(screen.getByRole("button", { name: "Correct end confirmation" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.queryByLabelText("Actual start (optional)")).toBeNull();
    expect(dialog.queryByLabelText("Actual end (optional)")).toBeNull();
    expect(dialog.getByRole("button", { name: "Confirm" })).toBeDisabled();
    await userEvent.type(dialog.getByLabelText("Reason"), "The meeting continues tomorrow.");
    fireEvent.click(dialog.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const body = vi.mocked(api.recordCockpitOccurrence).mock.calls[0]![2];
    expect(body).toMatchObject({ transition: "reopen", expected_revision: 1, reason: "The meeting continues tomorrow." });
    expect("actual_started_at" in body).toBe(false);
    expect("actual_ended_at" in body).toBe(false);
  });
  it("does not silently rebase an open occurrence confirmation and keeps entered times after a concurrent change", async () => {
    const header = lifecycleFixture(); const cache = client(); const view = render(shell(<CockpitMeetingOccurrence wsId="ws-1" header={header} refresh={vi.fn()} />, cache));
    fireEvent.click(screen.getByRole("button", { name: "Confirm meeting started" })); fireEvent.change(screen.getByLabelText("Actual start (optional)"), { target: { value: "2026-01-01T10:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" })); fireEvent.click(screen.getByRole("button", { name: "Confirm meeting started" })); expect(screen.getByLabelText("Actual start (optional)")).toHaveValue("2026-01-01T10:00");
    view.rerender(shell(<CockpitMeetingOccurrence wsId="ws-1" header={{ ...header, lifecycle_revision: 2 }} refresh={vi.fn()} />, cache));
    expect(screen.getByLabelText("Actual start (optional)")).toHaveValue("2026-01-01T10:00"); expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled(); expect(screen.getByText(enCockpit.meeting_lifecycle.changed)).toBeVisible(); expect(api.recordCockpitOccurrence).not.toHaveBeenCalled();
  });
  it("shows legacy confirmation as unknown actual time and fetches history details only after a named record is opened", async () => {
    const header = lifecycleFixture({ can_end: false, can_start: false, can_schedule: false, occurrence: { ...lifecycleFixture().occurrence, state: "ended", ended_at: "2025-01-01T10:00:00Z", ended_source: "legacy_confirmation" } });
    vi.mocked(api.getCockpitLifecycleCommands).mockResolvedValue({ workspace_id: "ws-1", meeting_id: "meeting-1", page_size: 25, total: 1, next_cursor: null, items: [{ command_key: "command-1", action: "correct_times", actor_id: "member-1", actor_name: "Reviewer", created_at: "2026-01-01T12:00:00Z", revision: 2, agenda_id: null, reference_id: null, issue_id: null }] });
    vi.mocked(api.getCockpitLifecycleCommand).mockResolvedValue({ workspace_id: "ws-1", meeting_id: "meeting-1", command_key: "command-1", action: "correct_times", actor_id: "member-1", actor_name: "Reviewer", created_at: "2026-01-01T12:00:00Z", revision: 2, agenda_id: null, reference_id: null, issue_id: null, receipt: lifecycleResultFixture(header, "command-1", "correct_times", { reason: "Correct the meeting record", previous_occurrence: header.occurrence, occurrence: header.occurrence }).receipt });
    render(shell(<CockpitMeetingOccurrence wsId="ws-1" header={header} refresh={vi.fn()} />)); expect(api.getCockpitLifecycleCommands).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Actual times & confirmation history")); expect(screen.getByText(enCockpit.meeting_lifecycle.legacy_confirmation)).toBeVisible(); fireEvent.click(screen.getByRole("button", { name: "Confirmation history" }));
    await screen.findByText(/Reviewer/); expect(api.getCockpitLifecycleCommand).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "Correct actual times" }).at(-1)!); expect(await screen.findByText("Correct the meeting record")).toBeVisible();
  });
  it("requires an explicit material confirmation and exposes real preparation routes", async () => {
    const header = lifecycleFixture({ workflow_enabled: true, can_confirm_materials: true, materials: { workflow_revision: 4, ready: false, confirmed_at: null, confirmed_by: null, released: false } });
    vi.mocked(api.confirmCockpitMaterials).mockRejectedValueOnce(new Error("Network timeout"));
    render(shell(<CockpitMeetingMaterialsConfirmation wsId="ws-1" header={header} resourcesHref="/ws/cockpit?meeting=meeting-1&meeting_view=resources" workflowHref="/ws/cockpit?meeting=meeting-1&meeting_view=workflow" />));
    expect(screen.getByRole("checkbox", { name: "I have checked the minutes inputs" })).not.toBeChecked(); expect(api.confirmCockpitMaterials).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Open links & materials" })).toHaveAttribute("href", expect.stringContaining("meeting_view=resources"));
    fireEvent.click(screen.getByRole("checkbox", { name: "I have checked the minutes inputs" })); await screen.findByText("Network timeout");
    expect(vi.mocked(api.confirmCockpitMaterials).mock.calls[0]![2]).toMatchObject({ expected_revision: 4, materials_ready: true }); expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Retry the same request" })).toBeEnabled();
  });
});
