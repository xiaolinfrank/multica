import { it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { I18nProvider } from "@multica/core/i18n/react";
import type { CockpitBoard, CockpitNode } from "@multica/core/types";
import enCockpit from "../../locales/en/cockpit.json";
import { CockpitGantt } from "./cockpit-gantt";

it("wires progress, current progress, deliverables, linked issues and weekly payments even when tasks are collapsed", async () => {
  const base: CockpitNode = { id: "root", cockpit_id: "cp", parent_id: null, code: "L1", name: "Branch", position: 0, color: "", owner: "", collaborators: "", start_date: null, end_date: null, status: "", progress: 0, deliverable: "", dependencies: "", note: "", current_progress: "", vendor: "", budget_category: "", budget_amount: null, exec_status: "", contract: "", source: "", updated_by_type: "", updated_by_id: null, created_at: "", updated_at: "" };
  const board: CockpitBoard = { cockpit: { id: "cp", workspace_id: "ws", title: "Board", goal_title: "Goal", goal_date: "2026-12-31", summary_overall: "", summary_next: "", summary_support: "", basis: "", created_at: "", updated_at: "" }, nodes: [base, { ...base, id: "task", parent_id: "root", code: "L3", name: "Validation", start_date: "2026-09-14", end_date: "2026-09-20", progress: 42, current_progress: "Reviewing evidence", deliverable: "Validated dataset" }], payments: [{ id: "pay", node_id: "task", label: "Acceptance payment", pay_date: "2026-09-16", amount: 25, position: 0 }, { id: "later", node_id: "task", label: "Later payment", pay_date: "2026-09-21", amount: 10, position: 1 }], issue_links: [{ id: "link", node_id: "task", issue_id: "issue", issue_number: 42, issue_identifier: "BIO-42", issue_title: "Evidence review", issue_status: "In progress", position: 0 }], milestones: [], meetings: [] };
  const select = vi.fn();
  render(<I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}><CockpitGantt board={board} today="2026-09-18" zoom="week" query="" rootIds={new Set()} collapsed={new Set(["root"])} onToggleCollapse={vi.fn()} onSelect={select} selectedId={null} onPatchNode={vi.fn()} statusSuggestions={[]} showFinance={false} scrollToTodayNonce={0} focusTarget={null} /></I18nProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Week · 2026-09-14 – 2026-09-20" }));
  const dialog = within(await screen.findByRole("dialog"));
  expect(dialog.getByText("Progress: 42%")).toBeInTheDocument();
  expect(dialog.getByText(/Reviewing evidence/)).toBeInTheDocument();
  expect(dialog.getByText(/Validated dataset/)).toBeInTheDocument();
  expect(dialog.getByText(/BIO-42 Evidence review/)).toBeInTheDocument();
  expect(dialog.getByText("2026-09-16 · 25")).toBeInTheDocument();
  expect(dialog.queryByText(/Later payment/)).not.toBeInTheDocument();
  fireEvent.click(dialog.getByRole("button", { name: "Validation · Acceptance payment" }));
  expect(select).toHaveBeenCalledWith("task");
});
