// @vitest-environment jsdom

import { cleanup, fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CockpitBoard, CockpitNode } from "@multica/core/types";
import { WorkspaceSlugProvider } from "@multica/core/paths";
import { renderWithI18n } from "../../test/i18n";
import { NavigationProvider } from "../../navigation";
import type { NavigationAdapter } from "../../navigation/types";

const queryRef = vi.hoisted(() => ({
  current: { data: undefined as CockpitBoard | undefined, isLoading: false },
}));

const mutRef = vi.hoisted(() => ({
  link: { mutate: vi.fn(), isPending: false },
  unlink: { mutate: vi.fn(), isPending: false },
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>(
    "@tanstack/react-query",
  );
  return { ...actual, useQuery: () => queryRef.current };
});

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

vi.mock("@multica/core/cockpit", async () => {
  const actual = await vi.importActual<typeof import("@multica/core/cockpit")>(
    "@multica/core/cockpit",
  );
  return {
    ...actual,
    useSetCockpitNodeIssues: () => mutRef.link,
    useDeleteCockpitNodeIssue: () => mutRef.unlink,
  };
});

// The picker's level-by-level submenu is its own concern; the stub surfaces
// what the section wired into it so both sides of the toggle stay testable
// without driving a portal-mounted dropdown.
vi.mock("../../cockpit/components/cockpit-node-picker", () => ({
  CockpitNodePicker: ({
    nodes,
    selectedIds,
    onToggle,
    label,
    disabled,
    codes,
  }: {
    nodes: CockpitNode[];
    selectedIds: Set<string>;
    onToggle: (nodeId: string) => void;
    label: string;
    disabled?: boolean;
    codes?: Map<string, string>;
  }) => (
    <div>
      <span data-testid="picker-label">{label}</span>
      <span data-testid="picker-node-count">{nodes.length}</span>
      <span data-testid="picker-selected">{[...selectedIds].sort().join(",")}</span>
      <span data-testid="picker-code-n2">{codes?.get("n2") ?? ""}</span>
      <button
        type="button"
        data-testid="picker-toggle"
        disabled={disabled}
        onClick={() => onToggle("n3")}
      >
        toggle n3
      </button>
    </div>
  ),
}));

import { CockpitNodesSection } from "./cockpit-nodes-section";

const adapter: NavigationAdapter = {
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  pathname: "/",
  searchParams: new URLSearchParams(),
  hash: "",
  getShareableUrl: (p) => p,
};

function renderSection(ui: React.ReactElement) {
  return renderWithI18n(
    <WorkspaceSlugProvider slug="acme">
      <NavigationProvider value={adapter}>{ui}</NavigationProvider>
    </WorkspaceSlugProvider>,
  );
}

function node(partial: Partial<CockpitNode> & { id: string }): CockpitNode {
  return {
    cockpit_id: "board-1",
    parent_id: null,
    code: "",
    name: "",
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
    updated_by_type: "member",
    updated_by_id: null,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    ...partial,
  };
}

function link(id: string, nodeId: string, issueId: string) {
  return {
    id,
    node_id: nodeId,
    issue_id: issueId,
    issue_number: 1,
    issue_identifier: "BIO-1",
    issue_title: "One",
    issue_status: "open",
    position: 0,
  };
}

function makeBoard(partial: Partial<CockpitBoard> = {}): CockpitBoard {
  return {
    cockpit: {
      id: "board-1",
      workspace_id: "ws-1",
      title: "Programme",
      goal_title: "",
      goal_date: null,
      summary_overall: "",
      summary_next: "",
      summary_support: "",
      basis: "",
      meeting_project_id: null,
      meeting_module_id: null,
      meeting_node_id: null,
      meeting_dir: "",
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-01T00:00:00Z",
    },
    // Board order is what the section's rows must keep: root, its two
    // children, then the grandchild under the first child. Module 06 is not
    // folded by the summary view, so raw and summary codes agree here.
    nodes: [
      node({ id: "n1", code: "06", name: "平台" }),
      node({ id: "n2", code: "06.01", name: "模块一", parent_id: "n1" }),
      node({ id: "n3", code: "06.02", name: "模块二", parent_id: "n1" }),
      node({ id: "n4", code: "06.01.01", name: "任务甲", parent_id: "n2" }),
    ],
    payments: [],
    issue_links: [
      link("l1", "n2", "issue-1"),
      link("l2", "n4", "issue-1"),
      link("l3", "n3", "issue-2"),
    ],
    milestones: [],
    meetings: [],
    meeting_issues: [],
    meeting_nodes: [],
    ...partial,
  };
}

// A branch of the shipped board where the summary tree folds: directions
// 02.02-02.09 collapse into one group row and their tasks number under it,
// so the gantt's code for a task under 02.07 differs from the raw tree's.
function makeFoldedBoard(): CockpitBoard {
  return makeBoard({
    nodes: [
      node({ id: "r", code: "L1-02", name: "平台与数据" }),
      node({ id: "d1", code: "02.01", name: "需求与方案", parent_id: "r" }),
      node({ id: "d2", code: "02.02", name: "方向二", parent_id: "r" }),
      node({ id: "d7", code: "02.07", name: "方向七", parent_id: "r" }),
      node({ id: "t1", code: "L3-01", name: "任务一", parent_id: "d2" }),
      node({ id: "t2", code: "L3-02", name: "任务二", parent_id: "d7" }),
    ],
    issue_links: [link("l1", "t2", "issue-1"), link("l2", "d7", "issue-1")],
  });
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mutRef.link.isPending = false;
  mutRef.unlink.isPending = false;
  queryRef.current = { data: undefined, isLoading: false };
});

