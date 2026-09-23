import type { CockpitNode, Module } from "../types";
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
// The display code is the join key by design: the module numbering follows the
// shipped tree's numbering, and so do the collaboration-space folders on NAS.
// But merged summary rows renumber the tree, and a module list that has not
// been re-cut to match makes a display number name the wrong module. So the
// row's stored direction code rides along as the cross-check: when both keys
// resolve to different modules the numberings have drifted, and filing
// withdraws rather than guess.

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

const DIRECTION_CODE_RE = /^\d{2}\.\d{2}$/;

/**
 * The stored code of the direction a node hangs under ("L3-02-16" → "02.10").
 * The climb starts at the node's parent — a direction row itself hangs under a
 * mainline, so it gets null and stays non-fileable whatever its own code says.
 * The module titles follow the shipped display numbering; this stored key is
 * the row's true address, and the cross-check exists to catch the two
 * numberings drifting apart. A parent cycle (creatable by two writes) yields
 * null rather than spinning — the tree builder breaks the same cycles.
 */
export function cockpitStoredDirectionCode(
  node: CockpitNode,
  nodeById: Map<string, CockpitNode>,
): string | null {
  const seen = new Set<string>([node.id]);
  let cursor = node.parent_id ? nodeById.get(node.parent_id) : undefined;
  while (cursor) {
    if (DIRECTION_CODE_RE.test(cursor.code)) return cursor.code;
    if (seen.has(cursor.id)) return null;
    seen.add(cursor.id);
    cursor = cursor.parent_id ? nodeById.get(cursor.parent_id) : undefined;
  }
  return null;
}

/**
 * Where an issue created from this work item belongs, or null when the board's
 * numbering does not name a module — a mainline or a direction row, whose
 * number is a project rather than a module, and anything the programme numbers
 * some other way.
 *
 * Null is how the affordance is withheld: an entry point that cannot say which
 * module it files into is not offering what it claims. A mainline or direction
 * row is never fileable — its number names a project — whatever the stored key
 * says. A number that names more than one module on the key being used is the
 * same case; when one key is ambiguous and the other names exactly one module,
 * the unambiguous one answers. And when both keys each name a DIFFERENT module,
 * the two numberings have drifted apart (a summary merge the module list has
 * not caught up with); null again, because either choice would be a silent
 * wrong answer.
 */
export function cockpitNodeIssueFiling(
  displayCode: string,
  modules: readonly CockpitFilingModule[],
  storedDirectionCode?: string | null,
): CockpitNodeIssueFiling | null {
  const code = displayCode.trim();
  // A mainline or a direction names a project, not a module — never file them,
  // even if a stored direction key would resolve.
  if (DIRECTION_CODE_RE.test(code)) return null;
  const number = parentNumber(code);
  if (!number) return null;
  const byNumber = (n: string) =>
    modules.filter((m) => moduleTitleNumberPrefix(m.title) === n);
  const displayMatches = byNumber(number);
  const storedMatches = storedDirectionCode ? byNumber(storedDirectionCode) : [];
  // Both keys resolved: they must name the same module. A disagreement means
  // the display number now points at a different module than the row's true
  // direction — withhold instead of filing into it.
  if (
    displayMatches.length === 1 &&
    storedMatches.length === 1 &&
    displayMatches[0]!.id !== storedMatches[0]!.id
  ) {
    return null;
  }
  const pick =
    displayMatches.length === 1
      ? displayMatches[0]!
      : storedMatches.length === 1
        ? storedMatches[0]!
        : null;
  if (!pick) return null;
  return { project_id: pick.project_id, module_id: pick.id, title: code };
}
