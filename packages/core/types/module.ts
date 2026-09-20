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
  // No collaboration-space path of its own: a module always lives inside its
  // project, so its deliverables sit in a folder named after the module under
  // the project's 人机协作空间路径. Storing that location again would add a
  // value that can drift from the folder it names.
  created_at: string;
  updated_at: string;
  issue_count: number;
  done_count: number;
}

export interface CreateModuleRequest {
  project_id: string;
  title: string;
  description?: string;
}

// Partial-update payload: omit a key to keep the field, send null to clear it
// (description only). Mirrors UpdateProjectRequest presence semantics.
export interface UpdateModuleRequest {
  title?: string;
  description?: string | null;
  position?: number;
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
