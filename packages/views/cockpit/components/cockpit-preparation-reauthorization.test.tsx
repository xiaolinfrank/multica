import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { api, ApiError } from "@multica/core/api";
import { cockpitPreparationAuthorizationPreviewOptions, useCockpitMeetingPreparationDraftStore } from "@multica/core/cockpit";
import type { CockpitDispositionIssue, CockpitPreparationEffect, CockpitPreparationReauthorizationPreview } from "@multica/core/types";
import { CockpitPreparationReauthorization } from "./cockpit-preparation-reauthorization";
import enCockpit from "../../locales/en/cockpit.json";
import enIssues from "../../locales/en/issues.json";

vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ cockpit: () => "/ws/cockpit", issueDetail: (id: string) => `/ws/issues/${id}` }) }));
vi.mock("../../navigation", () => ({ useNavigation: () => ({ pathname: "/ws/cockpit", searchParams: new URLSearchParams("meeting=m&preparation=p") }), AppLink: ({ children, href, ...props }: React.ComponentProps<"a">) => <a href={href} {...props}>{children}</a> }));
vi.mock("../../issues/utils/status-label", () => ({ useStatusLabel: () => (status: string) => status }));
vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: { getCockpitPreparationAuthorizationPreview: vi.fn(), reauthorizeCockpitPreparationEffect: vi.fn() } }));

const id = (value: number) => `10000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const ws = id(1), meeting = id(2), op = id(3), effectId = id(4);
const effect: CockpitPreparationEffect = { id: effectId, operation_id: op, slot_id: id(5), position: 1, kind: "cancel_issue", label: "Cancel preparation issue", revision: 3,
  state: "needs_attention", command_key: id(6), dependency_id: null, error_code: "context_changed", reason: "", targets: [], receipt: null,
  can_apply: false, can_skip: true, can_reauthorize: true, authorization_key: id(8), authorization_revision: 1 };
const impact = (title: string): CockpitDispositionIssue => ({
  issue: { id: id(11), identifier: "PRJ-1", title, status: "todo", status_category: "unstarted", priority: "medium", assignee_type: "user", assignee_id: id(12), assignee_name: "Lee", due_date: "2026-10-15", project_id: null, module_id: null, primary_node_id: null, primary_node_code: "", primary_node_name: "", primary_revision: 0 },
  issue_revision: 2, can_cancel: true, can_change_due_date: true, can_link_meeting: true, cancel_status: "cancelled", blocked_reasons: [], ordinary_wakeup_count: 1, system_rule_count: 2, unstarted_wakeup_run_count: 3, other_queued_run_count: 0, active_run_count: 1, targets: [], targets_total: 0, parent_issue_id: null, evaluates_parent_rules: false,
});
const preview = (title: string, token: string): CockpitPreparationReauthorizationPreview => ({ workspace_id: ws, meeting_id: meeting, operation_id: op, effect_id: effectId, effect_revision: 3,
  command_key: effect.command_key, fixed_intent_hash: "a".repeat(64), context_token: token, previous_authorization: { key: id(8), revision: 1, context_token: "b".repeat(64), facts_hash: "c".repeat(64),
    confirmed_by: id(9), confirmed_at: "2026-10-11T12:00:00Z", impact: impact("Originally reviewed issue"), selected_run: null, scope: null }, current_impact: impact(title), current_run: null, current_scope: null, targets: [], can_confirm: true, blocked_reasons: [] });
beforeEach(() => { vi.clearAllMocks(); useCockpitMeetingPreparationDraftStore.getState().clearDraft(); });

describe("cancellation reauthorization observation", () => {
  it("keeps the displayed impact fixed until an explicit new preview and retains the reason after a real conflict", async () => {
    let response = preview("Observed preparation issue", "d".repeat(64));
    vi.mocked(api.getCockpitPreparationAuthorizationPreview).mockImplementation(async () => response);
    vi.mocked(api.reauthorizeCockpitPreparationEffect).mockRejectedValue(new ApiError("Facts changed again", 409, "Conflict"));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
    const view = render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit, issues: enIssues } }}><CockpitPreparationReauthorization wsId={ws} meetingId={meeting} effect={effect} /></I18nProvider></QueryClientProvider>);
    try {
      expect(api.getCockpitPreparationAuthorizationPreview).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: enCockpit.meeting_preparation.reauthorize }));
      const dialog = within(screen.getByRole("dialog")); await dialog.findByText("PRJ-1 Observed preparation issue");
      fireEvent.change(dialog.getByRole("textbox", { name: "Reason" }), { target: { value: "Preserve this explanation while reviewing the changed impact." } });
      fireEvent.click(dialog.getByRole("checkbox"));
      response = preview("Newer preparation issue from another reader", "e".repeat(64));
      await act(async () => { client.setQueryData(cockpitPreparationAuthorizationPreviewOptions(ws, meeting, op, effectId).queryKey, response); });
      expect(dialog.getByText("PRJ-1 Observed preparation issue")).toBeVisible(); expect(dialog.queryByText("PRJ-1 Newer preparation issue from another reader")).toBeNull();
      expect(dialog.getByRole("checkbox")).toBeChecked();
      fireEvent.click(dialog.getByRole("button", { name: enCockpit.meeting_lifecycle.refresh }));
      await dialog.findByText("PRJ-1 Newer preparation issue from another reader"); expect(dialog.getByRole("checkbox")).not.toBeChecked();
      expect(dialog.getByRole("textbox", { name: "Reason" })).toHaveValue("Preserve this explanation while reviewing the changed impact.");
      fireEvent.click(dialog.getByRole("checkbox")); fireEvent.click(dialog.getByRole("button", { name: enCockpit.meeting_preparation.confirm_current_impact }));
      await dialog.findByText("Facts changed again");
      expect(vi.mocked(api.reauthorizeCockpitPreparationEffect).mock.calls[0]?.[4]).toMatchObject({ context_token: response.context_token, expected_revision: effect.revision, reason: "Preserve this explanation while reviewing the changed impact." });
      expect(dialog.getByRole("textbox", { name: "Reason" })).toHaveValue("Preserve this explanation while reviewing the changed impact.");
      await waitFor(() => expect(useCockpitMeetingPreparationDraftStore.getState().draft.commands).toEqual({}));
      expect(dialog.getByRole("button", { name: enCockpit.meeting_preparation.confirm_current_impact })).toBeDisabled();
      expect(dialog.getByRole("checkbox")).not.toBeChecked();
      expect(dialog.getByRole("checkbox")).toBeDisabled();
      fireEvent.click(dialog.getByRole("button", { name: enCockpit.meeting_lifecycle.refresh }));
      await waitFor(() => expect(dialog.getByRole("checkbox")).toBeEnabled());
      expect(dialog.getByRole("checkbox")).not.toBeChecked();
      expect(dialog.getByRole("button", { name: enCockpit.meeting_preparation.confirm_current_impact })).toBeDisabled();
      fireEvent.click(dialog.getByRole("checkbox"));
      expect(dialog.getByRole("button", { name: enCockpit.meeting_preparation.confirm_current_impact })).toBeEnabled();
    } finally { view.unmount(); client.clear(); }
  });
});
