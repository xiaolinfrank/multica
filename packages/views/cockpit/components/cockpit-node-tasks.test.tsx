import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@multica/core/api";
import { I18nProvider } from "@multica/core/i18n/react";
import { useCockpitActionCommandStore, useCockpitTaskViewStore } from "@multica/core/cockpit";
import { CockpitNodeTasks } from "./cockpit-node-tasks";
import { actionNode, compactPage, compactTask } from "./action-test-fixtures";
import enCockpit from "../../locales/en/cockpit.json";
import enIssues from "../../locales/en/issues.json";

vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: {
  getCockpitNodeTasks: vi.fn(), listIssueStatuses: vi.fn(), createCockpitNodeTask: vi.fn(), getCockpitPrimaryNode: vi.fn(), setCockpitPrimaryNode: vi.fn(), searchIssues: vi.fn(),
} }));
vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ issueDetail: (id: string) => `/ws/issues/${id}` }) }));
vi.mock("../../navigation", () => ({ AppLink: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
vi.mock("../../issues/components/pickers/assignee-picker", () => ({ AssigneePicker: () => <button type="button">Assignee picker</button> }));

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit, issues: enIssues } }}>
    <CockpitNodeTasks wsId="ws-1" node={actionNode} userId="reviewer-1" />
  </I18nProvider></QueryClientProvider>);
}
beforeEach(() => {
  vi.clearAllMocks(); useCockpitTaskViewStore.getState().reset(); useCockpitActionCommandStore.getState().clearDraft();
  vi.mocked(api.listIssueStatuses).mockResolvedValue({ statuses: [], categories: [], total: 0 });
  vi.mocked(api.getCockpitNodeTasks).mockImplementation(async (_node, query) => {
    if (query?.status === "done") return compactPage({ items: query.category === "active" ? [] : [compactTask(120, { status: "done", status_category: "done" })], filtered_total: query.category === "active" ? 0 : 20, next_cursor: null });
    if (query?.q === "needle") return compactPage({ items: [compactTask(110, { title: "Needle outside first page" })], filtered_total: 1, next_cursor: null });
    if (query?.category === "done") return compactPage({ items: [compactTask(120, { status: "done", status_category: "done" })], filtered_total: 20, next_cursor: null });
    if (query?.cursor === "page-2") return compactPage({ items: [compactTask(26)], next_cursor: null });
    return compactPage();
  });
});

describe("bounded L3 task workbench", () => {
  it("clears the default open category and cursor when a specific completed status is selected", async () => {
    setup();
    const user = userEvent.setup();
    await screen.findByText("Work item 1");
    expect(screen.getByRole("button", { name: "Open (100)" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText("Work item 26");
    expect(vi.mocked(api.getCockpitNodeTasks).mock.lastCall?.[1]?.cursor).toBe("page-2");
    await user.click(screen.getByRole("combobox", { name: "Issue status" }));
    await user.click(await screen.findByRole("option", { name: "Done (20)" }));
    await waitFor(() => expect(vi.mocked(api.getCockpitNodeTasks).mock.lastCall?.[1]).toMatchObject({ category: "", status: "done", cursor: undefined }));
    await screen.findByText("Work item 120");
    expect(screen.getByRole("combobox", { name: "Issue status" })).toHaveTextContent("Done");
    expect(vi.mocked(api.getCockpitNodeTasks).mock.lastCall?.[1]).toMatchObject({ category: "", status: "done", cursor: undefined });
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
  });
  it("requests only the selected L3's first 25 active rows while reporting whole-scope done/closed/unknown counts", async () => {
    setup();
    await screen.findByText("Work item 1");
    expect(api.getCockpitNodeTasks).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.getCockpitNodeTasks).mock.calls[0]?.[1]).toMatchObject({ page_size: 25, category: "active", relation: "primary" });
    expect(screen.getAllByRole("link")).toHaveLength(25);
    expect(screen.getByRole("button", { name: "All (125)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open (100)" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Completed (20)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Closed (5)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Unknown (1)" })).toBeTruthy();
    expect(screen.queryByText("Work item 26")).toBeNull();
  });

  it("uses the server cursor, retains it when returning, and resets it for server search and category changes", async () => {
    const first = setup();
    await screen.findByText("Work item 1");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText("Work item 26");
    expect(vi.mocked(api.getCockpitNodeTasks).mock.lastCall?.[1]?.cursor).toBe("page-2");
    first.unmount();
    setup();
    await screen.findByText("Work item 26");
    expect(vi.mocked(api.getCockpitNodeTasks).mock.lastCall?.[1]?.cursor).toBe("page-2");
    fireEvent.change(screen.getByRole("textbox", { name: "Search L3 issues" }), { target: { value: "needle" } });
    await screen.findByText("Needle outside first page");
    expect(vi.mocked(api.getCockpitNodeTasks).mock.lastCall?.[1]).toMatchObject({ q: "needle", cursor: undefined });
    fireEvent.change(screen.getByRole("textbox", { name: "Search L3 issues" }), { target: { value: "" } });
    await waitFor(() => expect(vi.mocked(api.getCockpitNodeTasks).mock.lastCall?.[1]?.q).toBe(""));
    await screen.findByText("Work item 1");
    expect(vi.mocked(api.getCockpitNodeTasks).mock.lastCall?.[1]?.cursor).toBeUndefined();
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Completed (20)" }));
    await screen.findByText("Work item 120");
    expect(vi.mocked(api.getCockpitNodeTasks).mock.lastCall?.[1]).toMatchObject({ category: "done", cursor: undefined });
  });

  it("shows malformed or failed reads as retryable errors instead of claiming an empty L3", async () => {
    vi.mocked(api.getCockpitNodeTasks).mockResolvedValue(null);
    setup();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load this list");
    expect(screen.queryByText("No issues in this relationship yet.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(api.getCockpitNodeTasks).toHaveBeenCalledTimes(2));
  });
});
