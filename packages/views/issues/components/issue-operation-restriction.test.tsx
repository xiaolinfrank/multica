import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import type { IssueOperationBasis } from "@multica/core/types";
import enIssues from "../../locales/en/issues.json";
import { IssueOperationRestriction, type IssueOperationObservation } from "./issue-operation-restriction";

vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ issueDetail: (id: string) => `/ws/issues/${id}`, cockpit: () => "/ws/cockpit" }) }));
vi.mock("../../navigation", () => ({ AppLink: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a> }));

function basis(): IssueOperationBasis {
  const allowed = { state: "allowed" as const, reason_codes: [] };
  return { issue_id: "issue-1", issue_revision: 1, availability: "available", status: { ...allowed, allowed_categories: ["unstarted", "started"] }, assignee: allowed, scope: allowed, parent: allowed, primary: allowed, delete: allowed, execution: allowed, targets: [], targets_total: 0 };
}
function setup(observation: IssueOperationObservation, operation: "scope" | "delete" = "scope") {
  return render(<I18nProvider locale="en" resources={{ en: { issues: enIssues } }}><IssueOperationRestriction observation={observation} operation={operation} /></I18nProvider>);
}
describe("issue operation recovery", () => {
  it("explains an allowed parent detach without claiming the retained artifact scope can be released", () => {
    const value = basis(); value.scope = { state: "allowed", reason_codes: ["parent_scope_requires_detach"] };
    value.targets = [{ kind: "issue", issue_id: "parent-1", label: "DEL-1 Parent delivery", purpose: "parent" }]; value.targets_total = 1;
    setup({ basis: value, pending: false, error: false, retry: vi.fn() });
    expect(screen.getByText(enIssues.operation_basis.parent_detach)).toBeVisible();
    expect(screen.getByRole("link", { name: "DEL-1 Parent delivery (new tab)" })).toHaveAttribute("href", "/ws/issues/parent-1");
    expect(screen.getByRole("link", { name: "DEL-1 Parent delivery (new tab)" })).toHaveAttribute("target", "_blank");
    expect(screen.queryByText(enIssues.operation_basis.retained_scope)).not.toBeInTheDocument();
  });
  it("keeps fixed version targets exact and gives unknown target kinds no invented navigation", () => {
    const value = basis(); value.delete = { state: "blocked", reason_codes: ["retained_formal_history"] };
    value.targets = [{ kind: "artifact_version", artifact_id: "artifact-1", version_id: "fixed-1", label: "Version 1", purpose: "history" }, { kind: "future_object", label: "Unknown object", purpose: "future" }]; value.targets_total = 2;
    setup({ basis: value, pending: false, error: false, retry: vi.fn() }, "delete");
    expect(screen.getByText(enIssues.operation_basis.retained_formal)).toBeVisible();
    expect(screen.getByRole("link", { name: "Version 1 (new tab)" })).toHaveAttribute("href", "/ws/cockpit?tab=artifacts&artifact=artifact-1&artifact_version=fixed-1");
    expect(screen.queryByRole("link", { name: "Unknown object" })).not.toBeInTheDocument();
    expect(screen.getByText("Unknown object")).toBeVisible();
  });
  it("opens the exact retained input manifest and meeting resource recovery destinations", () => {
    const value = basis(); value.delete = { state: "blocked", reason_codes: ["retained_input_history", "meeting_input_references"] };
    value.targets = [{ kind: "issue", issue_id: "issue-1", view: "inputs", version_id: "manifest-1", label: "Saved inputs 1", purpose: "input_manifest" },
      { kind: "meeting", meeting_id: "meeting-1", view: "resources", label: "Meeting materials", purpose: "input_reference" }]; value.targets_total = 2;
    setup({ basis: value, pending: false, error: false, retry: vi.fn() }, "delete");
    expect(screen.getByText(enIssues.operation_basis.retained_input_history)).toBeVisible();
    expect(screen.getByText(enIssues.operation_basis.meeting_input_references)).toBeVisible();
    expect(screen.getByRole("link", { name: "Saved inputs 1 (new tab)" })).toHaveAttribute("href", "/ws/issues/issue-1?input_manifest=manifest-1");
    expect(screen.getByRole("link", { name: "Meeting materials (new tab)" })).toHaveAttribute("href", "/ws/cockpit?meeting=meeting-1&meeting_view=resources");
  });
  it("keeps a failed read actionable and does not show stale available facts", async () => {
    const retry = vi.fn(); setup({ basis: basis(), pending: false, error: true, retry });
    expect(screen.getByRole("alert")).toHaveTextContent(enIssues.operation_basis.failed);
    await userEvent.click(screen.getByRole("button", { name: "Check again" })); expect(retry).toHaveBeenCalledOnce();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
