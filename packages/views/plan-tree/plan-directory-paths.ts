import type { CockpitNode } from "@multica/core/types";

/**
 * The absolute delivery folder of every module and work-item row, composed from
 * the plan read and the projects' collaboration roots.
 *
 * This is the tree's whole relationship with the collaboration space: a path
 * the reader can act on, derived from data already in hand. Nothing here asks
 * the disk — a folder's actual state is the panel's request, not the tree's.
 *
 * A row with no collaboration root, no module folder, or no folder of its own
 * is absent from the map; the caller shows the action disabled rather than a
 * path that would not resolve.
 */
export function planDirectoryPaths(
  nodes: readonly CockpitNode[],
  collabByProject: ReadonlyMap<string, string>,
): Map<string, string> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const paths = new Map<string, string>();
  for (const node of nodes) {
    const chain: CockpitNode[] = [];
    let current: CockpitNode | undefined = node;
    // The tree is acyclic (the server refuses cycles), but a malformed read
    // must not spin: stop at 32 levels, deeper than any real plan.
    for (let depth = 0; current && depth < 32; depth++) {
      chain.push(current);
      current = current.parent_id ? byId.get(current.parent_id) : undefined;
    }
    const root = chain[chain.length - 1];
    if (!root || chain.length < 2) continue; // the project row owns no folder
    const projectId = root.project_id ?? chain.find((entry) => entry.project_id)?.project_id ?? null;
    const collab = projectId ? (collabByProject.get(projectId) ?? "").trim().replace(/\/+$/, "") : "";
    if (!collab) continue;
    const moduleRow = chain[chain.length - 2];
    const moduleDir = (moduleRow?.directory_name ?? "").trim();
    if (!moduleDir) continue;
    const ownDir = (node.directory_name ?? "").trim();
    if (chain.length === 2) {
      // A module row: `<collab>/<module>`.
      paths.set(node.id, `${collab}/${moduleDir}`);
      continue;
    }
    if (chain.length === 3 && ownDir) {
      // A work item: `<collab>/<module>/<work item>`.
      paths.set(node.id, `${collab}/${moduleDir}/${ownDir}`);
    }
  }
  return paths;
}
