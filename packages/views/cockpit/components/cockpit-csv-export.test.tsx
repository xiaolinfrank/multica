import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CockpitBoard } from "@multica/core/types";
import enCockpit from "../../locales/en/cockpit.json";
import { CockpitCsvExport } from "./cockpit-csv-export";
import { cockpitPlanFixture } from "./cockpit-read-test-fixture";

const mocks = vi.hoisted(() => ({ getCockpitPlanExport: vi.fn() }));

vi.mock("@multica/core/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multica/core/api")>();
  return { ...actual, api: { ...actual.api, getCockpitPlanExport: mocks.getCockpitPlanExport } };
});
vi.mock("../../navigation", () => ({
  useNavigation: () => ({ pathname: "/ws/cockpit", searchParams: new URLSearchParams() }),
  AppLink: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const cockpit: CockpitBoard["cockpit"] = {
  id: "cp", workspace_id: "ws-1", title: "Board", goal_title: "", goal_date: null,
  summary_overall: "", summary_next: "", summary_support: "", basis: "",
  meeting_assignee_type: "", meeting_assignee_id: null, meeting_project_id: null,
  meeting_module_id: null, meeting_node_id: null, meeting_dir: "",
  created_at: "", updated_at: "",
};
const board: CockpitBoard = {
  cockpit,
  nodes: [
    { id: "root", cockpit_id: "cp", parent_id: null, code: "L1-01", name: "Programme", position: 0,
      color: "", owner: "", collaborators: "", start_date: null, end_date: null, status: "", progress: 0,
      deliverable: "", dependencies: "", note: "", current_progress: "", vendor: "", budget_category: "",
      budget_amount: null, exec_status: "", contract: "", source: "", updated_by_type: "", updated_by_id: null,
      created_at: "", updated_at: "" },
    { id: "task", cockpit_id: "cp", parent_id: "root", code: "L3-01-01", kind: "work_item", name: "Task",
      position: 0, color: "", owner: "", collaborators: "", start_date: null, end_date: null,
      status: "In progress", progress: 10, deliverable: "", dependencies: "", note: "", current_progress: "",
      vendor: "", budget_category: "", budget_amount: null, exec_status: "", contract: "", source: "",
      updated_by_type: "", updated_by_id: null, created_at: "", updated_at: "" },
  ],
  payments: [],
  issue_links: [],
  milestones: [],
  meetings: [],
  meeting_issues: [],
  meeting_nodes: [],
};

const scope = { projectId: null, moduleId: null };
const createObjectURL = vi.fn((_blob: Blob) => "blob:mock");
const revokeObjectURL = vi.fn();
const originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
const originalRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
let anchorClick: ReturnType<typeof vi.spyOn>;

function setup() {
  mocks.getCockpitPlanExport.mockResolvedValue({
    ...cockpitPlanFixture(board, scope),
    task_counts: [{ node_id: "task", primary_total: 4, reference_total: 0, active: 1, done: 3, closed: 0 }],
    issue_links: [],
    issue_link_total: 0,
    generated_at: "2026-11-22T00:00:00Z",
  });
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
  anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}>
      <QueryClientProvider client={qc}><CockpitCsvExport wsId="ws-1" scope={scope} /></QueryClientProvider>
    </I18nProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  mocks.getCockpitPlanExport.mockReset();
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  if (originalCreate) Object.defineProperty(URL, "createObjectURL", originalCreate);
  else Reflect.deleteProperty(URL, "createObjectURL");
  if (originalRevoke) Object.defineProperty(URL, "revokeObjectURL", originalRevoke);
  else Reflect.deleteProperty(URL, "revokeObjectURL");
});

describe("CockpitCsvExport", () => {
  it("downloads the progress the board shows, from the counts the plan read supplies", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: enCockpit.plan_views.csv_export }));
    const download = await screen.findByRole("button", { name: enCockpit.plan_views.download_csv });
    await waitFor(() => expect(download).toBeEnabled());
    fireEvent.click(download);
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    expect(anchorClick).toHaveBeenCalledTimes(1);

    const blob = createObjectURL.mock.calls[0]![0];
    const lines = (await blob.text()).split("\r\n").filter(Boolean);
    const task = lines.find((line) => line.includes("L3-01-01"))!;
    // 3 of 4 issues done: 75, not the typed 10. The component has to hand the
    // export the counts for this to be true.
    expect(task.split(",")[9]).toBe("75");
    // The project row quotes the same leaf average.
    expect(lines[1]!.split(",")[9]).toBe("75");
  });
});
