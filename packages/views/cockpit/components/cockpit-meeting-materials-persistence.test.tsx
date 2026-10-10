import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@multica/core/api";
import { CockpitBoardSchema } from "@multica/core/api/schemas";
import { cockpitBoardOptions, cockpitKeys, cockpitMeetingNotesDraftKey, useCockpitMeetingMaterialsDraftStore, useSaveCockpitMeetingMaterials } from "@multica/core/cockpit";
import { I18nProvider } from "@multica/core/i18n/react";
import { CockpitMeetingMaterials } from "./cockpit-meeting-materials";
import enCockpit from "../../locales/en/cockpit.json";
import enProjects from "../../locales/en/projects.json";

vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: { getCockpit: vi.fn(), updateCockpitMeeting: vi.fn() } }));
vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ cockpit: () => "/ws/cockpit", issueDetail: (id: string) => `/ws/issues/${id}` }) }));
vi.mock("../../navigation", () => ({ AppLink: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a> }));

const board = CockpitBoardSchema.parse({ cockpit: { id: "cockpit-1", workspace_id: "ws-1" },
  meetings: [{ id: "meeting-1", cockpit_id: "cockpit-1", title: "Review", note: "Saved meeting notes" }] });
let serverBoard = structuredClone(board);
const draftKey = cockpitMeetingNotesDraftKey("ws-1", "meeting-1");

function MaterialsWithRealMutation() {
  const query = useQuery(cockpitBoardOptions("ws-1"));
  const save = useSaveCockpitMeetingMaterials("ws-1");
  const meeting = query.data?.meetings[0];
  return meeting ? <CockpitMeetingMaterials wsId="ws-1" meeting={meeting} workflow={undefined}
    workflowHref="/ws/cockpit?meeting=meeting-1" onPrepareDirectory={async () => {}}
    onSaveMaterialPatch={async (patch) => {
      const confirmed = await save.mutateAsync({ id: meeting.id, patch });
      if (confirmed.id !== meeting.id || confirmed.note !== patch.note) throw new Error("Unconfirmed save");
    }} /> : null;
}

describe("meeting materials with confirmed board updates", () => {
  beforeEach(() => {
    vi.clearAllMocks(); useCockpitMeetingMaterialsDraftStore.getState().clearDraft();
    serverBoard = structuredClone(board);
    vi.mocked(api.getCockpit).mockImplementation(async () => structuredClone(serverBoard));
  });

  it("keeps the last confirmed board value and the user's draft through a failed save, then clears the draft after acknowledgement", async () => {
    let rejectSave!: (cause: Error) => void;
    vi.mocked(api.updateCockpitMeeting).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSave = reject; }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
    client.setQueryData(cockpitKeys.board("ws-1"), board);
    render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit, projects: enProjects } }}>
      <MaterialsWithRealMutation />
    </I18nProvider></QueryClientProvider>);
    const user = userEvent.setup();
    const note = await screen.findByRole("textbox", { name: enCockpit.meeting_materials.notes });
    await user.clear(note);
    await user.type(note, "Unsent notes must survive");
    await user.click(screen.getByRole("button", { name: enCockpit.meeting_materials.save_notes }));
    await waitFor(() => expect(api.updateCockpitMeeting).toHaveBeenCalledTimes(1));
    expect(client.getQueryData<typeof board>(cockpitKeys.board("ws-1"))?.meetings[0]?.note).toBe("Saved meeting notes");
    expect(useCockpitMeetingMaterialsDraftStore.getState().draft.byMeeting[draftKey]?.note).toBe("Unsent notes must survive");
    await act(async () => rejectSave(new Error("Save denied")));
    expect(await screen.findByRole("alert")).toHaveTextContent("Save denied");
    expect(note).toHaveValue("Unsent notes must survive");
    expect(client.getQueryData<typeof board>(cockpitKeys.board("ws-1"))?.meetings[0]?.note).toBe("Saved meeting notes");
    expect(useCockpitMeetingMaterialsDraftStore.getState().draft.byMeeting[draftKey]?.note).toBe("Unsent notes must survive");
    vi.mocked(api.updateCockpitMeeting).mockImplementation(async () => {
      const saved = { ...board.meetings[0]!, note: "Unsent notes must survive" };
      serverBoard = { ...serverBoard, meetings: [saved] };
      return saved;
    });
    await user.click(screen.getByRole("button", { name: enCockpit.meeting_materials.save_notes }));
    await waitFor(() => expect(useCockpitMeetingMaterialsDraftStore.getState().draft.byMeeting[draftKey]).toBeUndefined());
    expect(note).toHaveValue("Unsent notes must survive");
  });
});