describe("CockpitNodesSection", () => {
  it("renders nothing while the board loads or the board has no breakdown", () => {
    queryRef.current = { data: undefined, isLoading: true };
    const loading = renderSection(<CockpitNodesSection issueId="issue-1" />);
    expect(loading.container).toBeEmptyDOMElement();

    queryRef.current = { data: makeBoard({ nodes: [], issue_links: [] }), isLoading: false };
    const empty = renderSection(<CockpitNodesSection issueId="issue-1" />);
    expect(empty.container).toBeEmptyDOMElement();
  });

  it("lists this issue's work items in board order as links to the cockpit", () => {
    queryRef.current = { data: makeBoard(), isLoading: false };
    renderSection(<CockpitNodesSection issueId="issue-1" />);

    // Display codes are positional, not the stored ones: the two children of
    // root 06 number 06.01/06.02, the grandchild under the first is 06.01.01.
    const first = screen.getByRole("link", { name: "06.01 模块一" });
    expect(first).toHaveAttribute("href", "/acme/cockpit");
    expect(screen.getByRole("link", { name: "06.01.01 任务甲" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "06.02 模块二" })).toBeNull();
    // Count badge on the header, picker offered the whole board.
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByTestId("picker-node-count").textContent).toBe("4");
    expect(screen.getByTestId("picker-selected").textContent).toBe("n2,n4");
  });

  it("numbers rows by the summary tree, the same code the gantt quotes", () => {
    queryRef.current = { data: makeFoldedBoard(), isLoading: false };
    renderSection(<CockpitNodesSection issueId="issue-1" />);

    // 02.02-02.09 fold into one group at slot two: the task under direction
    // 02.07 numbers "02.02.02" on the gantt, not "02.03.01" as the raw tree
    // would have it. The folded direction itself keeps its stored code.
    expect(screen.getByRole("link", { name: "02.02.02 任务二" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "02.07 方向七" })).toBeInTheDocument();
    expect(screen.queryByText(/02\.03/)).toBeNull();
  });

  it("passes the same codes to the picker so menu and rows agree", () => {
    queryRef.current = { data: makeBoard(), isLoading: false };
    renderSection(<CockpitNodesSection issueId="issue-1" />);
    expect(screen.getByTestId("picker-code-n2").textContent).toBe("06.01");
  });

  it("shows the empty state and the picker when the board has room to link", () => {
    queryRef.current = { data: makeBoard(), isLoading: false };
    renderSection(<CockpitNodesSection issueId="issue-9" />);

    expect(screen.getByText("No work items linked.")).toBeInTheDocument();
    expect(screen.getByTestId("picker-selected").textContent).toBe("");
    expect(screen.getByTestId("picker-label").textContent).toBe("Add work item");
  });

  it("unlinks through the row button and links through the picker toggle", () => {
    queryRef.current = { data: makeBoard(), isLoading: false };
    renderSection(<CockpitNodesSection issueId="issue-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Unlink 06.01 模块一" }));
    expect(mutRef.unlink.mutate).toHaveBeenCalledWith(
      { nodeId: "n2", issueId: "issue-1" },
      expect.objectContaining({ onError: expect.any(Function) }),
    );
    expect(mutRef.link.mutate).not.toHaveBeenCalled();

    // n3 is linked to another issue, not this one. Toggling it from here
    // sends the node's whole set — the other issue's link kept, this one
    // appended — matching the cockpit picker's replace semantics.
    fireEvent.click(screen.getByTestId("picker-toggle"));
    expect(mutRef.link.mutate).toHaveBeenCalledWith(
      {
        nodeId: "n3",
        issueIds: ["issue-2", "issue-1"],
        replace: true,
      },
      expect.objectContaining({ onError: expect.any(Function) }),
    );
  });

  it("collapses and re-expands its body from the header", () => {
    queryRef.current = { data: makeBoard(), isLoading: false };
    renderSection(<CockpitNodesSection issueId="issue-1" />);

    fireEvent.click(screen.getByRole("button", { name: /Work items/ }));
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByTestId("picker-toggle")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Work items/ }));
    expect(screen.getByRole("link", { name: "06.01 模块一" })).toBeInTheDocument();
  });

  it("disables editing while a link mutation is in flight", () => {
    mutRef.link.isPending = true;
    queryRef.current = { data: makeBoard(), isLoading: false };
    renderSection(<CockpitNodesSection issueId="issue-1" />);

    expect(screen.getByTestId("picker-toggle")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Unlink 06.01.01 任务甲" }),
    ).toBeDisabled();
  });
});
