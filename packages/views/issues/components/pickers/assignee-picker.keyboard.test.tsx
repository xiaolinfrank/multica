// Keyboard behaviour of the assignee picker's search box. Uses the REAL
// PropertyPicker / Base UI Popover — the regression under test lives in
// PropertyPicker's highlight bookkeeping, so mocking it would test nothing.
//
// Regression: the "Unassigned" row is pinned as the picker's first row, which
// also makes it the first `data-picker-item`. PropertyPicker used to reset the
// highlight to index 0 on every keystroke, so typing a name and pressing Enter
// unassigned the issue instead of assigning it to the person being searched
// for. The empty row is now excluded from the search-result Enter default while
// staying reachable by arrow key.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@multica/core/i18n/react";
import enIssues from "../../../locales/en/issues.json";
import { AssigneePicker } from "./assignee-picker";

const MEMBERS = [
  { user_id: "user-1", name: "Ada Lovelace", role: "member" },
  { user_id: "user-2", name: "Grace Hopper", role: "member" },
];

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => {
    if (queryKey[0] === "members") return { data: MEMBERS };
    return { data: [] };
  },
}));

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "workspace-1" }));
vi.mock("@multica/core/auth", () => ({ useAuthStore: () => ({ id: "user-1" }) }));
vi.mock("@multica/core/agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multica/core/agents")>();
  return { ...actual, isAgentRuntimeBound: () => true };
});
vi.mock("@multica/core/permissions", () => ({
  canAssignAgentToIssue: () => ({ allowed: true }),
}));
vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({ getActorName: () => "Ada Lovelace" }),
}));
vi.mock("@multica/core/workspace/queries", () => ({
  memberListOptions: () => ({ queryKey: ["members"] }),
  agentListOptions: () => ({ queryKey: ["agents"] }),
  squadListOptions: () => ({ queryKey: ["squads"] }),
  assigneeFrequencyOptions: () => ({ queryKey: ["frequency"] }),
}));
vi.mock("../../../common/actor-avatar", () => ({
  ActorAvatar: () => <span data-testid="actor-avatar" />,
}));

const SEARCH_PLACEHOLDER = "Assign to...";

function renderPicker(onUpdate: () => void) {
  return render(
    <I18nProvider locale="en" resources={{ en: { issues: enIssues } }}>
      {/* Controlled open: the picker is the subject, its trigger is not. */}
      <AssigneePicker
        assigneeType={null}
        assigneeId={null}
        onUpdate={onUpdate}
        open
        onOpenChange={() => {}}
      />
    </I18nProvider>,
  );
}

describe("AssigneePicker search keyboard defaults", () => {
  it("keeps an unassigned read-only trigger unassigned rather than creating an empty member avatar", () => {
    render(<I18nProvider locale="en" resources={{ en: { issues: enIssues } }}><AssigneePicker assigneeType={null} assigneeId={null} onUpdate={vi.fn()} readOnly restriction={<p>Checking actions</p>} /></I18nProvider>);
    expect(screen.getByRole("button", { name: "Unassigned" })).toBeVisible();
    expect(screen.queryByTestId("actor-avatar")).not.toBeInTheDocument();
  });
  it("shows the formal handoff entry without offering a silent assignee replacement", async () => {
    const update = vi.fn(); const user = userEvent.setup();
    render(<I18nProvider locale="en" resources={{ en: { issues: enIssues } }}><AssigneePicker assigneeType="member" assigneeId="user-1" onUpdate={update}
      open onOpenChange={() => {}} readOnly restriction={<a href="/ws/cockpit?artifact=a&artifact_version=v">Open formal review</a>} /></I18nProvider>);
    expect(screen.getByRole("link", { name: "Open formal review" })).toHaveAttribute("href", "/ws/cockpit?artifact=a&artifact_version=v");
    expect(screen.queryByPlaceholderText(SEARCH_PLACEHOLDER)).toBeNull(); expect(screen.queryByRole("button", { name: "Grace Hopper" })).toBeNull();
    await user.keyboard("{Enter}"); expect(update).not.toHaveBeenCalled();
  });
  it("assigns the first match on Enter instead of unassigning", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();

    renderPicker(onUpdate);

    await user.type(await screen.findByPlaceholderText(SEARCH_PLACEHOLDER), "grace");
    await user.keyboard("{Enter}");

    expect(onUpdate).toHaveBeenCalledWith({
      assignee_type: "member",
      assignee_id: "user-2",
    });
  });

  it("leaves Enter inert when the query matches nobody", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();

    renderPicker(onUpdate);

    await user.type(await screen.findByPlaceholderText(SEARCH_PLACEHOLDER), "zzzznomatch");
    await user.keyboard("{Enter}");

    expect(onUpdate).not.toHaveBeenCalled();
  });
});
