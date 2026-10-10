import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { CockpitMeetingSchema } from "@multica/core/api/schemas";
import { cockpitMeetingNotesDraftKey, useCockpitMeetingMaterialsDraftStore } from "@multica/core/cockpit";
import type { CockpitMeeting } from "@multica/core/types";
import { CockpitMeetingMaterials } from "./cockpit-meeting-materials";
import { workflowFixture, workflowSummary } from "./workflow-test-fixtures";
import enCockpit from "../../locales/en/cockpit.json";
import enIssues from "../../locales/en/issues.json";
import enProjects from "../../locales/en/projects.json";

vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ issueDetail: (id: string) => `/ws/issues/${id}` }) }));
vi.mock("@multica/core/workspace/hooks", () => ({ useActorName: () => ({ getActorName: () => "Minutes writer" }) }));
vi.mock("../../issues/components/status-icon", () => ({ StatusIcon: () => <span /> }));
vi.mock("../../navigation", () => ({ AppLink: ({ href, target, rel, children }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} target={target} rel={rel}>{children}</a> }));
vi.mock("../../common/local-path-link", () => ({ LocalPathLink: ({ path }: { path: string }) => <span>{path}</span> }));

const original = CockpitMeetingSchema.parse({ id: "meeting-1", title: "Planning", note: "Original agenda", nas_dir: "" });
const save = vi.fn<(patch: { note?: string; nas_dir?: string }) => Promise<void>>();
const prepare = vi.fn<() => Promise<void>>();
function view(meeting: CockpitMeeting = original) {
  return <I18nProvider locale="en" resources={{ en: { cockpit: enCockpit, issues: enIssues, projects: enProjects } }}>
    <CockpitMeetingMaterials wsId="ws-1" meeting={meeting} workflow={workflowSummary(workflowFixture())} workflowHref="/ws/cockpit?meeting=meeting-1&meeting_view=workflow"
      onSaveMaterialPatch={save} onPrepareDirectory={prepare} />
  </I18nProvider>;
}
beforeEach(() => { vi.clearAllMocks(); save.mockResolvedValue(); prepare.mockResolvedValue(); useCockpitMeetingMaterialsDraftStore.getState().clearDraft(); });

describe("meeting material preparation", () => {
  it("provides a real input issue in a new tab and retains an unfinished note after closing and reopening the meeting", () => {
    const first = render(view());
    expect(screen.getByRole("link", { name: "Open minutes issue to add notes or attachments (new tab)" }))
      .toHaveAttribute("href", "/ws/issues/minutes-1");
    expect(screen.getByRole("link", { name: "Open minutes issue to add notes or attachments (new tab)" })).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: "Return to workflow" })).toHaveAttribute("href", "/ws/cockpit?meeting=meeting-1&meeting_view=workflow");
    fireEvent.change(screen.getByRole("textbox", { name: "Meeting notes" }), { target: { value: "Agenda and outstanding source files" } });
    first.unmount(); render(view());
    expect(screen.getByRole("textbox", { name: "Meeting notes" })).toHaveValue("Agenda and outstanding source files");
    expect(save).not.toHaveBeenCalled();
  });

  it("does not acknowledge an optimistic parent value and keeps the note when saving fails and rolls back", async () => {
    let reject!: (error: Error) => void;
    save.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const result = render(view());
    fireEvent.change(screen.getByRole("textbox", { name: "Meeting notes" }), { target: { value: "Keep this draft" } });
    const saveButton = screen.getByRole("button", { name: "Save meeting notes" });
    fireEvent.click(saveButton);
    expect(saveButton).toBeDisabled();
    result.rerender(view({ ...original, note: "Keep this draft" }));
    const key = cockpitMeetingNotesDraftKey("ws-1", original.id);
    expect(useCockpitMeetingMaterialsDraftStore.getState().draft.byMeeting[key]?.note).toBe("Keep this draft");
    await act(async () => reject(new Error("Save failed on server")));
    result.rerender(view());
    expect(await screen.findByRole("alert")).toHaveTextContent("Save failed on server");
    expect(screen.getByRole("textbox", { name: "Meeting notes" })).toHaveValue("Keep this draft");
    expect(useCockpitMeetingMaterialsDraftStore.getState().draft.byMeeting[key]?.note).toBe("Keep this draft");
  });

  it("clears only a confirmed save and requires reviewing concurrent notes before retrying", async () => {
    const result = render(view());
    fireEvent.change(screen.getByRole("textbox", { name: "Meeting notes" }), { target: { value: "My combined notes" } });
    result.rerender(view({ ...original, note: "Colleague's updated notes" }));
    expect(screen.getByRole("button", { name: "Save meeting notes" })).toBeDisabled();
    fireEvent.click(screen.getByText("Read latest notes"));
    expect(screen.getByText("Colleague's updated notes")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "I reviewed the latest notes; keep my draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Save meeting notes" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ note: "My combined notes" }));
    await waitFor(() => expect(useCockpitMeetingMaterialsDraftStore.getState().draft.byMeeting[cockpitMeetingNotesDraftKey("ws-1", original.id)]).toBeUndefined());
  });

  it("keeps directory provisioning failures inline instead of claiming preparation succeeded", async () => {
    prepare.mockRejectedValueOnce(new Error("Share is not mounted"));
    render(view());
    fireEvent.click(screen.getByRole("button", { name: "Create the folder" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Share is not mounted");
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });

  it("keeps a normalized folder draft open after the actual asynchronous save rejects", async () => {
    save.mockRejectedValueOnce(new Error("Folder binding was rejected"));
    render(view());
    fireEvent.click(screen.getByRole("button", { name: "Enter folder path" }));
    const input = screen.getByRole("textbox", { name: "Material folder" });
    fireEvent.change(input, { target: { value: "/Volumes/team/materials" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Folder binding was rejected");
    expect(screen.getByRole("textbox", { name: "Material folder" })).toHaveValue("/Volumes/team/materials");
    expect(save).toHaveBeenCalledWith({ nas_dir: "/Volumes/team/materials" });
  });
});
