import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import enGraph from "../../locales/en/graph.json";
// The graph behavior matrix (filtering, degrees, collapse subtrees, focus
// BFS, search matching) is pinned in packages/core/graph/build-graph-model.test.ts
// (node suite). This file keeps the happy path and wiring: the page fetches
// the snapshot, renders toolbar + counts + canvas, and searches.

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({
    issueDetail: (id: string) => `/ws/issues/${id}`,
  }),
}));

// The navigation mock hands out one shared push spy so menu actions can be
// asserted against it.
const pushMock = vi.hoisted(() => vi.fn());

// Same shape as office-page.test.tsx: platform plumbing we do not exercise.
vi.mock("../../navigation", () => ({
  useNavigation: () => ({
    push: pushMock,
    replace: vi.fn(),
    back: vi.fn(),
    pathname: "/ws/graph",
    searchParams: new URLSearchParams(),
  }),
}));

vi.mock("@multica/core/api", () => ({
  api: {
    getIssueGraph: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
    listProjects: vi.fn().mockResolvedValue({ projects: [], total: 0 }),
  },
}));

import { api } from "@multica/core/api";
import { GraphPage } from "./graph-page";

const graphFixture = {
  nodes: [
    { id: "a", identifier: "TES-1", number: 1, title: "Alpha issue", status: "todo", status_category: "todo", priority: "none", project_id: null, updated_at: "", assignee_name: "" },
    { id: "b", identifier: "TES-2", number: 2, title: "Beta issue", status: "in_progress", status_category: "in_progress", priority: "none", project_id: null, updated_at: "", assignee_name: "" },
    { id: "c", identifier: "TES-3", number: 3, title: "Gamma issue", status: "todo", status_category: "todo", priority: "high", project_id: null, updated_at: "2026-08-30T09:00:00Z", assignee_name: "Lin Wei" },
  ],
  edges: [
    { source: "a", target: "b", kind: "child" },
    { source: "a", target: "c", kind: "mention" },
  ],
};

/** Types a query, picks the search result, and waits for the node menu. */
async function selectNodeBySearch(query: string, title: string) {
  const input = screen.getByLabelText("Search issues…");
  fireEvent.change(input, { target: { value: query } });
  fireEvent.mouseDown(await screen.findByText(title));
  return screen.findByTestId("graph-node-menu");
}

/** Selects the Gamma node (the fixture's mention-referenced hub). */
async function selectGammaNode() {
  return selectNodeBySearch("Gamma", "Gamma issue");
}

