import type { Module } from "../types";
import { moduleTitleNumberPrefix } from "../modules/title-number";

// Where a work item's issues are filed.
//
// The board and the issue tracker are numbered by the same outline: a gantt row
// reads "01.01.01", and the module that carries it out is titled "01.01 回顾性
// 队列数据集". The row code is therefore already the address — its leading
// segments name the module, and the module carries its own project — so
// creating an issue from a work item needs no second mapping table to keep in
// sync with the board.
//
// The code used here is the DISPLAY code (buildCockpitDisplayCodes), not the
// stored one: stored codes carry the programme's history ("L3-01-08" for what
// is now the third task of 01.01), while the display code is the row's position
// in the shipped tree, which is what the module numbering follows and what the
// reader sees in the leftmost column.

/** The fields of a module this resolution reads. */
export type CockpitFilingModule = Pick<Module, "id" | "project_id" | "title">;

export interface CockpitNodeIssueFiling {
  project_id: string;
  module_id: string;
  /** What the new issue's title opens on — the work item's own row code. */
  title: string;
}

/** A row code's parent number: "01.01.01" → "01.01". "" when it has none. */
function parentNumber(code: string): string {
  const match = /^(\d+(?:\.\d+)*)\.\d+$/.exec(code);
  return match ? match[1]! : "";
}

/**
 * Where an issue created from this work item belongs, or null when the board's
 * numbering does not name a module — a mainline or a direction row, whose
 * number is a project rather than a module, and anything the programme numbers
 * some other way.
 *
 * Null is how the affordance is withheld: an entry point that cannot say which
 * module it files into is not offering what it claims. A number that names more
 * than one module is the same case — the board cannot choose for the user.
 */
export function cockpitNodeIssueFiling(
  displayCode: string,
  modules: readonly CockpitFilingModule[],
): CockpitNodeIssueFiling | null {
  const code = displayCode.trim();
  const number = parentNumber(code);
  if (!number) return null;
  const matches = modules.filter((m) => moduleTitleNumberPrefix(m.title) === number);
  if (matches.length !== 1) return null;
  const module = matches[0]!;
  return { project_id: module.project_id, module_id: module.id, title: code };
}
