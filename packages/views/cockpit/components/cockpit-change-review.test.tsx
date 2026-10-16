import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { api } from "@multica/core/api";
import { CockpitNodeSchema } from "@multica/core/api/schemas";
import { cockpitReadKeys } from "@multica/core/cockpit";
import type { CockpitChangePreview } from "@multica/core/types";
import enCockpit from "../../locales/en/cockpit.json";
import { CockpitChangeReview } from "./cockpit-change-review";
vi.mock("../../navigation", () => ({ useNavigation: () => ({ pathname: "/ws/cockpit", searchParams: new URLSearchParams("tab=governance") }), AppLink: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...props}>{children}</a> }));
vi.mock("@multica/core/api", () => ({ api: { getCockpitChangePreview: vi.fn(), applyReviewedCockpitChange: vi.fn() } }));
function observation(id: string, current = "35"): CockpitChangePreview { return { workspace_id: "ws-1", context: { project_id: "project-a", project_title: "Project A", module_id: "module-a", module_title: "Module A" }, current_value: current, conflict: true, review_token: `token-${id}-${current}`, change: { id, cockpit_id: "board", node_id: "node", node_code: "01.01", node_name: "Review task", field: "progress", old_value: "10", new_value: "60", source: "manual", reason: "Confirmed delivery scope", status: "pending", created_by_type: "member", created_by_label: "Owner", decided_by_type: "", decided_by_label: "", decided_at: null, created_at: "2026-10-10T00:00:00Z", updated_at: "2026-10-10T00:00:00Z", source_task_id: "", source_issue: null, decision_note: "" } }; }
function result(preview: CockpitChangePreview) { return { node: CockpitNodeSchema.parse({ id: "node", progress: 60 }), change: { ...preview.change, old_value: preview.current_value, status: "applied" } }; }
function setup(ids = ["first"], supported = true) { const close = vi.fn(); const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}>{children}</I18nProvider></QueryClientProvider>;
  const props = { wsId: "ws-1", scope: { projectId: "project-a", moduleId: "module-a" }, contextKey: "scope-a", ids, canApplyField: () => supported, fieldLabel: () => "Progress", onClose: close, beginDecision: () => true, endDecision: vi.fn() };
  const view = render(<CockpitChangeReview {...props} />, { wrapper }); return { ...view, props, close, client }; }
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.getCockpitChangePreview).mockImplementation(async (_ws, id) => observation(id)); vi.mocked(api.applyReviewedCockpitChange).mockImplementation(async (_ws, preview) => result(preview)); });
describe("fixed change review observations", () => {
  it("shows proposed/current/new values, requires explicit overwrite consent and does not rebase on cache refresh", async () => {
    const { client, close } = setup(); const user = userEvent.setup(); await screen.findByText("35");
    expect(screen.getByText("10")).toBeVisible(); expect(screen.getByText("60")).toBeVisible(); const confirm = screen.getByRole("button", { name: enCockpit.governance.confirm_reviewed }); expect(confirm).toBeDisabled();
    vi.mocked(api.getCockpitChangePreview).mockImplementation(async (_ws, id) => observation(id, "50"));
    await act(async () => { await client.invalidateQueries({ queryKey: cockpitReadKeys.all("ws-1") }); }); expect(api.getCockpitChangePreview).toHaveBeenCalledTimes(1); expect(screen.queryByText("50")).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: enCockpit.governance.confirm_overwrite })); await user.click(confirm);
    await waitFor(() => expect(close).toHaveBeenCalledOnce()); expect(api.applyReviewedCockpitChange).toHaveBeenCalledExactlyOnceWith("ws-1", observation("first"));
  });
  it("stops after an optimistic-concurrency refusal and previews only unconfirmed items when the person requests another review", async () => {
    vi.mocked(api.applyReviewedCockpitChange).mockResolvedValueOnce(result(observation("first"))).mockRejectedValueOnce(Object.assign(new Error("The field changed"), { status: 409 })); setup(["first", "second", "third"]); const user = userEvent.setup(); await screen.findAllByText("35");
    await user.click(screen.getByRole("checkbox", { name: enCockpit.governance.confirm_overwrite })); await user.click(screen.getByRole("button", { name: enCockpit.governance.confirm_reviewed }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The field changed"); expect(api.applyReviewedCockpitChange).toHaveBeenCalledTimes(2); expect(vi.mocked(api.applyReviewedCockpitChange).mock.calls.map((call) => call[1].change.id)).toEqual(["first", "second"]);
    expect(screen.getByRole("button", { name: enCockpit.governance.confirm_reviewed })).toBeDisabled(); expect(api.getCockpitChangePreview).toHaveBeenCalledTimes(3);
    vi.mocked(api.getCockpitChangePreview).mockImplementation(async (_ws, id) => observation(id, "50")); await user.click(screen.getByRole("button", { name: enCockpit.governance.refresh_preview })); await screen.findAllByText("50");
    expect(vi.mocked(api.getCockpitChangePreview).mock.calls.slice(3).map((call) => call[1])).toEqual(["second", "third"]); expect(screen.getByRole("checkbox", { name: enCockpit.governance.confirm_overwrite })).not.toBeChecked(); expect(api.applyReviewedCockpitChange).toHaveBeenCalledTimes(2);
  });
  it("keeps an unsupported future field readable without allowing application", async () => {
    setup(["first"], false); await screen.findByText("35"); expect(screen.getByRole("button", { name: enCockpit.governance.confirm_reviewed })).toBeDisabled(); expect(screen.getAllByText(enCockpit.governance.preview_unavailable).length).toBeGreaterThan(0); expect(api.applyReviewedCockpitChange).not.toHaveBeenCalled();
  });
});

  it("does not close another scope's review when the previous scope's confirmed command returns late", async () => {
    let finish!: (value: ReturnType<typeof result>) => void;
    vi.mocked(api.applyReviewedCockpitChange).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = setup(); const user = userEvent.setup(); await screen.findByText("35");
    await user.click(screen.getByRole("checkbox", { name: enCockpit.governance.confirm_overwrite })); await user.click(screen.getByRole("button", { name: enCockpit.governance.confirm_reviewed }));
    await waitFor(() => expect(api.applyReviewedCockpitChange).toHaveBeenCalledOnce());
    const otherClose = vi.fn(); view.rerender(<CockpitChangeReview {...view.props} contextKey="scope-b" ids={["second"]} onClose={otherClose} />);
    await waitFor(() => expect(api.getCockpitChangePreview).toHaveBeenCalledTimes(2)); await screen.findByText("35");
    expect(screen.getByRole("checkbox", { name: enCockpit.governance.confirm_overwrite })).not.toBeChecked();
    await act(async () => finish(result(observation("first")))); expect(view.close).not.toHaveBeenCalled(); expect(otherClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: enCockpit.governance.confirm_reviewed })).toBeDisabled();
  });

  it("keeps a moved proposal outside the selected scope read-only and links to its current scope", async () => {
    vi.mocked(api.getCockpitChangePreview).mockResolvedValue({ ...observation("first"), context: { project_id: "project-b", project_title: "Project B", module_id: "module-b", module_title: "Module B" } });
    setup(); await screen.findByText(enCockpit.governance.outside_scope);
    expect(screen.getByText(/Project B \/ Module B/)).toBeVisible();
    expect(screen.getByRole("button", { name: enCockpit.governance.confirm_reviewed })).toBeDisabled();
    expect(screen.getByRole("link", { name: enCockpit.governance.open_current_scope })).toHaveAttribute("href", "/ws/cockpit?tab=governance&governance_view=changes&project=project-b&module=module-b");
    expect(api.applyReviewedCockpitChange).not.toHaveBeenCalled();
  });
