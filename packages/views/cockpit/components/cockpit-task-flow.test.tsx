import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@multica/core/api";
import type { Issue } from "@multica/core/types";
import { I18nProvider } from "@multica/core/i18n/react";
import { CockpitIssueChoice } from "./cockpit-task-flow";
import { choiceIssue } from "./action-test-fixtures";
import enCockpit from "../../locales/en/cockpit.json";

vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: { searchIssues: vi.fn() } }));

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness() { const [selected, setSelected] = useState<Issue | null>(null); return <CockpitIssueChoice wsId="ws-1" selected={selected} onSelect={setSelected} />; }
  return render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}><Harness /></I18nProvider></QueryClientProvider>);
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.searchIssues).mockImplementation(async (params) => ({ issues: params.offset ? [choiceIssue(26)] : Array.from({ length: 25 }, (_, index) => choiceIssue(index + 1)) }));
});
describe("bounded issue selection", () => {
  it("searches only on demand, pages on the server and keeps the chosen issue visible across result pages", async () => {
    setup();
    expect(api.searchIssues).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: "Search existing issues" }), { target: { value: "Candidate" } });
    await screen.findByRole("button", { name: "PMO-1 Candidate 1" });
    expect(vi.mocked(api.searchIssues).mock.lastCall?.[0]).toMatchObject({ q: "Candidate", offset: 0, limit: 25, include_closed: true });
    fireEvent.click(screen.getByRole("button", { name: "PMO-1 Candidate 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByRole("button", { name: "PMO-26 Candidate 26" });
    expect(screen.getByText("Selected issue: PMO-1 Candidate 1")).toBeTruthy();
    expect(vi.mocked(api.searchIssues).mock.lastCall?.[0].offset).toBe(25);
    fireEvent.change(screen.getByRole("textbox", { name: "Search existing issues" }), { target: { value: "Other" } });
    await waitFor(() => expect(vi.mocked(api.searchIssues).mock.lastCall?.[0]).toMatchObject({ q: "Other", offset: 0 }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search existing issues" }), { target: { value: "Candidate" } });
    await waitFor(() => expect(vi.mocked(api.searchIssues).mock.lastCall?.[0]).toMatchObject({ q: "Candidate", offset: 0 }));
    expect(screen.getByText("Selected issue: PMO-1 Candidate 1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
  });

  it("distinguishes a failed search from no results", async () => {
    vi.mocked(api.searchIssues).mockRejectedValue(new Error("Unavailable"));
    setup();
    fireEvent.change(screen.getByRole("textbox", { name: "Search existing issues" }), { target: { value: "Candidate" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load this list");
    expect(screen.queryByText("No matching results. Your filters are preserved.")).toBeNull();
  });
});
