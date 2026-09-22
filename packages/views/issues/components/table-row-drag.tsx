"use client";

import { cloneElement } from "react";
import {
  PointerSensor,
  closestCenter,
  pointerWithin,
  useDraggable,
  useDroppable,
  type CollisionDetection,
  type Modifier,
  type PointerSensorOptions,
} from "@dnd-kit/core";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import type { Issue, Module, UpdateIssueRequest } from "@multica/core/types";
import { cn } from "@multica/ui/lib/utils";

// ---- dragging a row into another module ------------------------------------
//
// Module grouping is the one table grouping whose headers stand for a place an
// issue is FILED rather than a value it happens to carry, so it is the one
// where dropping a row under a different header is a move the user means. The
// gesture shares the table's existing DndContext with column reordering —
// nesting a second one inside it would capture the header handles, which
// resolve their sortable through the nearest context — and the two are told
// apart by the `type` on their drag data.

export const ROW_DRAG_TYPE = "issue-row";
export const ROW_DROP_TYPE = "module-drop";

export type IssueRowDragData = {
  type: typeof ROW_DRAG_TYPE;
  issue: Issue;
  groupKey: string | null;
};

export type ModuleDropData = {
  type: typeof ROW_DROP_TYPE;
  groupKey: string;
};

/** Controls inside a row own their own pointer gestures. A row drags from
 *  anywhere on it, so it has to stand down for them; a column header does not,
 *  because its listeners live on the grip button itself. `currentTarget` is
 *  what tells the two apart — it is the element the listeners were put on. */
const ROW_DRAG_EXEMPT_SELECTOR =
  'button, a, input, textarea, select, [contenteditable="true"], [role="menu"], [role="menuitem"], [role="dialog"], [role="checkbox"]';

export function tableDragMayStart(
  host: EventTarget | null,
  target: EventTarget | null,
): boolean {
  if (!(host instanceof HTMLTableRowElement)) return true;
  return !(
    target instanceof Element && target.closest(ROW_DRAG_EXEMPT_SELECTOR)
  );
}

export class TableDragSensor extends PointerSensor {
  static activators = [
    {
      eventName: "onPointerDown" as const,
      handler: (event: React.PointerEvent, { onActivation }: PointerSensorOptions) => {
        const native = event.nativeEvent;
        if (!native.isPrimary || native.button !== 0) return false;
        if (!tableDragMayStart(event.currentTarget, event.target)) return false;
        onActivation?.({ event: native });
        return true;
      },
    },
  ];
}

/** Columns travel sideways and rows travel down the table, so the axis lock
 *  the header drag needs has to step aside for a row. */
export const restrictColumnDragToHorizontalAxis: Modifier = (args) =>
  args.active?.data.current?.type === ROW_DRAG_TYPE
    ? args.transform
    : restrictToHorizontalAxis(args);

/** Both gestures register droppables in the same context, so each is scored
 *  only against its own targets: a header must not be a candidate slot for a
 *  row, nor a row for a header. Rows prefer what the pointer is actually
 *  inside — with group headers and data rows stacked, the nearest centre is
 *  regularly a row the pointer has already left. */
export const tableCollisionDetection: CollisionDetection = (args) => {
  const draggingRow = args.active.data.current?.type === ROW_DRAG_TYPE;
  const scoped = {
    ...args,
    droppableContainers: args.droppableContainers.filter(
      (container) =>
        (container.data.current?.type === ROW_DROP_TYPE) === draggingRow,
    ),
  };
  if (!draggingRow) return closestCenter(scoped);
  const pointer = pointerWithin(scoped);
  return pointer.length > 0 ? pointer : closestCenter(scoped);
};

/**
 * Wraps a row the table already built, rather than rebuilding it: the cells,
 * the click handling and the pinned-column styling stay DataTable's, and this
 * only adds the drag. `ref` and `data-index` arrive from DataTable's clone and
 * are passed down to the same <tr>, so the virtualizer keeps measuring it.
 */
export function DraggableIssueRow({
  id,
  data,
  children,
  ref,
  ...rest
}: {
  id: string;
  data: IssueRowDragData;
  children: React.ReactElement;
  ref?: React.Ref<HTMLTableRowElement>;
} & React.ComponentProps<"tr">) {
  const { setNodeRef: setDragRef, listeners, isDragging } = useDraggable({ id, data });
  // Every row in a group is a target for that group, so the pointer does not
  // have to find a header that may be far above the rows it is over. The id is
  // the row's, not the group's — a droppable id is unique per context, and the
  // header registers the group's own — while the data says which group a drop
  // here means.
  const { setNodeRef: setDropRef } = useDroppable({
    id: `drop:${id}`,
    disabled: data.groupKey === null,
    data: { type: ROW_DROP_TYPE, groupKey: data.groupKey ?? "" } satisfies ModuleDropData,
  });
  const childProps = children.props as React.ComponentProps<"tr">;
  return cloneElement(children, {
    ...rest,
    ref: (node: HTMLTableRowElement | null) => {
      setDragRef(node);
      setDropRef(node);
      if (typeof ref === "function") ref(node);
      else if (ref) (ref as React.RefObject<HTMLTableRowElement | null>).current = node;
    },
    ...listeners,
    // The row keeps its own semantics: dnd-kit's `attributes` would put
    // role="button" on a <tr> and take it out of the table for a screen
    // reader. The drag is a pointer affordance here; every move it can make
    // is also available from the module cell's picker.
    className: cn(childProps.className, isDragging && "opacity-40"),
  } as Partial<React.ComponentProps<"tr">>);
}

/** Group headers are drop targets too — the natural place to aim for when the
 *  group is collapsed or empty, which is exactly when it has no rows to hit. */
export function DroppableGroupRow({
  groupKey,
  isDropTarget,
  children,
  ref,
  ...rest
}: {
  groupKey: string;
  /** True while the drop under the pointer resolves to this group — including
   *  when the pointer is over one of the group's rows rather than its header.
   *  The header is where the highlight goes: it is what names the module. */
  isDropTarget: boolean;
  children: React.ReactElement;
  ref?: React.Ref<HTMLTableRowElement>;
} & React.ComponentProps<"tr">) {
  const { setNodeRef } = useDroppable({
    id: `drop:${groupKey}`,
    data: { type: ROW_DROP_TYPE, groupKey } satisfies ModuleDropData,
  });
  const childProps = children.props as React.ComponentProps<"tr">;
  return cloneElement(children, {
    ...rest,
    ref: (node: HTMLTableRowElement | null) => {
      setNodeRef(node);
      if (typeof ref === "function") ref(node);
      else if (ref) (ref as React.RefObject<HTMLTableRowElement | null>).current = node;
    },
    className: cn(
      childProps.className,
      isDropTarget && "bg-primary/15 hover:bg-primary/15",
    ),
  } as Partial<React.ComponentProps<"tr">>);
}


/**
 * The write that files an issue into the module a drop landed on, or null when
 * the drop changes nothing.
 *
 * The module carries its own project, and the update path validates the two
 * against each other — so a module move sends both. "No module" carries none:
 * that group spans projects, and a null project_id there would unfile the
 * issue from its project instead of only clearing its module.
 */
export function moduleDropUpdates(
  issue: Pick<Issue, "module_id">,
  targetModuleId: string | null,
  targetModule: Pick<Module, "project_id"> | undefined,
): Pick<UpdateIssueRequest, "project_id" | "module_id"> | null {
  if ((issue.module_id ?? null) === targetModuleId) return null;
  return {
    ...(targetModule ? { project_id: targetModule.project_id } : {}),
    module_id: targetModuleId,
  };
}
