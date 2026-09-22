import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@multica/core/i18n/react";
import type { CockpitBoard, CockpitNode } from "@multica/core/types";
import enCockpit from "../../locales/en/cockpit.json";
import enIssues from "../../locales/en/issues.json";
import { PillButton } from "../../common/pill-button";
import { CockpitNodeIssuePicker } from "./cockpit-node-issue-picker";

// The derivations stay real — which rows the board can file into is exactly
// what this picker is being tested on. Only the two reads are stubbed.
vi.mock("@multica/core/cockpit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multica/core/cockpit")>()),
  cockpitBoardOptions: () => ({ queryKey: ["board"] }),
}));

vi.mock("@multica/core/modules/queries", () => ({
  moduleListOptions: () => ({ queryKey: ["modules"] }),
}));

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({
    data: queryKey[0] === "board" ? board : modules,
  }),
}));

function node(over: Partial<CockpitNode> & { id: string; code: string }): CockpitNode {
  return {
    cockpit_id: "cp",
    parent_id: null,
    name: over.code,
    position: 0,
    color: "",
    owner: "",
    collaborators: "",
    start_date: null,
    end_date: null,
    status: "",
    progress: 0,
    deliverable: "",
    dependencies: "",
    note: "",
    current_progress: "",
    vendor: "",
    budget_category: "",
    budget_amount: null,
    exec_status: "",
    contract: "",
    source: "",
    updated_by_type: "",
    updated_by_id: null,
    created_at: "",
    updated_at: "",
    ...over,
  };
}

// Stored codes deliberately unlike the displayed ones ("L3-01-02" is the
// board's own history), so a test that passes cannot be reading them.
const board = {
  nodes: [
    node({ id: "root", code: "L1-01", name: "Datasets" }),
    node({ id: "dir-1", code: "L2-01-01", name: "Retrospective", parent_id: "root", position: 0 }),
    node({ id: "dir-2", code: "L2-01-02", name: "Prospective", parent_id: "root", position: 1 }),
    node({ id: "task-1", code: "L3-01-08", name: "Ethics filing", parent_id: "dir-1", position: 0 }),
    node({ id: "task-2", code: "L3-01-09", name: "Sample intake", parent_id: "dir-1", position: 1 }),
    node({ id: "task-3", code: "L3-02-01", name: "Consent forms", parent_id: "dir-2", position: 0 }),
  ],
} as unknown as CockpitBoard;

const modules = [
  { id: "mod-0101", project_id: "proj-01", title: "01.01 Retrospective cohort" },
  { id: "mod-0102", project_id: "proj-01", title: "01.02 Prospective cohort" },
  { id: "mod-none", project_id: "proj-01", title: "Meeting material" },
];

function renderPicker(props: Partial<React.ComponentProps<typeof CockpitNodeIssuePicker>> = {}) {
  return render(
    <I18nProvider locale="en" resources={{ en: { cockpit: enCockpit, issues: enIssues } }}>
      <CockpitNodeIssuePicker
        value={{
          node_id: "task-1",
          code: "01.01.01",
          label: "01.01.01 Ethics filing",
          project_id: "proj-01",
          module_id: "mod-0101",
        }}
        onUpdate={props.onUpdate ?? vi.fn()}
        triggerRender={<PillButton />}
        {...props}
      />
    </I18nProvider>,
  );
}

describe("CockpitNodeIssuePicker", () => {
  it("offers only the rows the board can file an issue into", async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole("button", { name: /01\.01\.01 Ethics filing/ }));

    expect(await screen.findByRole("button", { name: /01\.01\.02 Sample intake/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /01\.02\.01 Consent forms/ })).toBeInTheDocument();
    // A mainline and a direction number a project and a module, not a place
    // work is filed, so neither is an answer to this question.
    expect(screen.queryByRole("button", { name: /^01 Datasets/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^01\.01 Retrospective/ })).not.toBeInTheDocument();
  });

  it("reports the row with everything the dialog refiles on", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    renderPicker({ onUpdate });

    await user.click(screen.getByRole("button", { name: /01\.01\.01 Ethics filing/ }));
    await user.click(await screen.findByRole("button", { name: /01\.02\.01 Consent forms/ }));

    expect(onUpdate).toHaveBeenCalledWith({
      node_id: "task-3",
      code: "01.02.01",
      label: "01.02.01 Consent forms",
      project_id: "proj-01",
      module_id: "mod-0102",
    });
  });

  it("clears the link from the first row", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    renderPicker({ onUpdate });

    await user.click(screen.getByRole("button", { name: /01\.01\.01 Ethics filing/ }));
    await user.click(await screen.findByRole("button", { name: /No work item/i }));

    expect(onUpdate).toHaveBeenCalledWith(null);
  });

  it("narrows the list by branch number", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    renderPicker({ onUpdate });

    await user.click(screen.getByRole("button", { name: /01\.01\.01 Ethics filing/ }));
    await user.type(
      await screen.findByPlaceholderText("Search by code or name…"),
      "01.02.",
    );

    expect(screen.queryByRole("button", { name: /Sample intake/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /01\.02\.01 Consent forms/ }));
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ node_id: "task-3" }));
  });

  it("narrows the list by name", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    renderPicker({ onUpdate });

    await user.click(screen.getByRole("button", { name: /01\.01\.01 Ethics filing/ }));
    await user.type(
      await screen.findByPlaceholderText("Search by code or name…"),
      "consent",
    );

    expect(screen.queryByRole("button", { name: /Sample intake/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /01\.02\.01 Consent forms/ }));
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ node_id: "task-3" }));
  });

  it("names nothing when the issue is not filed against a row", () => {
    renderPicker({ value: null });

    expect(screen.getByRole("button", { name: /No work item/i })).toBeInTheDocument();
  });
});
