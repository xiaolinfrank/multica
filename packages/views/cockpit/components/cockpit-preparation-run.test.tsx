import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { api, ApiError } from "@multica/core/api";
import { CockpitPreparationRun } from "./cockpit-preparation-run";
import enCockpit from "../../locales/en/cockpit.json";

vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ issueDetail: (id: string) => `/ws/issues/${id}` }) }));
vi.mock("../../navigation", () => ({ AppLink: ({ children, href, ...props }: React.ComponentProps<"a">) => <a href={href} {...props}>{children}</a> }));
vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: { getTask: vi.fn() } }));
beforeEach(() => vi.clearAllMocks());

describe("preparation run recovery", () => {
  it.each([403, 404])("reads one exact run on demand and explains %s while preserving the Issue destination", async (status) => {
    vi.mocked(api.getTask).mockRejectedValue(new ApiError("Unavailable run", status, status === 403 ? "Forbidden" : "Not Found"));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}><CockpitPreparationRun wsId="ws-1" runId="run-1" issueId="issue-1" /></I18nProvider></QueryClientProvider>);
    try {
      expect(api.getTask).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: enCockpit.meeting_preparation.open_run }));
      expect(await screen.findByText(status === 403 ? enCockpit.meeting_preparation.run_forbidden : enCockpit.meeting_preparation.run_unavailable)).toBeVisible();
      expect(api.getTask).toHaveBeenCalledExactlyOnceWith("ws-1", "run-1", expect.any(AbortSignal));
      expect(screen.getByRole("link", { name: `${enCockpit.meeting_preparation.open_issue} ${enCockpit.action_flow.new_tab}` })).toHaveAttribute("href", "/ws/issues/issue-1");
      if (status === 403) expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
      else expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    } finally { view.unmount(); client.clear(); }
  });
});
