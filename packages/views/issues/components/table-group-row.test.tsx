import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithI18n } from "../../test/i18n";
import { IssueTableGroupRow } from "./table-view";

describe("IssueTableGroupRow", () => {
  it("keeps full-width row controls anchored during horizontal scrolling", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    renderWithI18n(
      <table>
        <tbody>
          <IssueTableGroupRow
            group={{
              kind: "group",
              key: "status:backlog",
              label: "Backlog",
              count: 13,
              collapsed: false,
            }}
            colSpan={3}
            onToggle={onToggle}
          />
        </tbody>
      </table>,
    );

    const group = screen.getByRole("button", { name: /Backlog\s*13/ });
    expect(group.parentElement).toHaveClass("sticky", "left-4", "w-fit");

    await user.click(group);
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("offers a create action that does not also toggle the group", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const onCreate = vi.fn();
    renderWithI18n(
      <table>
        <tbody>
          <IssueTableGroupRow
            group={{
              kind: "group",
              key: "module:m1",
              label: "Parser rewrite",
              count: 0,
              collapsed: false,
              value: { kind: "module", module_id: "m1" },
            }}
            colSpan={3}
            onToggle={onToggle}
            onCreate={onCreate}
          />
        </tbody>
      </table>,
    );

    // The toggle keeps its own accessible name: nesting the add button inside
    // it would fold "Add issue to …" into the name the group is read by.
    expect(
      screen.getByRole("button", { name: /Parser rewrite\s*0/ }),
    ).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Add issue to Parser rewrite" }),
    );
    expect(onCreate).toHaveBeenCalledOnce();
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("leaves the create action out when the group cannot take one", () => {
    renderWithI18n(
      <table>
        <tbody>
          <IssueTableGroupRow
            group={{
              kind: "group",
              key: "status:backlog",
              label: "Backlog",
              count: 13,
              collapsed: false,
            }}
            colSpan={3}
            onToggle={() => {}}
          />
        </tbody>
      </table>,
    );
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
});
