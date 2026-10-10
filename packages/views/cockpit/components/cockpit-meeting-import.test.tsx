import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@multica/core/api";
import type { CockpitMeetingScan } from "@multica/core/types";
import { I18nProvider } from "@multica/core/i18n/react";
import enCockpit from "../../locales/en/cockpit.json";
import enCommon from "../../locales/en/common.json";
import { CockpitMeetingImport } from "./cockpit-meeting-import";

vi.mock("@multica/core/api", () => ({ api: { scanCockpitMeetingFolders: vi.fn() } }));

const scan: CockpitMeetingScan = {
  base_dir: "/Volumes/share/meetings", base_dir_exists: true, matched: 0, truncated: false, error: "",
  entries: [{ name: "20261010-01 Weekly review", path: "/Volumes/share/meetings/20261010-01 Weekly review",
    modified_at: "2026-10-10T00:00:00Z", files: 1, meeting_id: "", code: "01", meet_date: "2026-10-10", parties: "", title: "Weekly review" }],
};

function setup(onSubmit = vi.fn().mockResolvedValue(undefined)) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onOpenChange = vi.fn();
  render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit, common: enCommon } }}>
    <CockpitMeetingImport open onOpenChange={onOpenChange} wsId="ws-1" projectId={null} moduleId={null} nodeId={null} onSubmit={onSubmit} />
  </I18nProvider></QueryClientProvider>);
  return { onOpenChange, onSubmit };
}

describe("meeting folder import recovery", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.scanCockpitMeetingFolders).mockResolvedValue(scan); });

  it("shows a failed read as an error with retry instead of claiming the share has no new folders", async () => {
    vi.mocked(api.scanCockpitMeetingFolders).mockRejectedValueOnce(new Error("offline"));
    setup();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not read the meeting folders");
    expect(screen.queryByText(/Nothing new on the share/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Scan again" }));
    expect(await screen.findByDisplayValue("Weekly review")).toBeInTheDocument();
    expect(api.scanCockpitMeetingFolders).toHaveBeenCalledTimes(2);
  });

  it("keeps the edited folder title and dialog open after an import failure, then permits retry", async () => {
    const onSubmit = vi.fn().mockRejectedValueOnce(new Error("Import unavailable")).mockResolvedValueOnce(undefined);
    const { onOpenChange } = setup(onSubmit);
    const user = userEvent.setup();
    const title = await screen.findByDisplayValue("Weekly review");
    await user.clear(title);
    await user.type(title, "Corrected review title");
    await user.click(screen.getByRole("button", { name: /^Import / }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Import unavailable");
    expect(screen.getByDisplayValue("Corrected review title")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /^Import / }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onSubmit).toHaveBeenLastCalledWith([expect.objectContaining({ title: "Corrected review title" })], false);
  });
});
