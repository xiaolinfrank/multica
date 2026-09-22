/**
 * @vitest-environment jsdom
 *
 * The parts of the table's row drag that decide things: which pointer presses
 * may start one, which droppables a gesture is scored against, which axis it
 * may travel on, and what write a drop turns into. The gesture itself is
 * exercised through the table in table-view-module-grouping.test.tsx.
 */
import { describe, expect, it } from "vitest";
import type { Active, DroppableContainer } from "@dnd-kit/core";
import {
  ROW_DRAG_TYPE,
  ROW_DROP_TYPE,
  moduleDropUpdates,
  restrictColumnDragToHorizontalAxis,
  tableCollisionDetection,
  tableDragMayStart,
} from "./table-row-drag";

function rowWith(inner: string) {
  const table = document.createElement("table");
  const body = document.createElement("tbody");
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.innerHTML = inner;
  row.append(cell);
  body.append(row);
  table.append(body);
  document.body.append(table);
  return { row, target: cell.firstElementChild ?? cell };
}

describe("tableDragMayStart", () => {
  it("starts from the body of a row", () => {
    const { row, target } = rowWith("<span>Collect samples</span>");
    expect(tableDragMayStart(row, target)).toBe(true);
  });

  it("stands down for the controls inside a row", () => {
    for (const html of [
      "<button>Edit</button>",
      '<a href="#">MUL-1</a>',
      '<input type="checkbox" />',
      '<div contenteditable="true">Title</div>',
      "<button><span>Nested label</span></button>",
    ]) {
      const { row, target } = rowWith(html);
      // The press may land on something inside the control, which is why the
      // check walks up rather than looking at the target alone.
      const deepest = target.querySelector("*") ?? target;
      expect(tableDragMayStart(row, deepest)).toBe(false);
    }
  });

  it("leaves a column header's own handle alone", () => {
    // The header's listeners sit on the grip button itself, so the host is not
    // a row and the row rule must not reach it.
    const handle = document.createElement("button");
    expect(tableDragMayStart(handle, handle)).toBe(true);
  });
});

function container(id: string, type?: string): DroppableContainer {
  return {
    id,
    key: id,
    data: { current: type ? { type } : {} },
    disabled: false,
    node: { current: null },
    rect: { current: { top: 0, left: 0, right: 10, bottom: 10, width: 10, height: 10 } },
  } as unknown as DroppableContainer;
}

function collisionArgs(activeType: string | undefined, pointer: { x: number; y: number }) {
  return {
    active: { id: "a", data: { current: activeType ? { type: activeType } : {} } } as unknown as Active,
    collisionRect: { top: 0, left: 0, right: 10, bottom: 10, width: 10, height: 10 },
    droppableRects: new Map([
      ["module:none", { top: 0, left: 0, right: 10, bottom: 10, width: 10, height: 10 }],
      ["title", { top: 0, left: 0, right: 10, bottom: 10, width: 10, height: 10 }],
    ]),
    droppableContainers: [
      container("module:none", ROW_DROP_TYPE),
      container("title"),
    ],
    pointerCoordinates: pointer,
  } as unknown as Parameters<typeof tableCollisionDetection>[0];
}

describe("tableCollisionDetection", () => {
  it("scores a row only against module drop targets", () => {
    const hits = tableCollisionDetection(
      collisionArgs(ROW_DRAG_TYPE, { x: 5, y: 5 }),
    );
    expect(hits.map((hit) => hit.id)).toEqual(["module:none"]);
  });

  it("scores a column only against columns", () => {
    const hits = tableCollisionDetection(collisionArgs(undefined, { x: 5, y: 5 }));
    expect(hits.map((hit) => hit.id)).toEqual(["title"]);
  });

  it("falls back to the nearest target when the pointer is outside them all", () => {
    const hits = tableCollisionDetection(
      collisionArgs(ROW_DRAG_TYPE, { x: 500, y: 500 }),
    );
    expect(hits.map((hit) => hit.id)).toEqual(["module:none"]);
  });
});

describe("restrictColumnDragToHorizontalAxis", () => {
  const transform = { x: 12, y: 40, scaleX: 1, scaleY: 1 };
  const args = (type?: string) =>
    ({
      active: { data: { current: type ? { type } : {} } },
      transform,
    }) as unknown as Parameters<typeof restrictColumnDragToHorizontalAxis>[0];

  it("lets a row travel down the table", () => {
    expect(restrictColumnDragToHorizontalAxis(args(ROW_DRAG_TYPE)).y).toBe(40);
  });

  it("keeps a column on its own strip", () => {
    expect(restrictColumnDragToHorizontalAxis(args()).y).toBe(0);
  });
});

describe("moduleDropUpdates", () => {
  it("sends the module with the project that owns it", () => {
    expect(
      moduleDropUpdates({ module_id: "m1" }, "m2", { project_id: "p2" }),
    ).toEqual({ project_id: "p2", module_id: "m2" });
  });

  it("clears the module without unfiling the issue from its project", () => {
    // "No module" spans projects, so it names none: a null project_id here
    // would detach the issue from its project too.
    expect(moduleDropUpdates({ module_id: "m1" }, null, undefined)).toEqual({
      module_id: null,
    });
  });

  it("is nothing to write when the row is already there", () => {
    expect(moduleDropUpdates({ module_id: "m1" }, "m1", { project_id: "p1" })).toBeNull();
    expect(moduleDropUpdates({ module_id: null }, null, undefined)).toBeNull();
  });
});
