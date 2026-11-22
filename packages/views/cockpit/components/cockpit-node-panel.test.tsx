import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nProvider } from "@multica/core/i18n/react";
import enCockpit from "../../locales/en/cockpit.json";
import enCommon from "../../locales/en/common.json";
import type { CockpitNode } from "@multica/core/types";
import { CockpitNodePanel, type CockpitNodePanelProps } from "./cockpit-node-panel";


vi.mock("../../navigation", () => ({
  useNavigation: () => ({ pathname: "/ws/cockpit", searchParams: new URLSearchParams() }),
  AppLink: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

const node: CockpitNode = {
  id: "task", cockpit_id: "board", parent_id: "module", code: "L3-01-01", name: "Task",
  position: 0, color: "", owner: "Owner", collaborators: "Collaborator",
  start_date: null, end_date: null, status: "In progress", progress: 40,
  deliverable: "Deliverable text", dependencies: "Dependency text", note: "Note text",
  current_progress: "Current text", vendor: "Vendor text", budget_category: "Category",
  budget_amount: 10, exec_status: "", contract: "Contract text", source: "",
  updated_by_type: "", updated_by_id: null, created_at: "", updated_at: "",
};

function setup(overrides: Partial<CockpitNodePanelProps> = {}) {
  const props: CockpitNodePanelProps = {
    node, deleteAllowed: true, parent: undefined, depth: 2, referenceWorkspace: <p>Issue links</p>, isBranch: false,
    section: "tasks", onSectionChange: vi.fn(),
    meetingCount: 0, meetingsHref: "/ws/cockpit?tab=meetings",
    statusSuggestions: [], ownerSuggestions: [],
    onPatch: vi.fn(), onDelete: vi.fn().mockResolvedValue(undefined), onClose: vi.fn(),
    deleteConfirmationDescription: "This permanently deletes the item and its issue links.", ...overrides,
  };
  const view = render(
    <I18nProvider locale="en" resources={{ en: { cockpit: enCockpit, common: enCommon } }}>
      <CockpitNodePanel {...props} />
    </I18nProvider>,
  );
  return { ...view, props };
}

async function openConfirmation(branch = false) {
  fireEvent.click(screen.getByRole("button", { name: branch ? "Delete this branch" : "Delete plan item" }));
  return screen.findByRole("alertdialog");
}

describe("CockpitNodePanel", () => {
  it("opens the URL-selected repair section and exposes a return to the task list", () => {
    const { props } = setup({ section: "details", taskWorkspace: <p>Task workspace</p> });
    expect(screen.getByRole("tab", { name: "Plan details" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: "Tasks" }));
    expect(props.onSectionChange).toHaveBeenCalledWith("tasks");
    expect(props.onPatch).not.toHaveBeenCalled();
  });
  it("asks for confirmation and awaits server success before closing", async () => {
    let resolve!: () => void;
    const { props } = setup({ onDelete: vi.fn(() => new Promise<void>((done) => { resolve = done; })) });
    const dialog = await openConfirmation();
    expect(dialog).toHaveAccessibleDescription(props.deleteConfirmationDescription);
    expect(props.onDelete).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(props.onDelete).toHaveBeenCalledTimes(1);
    expect(props.onClose).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("button", { name: "Loading..." })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(props.onClose).not.toHaveBeenCalled();
    await act(async () => resolve());
    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1));
  });

  it("keeps failure visible and permits retry", async () => {
    const onDelete = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined);
    const { props } = setup({ onDelete });
    const dialog = await openConfirmation();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save that change");
    expect(props.onClose).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1));
    expect(onDelete).toHaveBeenCalledTimes(2);
  });

  it("allows cancellation without deleting or closing the detail panel", async () => {
    const { props } = setup({ isBranch: true, deleteConfirmationDescription: "Deletes this branch and all descendants." });
    const dialog = await openConfirmation(true);
    expect(dialog).toHaveAccessibleDescription("Deletes this branch and all descendants.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(props.onDelete).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it.each([0, 1])("trims structural depth %i without clearing hidden data", (depth) => {
    const { props } = setup({ depth });
    expect(screen.getByRole("button", { name: "Owner" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Collaborators" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Vendor" })).not.toBeInTheDocument();
    expect(screen.getByText("Issue links")).toBeInTheDocument();
    expect(screen.queryByText("Instalments")).not.toBeInTheDocument();
    expect(screen.queryByText("Deliverable text")).not.toBeInTheDocument();
    expect(props.onPatch).not.toHaveBeenCalled();
    expect(node.deliverable).toBe("Deliverable text");
  });

  it.each([0, 1, 2])("keeps the supplied bounded reference workspace reachable at depth %i", (depth) => {
    const open = vi.fn(); setup({ depth, referenceWorkspace: <button onClick={open}>Manage references</button> });
    fireEvent.click(screen.getByRole("button", { name: "Manage references" })); expect(open).toHaveBeenCalledOnce();
  });

  const issueCounts = { node_id: "task", primary_total: 4, reference_total: 0, active: 1, done: 3, closed: 0 };

  it("reads a work item's progress from its issues and offers no typed field", () => {
    setup({ issueCounts });
    expect(screen.getByText("75%")).toBeInTheDocument();
    expect(screen.getByText(enCockpit.node.progress_issue_hint)).toBeInTheDocument();
    // The ratio is a read-out: there is no progress editor to type into.
    expect(screen.queryByRole("button", { name: "Progress" })).not.toBeInTheDocument();
  });

  it("shows a branch's rolled-up progress instead of its own typed number", () => {
    setup({ isBranch: true, subtreeProgress: 58 });
    expect(screen.getByText("58%")).toBeInTheDocument();
    expect(screen.getByText(enCockpit.node.progress_branch_hint)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Progress" })).not.toBeInTheDocument();
  });

  it("shows a dash, not a typed field, on a structure row nobody has broken down", () => {
    // An empty module is still structure, not a work item: its progress is a
    // roll-up with nothing under it, so there is no number to edit.
    setup({ depth: 1, isBranch: false, subtreeProgress: null, node: { ...node, kind: "module" } });
    expect(screen.queryByRole("button", { name: "Progress" })).not.toBeInTheDocument();
    expect(screen.getByText(enCockpit.node.progress_branch_hint).previousElementSibling).toHaveTextContent("—");
  });

  it("offers only the task and plan-detail tabs, and does not advertise hidden sections", () => {
    // §9 hides artifacts and acceptance: an old URL that still asks for one
    // lands on the plan details instead of a tab or an unavailable notice.
    setup({ taskWorkspace: <p>Task workspace</p>, section: "artifacts" });
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Tasks", "Plan details"]);
    expect(screen.getByRole("tab", { name: "Plan details" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByText(enCockpit.feature_availability.unavailable)).not.toBeInTheDocument();
  });

  it("keeps typed progress when every issue under the work item is cancelled", () => {
    // No countable work: the panel, the gantt and the summaries all fall back
    // to the same typed value instead of showing a dash over a hidden number.
    setup({ issueCounts: { node_id: "task", primary_total: 4, reference_total: 0, active: 0, done: 0, closed: 4 } });
    expect(screen.queryByText(enCockpit.node.progress_issue_hint)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Progress" })).toBeInTheDocument();
  });

  it("keeps typed progress for a work item that owns no issues", () => {
    setup({ issueCounts: { node_id: "task", primary_total: 0, reference_total: 0, active: 0, done: 0, closed: 0 } });
    expect(screen.queryByText(enCockpit.node.progress_issue_hint)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Progress" })).toBeInTheDocument();
  });

  it("sends the reader to the register for the node's meetings, as a count", () => {
    setup({ meetingCount: 3, meetingsHref: "/ws/cockpit?tab=meetings&meeting_node=task" });
    const link = screen.getByRole("link", { name: "3 meetings" });
    expect(link).toHaveAttribute("href", "/ws/cockpit?tab=meetings&meeting_node=task");
    // The list itself moved to the register; the panel only counts.
    expect(screen.queryByText(enCockpit.meetings.node_meetings)).toBeInTheDocument();
  });

  it("keeps the plan fields and folds only the secondary ones", () => {
    const { props } = setup({ readOnly: true });
    expect(screen.getByText("Deliverable text")).toBeInTheDocument();
    expect(screen.getByText("Issue links")).toBeInTheDocument();
    // Money lives in the finance view now: the panel carries no field for it.
    expect(screen.queryByRole("button", { name: "Vendor" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Contract" })).not.toBeInTheDocument();
    // Collaborators, dependencies and source are one click away, read-only.
    fireEvent.click(screen.getByText("More"));
    expect(screen.getByText("Collaborator")).toBeInTheDocument();
    expect(screen.getByText("Dependency text")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete plan item" })).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("shows the code as an address, not an editable field", () => {
    setup();
    expect(screen.getByText("L3-01-01")).toBeInTheDocument();
    // Renumbering is the only way a code moves; the header does not edit it.
    expect(screen.queryByRole("button", { name: enCockpit.node.stored_code })).not.toBeInTheDocument();
  });

  it("Escape cancels an editor first, then closes the idle panel", () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Name" }), { key: "Escape" });
    expect(props.onClose).not.toHaveBeenCalled();
    expect(props.onPatch).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});

  it("keeps ordinary edits available while retained deletion explains its real destination", async () => {
    const { props } = setup({ deleteAllowed: false, deleteRestriction: <a href="/ws/cockpit?node=task&node_view=acceptance">Open acceptance</a> });
    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Updated label" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Name" }), { key: "Enter" });
    expect(props.onPatch).toHaveBeenCalledWith({ name: "Updated label" });
    const dialog = await openConfirmation();
    expect(within(dialog).getByRole("button", { name: "Delete" })).toBeDisabled();
    expect(within(dialog).getByRole("link", { name: "Open acceptance" })).toHaveAttribute("href", "/ws/cockpit?node=task&node_view=acceptance");
    expect(props.onDelete).not.toHaveBeenCalled();
  });

it("does not close a newly opened A confirmation when an old A delete finishes after A→B→A", async () => {
  let complete!: () => void; const onDelete = vi.fn(() => new Promise<void>((resolve) => { complete = resolve; }));
  const view = setup({ onDelete }); const first = await openConfirmation(); fireEvent.click(within(first).getByRole("button", { name: "Delete" }));
  const show = (id: string) => <I18nProvider locale="en" resources={{ en: { cockpit: enCockpit, common: enCommon } }}><CockpitNodePanel {...view.props} node={{ ...node, id }} /></I18nProvider>;
  view.rerender(show("B")); view.rerender(show(node.id)); const second = await openConfirmation();
  await act(async () => { complete(); });
  expect(second).toBeInTheDocument(); expect(view.props.onClose).not.toHaveBeenCalled(); expect(onDelete).toHaveBeenCalledOnce();
});
