import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { api } from "@multica/core/api";
import enCockpit from "../../locales/en/cockpit.json";
import { CockpitReviewerSelect } from "./cockpit-reviewer-select";
vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ settings: () => "/ws/settings" }) }));
vi.mock("@multica/core/api", () => ({ api: { searchCockpitScopeMembers: vi.fn() } }));
vi.mock("../../navigation", () => ({ AppLink: ({ href, children }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href}>{children}</a> }));
const people = [{ id: "reviewer-a", title: "Alex", email: "alex.a@example.test", avatar_url: "", role: "member" }, { id: "reviewer-b", title: "Alex", email: "alex.b@example.test", avatar_url: "", role: "member" }];
function setup(value = "") { const change = vi.fn(); const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}><CockpitReviewerSelect wsId="ws-1" value={value} onChange={change} /></I18nProvider></QueryClientProvider>); return change; }
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.searchCockpitScopeMembers).mockImplementation(async (_ws, params = {}) => ({ workspace_id: "ws-1", scope: { q: params.q ?? "", ids: params.ids ?? [] }, items: people.filter((item) => !params.ids?.length || params.ids.includes(item.id)), total: 2, filtered_total: 2, next_cursor: null })); });
describe("formal reviewer identity choices", () => {
  it("keeps same-named accounts distinguishable by actual email and submits the chosen identity", async () => {
    const change = setup(); const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: "Reviewer" }));
    const choices = await screen.findAllByRole("button", { name: "Alex" }); expect(choices[0]).toHaveAccessibleDescription("alex.a@example.test"); expect(choices[1]).toHaveAccessibleDescription("alex.b@example.test");
    await user.click(choices[1]!); expect(change).toHaveBeenCalledWith("reviewer-b");
    expect(vi.mocked(api.searchCockpitScopeMembers).mock.lastCall?.[1]).toMatchObject({ page_size: 20 });
  });
  it("treats an invalid selected-identity response as a retryable read failure, not proof the person left", async () => {
    vi.mocked(api.searchCockpitScopeMembers).mockResolvedValue(null); setup("reviewer-a");
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load"); expect(screen.queryByText(/no longer/)).toBeNull();
    const calls = vi.mocked(api.searchCockpitScopeMembers).mock.calls.length; await userEvent.click(screen.getByRole("button", { name: "Retry" })); await waitFor(() => expect(vi.mocked(api.searchCockpitScopeMembers).mock.calls.length).toBeGreaterThan(calls));
  });
});
