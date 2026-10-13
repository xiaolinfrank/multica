import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { api } from "@multica/core/api";
import { CockpitDirectoryCancellationPreview, CockpitDirectoryCancellationReceipt } from "./cockpit-directory-cancellation";
import { WS, MEETING, OP, KEY, HASH, history } from "./meeting-directory-test-fixtures";
import enCockpit from "../../locales/en/cockpit.json";

vi.mock("../../navigation", () => ({ useNavigation: () => ({ pathname: "/ws/cockpit", searchParams: new URLSearchParams() }), AppLink: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a> }));
vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: { getCockpitLifecycleCommand: vi.fn() } }));
const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}>{children}</I18nProvider></QueryClientProvider>;
beforeEach(() => vi.clearAllMocks());
describe("directory cancellation disclosure", () => {
  it("shows the authoritative pause total instead of counting the bounded sample", () => {
    render(<CockpitDirectoryCancellationPreview meetingId={MEETING} value={{ unfinished_total: 104, will_pause_total: 103, sample_operation_ids: [OP], facts_hash: HASH }} />, { wrapper });
    expect(screen.getByText("Pause the remaining steps of 103 directory plans.")).toBeVisible();
    expect(screen.getByText(enCockpit.meeting_directory.cancel_boundary)).toBeVisible();
    expect(screen.getByRole("link", { name: /View this meeting’s directory plans/ })).toHaveAttribute("target", "_blank");
    expect(api.getCockpitLifecycleCommand).not.toHaveBeenCalled();
  });
  it("uses the exact cancellation receipt even when the plan contains no issue effects", async () => {
    const command = history(); command.action = "cancel"; command.directory_operation_id = null;
    command.receipt = { ...command.receipt, directory: null, preparation: { operation_id: OP, kind: "cancel_preparation", revision: 1, state: "completed", effect_ids: [], effect_id: null, reason: "", request_hash: HASH, occurrence: null, context_token: "", authorization: null, previous_authorization: null, directory_effect: { paused_total: 7, sample_operation_ids: [OP], facts_hash: HASH } } };
    vi.mocked(api.getCockpitLifecycleCommand).mockResolvedValue(command);
    render(<CockpitDirectoryCancellationReceipt wsId={WS} meetingId={MEETING} operationId={OP} commandKey={KEY} />, { wrapper });
    expect(await screen.findByText("This cancellation paused 7 directory plans.")).toBeVisible();
    expect(api.getCockpitLifecycleCommand).toHaveBeenCalledExactlyOnceWith(WS, MEETING, KEY, expect.any(AbortSignal));
  });
});
