/**
 * @vitest-environment jsdom
 *
 * The ownership picker: projects → modules → work items, with the selection
 * rules that keep the three fields consistent (a work item implies its module
 * and project; a module or project clears the levels below it).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setApiInstance } from "@multica/core/api";
import type { ApiClient } from "@multica/core/api/client";
import { renderWithI18n } from "../../../test/i18n";
import { IssueScopePicker, type IssueScopeValue } from "./issue-scope-picker";

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

vi.mock("../../../navigation", () => ({
  AppLink: ({ children, ...props }: React.ComponentProps<"a">) => (
    <a {...props}>{children}</a>
  ),
  useNavigation: () => ({ push: () => {}, searchParams: new URLSearchParams() }),
}));

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const MODULE_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_MODULE_ID = "33333333-3333-4333-8333-333333333333";
const WORK_ITEM_ID = "44444444-4444-4444-8444-444444444444";

const project = {
  id: PROJECT_ID,
  workspace_id: "ws-1",
  title: "Programme",
  description: null,
  status: "active",
  priority: "medium",
  icon: "📁",
  color: "#2563eb",
  lead_type: null,
  lead_id: null,
  start_date: null,
  due_date: null,
  collab_path: null,
  position: 0,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function makeModule(id: string, title: string, position: number) {
  return {
    id,
    workspace_id: "ws-1",
    project_id: PROJECT_ID,
    title,
    description: null,
    position,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    issue_count: 0,
    done_count: 0,
  };
}

const modules = [makeModule(MODULE_ID, "01.02 Docking", 0), makeModule(OTHER_MODULE_ID, "01.03 Pilot", 1)];

const workItem = {
  id: WORK_ITEM_ID,
  title: "Interface draft",
  project_id: PROJECT_ID,
  module_id: MODULE_ID,
  code: "01.02.01",
  eligible: true,
  reason: "",
};

describe("IssueScopePicker", () => {
  let queryClient: QueryClient;
  let reconciled: boolean;

  beforeEach(() => {
    reconciled = true;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    setApiInstance({
      listProjects: async () => ({ projects: [project], total: 1 }),
      listModules: async () => ({ modules, total: modules.length }),
      getCockpitContext: async () => ({
        workspace_id: "ws-1",
        scope: { project_id: null, module_id: null, project_title: "", module_title: "" },
        cockpit: {
          id: "cp",
          workspace_id: "ws-1",
          goal_date: null,
          plan_reconciled_at: reconciled ? "2026-11-20T00:00:00Z" : null,
        },
        actor: { user_id: "user-1", role: "owner", is_human: true },
        has_meeting_workflows: false,
        has_stable_bindings: false,
      }),
      searchCockpitScopeNodes: async () => ({
        workspace_id: "ws-1",
        scope: { project_id: null, module_id: null, q: "", eligible: true },
        items: [workItem],
        total: 1,
        filtered_total: 1,
        next_cursor: null,
      }),
    } as unknown as ApiClient);
  });

  afterEach(() => {
    cleanup();
  });

  function show(
    onUpdate: (next: IssueScopeValue) => void,
    value: IssueScopeValue = { project_id: null, module_id: null, work_item_id: null },
    opts: { readOnly?: boolean; workItemLabel?: string } = {},
  ) {
    renderWithI18n(
      <QueryClientProvider client={queryClient}>
        <IssueScopePicker
          value={value}
          onUpdate={onUpdate}
          readOnly={opts.readOnly}
          workItemLabel={opts.workItemLabel}
        />
      </QueryClientProvider>,
    );
  }

  it("offers projects first and opens a project's modules", async () => {
    show(vi.fn());
    fireEvent.click(screen.getByRole("button", { name: "Filing" }));
    expect(await screen.findByText("Programme")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Toggle project Programme" }));
    expect(await screen.findByText("01.02 Docking")).toBeTruthy();
  });

  it("files under a work item by its code and name, carrying its module and project", async () => {
    const onUpdate = vi.fn();
    show(onUpdate);
    fireEvent.click(screen.getByRole("button", { name: "Filing" }));
    fireEvent.click(await screen.findByRole("button", { name: "Toggle project Programme" }));
    fireEvent.click(await screen.findByRole("button", { name: "Toggle module 01.02 Docking" }));
    const row = await screen.findByRole("button", { name: /01\.02\.01 Interface draft/ });
    fireEvent.click(row);
    // One selection names all three: the issue files under the work item and
    // the server derives its module and project from that row.
    expect(onUpdate).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
      module_id: MODULE_ID,
      work_item_id: WORK_ITEM_ID,
    });
  });

  it("clears the work item when a module is picked, and both when a project is", async () => {
    const onUpdate = vi.fn();
    show(onUpdate, { project_id: PROJECT_ID, module_id: MODULE_ID, work_item_id: WORK_ITEM_ID }, { workItemLabel: "01.02.01 Interface draft" });
    fireEvent.click(await screen.findByRole("button", { name: /Programme \/ 01.02 Docking \/ 01.02.01 Interface draft/ }));
    fireEvent.click(await screen.findByRole("button", { name: "01.02 Docking" }));
    expect(onUpdate).toHaveBeenLastCalledWith({
      project_id: PROJECT_ID,
      module_id: MODULE_ID,
      work_item_id: null,
    });

    fireEvent.click(await screen.findByRole("button", { name: /Programme \/ 01.02 Docking/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Programme" }));
    expect(onUpdate).toHaveBeenLastCalledWith({
      project_id: PROJECT_ID,
      module_id: null,
      work_item_id: null,
    });
  });

  it("clears everything through the no-filing row", async () => {
    const onUpdate = vi.fn();
    show(onUpdate, { project_id: PROJECT_ID, module_id: MODULE_ID, work_item_id: WORK_ITEM_ID }, { workItemLabel: "01.02.01 Interface draft" });
    fireEvent.click(await screen.findByRole("button", { name: /Programme \/ 01.02 Docking \/ 01.02.01 Interface draft/ }));
    fireEvent.click(await screen.findByRole("button", { name: "No filing" }));
    expect(onUpdate).toHaveBeenCalledWith({ project_id: null, module_id: null, work_item_id: null });
  });

  it("still offers projects and modules on an unreconciled board, and says why work items are missing", async () => {
    reconciled = false;
    show(vi.fn());
    fireEvent.click(screen.getByRole("button", { name: "Filing" }));
    fireEvent.click(await screen.findByRole("button", { name: "Toggle project Programme" }));
    expect(await screen.findByText("01.02 Docking")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Toggle module 01.02 Docking" }));
    // The reason replaces the list: an empty list would read as "no work items".
    expect(
      await screen.findByText(/has not been reconciled/),
    ).toBeTruthy();
  });

  it("keeps a sub-issue's filing locked", async () => {
    const onUpdate = vi.fn();
    show(
      onUpdate,
      { project_id: PROJECT_ID, module_id: MODULE_ID, work_item_id: WORK_ITEM_ID },
      { readOnly: true, workItemLabel: "01.02.01 Interface draft" },
    );
    const trigger = await screen.findByRole("button", { name: /Programme \/ 01.02 Docking \/ 01.02.01 Interface draft/ });
    expect(trigger).toBeDisabled();
    expect(screen.queryByRole("button", { name: "No filing" })).toBeNull();
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
