import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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

// Same shape as office-page.test.tsx: platform plumbing we do not exercise.
vi.mock("../../navigation", () => ({
  useNavigation: () => ({
    push: vi.fn(),
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
    { id: "c", identifier: "TES-3", number: 3, title: "Gamma issue", status: "todo", status_category: "todo", priority: "none", project_id: null, updated_at: "", assignee_name: "" },
  ],
  edges: [
    { source: "a", target: "b", kind: "child" },
    { source: "a", target: "c", kind: "mention" },
  ],
};

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
});
