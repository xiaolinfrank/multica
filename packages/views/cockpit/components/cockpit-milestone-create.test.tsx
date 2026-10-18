import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { api } from "@multica/core/api";
import { CockpitBoardSchema, CockpitMilestoneSchema } from "@multica/core/api/schemas";
import { useCockpitMilestoneDraftStore } from "@multica/core/cockpit";
import enCockpit from "../../locales/en/cockpit.json";
import { cockpitNodeDetailFixture } from "./cockpit-read-test-fixture";
import { CockpitMilestoneCreate } from "./cockpit-milestone-create";
vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: { getCockpitNodeDetail: vi.fn(), createCockpitMilestone: vi.fn() } }));
vi.mock("../../navigation", () => ({ useNavigation: () => ({ pathname: "/ws/cockpit", searchParams: new URLSearchParams("tab=plan&project=project-a") }), AppLink: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...props}>{children}</a> }));
vi.mock("./cockpit-node-choice", () => ({ CockpitNodeChoicePicker: ({ onSelect, disabled }: { onSelect: (node: { id: string }) => void; disabled?: boolean }) => <button type="button" disabled={disabled} onClick={() => onSelect({ id: "node-a" })}>Choose scoped plan item</button> }));
const scope = { projectId: "project-a", moduleId: null };
const board = CockpitBoardSchema.parse({ cockpit: { id: "board" }, nodes: [{ id: "node-a", name: "Scoped plan item", code: "L1-01", project_id: "project-a" }] });
function setup() { const onOpenChange = vi.fn(); const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}><CockpitMilestoneCreate wsId="ws-1" scope={scope} open onOpenChange={onOpenChange} initialNodeId={null} disabled={false} /></I18nProvider></QueryClientProvider>); return { onOpenChange }; }
beforeEach(() => { vi.clearAllMocks(); useCockpitMilestoneDraftStore.getState().clearDraft(); vi.mocked(api.getCockpitNodeDetail).mockResolvedValue(cockpitNodeDetailFixture(board, "node-a", scope)); vi.mocked(api.createCockpitMilestone).mockImplementation(async (body) => CockpitMilestoneSchema.parse({ id: "milestone", ...body })); });
describe("scoped milestone creation", () => {
  it("requires an explicit in-scope anchor instead of creating a hidden workspace-wide milestone", async () => {
    const { onOpenChange } = setup(); const user = userEvent.setup(); await user.type(screen.getByRole("textbox", { name: enCockpit.milestone.name }), "Approved delivery");
    const submit = screen.getByRole("button", { name: enCockpit.overview.add_milestone }); expect(submit).toBeDisabled(); expect(screen.getByText(enCockpit.milestone_create.anchor_required)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Choose scoped plan item" })); await waitFor(() => expect(submit).toBeEnabled()); await user.click(submit);
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false)); expect(api.createCockpitMilestone).toHaveBeenCalledExactlyOnceWith({ name: "Approved delivery", node_id: "node-a", plan_date: null, status: "" });
  });
  it("keeps an unknown result read-only and provides the actual scoped list to inspect before another creation", async () => {
    vi.mocked(api.createCockpitMilestone).mockRejectedValue(new Error("response lost")); setup(); const user = userEvent.setup(); await user.type(screen.getByRole("textbox", { name: enCockpit.milestone.name }), "Approved delivery"); await user.click(screen.getByRole("button", { name: "Choose scoped plan item" })); const submit = screen.getByRole("button", { name: enCockpit.overview.add_milestone }); await waitFor(() => expect(submit).toBeEnabled()); await user.click(submit);
    expect(await screen.findByText("response lost")).toBeVisible(); expect(submit).toBeDisabled(); expect(screen.getByRole("textbox", { name: enCockpit.milestone.name })).toHaveValue("Approved delivery");
    expect(screen.getByRole("link", { name: enCockpit.milestone_create.inspect })).toHaveAttribute("href", "/ws/cockpit?tab=plan&plan_view=milestones&project=project-a"); await user.click(submit); expect(api.createCockpitMilestone).toHaveBeenCalledOnce();
  });
});
