import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { api, ApiError } from "@multica/core/api";
import { cockpitPreparationAuthorizationPreviewOptions, useCockpitMeetingPreparationDraftStore } from "@multica/core/cockpit";
import type { CockpitPreparationEffect, CockpitPreparationReauthorizationPreview } from "@multica/core/types";
import { CockpitPreparationReauthorization } from "./cockpit-preparation-reauthorization";
import enCockpit from "../../locales/en/cockpit.json";
import enIssues from "../../locales/en/issues.json";

vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ cockpit: () => "/ws/cockpit", issueDetail: (id: string) => `/ws/issues/${id}` }) }));
vi.mock("../../navigation", () => ({ useNavigation: () => ({ pathname: "/ws/cockpit", searchParams: new URLSearchParams("meeting=m&preparation=p") }), AppLink: ({ children, href, ...props }: React.ComponentProps<"a">) => <a href={href} {...props}>{children}</a> }));
vi.mock("../../issues/utils/status-label", () => ({ useStatusLabel: () => (status: string) => status }));
vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: { getCockpitPreparationAuthorizationPreview: vi.fn(), reauthorizeCockpitPreparationEffect: vi.fn() } }));

const id = (value: number) => `10000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const ws = id(1), meeting = id(2), op = id(3), effectId = id(4);
const effect: CockpitPreparationEffect = { id: effectId, operation_id: op, slot_id: id(5), position: 1, kind: "preparation_issue", label: "Prepare delivery evidence", revision: 3,
  state: "needs_attention", command_key: id(6), dependency_id: id(7), error_code: "context_changed", reason: "", targets: [], receipt: null,
  can_apply: false, can_skip: true, can_reauthorize: true, authorization_key: id(8), authorization_revision: 1 };
const scope = (title: string) => ({ node_id: id(11), node_title: "Deliver evidence", project_id: id(12), project_title: title, module_id: null, module_title: "" });
const preview = (title: string, token: string): CockpitPreparationReauthorizationPreview => ({ workspace_id: ws, meeting_id: meeting, operation_id: op, effect_id: effectId, effect_revision: 3,
  command_key: effect.command_key, fixed_intent_hash: "a".repeat(64), context_token: token, previous_authorization: { key: id(8), revision: 1, context_token: "b".repeat(64), facts_hash: "c".repeat(64),
    confirmed_by: id(9), confirmed_at: "2026-10-11T12:00:00Z", impact: null, selected_run: null, scope: scope("Original project") }, current_impact: null, current_run: null, current_scope: scope(title), targets: [], can_confirm: true, blocked_reasons: [] });
beforeEach(() => { vi.clearAllMocks(); useCockpitMeetingPreparationDraftStore.getState().clearDraft(); });

describe("preparation reauthorization observation", () => {
  it("keeps the displayed impact fixed until an explicit new preview and retains the reason after a real conflict", async () => {
    let response = preview("Observed current project", "d".repeat(64));
    vi.mocked(api.getCockpitPreparationAuthorizationPreview).mockImplementation(async () => response);
    vi.mocked(api.reauthorizeCockpitPreparationEffect).mockRejectedValue(new ApiError("Facts changed again", 409, "Conflict"));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
    const view = render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit, issues: enIssues } }}><CockpitPreparationReauthorization wsId={ws} meetingId={meeting} effect={effect} /></I18nProvider></QueryClientProvider>);
    try {
      expect(api.getCockpitPreparationAuthorizationPreview).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: enCockpit.meeting_preparation.reauthorize }));
      const dialog = within(screen.getByRole("dialog")); await dialog.findByText("Observed current project");
      fireEvent.change(dialog.getByRole("textbox", { name: "Reason" }), { target: { value: "Preserve this explanation while reviewing the changed placement." } });
      fireEvent.click(dialog.getByRole("checkbox"));
      response = preview("Newer project from another reader", "e".repeat(64));
      await act(async () => { client.setQueryData(cockpitPreparationAuthorizationPreviewOptions(ws, meeting, op, effectId).queryKey, response); });
      expect(dialog.getByText("Observed current project")).toBeVisible(); expect(dialog.queryByText("Newer project from another reader")).toBeNull();
      expect(dialog.getByRole("checkbox")).toBeChecked();
      fireEvent.click(dialog.getByRole("button", { name: "Preview again" }));
      await dialog.findByText("Newer project from another reader"); expect(dialog.getByRole("checkbox")).not.toBeChecked();
      expect(dialog.getByRole("textbox", { name: "Reason" })).toHaveValue("Preserve this explanation while reviewing the changed placement.");
      fireEvent.click(dialog.getByRole("checkbox")); fireEvent.click(dialog.getByRole("button", { name: "Confirm current impact" }));
      await dialog.findByText("Facts changed again");
      expect(vi.mocked(api.reauthorizeCockpitPreparationEffect).mock.calls[0]?.[4]).toMatchObject({ context_token: response.context_token, expected_revision: effect.revision, reason: "Preserve this explanation while reviewing the changed placement." });
      expect(dialog.getByRole("textbox", { name: "Reason" })).toHaveValue("Preserve this explanation while reviewing the changed placement.");
      await waitFor(() => expect(useCockpitMeetingPreparationDraftStore.getState().draft.commands).toEqual({}));
      expect(dialog.getByRole("button", { name: "Confirm current impact" })).toBeDisabled();
      expect(dialog.getByRole("checkbox")).not.toBeChecked();
      expect(dialog.getByRole("checkbox")).toBeDisabled();
      fireEvent.click(dialog.getByRole("button", { name: "Preview again" }));
      await waitFor(() => expect(dialog.getByRole("checkbox")).toBeEnabled());
      expect(dialog.getByRole("checkbox")).not.toBeChecked();
      expect(dialog.getByRole("button", { name: "Confirm current impact" })).toBeDisabled();
      fireEvent.click(dialog.getByRole("checkbox"));
      expect(dialog.getByRole("button", { name: "Confirm current impact" })).toBeEnabled();
    } finally { view.unmount(); client.clear(); }
  });
});
