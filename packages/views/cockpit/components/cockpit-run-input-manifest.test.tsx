import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { api } from "@multica/core/api";
import { CockpitRunInputManifest } from "./cockpit-run-input-manifest";
import { INPUT_ID, INPUT_MEETING, INPUT_MEMBER, INPUT_REFERENCE, INPUT_TIME, INPUT_VERSION, INPUT_WS } from "./input-test-fixtures";
import enCockpit from "../../locales/en/cockpit.json";
vi.mock("../../navigation", () => ({ AppLink: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a> }));
vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ issueDetail: (id: string) => `/ws/issues/${id}` }) }));
vi.mock("@multica/core/auth", async (original) => {
  const actual = await original<typeof import("@multica/core/auth")>();
  const state = { user: { id: "b1000000-0000-4000-8000-000000000006" } };
  return { ...actual, useAuthStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), { getState: () => state }) };
});
vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: { getCockpitRunInputManifest: vi.fn(), getCockpitInputManifestItems: vi.fn() } }));
describe("run input history versus current readability", () => {
  it("keeps recorded pre-execution preparation distinct from an expired current copy proof", async () => {
    const manifest = { workspaceId: INPUT_WS, issueId: INPUT_ID, id: INPUT_MEETING, versionNumber: 1, commandKey: INPUT_MEETING, manifestHash: "a".repeat(64), itemTotal: 1, requiredTotal: 1, createdBy: INPUT_MEMBER, createdByName: "Owner", createdAt: INPUT_TIME, hasNote: false };
    vi.mocked(api.getCockpitRunInputManifest).mockResolvedValue({ workspaceId: INPUT_WS, taskId: INPUT_REFERENCE, issueId: INPUT_ID, manifestVersion: manifest,
      preparationState: "required_ready", preparationHash: "a".repeat(64), preparedAt: INPUT_TIME, errorCode: "", counts: { total: 1, required: 1, availableRequired: 0, unknownRequired: 1, unavailableRequired: 0 }, runtimeSupported: true });
    vi.mocked(api.getCockpitInputManifestItems).mockResolvedValue({ workspaceId: INPUT_WS, issueId: INPUT_ID, manifestVersionId: INPUT_MEETING, manifestHash: "a".repeat(64), pageSize: 25, total: 1, nextCursor: null,
      items: [{ position: 0, inputId: INPUT_ID, inputTitle: "Meeting evidence", inputVersionId: INPUT_VERSION, inputVersionNumber: 1, payloadKind: "file", filename: "evidence.txt", contentType: "text/plain", sizeBytes: 6, contentHash: "b".repeat(64), purpose: "Preparation", required: true, availability: "unknown", unavailableReason: "verification_pending" }] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}><CockpitRunInputManifest wsId={INPUT_WS} runId={INPUT_REFERENCE} /></I18nProvider></QueryClientProvider>);
    try {
      expect(await screen.findByText(enCockpit.input_materials.manifest_run_ready)).toBeVisible();
      expect(await screen.findByText(new RegExp(enCockpit.input_materials.unknown_availability))).toBeVisible();
      expect(screen.getByText(enCockpit.input_materials.manifest_run_notice)).toBeVisible();
      expect(screen.queryByText(enCockpit.input_materials.manifest_run_failed)).toBeNull();
      expect(screen.queryByRole("progressbar")).toBeNull();
      expect(api.getCockpitInputManifestItems).toHaveBeenCalledExactlyOnceWith(INPUT_WS, INPUT_ID, INPUT_MEETING, { pageSize: 25, cursor: undefined }, expect.any(AbortSignal));
    } finally { view.unmount(); client.clear(); }
  });
});
