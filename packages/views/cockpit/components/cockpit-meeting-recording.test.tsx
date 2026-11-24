import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useModalStore } from "@multica/core/modals";
import { I18nProvider } from "@multica/core/i18n/react";
import { CockpitMeetingRecording } from "./cockpit-meeting-recording";
import en from "../../locales/en/cockpit.json";

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/api", async (original) => ({
  ...(await original<typeof import("@multica/core/api")>()),
  api: { commandCockpitMeetingWorkflow: vi.fn() },
}));

function show(nodeId: string | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider locale="en" resources={{ en: { cockpit: en } }}>
        <CockpitMeetingRecording
          wsId="ws-1"
          meetingId="meeting-1"
          workflow={null}
          loading={false}
          loadError={false}
          onReload={vi.fn()}
          currentUserId="user-1"
          defaultPlacement={{ project_id: "project-1", module_id: "module-1", node_id: nodeId }}
          defaultAssigneeType="member"
          defaultAssigneeId="user-1"
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useModalStore.getState().close();
});

describe("meeting recording stage", () => {
  it("seeds the minutes task with the meeting's default work item", () => {
    show("work-item-1");
    fireEvent.click(screen.getByRole("button", { name: en.workflow.setup_title }));
    expect(useModalStore.getState().data).toEqual(expect.objectContaining({
      status: "backlog",
      project_id: "project-1",
      module_id: "module-1",
      work_item_id: "work-item-1",
    }));
  });

  it("sends no work item when the board sets none", () => {
    show(null);
    fireEvent.click(screen.getByRole("button", { name: en.workflow.setup_title }));
    expect(useModalStore.getState().data).toEqual(expect.objectContaining({ work_item_id: null }));
  });
});
