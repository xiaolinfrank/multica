import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@multica/core/api";
import { I18nProvider } from "@multica/core/i18n/react";
import type { CockpitArtifactSourceAttachment } from "@multica/core/types";
import { CockpitArtifactFilePicker } from "./cockpit-artifact-file-picker";
import enCockpit from "../../locales/en/cockpit.json";

vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ issueDetail: (id: string) => `/ws/issues/${id}` }) }));
vi.mock("../../navigation", () => ({ AppLink: ({ children, href, ...props }: React.ComponentProps<"a">) => <a href={href} {...props}>{children}</a> }));
vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: { getCockpitArtifactSourceAttachments: vi.fn() } }));
const uploaded: CockpitArtifactSourceAttachment = { id: "file-1", source_issue_id: "producer-2", filename: "revised-report.pdf", content_type: "application/pdf", size_bytes: 64, created_at: "2026-10-11T01:00:00Z" };
let files: CockpitArtifactSourceAttachment[]; let producer: string;
const select = vi.fn();
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}><CockpitArtifactFilePicker wsId="ws-1" artifactId="artifact-1" producerIssueId="producer-2" selectedId="" selected={null} disabled={false} onSelect={select} /></I18nProvider></QueryClientProvider>);
}
beforeEach(() => {
  vi.clearAllMocks(); files = []; producer = "producer-2";
  vi.mocked(api.getCockpitArtifactSourceAttachments).mockImplementation(async () => ({ workspace_id: "ws-1", artifact_id: "artifact-1", producer_issue_id: producer, q: "", items: [...files], total: files.length, filtered_total: files.length, next_cursor: null }));
});
describe("artifact production files", () => {
  it("refreshes files after returning from the actual production issue even with an infinite cache and no websocket event", async () => {
    setup(); expect(await screen.findByText(enCockpit.artifacts.no_files)).toBeVisible();
    const link = screen.getByRole("link", { name: /Open production issue/ }); expect(link).toHaveAttribute("href", "/ws/issues/producer-2"); expect(link).toHaveAttribute("target", "_blank");
    files = [uploaded]; expect(api.getCockpitArtifactSourceAttachments).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Refresh files" }));
    const option = await screen.findByRole("button", { name: /revised-report.pdf/ }); fireEvent.click(option);
    expect(select).toHaveBeenCalledWith("file-1"); await waitFor(() => expect(api.getCockpitArtifactSourceAttachments).toHaveBeenCalledTimes(2));
  });
  it("withholds file selection when the artifact producer changes instead of misfiling an attachment from another issue", async () => {
    producer = "producer-3"; files = [{ ...uploaded, source_issue_id: producer }]; setup();
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(screen.queryByRole("button", { name: /revised-report.pdf/ })).toBeNull(); expect(select).not.toHaveBeenCalled();
  });
});
