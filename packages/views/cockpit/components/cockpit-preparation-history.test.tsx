import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { api } from "@multica/core/api";
import type { CockpitPreparationOperationHeader } from "@multica/core/types";
import { CockpitPreparationHistory } from "./cockpit-preparation-history";
import enCockpit from "../../locales/en/cockpit.json";

vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ cockpit: () => "/ws/cockpit" }) }));
vi.mock("../../navigation", () => ({
  useNavigation: () => ({ pathname: "/ws/cockpit", searchParams: new URLSearchParams("meeting=meeting-1&meeting_view=details&track=bio") }),
  AppLink: ({ children, href, ...props }: React.ComponentProps<"a">) => <a href={href} {...props}>{children}</a>,
}));
vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: { getCockpitPreparationOperations: vi.fn() } }));

function operation(index: number): CockpitPreparationOperationHeader {
  return { workspace_id: "ws-1", meeting_id: "meeting-1", id: `operation-${index}`, kind: "cancel_preparation", revision: 1, state: "completed", command_key: `command-${index}`,
    created_by: "user-1", created_by_name: `Member ${index}`, responsible_user_id: "user-1", responsible_user_name: `Member ${index}`, created_at: "2026-10-13T10:00:00Z", updated_at: "2026-10-13T10:00:00Z",
    counts: { total: 1, pending: 0, applied: 1, needs_attention: 0, skipped: 0 }, can_continue: false, can_resume: false, can_pause: false, can_claim: false, blocked_reasons: [] };
}
function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}><CockpitPreparationHistory wsId="ws-1" meetingId="meeting-1" /></I18nProvider></QueryClientProvider>);
  return () => { view.unmount(); client.clear(); };
}
beforeEach(() => vi.clearAllMocks());

describe("meeting cancellation history", () => {
  it("loads on demand, pages bounded records and links each record to meeting details", async () => {
    const rows = Array.from({ length: 26 }, (_, index) => operation(index + 1));
    vi.mocked(api.getCockpitPreparationOperations).mockImplementation(async (_ws, _meeting, query = {}) => ({ workspace_id: "ws-1", meeting_id: "meeting-1", page_size: 25,
      items: query.cursor ? rows.slice(25) : rows.slice(0, 25), total: rows.length, next_cursor: query.cursor ? null : "page-two" }));
    const cleanup = show();
    try {
      expect(api.getCockpitPreparationOperations).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: enCockpit.meeting_preparation.history }));
      const links = await screen.findAllByRole("link", { name: enCockpit.meeting_preparation.cancellation });
      expect(links).toHaveLength(25);
      const query = new URL(links[0]!.getAttribute("href")!, "https://example.test").searchParams;
      expect(query.get("meeting")).toBe("meeting-1");
      expect(query.get("meeting_view")).toBe("details");
      expect(query.get("preparation")).toBe("operation-1");
      expect(query.get("track")).toBe("bio");
      fireEvent.click(screen.getByRole("button", { name: enCockpit.task_flow.next }));
      await waitFor(() => expect(screen.getAllByRole("link", { name: enCockpit.meeting_preparation.cancellation })).toHaveLength(1));
      expect(screen.getByRole("link", { name: enCockpit.meeting_preparation.cancellation })).toHaveAttribute("href", expect.stringContaining("preparation=operation-26"));
      expect(vi.mocked(api.getCockpitPreparationOperations).mock.calls.every((call) => call[2]?.page_size === 25)).toBe(true);
      expect(vi.mocked(api.getCockpitPreparationOperations).mock.calls.some((call) => call[2]?.cursor === "page-two")).toBe(true);
    } finally { cleanup(); }
  });

  it("shows an empty cancellation history without offering template application", async () => {
    vi.mocked(api.getCockpitPreparationOperations).mockResolvedValue({ workspace_id: "ws-1", meeting_id: "meeting-1", page_size: 25, items: [], total: 0, next_cursor: null });
    const cleanup = show();
    try {
      fireEvent.click(screen.getByRole("button", { name: enCockpit.meeting_preparation.history }));
      expect(await screen.findByText(enCockpit.meeting_preparation.empty)).toBeVisible();
      expect(screen.queryByRole("link")).toBeNull();
    } finally { cleanup(); }
  });
});
