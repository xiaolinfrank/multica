import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import { api } from "@multica/core/api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateIssueRequest } from "@multica/core/types";
import enIssues from "../../locales/en/issues.json";
import { issueOperationPageFixture, operationIssueFixture } from "../operation-basis-test-fixture";
import { IssueAssigneeControl } from "./issue-assignee-control";

const mocks = vi.hoisted(() => ({ picker: vi.fn() }));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/api", async (original) => ({ ...await original<typeof import("@multica/core/api")>(), api: { getIssueOperationBasis: vi.fn() } }));
vi.mock("./pickers", () => ({ AssigneePicker: (props: { trigger: React.ReactNode; restriction: React.ReactNode; readOnly: boolean; onUpdate: (body: Partial<UpdateIssueRequest>) => void }) => {
  mocks.picker(props); return <div>{props.trigger}{props.restriction}<button disabled={props.readOnly} onClick={() => props.onUpdate({ assignee_type: "member", assignee_id: "member-2" })}>Assign member</button></div>;
} }));
vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ issueDetail: (id: string) => `/ws/issues/${id}`, cockpit: () => "/ws/cockpit" }) }));
vi.mock("../../navigation", () => ({ AppLink: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a> }));
function setup(update = vi.fn()) {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><I18nProvider locale="en" resources={{ en: { issues: enIssues } }}><IssueAssigneeControl issue={operationIssueFixture("a")} onUpdate={update} trigger="Current owner" /></I18nProvider></QueryClientProvider>);
  return update;
}
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.getIssueOperationBasis).mockImplementation(async (ws, ids) => issueOperationPageFixture(ws, ids)); });
describe("board assignee action", () => {
  it("does not mount the roster picker or read policy for untouched cards", async () => {
    const update = setup(); expect(mocks.picker).not.toHaveBeenCalled(); expect(api.getIssueOperationBasis).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Current owner" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Assign member" })).toBeEnabled());
    expect(api.getIssueOperationBasis).toHaveBeenCalledExactlyOnceWith("ws-1", ["a"], expect.any(AbortSignal));
    await userEvent.click(screen.getByRole("button", { name: "Assign member" })); expect(update).toHaveBeenCalledExactlyOnceWith({ assignee_type: "member", assignee_id: "member-2" });
  });
  it("keeps a formal responsibility unchanged and gives its exact workbench when opened", async () => {
    const page = issueOperationPageFixture("ws-1", ["a"]); page.items[0]!.assignee = { state: "blocked", reason_codes: ["formal_reviewer_binding"] };
    page.items[0]!.targets = [{ kind: "artifact_version", artifact_id: "artifact", version_id: "fixed", purpose: "formal_review", label: "Interface evidence" }]; page.items[0]!.targets_total = 1;
    vi.mocked(api.getIssueOperationBasis).mockResolvedValue(page);
    const update = setup(); await userEvent.click(screen.getByRole("button", { name: "Current owner" }));
    const link = await screen.findByRole("link", { name: "Open formal review · Interface evidence (new tab)" });
    expect(link).toHaveAttribute("href", "/ws/cockpit?tab=artifacts&artifact=artifact&artifact_version=fixed");
    expect(screen.getByRole("button", { name: "Assign member" })).toBeDisabled(); expect(update).not.toHaveBeenCalled();
  });
});