function renderPage(props?: { projectId?: string | null }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en" resources={{ en: { graph: enGraph } }}>
        <GraphPage projectId={props?.projectId ?? null} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("GraphPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getIssueGraph).mockResolvedValue({ nodes: [], edges: [] });
    vi.mocked(api.listProjects).mockResolvedValue({ projects: [], total: 0 });
  });

  it("renders the title, toolbar and node/edge counts from the snapshot", async () => {
    vi.mocked(api.getIssueGraph).mockResolvedValue(graphFixture);
    renderPage();

    expect(await screen.findByTestId("graph-page")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Graph" })).toBeInTheDocument();
    expect(await screen.findByTestId("graph-counts")).toHaveTextContent("3 issues · 2 links");
    expect(screen.getByTestId("graph-toolbar")).toBeInTheDocument();
    expect(screen.getByTestId("graph-legend")).toBeInTheDocument();
  });

  it("requests the workspace graph without a project scope by default", async () => {
    renderPage();
    await screen.findByTestId("graph-page");

    expect(api.getIssueGraph).toHaveBeenCalledWith(undefined);
  });

  it("scopes the snapshot to the project when the page is project-scoped", async () => {
    renderPage({ projectId: "p-1" });
    await screen.findByTestId("graph-page");

    expect(api.getIssueGraph).toHaveBeenCalledWith({ project_id: "p-1" });
  });

  it("narrows the visible count as the user searches", async () => {
    vi.mocked(api.getIssueGraph).mockResolvedValue(graphFixture);
    renderPage();
    await screen.findByTestId("graph-counts");

    const input = screen.getByLabelText("Search issues…");
    fireEvent.change(input, { target: { value: "Gamma" } });

    // Matching nodes keep their labels on the canvas; the result dropdown
    // lists the match and picking it focuses the node.
    expect(await screen.findByText("Gamma issue")).toBeInTheDocument();
  });

  it("shows the empty state for a workspace with no issues", async () => {
    renderPage();
    expect(await screen.findByText("Nothing to map yet")).toBeInTheDocument();
    expect(screen.queryByTestId("graph-legend")).not.toBeInTheDocument();
  });

  it("shows the radial action menu around a selected node", async () => {
    vi.mocked(api.getIssueGraph).mockResolvedValue(graphFixture);
    renderPage();
    await screen.findByTestId("graph-counts");

    const menu = await selectGammaNode();
    expect(menu).toHaveAttribute("data-node-id", "c");
    expect(screen.getByTestId("graph-menu-open")).toHaveAccessibleName("Open issue");
    expect(screen.getByTestId("graph-menu-preview")).toHaveAccessibleName("Preview");
    expect(screen.getByTestId("graph-menu-isolate")).toHaveAccessibleName("Keep related only");
    expect(screen.queryByTestId("graph-node-preview")).not.toBeInTheDocument();
  });

  it("pins the preview card beside the node from the menu, and dismisses it", async () => {
    vi.mocked(api.getIssueGraph).mockResolvedValue(graphFixture);
    renderPage();
    await screen.findByTestId("graph-counts");
    await selectGammaNode();

    fireEvent.click(screen.getByTestId("graph-menu-preview"));
    const preview = await screen.findByTestId("graph-node-preview");
    expect(preview).toHaveAttribute("data-node-id", "c");
    expect(screen.getByText("Gamma issue")).toBeInTheDocument();
    expect(screen.getByText("Lin Wei")).toBeInTheDocument();
    expect(screen.getByText("high")).toBeInTheDocument();
    expect(screen.getByText("1 reference")).toBeInTheDocument(); // a -> c mention

    // The menu button toggles the card off; the card's own close button is
    // the second exit — both paths are pinned.
    fireEvent.click(screen.getByTestId("graph-menu-preview"));
    await waitFor(() =>
      expect(screen.queryByTestId("graph-node-preview")).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("graph-menu-preview"));
    await screen.findByTestId("graph-node-preview");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByTestId("graph-node-preview")).not.toBeInTheDocument(),
    );
  });

  it("navigates to the issue from the menu", async () => {
    vi.mocked(api.getIssueGraph).mockResolvedValue(graphFixture);
    renderPage();
    await screen.findByTestId("graph-counts");
    await selectGammaNode();

    fireEvent.click(screen.getByTestId("graph-menu-open"));
    expect(pushMock).toHaveBeenCalledWith("/ws/issues/c");
  });

  it("keeps only the node's relatives from the menu", async () => {
    vi.mocked(api.getIssueGraph).mockResolvedValue(graphFixture);
    renderPage();
    await screen.findByTestId("graph-counts");
    await selectGammaNode();

    fireEvent.click(screen.getByTestId("graph-menu-isolate"));
    // Gamma's 1-hop neighborhood: {c, a} — the a→b child edge drops out.
    await waitFor(() =>
      expect(screen.getByTestId("graph-counts")).toHaveTextContent("2 issues · 1 link"),
    );
  });

  it("retires the menu and preview when Reset clears the selection", async () => {
    vi.mocked(api.getIssueGraph).mockResolvedValue(graphFixture);
    renderPage();
    await screen.findByTestId("graph-counts");
    await selectGammaNode();
    fireEvent.click(screen.getByTestId("graph-menu-preview"));
    await screen.findByTestId("graph-node-preview");

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    await waitFor(() => {
      expect(screen.queryByTestId("graph-node-menu")).not.toBeInTheDocument();
      expect(screen.queryByTestId("graph-node-preview")).not.toBeInTheDocument();
    });
  });

  it("retires the preview and re-anchors the menu when the selection moves", async () => {
    vi.mocked(api.getIssueGraph).mockResolvedValue(graphFixture);
    renderPage();
    await screen.findByTestId("graph-counts");
    await selectGammaNode();
    fireEvent.click(screen.getByTestId("graph-menu-preview"));
    expect(await screen.findByTestId("graph-node-preview")).toHaveAttribute("data-node-id", "c");

    const menu = await selectNodeBySearch("Alpha", "Alpha issue");
    expect(menu).toHaveAttribute("data-node-id", "a");
    await waitFor(() =>
      expect(screen.queryByTestId("graph-node-preview")).not.toBeInTheDocument(),
    );
  });
});
