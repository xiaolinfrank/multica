import type { CockpitNode, Module } from "../types";

export type CockpitFilingModule = Pick<Module, "id" | "project_id" | "title">;
type BindingNode = Pick<CockpitNode, "id" | "parent_id" | "project_id" | "module_id" | "code">;

export type CockpitNodeBinding =
  | { status: "unbound" | "invalid" }
  | { status: "bound"; project_id: string; module_id: string | null; source_node_id: string };

export interface CockpitNodeIssueFiling {
  project_id: string;
  module_id: string;
  title: string;
}

/** Read the UUID ancestry, validating the whole path before exposing a filing destination. */
export function resolveCockpitNodeBinding(
  node: BindingNode,
  nodes: ReadonlyMap<string, BindingNode>,
  modules: readonly CockpitFilingModule[],
): CockpitNodeBinding {
  const visited = new Set<string>();
  let current: BindingNode | undefined = node;
  let binding: Extract<CockpitNodeBinding, { status: "bound" }> | undefined;
  while (current) {
    if (visited.has(current.id)) return { status: "invalid" };
    visited.add(current.id);
    const projectId = current.project_id ?? null;
    const moduleId = current.module_id ?? null;
    if (moduleId) {
      const module = modules.find((entry) => entry.id === moduleId);
      if (!module || !projectId || module.project_id !== projectId || binding) return { status: "invalid" };
    }
    if (projectId) {
      if (binding && binding.project_id !== projectId) return { status: "invalid" };
      binding ??= { status: "bound", project_id: projectId, module_id: moduleId, source_node_id: current.id };
    }
    if (!current.parent_id) break;
    current = nodes.get(current.parent_id);
    if (!current) return { status: "invalid" };
  }
  return binding ?? { status: "unbound" };
}

/** Structural mapping rows are not execution tasks. Names and WBS numbering never select a module. */
export function cockpitNodeIssueFiling(
  node: BindingNode,
  nodes: ReadonlyMap<string, BindingNode>,
  modules: readonly CockpitFilingModule[],
  displayCode = node.code,
): CockpitNodeIssueFiling | null {
  if (node.project_id || node.module_id) return null;
  const binding = resolveCockpitNodeBinding(node, nodes, modules);
  if (binding.status !== "bound" || !binding.module_id) return null;
  return { project_id: binding.project_id, module_id: binding.module_id, title: displayCode };
}
