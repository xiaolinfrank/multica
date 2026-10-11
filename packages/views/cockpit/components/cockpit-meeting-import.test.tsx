import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "@multica/core/api";
import type { CockpitMeetingScan, CockpitMeetingImportResult } from "@multica/core/types";
import { CockpitMeetingSchema } from "@multica/core/api/schemas";
import { cockpitKeys } from "@multica/core/cockpit";
import { I18nProvider } from "@multica/core/i18n/react";
import enCockpit from "../../locales/en/cockpit.json";
import enCommon from "../../locales/en/common.json";
import { CockpitMeetingImport, type CockpitMeetingImportProps } from "./cockpit-meeting-import";

vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: { scanCockpitMeetingFolders: vi.fn() } }));
vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ cockpit: () => "/ws/cockpit" }) }));
vi.mock("../../navigation", () => ({ useNavigation: () => ({ pathname: "/ws/cockpit", searchParams: new URLSearchParams("tab=meetings") }), AppLink: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...props}>{children}</a> }));

const scan: CockpitMeetingScan = {
  base_dir: "/Volumes/share/meetings", base_dir_exists: true, matched: 0, truncated: false, error: "",
  entries: [{ name: "20261010-01 Weekly review", path: "/Volumes/share/meetings/20261010-01 Weekly review",
    modified_at: "2026-10-10T00:00:00Z", files: 1, meeting_id: "", code: "01", meet_date: "2026-10-10", parties: "", title: "Weekly review" }],
};

function imported(path = scan.entries[0]!.path): CockpitMeetingImportResult { return { meetings: [CockpitMeetingSchema.parse({ id: "meeting-created", title: "Recorded meeting", nas_dir: path })], issues: [], skipped: [] }; }
function setup(onSubmit = vi.fn<CockpitMeetingImportProps["onSubmit"]>().mockResolvedValue(imported())) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const props: CockpitMeetingImportProps = { open: true, onOpenChange: vi.fn(), wsId: "ws-1", projectId: null, moduleId: null, nodeId: null, onSubmit };
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit, common: enCommon } }}>{children}</I18nProvider></QueryClientProvider>;
  return { ...render(<CockpitMeetingImport {...props} />, { wrapper }), client, props, onOpenChange: props.onOpenChange, onSubmit };
}

beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.scanCockpitMeetingFolders).mockResolvedValue(scan); });

