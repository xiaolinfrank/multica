// Module: the middle layer of Project → Module → Issue. A module groups the
// issues of ONE project (app-layer relation — no FK), so every cache that
// holds modules is workspace-scoped and invalidated like project caches.

export interface Module {
  id: string;
  workspace_id: string;
  project_id: string;
  title: string;
  description: string | null;
  position: number;
  // Absolute directory on shared storage ("人机协作空间路径") for this module's
  // deliverables — the project's collaboration space narrowed to one module.
  // The project keeps its own path; this one does not replace it.
  collab_path: string | null;
  created_at: string;
  updated_at: string;
  issue_count: number;
  done_count: number;
}

export interface CreateModuleRequest {
  project_id: string;
  title: string;
  description?: string;
  collab_path?: string;
}

// Partial-update payload: omit a key to keep the field, send null to clear it
// (description and collab_path only). Mirrors UpdateProjectRequest presence
// semantics.
export interface UpdateModuleRequest {
  title?: string;
  description?: string | null;
  position?: number;
  // Omit the key to leave the path untouched; send null (or "") to clear it.
  collab_path?: string | null;
}

export interface ListModulesResponse {
  modules: Module[];
  total: number;
}

/** Single-module envelope: {"module": {...}} — the response shape of
 * GET/POST/PUT /api/modules[...], mirroring how projects are wrapped. */
export interface ModuleResponse {
  module: Module;
}

/** Response of PUT /api/modules/reorder — the modules in their new order. */
export interface ReorderModulesResponse {
  modules: Module[];
}
