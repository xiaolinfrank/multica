import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@multica/core/api";
import type { SearchProjectResult } from "@multica/core/types";
import { I18nProvider } from "@multica/core/i18n/react";
import { CockpitDashboardScope } from "./cockpit-dashboard-scope";
import enCockpit from "../../locales/en/cockpit.json";

vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: { searchProjects: vi.fn() } }));
function project(index: number): SearchProjectResult {
  return { id: `project-${index}`, workspace_id: "ws-1", title: `Project ${index}`, description: null, icon: null, status: "in_progress", priority: "none", lead_type: null, lead_id: null,
    start_date: null, due_date: null, collab_path: null, created_at: "", updated_at: "", issue_count: 0, done_count: 0, resource_count: 0, match_source: "title" };
}
function setup(onSelect = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}>
    <CockpitDashboardScope wsId="ws-1" projectId="project-27" projectTitle="Chosen project" onSelect={onSelect} />
  </I18nProvider></QueryClientProvider>);
  return onSelect;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.searchProjects).mockImplementation(async ({ q, offset }) => ({ projects: q === "absent" ? [] : Array.from({ length: offset ? 7 : 20 }, (_, index) => project(index + (offset ?? 0) + 1)) }));
});

describe("bounded project scope picker", () => {
  it("loads no project collection before search and requests 20 results per offset page", async () => {
    const select = setup();
    fireEvent.click(screen.getByRole("button", { name: "Project scope" }));
    const input = await screen.findByRole("textbox", { name: "Search projects" });
    expect(api.searchProjects).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "Project" } });
    await screen.findByRole("button", { name: "Project 20" });
    expect(vi.mocked(api.searchProjects).mock.lastCall?.[0]).toMatchObject({ q: "Project", offset: 0, limit: 20, include_closed: true });
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByRole("button", { name: "Project 27" });
    expect(vi.mocked(api.searchProjects).mock.lastCall?.[0]).toMatchObject({ q: "Project", offset: 20, limit: 20 });
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Project 27" }));
    expect(select).toHaveBeenCalledWith("project-27");
  });

  it("resets pagination when search changes back to a previous query without changing the current scope", async () => {
    const select = setup();
    fireEvent.click(screen.getByRole("button", { name: "Project scope" }));
    const input = await screen.findByRole("textbox", { name: "Search projects" });
    fireEvent.change(input, { target: { value: "Project" } });
    await screen.findByRole("button", { name: "Project 20" });
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByRole("button", { name: "Project 27" });
    fireEvent.change(input, { target: { value: "absent" } });
    await waitFor(() => expect(vi.mocked(api.searchProjects).mock.lastCall?.[0]).toMatchObject({ q: "absent", offset: 0 }));
    fireEvent.change(input, { target: { value: "Project" } });
    await screen.findByRole("button", { name: "Project 1" });
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    expect(select).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Project scope" })).toHaveTextContent("Chosen project");
  });

  it("keeps All projects and retry available after a search failure", async () => {
    vi.mocked(api.searchProjects).mockRejectedValue(new Error("offline"));
    const select = setup();
    fireEvent.click(screen.getByRole("button", { name: "Project scope" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Search projects" }), { target: { value: "Project" } });
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "All projects" }));
    expect(select).toHaveBeenCalledWith("");
  });
});