describe("meeting folder import recovery", () => {

  it("keeps an imported meeting out of retries while showing its directory plan and separate task recovery", async () => {
    const onSubmit = vi.fn<CockpitMeetingImportProps["onSubmit"]>().mockResolvedValue({ ...imported(), task_errors: [{ name: scan.entries[0]!.name, meeting_id: "meeting-created", error: "Assignee needs review" }],
      directory_results: [{ name: scan.entries[0]!.name, meeting_id: "meeting-created", directory_operation_id: "10000000-0000-4000-8000-000000000044", directory_state: "active", dir_created: true, dir_error: "Directory preparation is not complete. Open its recorded plan to check the remaining steps.", dir_error_code: "directory_preparation_incomplete" }] });
    setup(onSubmit); const user = userEvent.setup(); await screen.findByDisplayValue("Weekly review");
    await user.click(within(screen.getByText(enCockpit.meetings.scan_with_task).closest("label")!).getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Import 1" }));
    const importedSection = within(await screen.findByRole("region", { name: enCockpit.import_recovery.imported }));
    expect(importedSection.getByText(enCockpit.meeting_directory.import_task_pending)).toBeVisible();
    expect(importedSection.getByText("Assignee needs review")).toBeVisible();
    expect(importedSection.getByText("Directory preparation · Preparing")).toBeVisible();
    expect(importedSection.getByText(enCockpit.meeting_directory.preparation_incomplete)).toBeVisible();
    expect(importedSection.queryByText(enCockpit.meeting_directory.unknown_reason)).toBeNull();
    const directory = importedSection.getByRole("link", { name: /View directory progress/ });
    const href = new URL(directory.getAttribute("href")!, "https://example.test");
    expect(href.searchParams.get("directory_operation")).toBe("10000000-0000-4000-8000-000000000044"); expect(href.searchParams.get("meeting_view")).toBe("resources"); expect(directory).toHaveAttribute("target", "_blank");
    expect(importedSection.getByRole("link", { name: /Open the meeting work package/ })).toHaveAttribute("href", "/ws/cockpit?meeting=meeting-created&meeting_view=workflow");
    expect(screen.getByRole("button", { name: "Import 0" })).toBeDisabled(); expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("shows a failed read as an error with retry instead of claiming the share has no new folders", async () => {
    vi.mocked(api.scanCockpitMeetingFolders).mockRejectedValueOnce(new Error("offline"));
    setup();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not read the meeting folders");
    expect(screen.queryByText(/Nothing new on the share/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Scan again" }));
    expect(await screen.findByDisplayValue("Weekly review")).toBeInTheDocument();
    expect(api.scanCockpitMeetingFolders).toHaveBeenCalledTimes(2);
  });

  it("keeps the edited folder title and dialog open after an import failure, then permits retry", async () => {
    const onSubmit = vi.fn().mockRejectedValueOnce(new Error("Import unavailable")).mockResolvedValueOnce(imported());
    const { onOpenChange } = setup(onSubmit);
    const user = userEvent.setup();
    const title = await screen.findByDisplayValue("Weekly review");
    await user.clear(title);
    await user.type(title, "Corrected review title");
    await user.click(screen.getByRole("button", { name: /^Import / }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Import unavailable");
    expect(screen.getByDisplayValue("Corrected review title")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /^Import / }));
    expect(await screen.findByRole("link", { name: /Corrected review title/ })).toHaveAttribute("href", "/ws/cockpit?meeting=meeting-created");
    expect(onOpenChange).not.toHaveBeenCalled(); await user.click(screen.getByRole("button", { name: "Done" })); expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSubmit).toHaveBeenLastCalledWith([expect.objectContaining({ title: "Corrected review title" })], false, scan.base_dir);
  });
});

  it("preserves corrections through background invalidation and keeps only failed folders retryable after a partial import", async () => {
    const second = { ...scan.entries[0]!, name: "Second folder", path: "/Volumes/share/meetings/Second folder", title: "Second meeting" };
    vi.mocked(api.scanCockpitMeetingFolders).mockResolvedValue({ ...scan, entries: [scan.entries[0]!, second] });
    const first = { ...imported(), skipped: [{ name: scan.entries[0]!.name, reason: "Minutes task could not be created" }, { name: second.name, reason: "Correct this meeting title" }] };
    const onSubmit = vi.fn<CockpitMeetingImportProps["onSubmit"]>().mockResolvedValueOnce(first).mockResolvedValueOnce({ meetings: [CockpitMeetingSchema.parse({ id: "second-meeting", nas_dir: second.path })], issues: [], skipped: [] });
    const view = setup(onSubmit); const user = userEvent.setup(); const title = await screen.findByDisplayValue("Second meeting"); await user.clear(title); await user.type(title, "Human correction");
    await act(async () => { await view.client.invalidateQueries({ queryKey: cockpitKeys.all("ws-1") }); window.dispatchEvent(new Event("focus")); });
    expect(api.scanCockpitMeetingFolders).toHaveBeenCalledTimes(1); expect(screen.getByDisplayValue("Human correction")).toBeInTheDocument();
    await user.click(within(screen.getByText(enCockpit.meetings.scan_with_task).closest("label")!).getByRole("checkbox")); await user.click(screen.getByRole("button", { name: "Import 2" }));
    expect(await screen.findByRole("link", { name: /Weekly review/ })).toHaveAttribute("href", "/ws/cockpit?meeting=meeting-created"); expect(screen.getByText("Minutes task could not be created")).toBeVisible();
    expect(screen.getByDisplayValue("Human correction")).toBeInTheDocument(); expect(screen.getByText("Correct this meeting title")).toBeVisible(); expect(view.onOpenChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Import 1" })); await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(onSubmit).toHaveBeenLastCalledWith([expect.objectContaining({ name: "Second folder", title: "Human correction" })], true, scan.base_dir);
    expect(await screen.findByRole("link", { name: /Human correction/ })).toHaveAttribute("href", "/ws/cockpit?meeting=second-meeting");
  });
  it("requires an explicit refresh before replacing edits and ignores a late receipt after switching scope", async () => {
    const view = setup(); const user = userEvent.setup(); const title = await screen.findByDisplayValue("Weekly review"); await user.clear(title); await user.type(title, "Keep until confirmed");
    await user.click(screen.getByRole("button", { name: "Scan again" })); const confirm = await screen.findByRole("alertdialog"); expect(api.scanCockpitMeetingFolders).toHaveBeenCalledTimes(1);
    await user.click(within(confirm).getByRole("button", { name: "Cancel" })); expect(screen.getByDisplayValue("Keep until confirmed")).toBeInTheDocument();
    let finish!: (value: CockpitMeetingImportResult) => void; view.onSubmit.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await user.click(screen.getByRole("button", { name: "Import 1" })); await waitFor(() => expect(view.onSubmit).toHaveBeenCalledOnce());
    vi.mocked(api.scanCockpitMeetingFolders).mockResolvedValue({ ...scan, entries: [{ ...scan.entries[0]!, title: "Other scope meeting" }] });
    const otherClose = vi.fn(); view.rerender(<CockpitMeetingImport {...view.props} projectId="other-project" onOpenChange={otherClose} />); await screen.findByDisplayValue("Other scope meeting");
    await act(async () => finish(imported())); expect(otherClose).not.toHaveBeenCalled(); expect(view.onOpenChange).not.toHaveBeenCalled(); expect(screen.queryByRole("link", { name: /Keep until confirmed/ })).toBeNull(); expect(screen.getByDisplayValue("Other scope meeting")).toBeInTheDocument();
  });

  it("keeps edits after directory drift and requires an explicit rescan before submitting the new location", async () => {
    const onSubmit = vi.fn<CockpitMeetingImportProps["onSubmit"]>().mockRejectedValueOnce(new ApiError("Directory changed", 409, "Conflict", { code: "directory_changed" }));
    setup(onSubmit); const user = userEvent.setup(); const title = await screen.findByDisplayValue("Weekly review"); await user.clear(title); await user.type(title, "Confirmed old-location title"); await user.click(screen.getByRole("button", { name: "Import 1" }));
    expect(await screen.findByText(enCockpit.import_recovery.directory_changed)).toBeVisible(); expect(screen.getByDisplayValue("Confirmed old-location title")).toBeInTheDocument(); expect(screen.getByRole("button", { name: "Import 1" })).toBeDisabled(); expect(onSubmit.mock.calls[0]?.[2]).toBe(scan.base_dir);
    const nextBase = "/Volumes/share/new-location", nextPath = `${nextBase}/${scan.entries[0]!.name}`;
    vi.mocked(api.scanCockpitMeetingFolders).mockResolvedValue({ ...scan, base_dir: nextBase, entries: [{ ...scan.entries[0]!, path: nextPath, title: "Rescanned title" }] });
    await user.click(screen.getByRole("button", { name: enCockpit.import_recovery.rescan_destination })); const confirmation = await screen.findByRole("alertdialog"); expect(api.scanCockpitMeetingFolders).toHaveBeenCalledTimes(1);
    await user.click(within(confirmation).getByRole("button", { name: "Scan again" })); await screen.findByDisplayValue("Rescanned title"); onSubmit.mockResolvedValueOnce(imported(nextPath));
    await user.click(screen.getByRole("button", { name: "Import 1" })); await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2)); expect(onSubmit.mock.calls[1]?.[2]).toBe(nextBase);
  });

  it("opens a recorded meeting after a lost import response is recovered by an explicit rescan", async () => {
    const onSubmit = vi.fn<CockpitMeetingImportProps["onSubmit"]>().mockRejectedValueOnce(new Error("Response lost")).mockResolvedValueOnce({ meetings: [], issues: [], skipped: [{ name: scan.entries[0]!.name, reason: "Already in the register" }] });
    setup(onSubmit); const user = userEvent.setup(); await screen.findByDisplayValue("Weekly review"); await user.click(screen.getByRole("button", { name: "Import 1" })); await screen.findByText("Response lost"); await user.click(screen.getByRole("button", { name: "Import 1" })); await screen.findByText("Already in the register");
    vi.mocked(api.scanCockpitMeetingFolders).mockResolvedValue({ ...scan, matched: 1, truncated: true, entries: [{ ...scan.entries[0]!, meeting_id: "existing-meeting" }] });
    await user.click(screen.getByRole("button", { name: "Scan again" })); const dialog = await screen.findByRole("alertdialog"); await user.click(within(dialog).getByRole("button", { name: "Scan again" }));
    const summary = await screen.findByText("Recorded meetings found (1)"); await user.click(summary);
    const group = summary.closest("details"); if (!group) throw new Error("Expected the recorded-meeting section");
    expect(within(group).getByRole("link", { name: /20261010-01 Weekly review/ })).toHaveAttribute("href", "/ws/cockpit?meeting=existing-meeting"); expect(within(group).getByRole("link")).toHaveAttribute("target", "_blank");
    expect(screen.getByText(enCockpit.meetings.scan_truncated)).toBeVisible(); expect(screen.getByRole("button", { name: "Import 0" })).toBeDisabled(); expect(onSubmit).toHaveBeenCalledTimes(2);
  });
