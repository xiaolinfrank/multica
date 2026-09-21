import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nProvider } from "@multica/core/i18n/react";
import enCockpit from "../../locales/en/cockpit.json";
import enCommon from "../../locales/en/common.json";
import type { CockpitNode } from "@multica/core/types";
import { CockpitNodePanel, type CockpitNodePanelProps } from "./cockpit-node-panel";

vi.mock("./cockpit-issue-links", () => ({
  CockpitIssueLinks: ({ disabled, onLink, onUnlink }: {
    disabled?: boolean; onLink: (id: string) => void; onUnlink: (id: string) => void;
  }) => <div>Issue links
    <button disabled={disabled} onClick={() => onLink("issue-2")}>Link issue</button>
    <button disabled={disabled} onClick={() => onUnlink("issue-1")}>Unlink issue</button>
  </div>,
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
    node, parent: undefined, depth: 2, payments: [], links: [], isBranch: false,
    statusSuggestions: [], execStatusSuggestions: [], budgetCategorySuggestions: [], ownerSuggestions: [],
    vendorSuggestions: [],
    onPatch: vi.fn(), onDelete: vi.fn().mockResolvedValue(undefined), onClose: vi.fn(),
    deleteConfirmationDescription: "This permanently deletes the item and its payments and issue links.",
    onLinkIssue: vi.fn(), onUnlinkIssue: vi.fn(), onCreatePayment: vi.fn(),
    onPatchPayment: vi.fn(), onDeletePayment: vi.fn(), ...overrides,
  };
  const view = render(
    <I18nProvider locale="en" resources={{ en: { cockpit: enCockpit, common: enCommon } }}>
      <CockpitNodePanel {...props} />
    </I18nProvider>,
  );
  return { ...view, props };
}

async function openConfirmation(branch = false) {
  fireEvent.click(screen.getByRole("button", { name: branch ? "Delete this branch" : "Delete this item" }));
  return screen.findByRole("alertdialog");
}

describe("CockpitNodePanel", () => {
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

  it.each([0, 1, 2])("keeps issue management wired at depth %i", (depth) => {
    const { props } = setup({ depth });
    fireEvent.click(screen.getByRole("button", { name: "Link issue" }));
    fireEvent.click(screen.getByRole("button", { name: "Unlink issue" }));
    expect(props.onLinkIssue).toHaveBeenCalledWith("issue-2");
    expect(props.onUnlinkIssue).toHaveBeenCalledWith("issue-1");
  });

  it.each([0, 1, 2])("disables issue management in read-only depth %i", (depth) => {
    const { props } = setup({ depth, readOnly: true });
    expect(screen.getByText("Issue links")).toBeInTheDocument();
    const link = screen.getByRole("button", { name: "Link issue" });
    const unlink = screen.getByRole("button", { name: "Unlink issue" });
    expect(link).toBeDisabled();
    expect(unlink).toBeDisabled();
    fireEvent.click(link);
    fireEvent.click(unlink);
    expect(props.onLinkIssue).not.toHaveBeenCalled();
    expect(props.onUnlinkIssue).not.toHaveBeenCalled();
  });

  const payments = [{ id: "pay-1", node_id: "task", label: "First", pay_date: null, amount: 15, position: 0 }];

  it.each([0, 1])("preserves editable existing instalments at structural depth %i", (depth) => {
    const { props } = setup({ depth, payments });
    expect(screen.getByText("Instalments")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Vendor" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Amount" }));
    const input = screen.getByRole("spinbutton", { name: "Amount" });
    fireEvent.change(input, { target: { value: "20" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onPatchPayment).toHaveBeenCalledWith("pay-1", { amount: 20 });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(props.onCreatePayment).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Delete instalment" }));
    expect(props.onDeletePayment).toHaveBeenCalledWith("pay-1");
  });

  it.each([0, 1])("keeps existing structural instalments read-only at depth %i", (depth) => {
    setup({ depth, payments, readOnly: true });
    expect(screen.getByText("First")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Amount" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Add" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete instalment" })).not.toBeInTheDocument();
  });

  it("shows full task details and honors read-only mode", () => {
    const { props } = setup({ readOnly: true });
    expect(screen.getByText("Vendor text")).toBeInTheDocument();
    expect(screen.getByText("Deliverable text")).toBeInTheDocument();
    expect(screen.getByText("Issue links")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete this item" })).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(1);
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
