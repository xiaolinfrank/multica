import { parseDay, type CockpitTreeNode } from "@multica/core/cockpit";
import type { CockpitNode, CockpitPayment } from "@multica/core/types";

/** Timeline density. Month is the year-at-a-glance read; week zooms in. */
export type CockpitZoom = "month" | "week";

export const DAY_WIDTH: Record<CockpitZoom, number> = { month: 3.5, week: 9 };
export const ROW_HEIGHT = 32;
/** One indent step in the tree pane. */
export const INDENT = 20;
export const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Shortest bar that still reads as a bar. */
export const MIN_BAR_WIDTH = 3;
/**
 * Clearance between two payment markers, amount labels included: below it the
 * later marker slides right so its figure does not land on the previous one.
 */
export const MARKER_CLEARANCE = 78;
/** The board quotes its amounts in 万元 (10k CNY); labels carry the unit. */
export const AMOUNT_UNIT = "万";
/** The module whose rows carry the annual-objective marker, as the source sheet pins it. */
export const GOAL_ROOT_CODE = "L1-02";
export function cockpitWeekTasks(nodes: CockpitNode[], start: string, end: string): CockpitNode[] {
  return nodes.filter((node) => {
    const first = node.start_date ?? node.end_date;
    const last = node.end_date ?? node.start_date;
    return !!first && !!last && !!parseDay(first) && !!parseDay(last)
      && first <= last && first <= end && last >= start;
  });
}

export function matches(node: CockpitNode, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return (
    node.name.toLowerCase().includes(needle) ||
    node.code.toLowerCase().includes(needle) ||
    node.owner.toLowerCase().includes(needle) ||
    node.collaborators.toLowerCase().includes(needle)
  );
}

/**
 * The rows to render: depth-first, minus collapsed subtrees. A search keeps a
 * row when it matches OR when a descendant does — hiding the parent of a hit
 * would leave the hit with no context to read it in — but it does not open a
 * branch the reader collapsed: the search answers "is it here", the chevron
 * answers "show me".
 */
export function visibleRows(
  tree: CockpitTreeNode[],
  collapsed: Set<string>,
  query: string,
): CockpitTreeNode[] {
  const keep = new Set<string>();
  if (query) {
    const walk = (entry: CockpitTreeNode, ancestors: string[]): boolean => {
      const path = [...ancestors, entry.node.id];
      const selfHit = matches(entry.node, query);
      let childHit = false;
      for (const child of entry.children) {
        if (walk(child, path)) childHit = true;
      }
      if (selfHit || childHit) {
        path.forEach((id) => keep.add(id));
        return true;
      }
      return false;
    };
    tree.forEach((entry) => walk(entry, []));
  }

  const rows: CockpitTreeNode[] = [];
  const walk = (entries: CockpitTreeNode[]) => {
    for (const entry of entries) {
      if (query && !keep.has(entry.node.id)) continue;
      rows.push(entry);
      if (!collapsed.has(entry.node.id)) walk(entry.children);
    }
  };
  walk(tree);
  return rows;
}

/**
 * Which rows carry the payment markers: the module rows. One row per module,
 * always the same one — drawing an instalment on whichever row happens to be
 * collapsed right now moves it around as the reader expands the tree, and
 * drawing it on every ancestor draws it three times. Depth is the plan's own
 * shape (three fixed levels), so this needs no code format.
 */
export function carriesMarkers(entry: CockpitTreeNode): boolean {
  return entry.depth === 1;
}

/** Trims "李林（POOL 超饱和）" down to the name the row has space for. */
export function shortOwner(owner: string): string {
  const name = owner.split("(")[0]!.split("（")[0]!.trim();
  return name || owner;
}

export function countPeople(value: string): number {
  return value
    .split(/[、,，;；/]/)
    .map((s) => s.trim())
    .filter(Boolean).length;
}

/** Board amounts carry the programme's own unit, so the unit rides along. */
export function wan(value: number): string {
  // 万元 with up to 分 (6 decimals); trailing zeros would fake a precision
  // the number does not have.
  return `${Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)))}${AMOUNT_UNIT}`;
}

/** Marks a row that has a deadline but no start date. */
export const DEADLINE_GLYPH = "◇";

/** One instalment as a line of text: amount, what it buys, who from, where it stands. */
export function paymentLine(payment: CockpitPayment, node: CockpitNode): string {
  return [
    `${payment.label} ${wan(payment.amount)}`,
    node.name,
    node.vendor,
    node.exec_status,
  ]
    .filter(Boolean)
    .join("｜");
}

/** One instalment as a schedule line: which instalment, when, how much. */
export function instalmentLine(payment: CockpitPayment): string {
  return `${payment.label} ${payment.pay_date ?? "—"}：${wan(payment.amount)}`;
}


export function barCodePlacement(
  barColor: string,
  progress: number,
  width: number,
  codeLen: number,
  roomAfter: number,
): "white" | "dark" | "outside" {
  const light = barColor === "var(--faint-foreground)" || barColor === "var(--muted-foreground)";
  if (light) return "dark";
  const labelPx = 10 + codeLen * 5.6;
  const solidPx = (Math.max(progress, 0) / 100) * width;
  if (solidPx >= labelPx) return "white";
  return roomAfter >= labelPx ? "outside" : "dark";
}
