import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@multica/core/api";
import { useModalStore } from "@multica/core/modals";
import { I18nProvider } from "@multica/core/i18n/react";
import type { Issue, CockpitMeetingIssueLink } from "@multica/core/types";
import { CockpitMeetingPreparation } from "./cockpit-meeting-preparation";
import en from "../../locales/en/cockpit.json";

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: {
  createIssue: vi.fn(), appendCockpitMeetingIssue: vi.fn(), setCockpitMeetingIssueRolesCompact: vi.fn(),
} }));
const issue: Issue = { id: "issue-1", workspace_id: "ws-1", number: 1, identifier: "BIO-1", title: "Prepare evidence", description: "", status: "backlog", priority: "none",
  assignee_type: null, assignee_id: null, creator_type: "member", creator_id: "user-1", parent_issue_id: null, project_id: "project-1", module_id: "module-1", position: 0,
  stage: null, start_date: null, due_date: null, metadata: {}, properties: {}, created_at: "2026-10-13T00:00:00Z", updated_at: "2026-10-13T00:00:00Z" };
const link: CockpitMeetingIssueLink = { meeting_id: "meeting-1", issue_id: issue.id, issue_identifier: issue.identifier, issue_number: 1, issue_title: issue.title, issue_status: "backlog", role: "task", roles: ["preparation"], position: 0 };
function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: en } }}><CockpitMeetingPreparation wsId="ws-1" currentUserId="user-1"
    meeting={{ id: "meeting-1" }} defaultPlacement={{ project_id: "project-1", module_id: "module-1", node_id: null }}
    defaultAssigneeType="member" defaultAssigneeId="user-1" /></I18nProvider></QueryClientProvider>);
}
beforeEach(() => {
  vi.clearAllMocks(); useModalStore.getState().close();
  vi.mocked(api.appendCockpitMeetingIssue).mockResolvedValue(link);
  vi.mocked(api.setCockpitMeetingIssueRolesCompact).mockResolvedValue(link);
});
describe("meeting preparation stage", () => {
  it("hands the create to the platform dialog, seeded with the meeting placement", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: en.meeting_lifecycle.create_preparation_issue }));
    const opened = useModalStore.getState();
    expect(opened.modal).toBe("create-issue");
    expect(opened.data).toEqual(expect.objectContaining({ status: "backlog", project_id: "project-1", module_id: "module-1", assignee_type: "member", assignee_id: "user-1" }));
  });
  it("links the created issue with the preparation role", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: en.meeting_lifecycle.create_preparation_issue }));
    const onCreated = useModalStore.getState().data?.on_created as (created: Issue) => Promise<unknown>;
    await onCreated(issue);
    expect(api.createIssue).not.toHaveBeenCalled();
    expect(api.appendCockpitMeetingIssue).toHaveBeenCalledExactlyOnceWith("ws-1", "meeting-1", issue.id);
    expect(api.setCockpitMeetingIssueRolesCompact).toHaveBeenCalledExactlyOnceWith("ws-1", "meeting-1", issue.id, ["preparation"]);
  });
  it("keeps the created issue findable when the link fails", async () => {
    vi.mocked(api.appendCockpitMeetingIssue).mockRejectedValueOnce(new Error("Link reply lost"));
    show();
    fireEvent.click(screen.getByRole("button", { name: en.meeting_lifecycle.create_preparation_issue }));
    const onCreated = useModalStore.getState().data?.on_created as (created: Issue) => Promise<unknown>;
    await onCreated(issue);
    await waitFor(() => expect(api.appendCockpitMeetingIssue).toHaveBeenCalledTimes(1));
  });
});
