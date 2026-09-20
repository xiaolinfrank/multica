import type { ProjectStatus, ProjectPriority } from "../types";
import { createDraftStore } from "../drafts/create-draft-store";

interface ProjectDraft {
  title: string;
  description: string;
  status: ProjectStatus;
  priority: ProjectPriority;
  leadType?: "member" | "agent";
  leadId?: string;
  icon?: string;
  // Calendar days ("YYYY-MM-DD"); empty/undefined means unset.
  startDate?: string;
  dueDate?: string;
  // Absolute shared-storage path ("人机协作空间路径"); empty/undefined means
  // unset. Part of the draft because it is typed by hand and is the longest
  // field in the modal — losing it on a reopen costs more than a re-pick.
  collabPath?: string;
}

const EMPTY_DRAFT: ProjectDraft = {
  title: "",
  description: "",
  status: "planned",
  priority: "none",
  leadType: undefined,
  leadId: undefined,
  icon: undefined,
  startDate: undefined,
  dueDate: undefined,
  collabPath: undefined,
};

export const useProjectDraftStore = createDraftStore<ProjectDraft>({
  storageKey: "multica_project_draft",
  emptyData: EMPTY_DRAFT,
  hasMeaningful: (d) => !!(d.title || d.description),
});
