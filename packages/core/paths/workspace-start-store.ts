import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { defaultStorage } from "../platform/storage";
import { normalizeWorkspaceStartPage, type WorkspaceStartPage } from "./workspace-start";
interface WorkspaceStartState {
  page: WorkspaceStartPage;
  setPage: (page: WorkspaceStartPage) => void;
}
// Device preference affects new entry only, never an existing page or tab.
export const useWorkspaceStartStore = create<WorkspaceStartState>()(persist((set) => ({
  page: "cockpit", setPage: (page) => set({ page: normalizeWorkspaceStartPage(page) }),
}), {
  name: "multica_workspace_start",
  storage: createJSONStorage(() => defaultStorage),
  partialize: ({ page }) => ({ page }),
  merge: (persisted, current) => ({ ...current, page: normalizeWorkspaceStartPage(
    persisted && typeof persisted === "object" && "page" in persisted ? persisted.page : undefined,
  ) }),
}));
